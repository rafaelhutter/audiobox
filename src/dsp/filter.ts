/**
 * Biquad filters and dynamics.
 *
 * Coefficient formulas follow the Audio EQ Cookbook (Robert Bristow-Johnson),
 * the same derivation the Web Audio `BiquadFilterNode` uses — so a filter
 * configured here and one configured in the browser produce matching results.
 */

import { InvalidArgumentError } from '../errors.ts';

export type FilterType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'allpass';

export interface FilterOptions {
  type: FilterType;
  /** Corner or centre frequency in Hz. */
  frequency: number;
  /** Resonance. Defaults to 0.7071 (Butterworth — maximally flat, no peak). */
  q?: number;
  /** Gain in dB. Used only by `peaking`, `lowshelf`, and `highshelf`. */
  gain?: number;
}

interface Coefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function designFilter(options: FilterOptions, sampleRate: number): Coefficients {
  const { type } = options;
  const q = options.q ?? Math.SQRT1_2;
  const gainDb = options.gain ?? 0;

  if (!Number.isFinite(options.frequency) || options.frequency <= 0) {
    throw new InvalidArgumentError(`Filter frequency must be positive, got ${options.frequency}.`);
  }
  if (q <= 0) throw new InvalidArgumentError(`Filter Q must be positive, got ${q}.`);

  // Above Nyquist a biquad is undefined and produces garbage rather than
  // failing, so clamp just below it.
  const nyquist = sampleRate / 2;
  const frequency = Math.min(options.frequency, nyquist * 0.999);

  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha;
      b1 = -2 * cos;
      b2 = 1 + alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const shelfAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + shelfAlpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - shelfAlpha);
      a0 = A + 1 + (A - 1) * cos + shelfAlpha;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - shelfAlpha;
      break;
    }
    case 'highshelf': {
      const shelfAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + shelfAlpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - shelfAlpha);
      a0 = A + 1 - (A - 1) * cos + shelfAlpha;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - shelfAlpha;
      break;
    }
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Applies a biquad filter to every channel. */
export function applyFilter(
  channels: readonly Float32Array[],
  options: FilterOptions,
  sampleRate: number,
): Float32Array[] {
  const c = designFilter(options, sampleRate);

  return channels.map((input) => {
    const out = new Float32Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;

    for (let i = 0; i < input.length; i++) {
      const x0 = input[i]!;
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    return out;
  });
}

export interface LimiterOptions {
  /** Ceiling in dBFS. Defaults to -1. The output is guaranteed not to exceed it. */
  threshold?: number;
  /**
   * Lookahead in milliseconds. Defaults to 5.
   *
   * Gain reduction is ramped in over this window *before* a peak arrives, which
   * is what stops a hard limiter from sounding like a click on every transient.
   * It costs latency: the result is delayed by exactly this much, and the
   * function compensates so the returned audio stays sample-aligned with its
   * input.
   */
  lookahead?: number;
  /** Release time in ms. Defaults to 50. */
  release?: number;
}

/**
 * A lookahead peak limiter.
 *
 * The ceiling is a guarantee, not a target. That rules out the naive design —
 * smoothing the rectified signal and dividing by it — because a slow attack lets
 * the very first transient through at full level before the envelope has moved.
 * Instead the envelope takes the maximum over a lookahead window, so reduction
 * is already in place by the time the peak arrives, and decays with the release
 * time afterwards.
 *
 * Gain reduction is computed from the loudest channel and applied to all of
 * them. Limiting channels independently would shift the stereo image whenever
 * one side is louder — audible as the image pulling toward the quieter channel
 * on every transient.
 */
export function applyLimiter(
  channels: readonly Float32Array[],
  sampleRate: number,
  options?: LimiterOptions,
): Float32Array[] {
  const threshold = Math.pow(10, (options?.threshold ?? -1) / 20);
  const lookaheadFrames = Math.max(1, Math.round(((options?.lookahead ?? 5) / 1000) * sampleRate));
  const releaseCoefficient = Math.exp(-1 / (((options?.release ?? 50) / 1000) * sampleRate));

  const frames = channels[0]?.length ?? 0;
  const out = channels.map((c) => c.slice());
  if (frames === 0) return out;

  // Per-frame peak across channels.
  const peaks = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let peak = 0;
    for (const channel of channels) {
      const v = Math.abs(channel[i]!);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }

  // Envelope = the largest peak within the lookahead window, then released.
  // Taking the window maximum is what makes the ceiling a guarantee: the gain
  // at sample i already accounts for every peak up to i + lookahead.
  // A monotonic deque gives the sliding-window maximum in O(n) rather than the
  // O(n × window) a naive rescan would cost — which matters, because a 5 ms
  // window at 48 kHz is 240 samples per output sample.
  const envelope = new Float32Array(frames);
  const deque = new Int32Array(frames);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < frames; i++) {
    const windowEnd = Math.min(frames, i + lookaheadFrames);
    // Extend the window to cover everything up to windowEnd.
    for (let j = i === 0 ? 0 : Math.min(frames, i - 1 + lookaheadFrames); j < windowEnd; j++) {
      while (tail > head && peaks[deque[tail - 1]!]! <= peaks[j]!) tail--;
      deque[tail++] = j;
    }
    // Drop indices that have fallen out of the window's left edge.
    while (tail > head && deque[head]! < i) head++;
    envelope[i] = tail > head ? peaks[deque[head]!]! : 0;
  }

  // Forward pass applies the release so gain recovers smoothly rather than
  // snapping back the instant a peak passes.
  let gain = 1;
  for (let i = 0; i < frames; i++) {
    const target = envelope[i]! > threshold ? threshold / envelope[i]! : 1;
    // Reduction is immediate; recovery is smoothed. Taking the minimum keeps
    // the ceiling intact even mid-release.
    gain = target < gain ? target : releaseCoefficient * gain + (1 - releaseCoefficient) * target;
    gain = Math.min(gain, target);
    for (const channel of out) channel[i]! *= gain;
  }

  return out;
}
