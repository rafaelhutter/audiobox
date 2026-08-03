/**
 * Structural edits: cutting, joining, padding, reversing, and mixing.
 *
 * Every function here takes and returns planar channel arrays and allocates a
 * fresh result. Nothing mutates its input — an editing pipeline that mutates in
 * place makes `const original = ...` a lie, and undo impossible.
 */

import { InvalidArgumentError } from '../errors.ts';

/** Extracts frames `[start, end)` from every channel. */
export function slicePlanar(
  channels: readonly Float32Array[],
  start: number,
  end: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(start, frames));
  const to = Math.max(from, Math.min(end, frames));
  return channels.map((c) => c.slice(from, to));
}

/** Removes frames `[start, end)`, joining what remains. */
export function removeRange(
  channels: readonly Float32Array[],
  start: number,
  end: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(start, frames));
  const to = Math.max(from, Math.min(end, frames));
  const removed = to - from;

  return channels.map((c) => {
    const out = new Float32Array(frames - removed);
    out.set(c.subarray(0, from), 0);
    out.set(c.subarray(to), from);
    return out;
  });
}

/**
 * Concatenates buffers end to end.
 *
 * All inputs must already agree on channel count — this operates on raw sample
 * data and has no sample rate to reconcile. The `Audio` wrapper checks rates
 * before delegating here.
 */
export function concatPlanar(buffers: ReadonlyArray<readonly Float32Array[]>): Float32Array[] {
  if (buffers.length === 0) throw new InvalidArgumentError('Nothing to concatenate.');

  const channels = buffers[0]!.length;
  let total = 0;
  for (const buf of buffers) {
    if (buf.length !== channels) {
      throw new InvalidArgumentError(
        `Cannot concatenate: expected ${channels} channel(s), found ${buf.length}. ` +
          'Convert to a common channel layout first.',
      );
    }
    total += buf[0]?.length ?? 0;
  }

  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const dst = new Float32Array(total);
    let offset = 0;
    for (const buf of buffers) {
      dst.set(buf[c]!, offset);
      offset += buf[c]!.length;
    }
    out.push(dst);
  }
  return out;
}

/** Adds silence before and/or after. */
export function padPlanar(
  channels: readonly Float32Array[],
  before: number,
  after: number,
): Float32Array[] {
  const start = Math.max(0, Math.round(before));
  const end = Math.max(0, Math.round(after));
  const frames = channels[0]?.length ?? 0;

  return channels.map((c) => {
    const out = new Float32Array(start + frames + end);
    out.set(c, start);
    return out;
  });
}

/** Reverses every channel in place-equivalent fashion, returning new arrays. */
export function reversePlanar(channels: readonly Float32Array[]): Float32Array[] {
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    for (let i = 0, j = c.length - 1; i < c.length; i++, j--) out[i] = c[j]!;
    return out;
  });
}

export interface MixOptions {
  /** Frame at which the overlaid buffer starts. Defaults to 0. */
  offset?: number;
  /** Linear gain applied to the overlaid buffer. Defaults to 1. */
  gain?: number;
  /**
   * Extend the result when the overlay runs past the end. Defaults to `false`,
   * which truncates to the original length.
   */
  extend?: boolean;
}

/**
 * Sums `overlay` onto `base`.
 *
 * Summing can exceed ±1. Nothing is clamped here — clipping is a decision for
 * the point where audio leaves the float domain, and clamping early would
 * silently destroy headroom that a later `normalize` could have recovered.
 */
export function mixPlanar(
  base: readonly Float32Array[],
  overlay: readonly Float32Array[],
  options?: MixOptions,
): Float32Array[] {
  if (base.length !== overlay.length) {
    throw new InvalidArgumentError(
      `Cannot mix ${overlay.length}-channel audio into ${base.length}-channel audio. ` +
        'Match the channel counts first.',
    );
  }

  const offset = Math.round(options?.offset ?? 0);
  const gain = options?.gain ?? 1;
  const baseFrames = base[0]?.length ?? 0;
  const overlayFrames = overlay[0]?.length ?? 0;
  const needed = Math.max(baseFrames, offset + overlayFrames);
  const frames = options?.extend ? needed : baseFrames;

  return base.map((src, c) => {
    const out = new Float32Array(frames);
    out.set(src.subarray(0, Math.min(src.length, frames)), 0);

    const add = overlay[c]!;
    const start = Math.max(0, offset);
    const count = Math.min(add.length - (start - offset), frames - start);
    for (let i = 0; i < count; i++) {
      out[start + i]! += add[i + (start - offset)]! * gain;
    }
    return out;
  });
}
