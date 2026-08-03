/**
 * Loudness and level measurement.
 *
 * ## Why LUFS rather than peak
 *
 * Peak normalisation makes files *the same height*, not the same loudness. A
 * dense pop master and a sparse acoustic recording can share an identical peak
 * and still differ by 10 dB in perceived level — which is why a naive
 * "normalise to 0 dBFS" playlist lurches in volume between tracks.
 *
 * ITU-R BS.1770 measures perceived loudness instead: K-weight the signal
 * (roughly, model the ear's frequency response), take the mean square over
 * overlapping 400 ms blocks, and average the blocks with a two-stage gate that
 * discards silence and quiet passages. EBU R128 builds broadcast practice on
 * top of it, and every streaming platform now normalises this way — Spotify to
 * about -14 LUFS, broadcast to -23.
 *
 * ## True peak
 *
 * Sample peak underreads. The continuous waveform reconstructed at playback can
 * overshoot the highest *sample*, so a file that measures -0.1 dBFS can still
 * clip a listener's DAC or a lossy encoder. True-peak measurement oversamples
 * before measuring, which is what BS.1770 requires and what "-1 dBTP" targets
 * mean.
 */

import { InvalidArgumentError } from '../errors.ts';

/** Second-order section state, one per channel. */
interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Derives the two K-weighting stages for an arbitrary sample rate.
 *
 * BS.1770 publishes coefficients only for 48 kHz. Rather than resample
 * everything to 48 kHz first — which would add its own filtering to the
 * measurement — the analogue prototypes are re-discretised at the actual rate
 * via the bilinear transform. These are the same prototype constants libebur128
 * uses, so results line up with ffmpeg and other R128 implementations.
 */
function kWeightingFilters(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  // Stage 1: high-frequency shelf, approximating the acoustic effect of a head.
  const shelfF0 = 1681.974450955533;
  const shelfGain = 3.999843853973347;
  const shelfQ = 0.7071752369554196;

  const k1 = Math.tan((Math.PI * shelfF0) / sampleRate);
  const vh = Math.pow(10, shelfGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k1 / shelfQ + k1 * k1;

  const shelf: BiquadCoefficients = {
    b0: (vh + (vb * k1) / shelfQ + k1 * k1) / a0,
    b1: (2 * (k1 * k1 - vh)) / a0,
    b2: (vh - (vb * k1) / shelfQ + k1 * k1) / a0,
    a1: (2 * (k1 * k1 - 1)) / a0,
    a2: (1 - k1 / shelfQ + k1 * k1) / a0,
  };

  // Stage 2: high-pass, discarding rumble the ear barely registers.
  const hpF0 = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * hpF0) / sampleRate);
  const denom = 1 + k2 / hpQ + k2 * k2;

  const highpass: BiquadCoefficients = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / denom,
    a2: (1 - k2 / hpQ + k2 * k2) / denom,
  };

  return [shelf, highpass];
}

function applyBiquad(input: Float32Array, c: BiquadCoefficients): Float32Array {
  const out = new Float32Array(input.length);
  const s: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = c.b0 * x0 + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
    s.x2 = s.x1;
    s.x1 = x0;
    s.y2 = s.y1;
    s.y1 = y0;
    out[i] = y0;
  }
  return out;
}

/**
 * Per-channel weighting from BS.1770.
 *
 * Surround channels are weighted up by ~1.5 dB because sound arriving from
 * behind is perceived as louder than the same energy arriving from the front.
 * The LFE channel is excluded from the measurement entirely.
 */
function channelWeights(channelCount: number): number[] {
  switch (channelCount) {
    case 1:
      return [1];
    case 2:
      return [1, 1];
    case 3:
      return [1, 1, 1];
    case 4:
      return [1, 1, 1.41, 1.41];
    case 5:
      return [1, 1, 1, 1.41, 1.41];
    case 6:
      // 5.1: L R C LFE Ls Rs — the LFE contributes 0.
      return [1, 1, 1, 0, 1.41, 1.41];
    default:
      return new Array<number>(channelCount).fill(1);
  }
}

export interface LoudnessResult {
  /** Integrated (gated) loudness in LUFS. `-Infinity` for digital silence. */
  integrated: number;
  /** Loudness range in LU — the spread between quiet and loud passages. */
  range: number;
  /** Highest 400 ms block loudness, in LUFS. */
  peakMomentary: number;
}

/**
 * Measures integrated loudness per ITU-R BS.1770-4 with EBU R128 gating.
 *
 * @param channels Planar float channels.
 * @param sampleRate Sample rate in Hz.
 */
