/**
 * Resolution of caller-facing time positions into exact sample indices.
 *
 * Editing operations take positions in whatever unit is natural at the call
 * site. Everything funnels through here so that "1:30" means the same thing in
 * `cut`, `fade`, and `mix`, and so an out-of-range value is reported once,
 * clearly, instead of silently clamping in three different ways.
 */

import { InvalidArgumentError } from '../errors.ts';
import type { TimePosition } from '../types.ts';

/** `"1:30"`, `"1:02:03.5"`, `"500ms"`, `"1.5s"`, or a bare number of seconds. */
function parseTimeString(value: string): number {
  const text = value.trim();

  const ms = /^(-?\d+(?:\.\d+)?)\s*ms$/i.exec(text);
  if (ms) return Number(ms[1]) / 1000;

  const s = /^(-?\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i.exec(text);
  if (s) return Number(s[1]);

  // Clock form: [hh:]mm:ss[.mmm]
  if (text.includes(':')) {
    const parts = text.split(':');
    if (parts.length > 3) {
      throw new InvalidArgumentError(`Cannot parse time "${value}": too many ":" separators.`);
    }
    let seconds = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(`Cannot parse time "${value}": "${part}" is not a number.`);
      }
      seconds = seconds * 60 + n;
    }
    return seconds;
  }

  const plain = Number(text);
  if (!Number.isFinite(plain)) {
    throw new InvalidArgumentError(
      `Cannot parse time "${value}". Use seconds (1.5), a timestamp ("1:30"), ` +
        `a suffixed value ("500ms"), or { sample: n }.`,
    );
  }
  return plain;
}

/**
 * Converts a {@link TimePosition} to a sample index.
 *
 * Negative values count back from `totalFrames`, matching `Array.prototype.slice`
 * — `cut({ from: -5 })` takes the last five seconds. The result is clamped to
 * `[0, totalFrames]`.
 */
export function toSampleIndex(
  position: TimePosition,
  sampleRate: number,
  totalFrames: number,
): number {
  let index: number;

  if (typeof position === 'object' && position !== null && 'sample' in position) {
    index = position.sample;
    if (!Number.isFinite(index)) {
      throw new InvalidArgumentError(`Sample index must be a finite number, got ${index}.`);
    }
    index = Math.round(index);
  } else {
    const seconds = typeof position === 'string' ? parseTimeString(position) : position;
    if (!Number.isFinite(seconds)) {
      throw new InvalidArgumentError(`Time position must be finite, got ${seconds}.`);
    }
    index = Math.round(seconds * sampleRate);
  }

  if (index < 0) index = totalFrames + index;
  return index < 0 ? 0 : index > totalFrames ? totalFrames : index;
}

/** Converts a duration (never relative to the end) to a frame count. */
export function toFrameCount(duration: TimePosition, sampleRate: number): number {
  if (typeof duration === 'object' && duration !== null && 'sample' in duration) {
    return Math.max(0, Math.round(duration.sample));
  }
  const seconds = typeof duration === 'string' ? parseTimeString(duration) : duration;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new InvalidArgumentError(`Duration must be a non-negative finite value, got ${duration}.`);
  }
  return Math.round(seconds * sampleRate);
}

/** Formats seconds as `h:mm:ss.mmm`, for messages and display. */
export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}
