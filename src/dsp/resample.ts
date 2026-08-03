/**
 * Sample-rate conversion.
 *
 * The default is a windowed-sinc (Kaiser) interpolator — the same design SoX
 * and libsamplerate use. Cheaper alternatives are offered explicitly, because
 * the naive ones are the reason so much web audio sounds bad:
 *
 * - **Dropping or duplicating samples** (what a bare index-scale loop does)
 *   aliases badly and adds audible grit.
 * - **Linear interpolation** is a poor low-pass: it rolls off the top octave and
 *   still passes significant aliasing. Fine for a preview, wrong for a file
 *   somebody keeps.
 * - **Windowed sinc** approximates the ideal reconstruction filter. It costs
 *   more arithmetic and is worth it for anything that gets saved or shipped.
 *
 * Downsampling additionally needs the anti-alias cutoff moved *below* the new
 * Nyquist frequency before decimation. Skipping that step folds high frequencies
 * back down as inharmonic noise, which is the single most common resampling bug.
 */

import { InvalidArgumentError } from '../errors.ts';

export type ResampleQuality = 'fast' | 'good' | 'best';

export interface ResampleOptions {
  /**
   * `'best'` (default) windowed sinc, `'good'` cubic, `'fast'` linear.
   *
   * Use `'fast'` for realtime previews and waveform thumbnails; keep `'best'`
   * for anything the user will download.
   */
  quality?: ResampleQuality;
}

/** Modified Bessel function of the first kind, order 0. */
function besselI0(x: number): number {
  // Series expansion; converges quickly for the arguments a Kaiser window uses.
  let sum = 1;
  let term = 1;
  const halfSquared = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= halfSquared / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * A precomputed windowed-sinc filter, sampled `oversample` times per zero
 * crossing so per-output-sample cost is a table lookup plus a lerp rather than a
 * transcendental call.
 */
interface SincTable {
  table: Float32Array;
  zeros: number;
  oversample: number;
}

const TABLE_CACHE = new Map<string, SincTable>();

function buildSincTable(zeros: number, oversample: number, beta: number): SincTable {
  const key = `${zeros}:${oversample}:${beta}`;
  const cached = TABLE_CACHE.get(key);
  if (cached) return cached;

  const length = zeros * oversample + 1;
  const table = new Float32Array(length);
  const invI0Beta = 1 / besselI0(beta);

  for (let i = 0; i < length; i++) {
    const t = i / oversample; // distance in zero-crossings
    const window = t >= zeros ? 0 : besselI0(beta * Math.sqrt(1 - (t / zeros) ** 2)) * invI0Beta;
    table[i] = sinc(t) * window;
  }

  const built: SincTable = { table, zeros, oversample };
  // A handful of (rate-pair, quality) combinations covers any real workload, so
  // an unbounded cache cannot grow unbounded in practice.
  TABLE_CACHE.set(key, built);
  return built;
}

/** Output frame count for a given conversion. */
export function resampledLength(inputFrames: number, fromRate: number, toRate: number): number {
  return Math.max(0, Math.round((inputFrames * toRate) / fromRate));
}

/**
 * Resamples one channel.
 *
 * @param input Source samples.
 * @param fromRate Source sample rate in Hz.
 * @param toRate Target sample rate in Hz.
 */
export function resampleChannel(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  options?: ResampleOptions,
): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    throw new InvalidArgumentError(`Invalid source sample rate: ${fromRate}.`);
  }
  if (!Number.isFinite(toRate) || toRate <= 0) {
    throw new InvalidArgumentError(`Invalid target sample rate: ${toRate}.`);
  }
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);

  const quality = options?.quality ?? 'best';
  const ratio = toRate / fromRate;
  const outLength = resampledLength(input.length, fromRate, toRate);

  if (quality === 'fast') return resampleLinear(input, ratio, outLength);
  if (quality === 'good') return resampleCubic(input, ratio, outLength);
  return resampleSinc(input, ratio, outLength);
}

function resampleLinear(input: Float32Array, ratio: number, outLength: number): Float32Array {
  const out = new Float32Array(outLength);
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, last)]!;
    const b = input[Math.min(idx + 1, last)]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Catmull-Rom cubic interpolation. */
function resampleCubic(input: Float32Array, ratio: number, outLength: number): Float32Array {
  const out = new Float32Array(outLength);
  const last = input.length - 1;
  const at = (i: number): number => input[i < 0 ? 0 : i > last ? last : i]!;

  for (let i = 0; i < outLength; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const t = pos - idx;
    const p0 = at(idx - 1);
    const p1 = at(idx);
    const p2 = at(idx + 1);
    const p3 = at(idx + 2);

    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    out[i] = ((a * t + b) * t + c) * t + p1;
  }
  return out;
}

function resampleSinc(input: Float32Array, ratio: number, outLength: number): Float32Array {
  // 32 zero crossings with beta 10 puts the stopband near -110 dB, comfortably
  // below 24-bit noise. beta and zeros trade transition width against cost.
  const zeros = 32;
  const oversample = 512;
  const beta = 10;
  const { table } = buildSincTable(zeros, oversample, beta);

  // When downsampling, the filter must cut at the *new* Nyquist, not the old
  // one, or everything above it aliases back into the audible band.
  const cutoff = ratio < 1 ? ratio * 0.97 : 0.97;
  const halfWidth = zeros / cutoff;

  const out = new Float32Array(outLength);
  const last = input.length - 1;

  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const start = Math.ceil(center - halfWidth);
    const end = Math.floor(center + halfWidth);

    let sum = 0;
    let weight = 0;

    for (let n = start; n <= end; n++) {
      const distance = Math.abs(center - n) * cutoff;
      const pos = distance * oversample;
      const idx = pos | 0;
      if (idx >= table.length - 1) continue;

      // Linear interpolation between table entries; at 512x oversampling the
      // residual error is far below the quantization floor.
      const frac = pos - idx;
      const coefficient = table[idx]! + (table[idx + 1]! - table[idx]!) * frac;

      // Clamp rather than zero-pad at the edges: zero-padding creates a step
      // discontinuity that rings audibly at the very start and end of a file.
      sum += coefficient * input[n < 0 ? 0 : n > last ? last : n]!;
      weight += coefficient;
    }

    // Normalising by the realised weight keeps gain flat even where the kernel
    // is truncated by an edge.
    out[i] = weight !== 0 ? sum / weight : 0;
  }

  return out;
}

/** Resamples every channel of a planar buffer. */
export function resamplePlanar(
  channels: readonly Float32Array[],
  fromRate: number,
  toRate: number,
  options?: ResampleOptions,
): Float32Array[] {
  return channels.map((c) => resampleChannel(c, fromRate, toRate, options));
}