export function measureLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
): LoudnessResult {
  if (channels.length === 0) throw new InvalidArgumentError('At least one channel is required.');

  const [shelf, highpass] = kWeightingFilters(sampleRate);
  const weights = channelWeights(channels.length);

  // K-weight each channel once, up front.
  const filtered = channels.map((c) => applyBiquad(applyBiquad(c, shelf), highpass));

  const frames = channels[0]!.length;
  const blockFrames = Math.round(0.4 * sampleRate); // 400 ms
  const stepFrames = Math.round(0.1 * sampleRate); // 75% overlap

  if (frames < blockFrames) {
    // Too short to gate meaningfully; report the ungated mean square so callers
    // still get a usable number for short clips instead of -Infinity.
    return shortClipLoudness(filtered, weights);
  }

  // Weighted mean square per block.
  const blockPower: number[] = [];
  for (let start = 0; start + blockFrames <= frames; start += stepFrames) {
    let sum = 0;
    for (let c = 0; c < filtered.length; c++) {
      const weight = weights[c] ?? 1;
      if (weight === 0) continue;
      const data = filtered[c]!;
      let acc = 0;
      for (let i = start; i < start + blockFrames; i++) acc += data[i]! * data[i]!;
      sum += weight * (acc / blockFrames);
    }
    blockPower.push(sum);
  }

  const toLufs = (power: number): number => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

  // Stage 1: absolute gate at -70 LUFS removes true silence.
  const aboveAbsolute = blockPower.filter((p) => toLufs(p) >= -70);
  if (aboveAbsolute.length === 0) {
    return { integrated: -Infinity, range: 0, peakMomentary: -Infinity };
  }

  // Stage 2: relative gate 10 LU below the mean of what survived stage 1. This
  // is what stops a long fade-out or a quiet intro from dragging the measured
  // loudness of a track below what a listener would call its level.
  const meanAbsolute = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
  const relativeThreshold = toLufs(meanAbsolute) - 10;

  const gated = blockPower.filter((p) => toLufs(p) >= relativeThreshold && toLufs(p) >= -70);
  const usable = gated.length > 0 ? gated : aboveAbsolute;
  const integrated = toLufs(usable.reduce((a, b) => a + b, 0) / usable.length);

  // Loudness range: the 10th-to-95th percentile spread of the gated blocks,
  // per EBU Tech 3342.
  const sorted = usable.map(toLufs).filter(Number.isFinite).sort((a, b) => a - b);
  const range =
    sorted.length > 1
      ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0) -
        (sorted[Math.floor(sorted.length * 0.1)] ?? 0)
      : 0;

  return {
    integrated,
    range,
    peakMomentary: Math.max(...blockPower.map(toLufs)),
  };
}

/** Ungated measurement, for clips shorter than one 400 ms block. */
function shortClipLoudness(filtered: Float32Array[], weights: number[]): LoudnessResult {
  const frames = filtered[0]!.length;
  if (frames === 0) return { integrated: -Infinity, range: 0, peakMomentary: -Infinity };

  let sum = 0;
  for (let c = 0; c < filtered.length; c++) {
    const weight = weights[c] ?? 1;
    if (weight === 0) continue;
    const data = filtered[c]!;
    let acc = 0;
    for (let i = 0; i < frames; i++) acc += data[i]! * data[i]!;
    sum += weight * (acc / frames);
  }

  const lufs = sum > 0 ? -0.691 + 10 * Math.log10(sum) : -Infinity;
  return { integrated: lufs, range: 0, peakMomentary: lufs };
}

/** Highest absolute sample value across all channels, as a linear ratio. */
export function measurePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i]!);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * True-peak level as a linear ratio, via 4x oversampling.
 *
 * BS.1770 specifies at least 4x for rates up to 48 kHz. Inter-sample peaks
 * routinely sit 0.5–1.5 dB above the sample peak on loud material, which is why
 * mastering targets sit at -1 dBTP rather than 0.
 */
export function measureTruePeak(channels: readonly Float32Array[]): number {
  const factor = 4;
  // 4x zero-stuffed upsampling followed by a short windowed-sinc reconstruction.
  const taps = 32;
  const kernel = new Float32Array(taps * factor);
  for (let i = 0; i < kernel.length; i++) {
    const t = i / factor - taps / 2;
    const sincValue = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    // Blackman window keeps the reconstruction ripple well below the 0.1 dB
    // that would matter for a peak reading.
    const w = i / (kernel.length - 1);
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
    kernel[i] = sincValue * window;
  }

  let peak = 0;
  for (const channel of channels) {
    const n = channel.length;
    for (let i = 0; i < n; i++) {
      for (let phase = 0; phase < factor; phase++) {
        let sum = 0;
        for (let k = 0; k < taps; k++) {
          const idx = i + k - taps / 2;
          if (idx < 0 || idx >= n) continue;
          sum += channel[idx]! * kernel[k * factor + phase]!;
        }
        const v = Math.abs(sum);
        if (v > peak) peak = v;
      }
    }
  }

  // Never report below the sample peak; the reconstruction is an estimate and
  // the actual samples are ground truth.
  return Math.max(peak, measurePeak(channels));
}

/** Root-mean-square level across all channels, as a linear ratio. */
export function measureRms(channels: readonly Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) sum += channel[i]! * channel[i]!;
    count += channel.length;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Linear ratio to decibels. Returns `-Infinity` for zero. */
export function toDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

/** Decibels to linear ratio. */
export function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}
