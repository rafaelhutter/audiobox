/**
 * Silence detection and DC-offset removal.
 */

import { fromDb } from '../analyze/loudness.ts';

export interface SilenceOptions {
  /**
   * Level below which audio counts as silent, in dBFS. Defaults to -60.
   *
   * A literal zero threshold almost never works: real recordings carry a noise
   * floor from the preamp and converter, so "silence" is quiet, not absent.
   */
  threshold?: number;
  /**
   * Window in milliseconds over which level is measured. Defaults to 10.
   *
   * Measuring per sample would treat every zero crossing of a loud waveform as
   * silence, cutting holes through the middle of a note.
   */
  windowMs?: number;
}

/** A detected span of silence, in frames. */
export interface SilentRange {
  start: number;
  end: number;
}

/** Per-window RMS envelope, used by both detection and trimming. */
function rmsEnvelope(
  channels: readonly Float32Array[],
  windowFrames: number,
): { level: Float32Array; windows: number } {
  const frames = channels[0]?.length ?? 0;
  const windows = Math.max(1, Math.ceil(frames / windowFrames));
  const level = new Float32Array(windows);

  for (let w = 0; w < windows; w++) {
    const start = w * windowFrames;
    const end = Math.min(start + windowFrames, frames);
    let sum = 0;
    let count = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) sum += channel[i]! * channel[i]!;
      count += end - start;
    }
    level[w] = count > 0 ? Math.sqrt(sum / count) : 0;
  }

  return { level, windows };
}

/** Finds every silent span. */
export function detectSilence(
  channels: readonly Float32Array[],
  sampleRate: number,
  options?: SilenceOptions,
): SilentRange[] {
  const threshold = fromDb(options?.threshold ?? -60);
  const windowFrames = Math.max(1, Math.round(((options?.windowMs ?? 10) / 1000) * sampleRate));
  const frames = channels[0]?.length ?? 0;
  const { level, windows } = rmsEnvelope(channels, windowFrames);

  const ranges: SilentRange[] = [];
  let start = -1;

  for (let w = 0; w < windows; w++) {
    const silent = level[w]! < threshold;
    if (silent && start < 0) start = w * windowFrames;
    if (!silent && start >= 0) {
      ranges.push({ start, end: Math.min(w * windowFrames, frames) });
      start = -1;
    }
  }
  if (start >= 0) ranges.push({ start, end: frames });

  return ranges;
}

export interface TrimSilenceOptions extends SilenceOptions {
  /** Trim leading silence. Defaults to `true`. */
  start?: boolean;
  /** Trim trailing silence. Defaults to `true`. */
  end?: boolean;
  /**
   * Silence to leave in place, in milliseconds. Defaults to 0.
   *
   * Trimming hard to the first audible sample clips the attack of the first
   * note and sounds abrupt; a few milliseconds of lead-in usually sounds right.
   */
  paddingMs?: number;
}

/** Removes silence from the start and/or end. */
export function trimSilence(
  channels: readonly Float32Array[],
  sampleRate: number,
  options?: TrimSilenceOptions,
): Float32Array[] {
  const threshold = fromDb(options?.threshold ?? -60);
  const windowFrames = Math.max(1, Math.round(((options?.windowMs ?? 10) / 1000) * sampleRate));
  const padding = Math.round(((options?.paddingMs ?? 0) / 1000) * sampleRate);
  const frames = channels[0]?.length ?? 0;
  const { level, windows } = rmsEnvelope(channels, windowFrames);

  let firstLoud = 0;
  let lastLoud = windows - 1;
  while (firstLoud < windows && level[firstLoud]! < threshold) firstLoud++;
  while (lastLoud >= firstLoud && level[lastLoud]! < threshold) lastLoud--;

  // Entirely silent: return an empty buffer rather than the whole thing.
  if (firstLoud >= windows) return channels.map(() => new Float32Array(0));

  const start = options?.start === false ? 0 : Math.max(0, firstLoud * windowFrames - padding);
  const end =
    options?.end === false ? frames : Math.min(frames, (lastLoud + 1) * windowFrames + padding);

  return channels.map((c) => c.slice(start, end));
}

/**
 * Removes DC offset by subtracting each channel's mean.
 *
 * A DC offset eats headroom asymmetrically and can produce a click at the start
 * and end of playback. It usually comes from a poorly-biased ADC or an analogue
 * input stage, and shows up as a waveform that is not centred on zero.
 */
export function removeDcOffset(channels: readonly Float32Array[]): Float32Array[] {
  return channels.map((c) => {
    if (c.length === 0) return new Float32Array(0);
    let sum = 0;
    for (let i = 0; i < c.length; i++) sum += c[i]!;
    const mean = sum / c.length;
    if (mean === 0) return c.slice();

    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i]! - mean;
    return out;
  });
}
