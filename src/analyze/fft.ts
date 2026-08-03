/**
 * Fourier analysis.
 *
 * An iterative radix-2 Cooley-Tukey FFT. Recursive implementations read more
 * clearly but allocate two arrays per level and blow the call stack on large
 * inputs; this one works in place on preallocated buffers, which is what makes
 * a spectrogram over a whole track practical.
 *
 * Twiddle factors are cached per size, since a spectrogram calls the same
 * transform size thousands of times in a row.
 */

import { InvalidArgumentError } from '../errors.ts';

interface Twiddles {
  cos: Float64Array;
  sin: Float64Array;
  reverse: Uint32Array;
}

const TWIDDLE_CACHE = new Map<number, Twiddles>();

function twiddlesFor(size: number): Twiddles {
  const cached = TWIDDLE_CACHE.get(size);
  if (cached) return cached;

  const half = size >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }

  // Precomputed bit-reversal permutation.
  const bits = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }

  const built = { cos, sin, reverse };
  TWIDDLE_CACHE.set(size, built);
  return built;
}

/**
 * In-place complex FFT. `real` and `imag` must both have a power-of-two length.
 *
 * For real input, leave `imag` zeroed; the output's second half mirrors the
 * first, so only bins `0 .. size/2` carry independent information.
 */
export function fft(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  if (size !== imag.length) {
    throw new InvalidArgumentError('fft: real and imaginary arrays must be the same length.');
  }
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new InvalidArgumentError(`fft: length must be a power of two, got ${size}.`);
  }

  const { cos, sin, reverse } = twiddlesFor(size);

  // Bit-reversal permutation.
  for (let i = 0; i < size; i++) {
    const j = reverse[i]!;
    if (j > i) {
      let temp = real[i]!;
      real[i] = real[j]!;
      real[j] = temp;
      temp = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = temp;
    }
  }

  // Butterfly stages.
  for (let span = 2; span <= size; span <<= 1) {
    const half = span >> 1;
    const step = size / span;
    for (let start = 0; start < size; start += span) {
      for (let k = 0; k < half; k++) {
        const twiddle = k * step;
        const wr = cos[twiddle]!;
        const wi = sin[twiddle]!;
        const a = start + k;
        const b = a + half;

        const tr = real[b]! * wr - imag[b]! * wi;
        const ti = real[b]! * wi + imag[b]! * wr;

        real[b] = real[a]! - tr;
        imag[b] = imag[a]! - ti;
        real[a] = real[a]! + tr;
        imag[a] = imag[a]! + ti;
      }
    }
  }
}

export interface SpectrumOptions {
  /** Transform size; must be a power of two. Defaults to 2048. */
  fftSize?: number;
  /**
   * Analysis window. Defaults to `'hann'`.
   *
   * Windowing is not optional in practice: a rectangular window on a signal
   * whose period does not divide the frame length smears energy across every
   * bin ("spectral leakage"), which buries real detail under an artefact.
   */
  window?: 'hann' | 'hamming' | 'blackman' | 'none';
}

function buildWindow(size: number, type: NonNullable<SpectrumOptions['window']>): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    switch (type) {
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
        break;
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * x);
        break;
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
        break;
      case 'none':
        w[i] = 1;
        break;
    }
  }
  return w;
}

/**
 * Magnitude spectrum of one frame, in linear units.
 *
 * Returns `fftSize / 2 + 1` bins. Bin `k` is centred on
 * `k * sampleRate / fftSize` Hz.
 */
export function spectrum(samples: Float32Array, options?: SpectrumOptions): Float64Array {
  const size = options?.fftSize ?? 2048;
  const window = buildWindow(size, options?.window ?? 'hann');

  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  const count = Math.min(size, samples.length);
  for (let i = 0; i < count; i++) real[i] = samples[i]! * window[i]!;

  fft(real, imag);

  const bins = (size >> 1) + 1;
  const out = new Float64Array(bins);
  // Scale so a full-scale sine reads 1.0 regardless of transform size.
  const scale = 2 / size;
  for (let i = 0; i < bins; i++) {
    out[i] = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!) * scale;
  }
  return out;
}

/**
 * Magnitude spectra over successive overlapping frames.
 *
 * @param hopSize Frames advanced between windows. Defaults to `fftSize / 4`.
 */
export function spectrogram(
  samples: Float32Array,
  options?: SpectrumOptions & { hopSize?: number },
): Float64Array[] {
  const size = options?.fftSize ?? 2048;
  const hop = options?.hopSize ?? size >> 2;
  const out: Float64Array[] = [];

  for (let start = 0; start + size <= samples.length; start += hop) {
    out.push(spectrum(samples.subarray(start, start + size), options));
  }
  return out;
}
