/**
 * Level control: gain, fades, and normalisation.
 */

import { InvalidArgumentError } from '../errors.ts';
import { measureLoudness, measurePeak, measureTruePeak, fromDb, toDb } from '../analyze/loudness.ts';

/** Applies a linear gain to every channel. */
export function applyGain(channels: readonly Float32Array[], linear: number): Float32Array[] {
  if (linear === 1) return channels.map((c) => c.slice());
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i]! * linear;
    return out;
  });
}

/** Fade shapes. */
export type FadeCurve =
  /** Straight line in amplitude. Simple, but dips in perceived level mid-fade. */
  | 'linear'
  /** Straight line in decibels. Sounds like a hand moving a fader. */
  | 'exponential'
  /** Constant-power sine/cosine. The right choice for crossfades. */
  | 'equalPower';

function fadeFactor(progress: number, curve: FadeCurve): number {
  switch (curve) {
    case 'linear':
      return progress;
    case 'exponential':
      // -60 dB to 0 dB. A true exponential never reaches zero, so the floor is
      // chosen at the point where it stops being audible.
      return progress <= 0 ? 0 : Math.pow(10, (-60 * (1 - progress)) / 20);
    case 'equalPower':
      return Math.sin((progress * Math.PI) / 2);
  }
}

export interface FadeOptions {
  /** Fade-in length in frames. */
  inFrames?: number;
  /** Fade-out length in frames. */
  outFrames?: number;
  /** Shape. Defaults to `'linear'`. */
  curve?: FadeCurve;
}

/** Applies a fade-in and/or fade-out. */
export function applyFade(
  channels: readonly Float32Array[],
  options: FadeOptions,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const curve = options.curve ?? 'linear';
  const fadeIn = Math.max(0, Math.min(Math.round(options.inFrames ?? 0), frames));
  const fadeOut = Math.max(0, Math.min(Math.round(options.outFrames ?? 0), frames));

  return channels.map((c) => {
    const out = c.slice();
    for (let i = 0; i < fadeIn; i++) out[i]! *= fadeFactor(i / fadeIn, curve);
    for (let i = 0; i < fadeOut; i++) {
      const idx = frames - 1 - i;
      if (idx < 0) break;
      out[idx]! *= fadeFactor(i / fadeOut, curve);
    }
    return out;
  });
}

/**
 * Crossfades from `a` into `b` over `overlapFrames`.
 *
 * Uses equal-power curves by default. Linear crossfades sum to a level dip in
 * the middle for uncorrelated material — the classic "hole" in a DJ transition.
 */
export function crossfade(
  a: readonly Float32Array[],
  b: readonly Float32Array[],
  overlapFrames: number,
  curve: FadeCurve = 'equalPower',
): Float32Array[] {
  if (a.length !== b.length) {
    throw new InvalidArgumentError(
      `Cannot crossfade ${a.length}-channel into ${b.length}-channel audio.`,
    );
  }

  const aFrames = a[0]?.length ?? 0;
  const bFrames = b[0]?.length ?? 0;
  const overlap = Math.max(0, Math.min(Math.round(overlapFrames), aFrames, bFrames));
  const total = aFrames + bFrames - overlap;

  return a.map((aCh, c) => {
    const bCh = b[c]!;
    const out = new Float32Array(total);
    out.set(aCh.subarray(0, aFrames - overlap), 0);

    const start = aFrames - overlap;
    for (let i = 0; i < overlap; i++) {
      const progress = overlap === 1 ? 1 : i / (overlap - 1);
      const fadeOut = fadeFactor(1 - progress, curve);
      const fadeIn = fadeFactor(progress, curve);
      out[start + i] = aCh[start + i]! * fadeOut + bCh[i]! * fadeIn;
    }

    out.set(bCh.subarray(overlap), aFrames);
    return out;
  });
}

/** How a normalisation target is interpreted. */
export type NormalizeUnit =
  /** Highest sample value. Fast, but says nothing about perceived loudness. */
  | 'peak'
  /** Inter-sample peak. What "-1 dBTP" targets mean. */
  | 'truePeak'
  /** Perceived loudness per ITU-R BS.1770. What streaming platforms use. */
  | 'LUFS';

export interface NormalizeOptions {
  /** Target level in dB (dBFS for peak modes, LUFS for loudness). */
  to?: number;
  /** Which measurement to hit. Defaults to `'peak'`. */
  unit?: NormalizeUnit;
  /**
   * Ceiling in dBTP that the result must not exceed. Only meaningful with
   * `unit: 'LUFS'`, where hitting a loudness target can otherwise push peaks
   * into clipping. Defaults to -1 dBTP; pass `null` to disable.
   */
  truePeakCeiling?: number | null;
}

export interface NormalizeResult {
  channels: Float32Array[];
  /** Linear gain that was applied. */
  gain: number;
  /** Measured level before the change, in dB or LUFS. */
  measured: number;
  /** True when `truePeakCeiling` reduced the gain below the loudness target. */
  limitedByPeak: boolean;
}

/**
 * Scales audio to hit a target level.
 *
 * With `unit: 'LUFS'` the gain needed for the loudness target can push peaks
 * past full scale, so the result is additionally held under `truePeakCeiling`.
 * Reporting `limitedByPeak` matters: it tells the caller the loudness target was
 * *not* met, rather than leaving them to wonder why two normalised files still
 * differ in level.
 */
export function normalize(
  channels: readonly Float32Array[],
  sampleRate: number,
  options?: NormalizeOptions,
): NormalizeResult {
  const unit = options?.unit ?? 'peak';
  const target = options?.to ?? (unit === 'LUFS' ? -14 : -1);

  let measured: number;
  let gain: number;

  if (unit === 'LUFS') {
    measured = measureLoudness(channels, sampleRate).integrated;
    if (!Number.isFinite(measured)) {
      // Digital silence has no loudness to scale; amplifying it would only
      // raise the noise floor of whatever it is mixed with later.
      return { channels: channels.map((c) => c.slice()), gain: 1, measured, limitedByPeak: false };
    }
    gain = fromDb(target - measured);
  } else {
    const level = unit === 'truePeak' ? measureTruePeak(channels) : measurePeak(channels);
    measured = toDb(level);
    if (level === 0) {
      return { channels: channels.map((c) => c.slice()), gain: 1, measured, limitedByPeak: false };
    }
    gain = fromDb(target) / level;
  }

  let limitedByPeak = false;
  const ceiling = options?.truePeakCeiling === undefined ? -1 : options.truePeakCeiling;
  if (unit === 'LUFS' && ceiling !== null) {
    const peakAfter = toDb(measureTruePeak(channels) * gain);
    if (peakAfter > ceiling) {
      gain *= fromDb(ceiling - peakAfter);
      limitedByPeak = true;
    }
  }

  return { channels: applyGain(channels, gain), gain, measured, limitedByPeak };
}
