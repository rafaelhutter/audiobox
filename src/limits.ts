/**
 * Safety limits for untrusted input.
 *
 * Audio containers describe their own size. A malicious file can claim a
 * multi-gigabyte payload in a 44-byte header, and a decoder that believes it
 * will happily try to allocate that much — a denial of service from a tiny
 * upload. Every allocation derived from file-supplied numbers is checked here
 * first.
 *
 * Defaults are sized for "a user uploaded a song", not "I am transcoding a
 * feature film". Raise them explicitly when you trust the source.
 */

import { LimitExceededError } from './errors.ts';

export interface Limits {
  /**
   * Ceiling on the decoded PCM buffer, in bytes. Decoded audio is `Float32Array`,
   * so this is `sampleRate × channels × duration × 4`.
   *
   * Default: 512 MiB — roughly 50 minutes of 48 kHz stereo.
   */
  maxDecodedBytes: number;

  /**
   * Ceiling on decoded duration, in seconds. Catches the case of a low sample
   * rate stretching a small buffer across an implausible span of time.
   *
   * Default: 21600 (6 hours).
   */
  maxDurationSeconds: number;

  /**
   * Ceiling on channel count. Real content is 1–8; the format fields allow far
   * more, and each channel is a separate allocation.
   *
   * Default: 64.
   */
  maxChannels: number;

  /**
   * Accepted sample-rate range, in Hz. Values outside it are always a corrupt or
   * hostile header — and a sample rate of 0 or 1 is a fast route to a division
   * blow-up or an absurd resampling ratio.
   *
   * Default: 1000 – 768000.
   */
  minSampleRate: number;
  maxSampleRate: number;

  /**
   * Ceiling on total frames in a single decode. Backstop for formats where the
   * frame count is discovered incrementally rather than declared up front.
   *
   * Default: 2^32 - 1.
   */
  maxFrames: number;
}

/** Conservative defaults, applied to every decode unless overridden. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxDecodedBytes: 512 * 1024 * 1024,
  maxDurationSeconds: 6 * 60 * 60,
  maxChannels: 64,
  minSampleRate: 1000,
  maxSampleRate: 768000,
  maxFrames: 0xffffffff,
});

/** Fills in any unset field from {@link DEFAULT_LIMITS}. */
export function resolveLimits(limits?: Partial<Limits>): Limits {
  if (!limits) return DEFAULT_LIMITS as Limits;
  return {
    maxDecodedBytes: limits.maxDecodedBytes ?? DEFAULT_LIMITS.maxDecodedBytes,
    maxDurationSeconds: limits.maxDurationSeconds ?? DEFAULT_LIMITS.maxDurationSeconds,
    maxChannels: limits.maxChannels ?? DEFAULT_LIMITS.maxChannels,
    minSampleRate: limits.minSampleRate ?? DEFAULT_LIMITS.minSampleRate,
    maxSampleRate: limits.maxSampleRate ?? DEFAULT_LIMITS.maxSampleRate,
    maxFrames: limits.maxFrames ?? DEFAULT_LIMITS.maxFrames,
  };
}

/**
 * Validates a decode's shape *before* any buffer is allocated.
 *
 * Call this the moment the header has been parsed and the dimensions are known —
 * the entire point is to fail before `new Float32Array(huge)` runs.
 */
export function checkDecodeShape(
  frames: number,
  channels: number,
  sampleRate: number,
  limits: Limits,
): void {
  if (!Number.isFinite(sampleRate) || sampleRate < limits.minSampleRate || sampleRate > limits.maxSampleRate) {
    throw new LimitExceededError('sampleRate', sampleRate, limits.maxSampleRate);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > limits.maxChannels) {
    throw new LimitExceededError('maxChannels', channels, limits.maxChannels);
  }
  if (!Number.isInteger(frames) || frames < 0 || frames > limits.maxFrames) {
    throw new LimitExceededError('maxFrames', frames, limits.maxFrames);
  }

  const duration = frames / sampleRate;
  if (duration > limits.maxDurationSeconds) {
    throw new LimitExceededError('maxDurationSeconds', duration, limits.maxDurationSeconds);
  }

  // Float32Array = 4 bytes per sample.
  const bytes = frames * channels * 4;
  if (bytes > limits.maxDecodedBytes) {
    throw new LimitExceededError('maxDecodedBytes', bytes, limits.maxDecodedBytes);
  }
}

/** Guards a single incremental allocation for formats that grow as they decode. */
export function checkAllocation(bytes: number, limits: Limits): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > limits.maxDecodedBytes) {
    throw new LimitExceededError('maxDecodedBytes', bytes, limits.maxDecodedBytes);
  }
}
