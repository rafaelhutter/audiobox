/**
 * The `Audio` value type — the thing you actually hold and pass around.
 *
 * ## Immutability
 *
 * Every transform returns a **new** `Audio`; nothing mutates in place. That
 * costs an allocation per step, and buys three things worth more than the
 * allocation: `const original = ...` stays true, an accidental second call
 * cannot corrupt earlier state, and chains read in the order they happen.
 *
 * For very large files where the copies matter, use the standalone functions in
 * `dsp/` directly, or stream the work — see `audiobox/stream`.
 *
 * ## Sample representation
 *
 * Planar `Float32Array`, one per channel, nominally in [-1, 1]. Values outside
 * that range are *allowed* between steps — summing two signals legitimately
 * exceeds 1 — and are clamped only when encoding to an integer format. Clamping
 * earlier would throw away headroom that a later `normalize()` could recover.
 */

import { InvalidArgumentError } from './errors.ts';
import type { AudioMetadata, DecodeInfo, TimePosition } from './types.ts';

import { toSampleIndex, toFrameCount, formatDuration } from './dsp/time.ts';
import { slicePlanar, removeRange, concatPlanar, padPlanar, reversePlanar, mixPlanar } from './dsp/edit.ts';
import type { MixOptions } from './dsp/edit.ts';
import { resamplePlanar } from './dsp/resample.ts';
import type { ResampleOptions } from './dsp/resample.ts';
import { applyGain, applyFade, normalize as normalizeChannels, crossfade } from './dsp/gain.ts';
import type { FadeCurve, NormalizeOptions, NormalizeResult } from './dsp/gain.ts';
import { toMono, toStereo, toChannelCount, mapChannels, pan, splitChannels, mergeChannels } from './dsp/channels.ts';
import { applyFilter, applyLimiter } from './dsp/filter.ts';
import type { FilterOptions, LimiterOptions } from './dsp/filter.ts';
import { trimSilence, detectSilence, removeDcOffset } from './dsp/silence.ts';
import type { TrimSilenceOptions, SilenceOptions, SilentRange } from './dsp/silence.ts';
import { changeSpeed, changeTempo, changePitch } from './dsp/timestretch.ts';
import { measurePeak, measureTruePeak, measureRms, measureLoudness, toDb, fromDb } from './analyze/loudness.ts';
import type { LoudnessResult } from './analyze/loudness.ts';

/** Options for {@link Audio.cut}. */
export interface CutOptions {
  /** Start position. Defaults to the beginning. Negative counts from the end. */
  from?: TimePosition;
  /** End position. Defaults to the end. Negative counts from the end. */
  to?: TimePosition;
}

/** Options for {@link Audio.fade}. */
export interface AudioFadeOptions {
  /** Fade-in length. */
  in?: TimePosition;
  /** Fade-out length. */
  out?: TimePosition;
  /** Shape. Defaults to `'linear'`. */
  curve?: FadeCurve;
}

export class Audio {
  /** Samples per second. */
  readonly sampleRate: number;
  /** What the decoder found, when this came from a file. */
  readonly info: DecodeInfo | undefined;

  readonly #data: readonly Float32Array[];

  /**
   * @param channelData One `Float32Array` per channel; all must be equal length.
   * @param sampleRate Samples per second.
   */
  constructor(channelData: readonly Float32Array[], sampleRate: number, info?: DecodeInfo) {
    if (channelData.length === 0) {
      throw new InvalidArgumentError('Audio requires at least one channel.');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new InvalidArgumentError(`Sample rate must be positive, got ${sampleRate}.`);
    }
    const frames = channelData[0]!.length;
    for (let c = 1; c < channelData.length; c++) {
      if (channelData[c]!.length !== frames) {
        throw new InvalidArgumentError(
          `Channel ${c} has ${channelData[c]!.length} frames but channel 0 has ${frames}.`,
        );
      }
    }

    this.#data = channelData;
    this.sampleRate = sampleRate;
    this.info = info;
    Object.freeze(this);
  }

  // --- Construction --------------------------------------------------------

  /** Creates silence. */
  static silence(duration: TimePosition, sampleRate = 44100, channels = 1): Audio {
    const frames = toFrameCount(duration, sampleRate);
    return new Audio(
      Array.from({ length: channels }, () => new Float32Array(frames)),
      sampleRate,
    );
  }

  /** Wraps interleaved samples, as produced by most capture APIs. */
  static fromInterleaved(data: Float32Array, channels: number, sampleRate: number): Audio {
    if (channels < 1) throw new InvalidArgumentError(`channels must be >= 1, got ${channels}.`);
    const frames = Math.floor(data.length / channels);
    const planar = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) planar[c]![i] = data[i * channels + c]!;
    }
    return new Audio(planar, sampleRate);
  }

  /**
   * Wraps a Web Audio `AudioBuffer`.
   *
   * Typed structurally rather than against the DOM `AudioBuffer` so that core
   * stays free of browser type dependencies; a real `AudioBuffer` satisfies it.
   */
  static fromAudioBuffer(buffer: {
    numberOfChannels: number;
    sampleRate: number;
    getChannelData(channel: number): Float32Array;
  }): Audio {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice());
    }
    return new Audio(channels, buffer.sampleRate);
  }

  // --- Inspection ----------------------------------------------------------

  /** Number of channels. */
  get channels(): number {
    return this.#data.length;
  }

  /** Frames per channel. */
  get frames(): number {
    return this.#data[0]!.length;
  }

  /** Duration in seconds. */
  get duration(): number {
    return this.frames / this.sampleRate;
  }

  /** Duration as `h:mm:ss.mmm`. */
  get durationFormatted(): string {
    return formatDuration(this.duration);
  }

  /** The raw samples for one channel. Treat as read-only. */
  channelData(index: number): Float32Array {
    const channel = this.#data[index];
    if (!channel) {
      throw new InvalidArgumentError(
        `Channel ${index} does not exist; this audio has ${this.channels}.`,
      );
    }
    return channel;
  }

  /** All channels. Treat as read-only. */
  get allChannels(): readonly Float32Array[] {
    return this.#data;
  }

  /** Interleaves into a single array, as most playback APIs expect. */
  toInterleaved(): Float32Array {
    const { channels, frames } = this;
    const out = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      const src = this.#data[c]!;
      for (let i = 0; i < frames; i++) out[i * channels + c] = src[i]!;
    }
    return out;
  }

  /** Copies into an existing Web Audio `AudioBuffer`. */
  copyToAudioBuffer(buffer: { numberOfChannels: number; copyToChannel(source: Float32Array, channel: number): void }): void {
    const count = Math.min(buffer.numberOfChannels, this.channels);
    for (let c = 0; c < count; c++) buffer.copyToChannel(this.#data[c]!, c);
  }

  /** Returns a new `Audio` with the same rate but different samples. */
  #with(channelData: readonly Float32Array[]): Audio {
    return new Audio(channelData, this.sampleRate, this.info);
  }

  // --- Editing -------------------------------------------------------------

  /**
   * Keeps the region between `from` and `to`.
   *
   * ```ts
   * audio.cut({ from: '0:30', to: '1:00' });   // the second half-minute
   * audio.cut({ from: -10 });                  // the last ten seconds
   * audio.cut({ to: { sample: 44100 } });      // exactly one second at 44.1k
   * ```
   */
  cut(options: CutOptions): Audio {
    const start = options.from === undefined ? 0 : toSampleIndex(options.from, this.sampleRate, this.frames);
    const end = options.to === undefined ? this.frames : toSampleIndex(options.to, this.sampleRate, this.frames);
    if (end < start) {
      throw new InvalidArgumentError(
        `cut: "to" (frame ${end}) is before "from" (frame ${start}).`,
      );
    }
    return this.#with(slicePlanar(this.#data, start, end));
  }

  /** Deletes the region between `from` and `to`, closing the gap. */
  remove(options: CutOptions): Audio {
    const start = options.from === undefined ? 0 : toSampleIndex(options.from, this.sampleRate, this.frames);
    const end = options.to === undefined ? this.frames : toSampleIndex(options.to, this.sampleRate, this.frames);
    return this.#with(removeRange(this.#data, start, end));
  }

  /** Appends other audio. All inputs must share a sample rate and channel count. */
  concat(...others: readonly Audio[]): Audio {
    for (const other of others) {
      if (other.sampleRate !== this.sampleRate) {
        throw new InvalidArgumentError(
          `Cannot concatenate ${other.sampleRate} Hz audio onto ${this.sampleRate} Hz. ` +
            `Call .resample(${this.sampleRate}) first.`,
        );
      }
    }
    return this.#with(concatPlanar([this.#data, ...others.map((o) => o.allChannels)]));
  }

  /** Adds silence at the start and/or end. */
  pad(options: { start?: TimePosition; end?: TimePosition }): Audio {
    return this.#with(
      padPlanar(
        this.#data,
        options.start ? toFrameCount(options.start, this.sampleRate) : 0,
        options.end ? toFrameCount(options.end, this.sampleRate) : 0,
      ),
    );
  }

  /** Reverses the audio. */
  reverse(): Audio {
    return this.#with(reversePlanar(this.#data));
  }

  /** Sums other audio on top of this. */
  mix(other: Audio, options?: Omit<MixOptions, 'offset'> & { at?: TimePosition }): Audio {
    if (other.sampleRate !== this.sampleRate) {
      throw new InvalidArgumentError(
        `Cannot mix ${other.sampleRate} Hz audio into ${this.sampleRate} Hz. ` +
          `Call .resample(${this.sampleRate}) on it first.`,
      );
    }
    const offset = options?.at ? toSampleIndex(options.at, this.sampleRate, Number.MAX_SAFE_INTEGER) : 0;
    return this.#with(mixPlanar(this.#data, other.allChannels, { ...options, offset }));
  }

  /** Crossfades into `next` over `duration`. */
  crossfadeTo(next: Audio, duration: TimePosition, curve: FadeCurve = 'equalPower'): Audio {
    if (next.sampleRate !== this.sampleRate) {
      throw new InvalidArgumentError(
        `Cannot crossfade into ${next.sampleRate} Hz audio from ${this.sampleRate} Hz.`,
      );
    }
    const frames = toFrameCount(duration, this.sampleRate);
    return this.#with(crossfade(this.#data, next.allChannels, frames, curve));
  }

  // --- Rate and channels ---------------------------------------------------

  /** Converts to a different sample rate. */
  resample(targetRate: number, options?: ResampleOptions): Audio {
    if (targetRate === this.sampleRate) return this;
    return new Audio(resamplePlanar(this.#data, this.sampleRate, targetRate, options), targetRate, this.info);
  }

  /** Downmixes to one channel by averaging. */
  toMono(): Audio {
    return this.channels === 1 ? this : this.#with(toMono(this.#data));
  }

  /** Converts to two channels. */
  toStereo(): Audio {
    return this.channels === 2 ? this : this.#with(toStereo(this.#data));
  }

  /** Converts to an arbitrary channel count. */
  toChannels(count: number): Audio {
    return count === this.channels ? this : this.#with(toChannelCount(this.#data, count));
  }

  /** Reorders or duplicates channels by index. `[1, 0]` swaps a stereo pair. */
  mapChannels(mapping: readonly number[]): Audio {
    return this.#with(mapChannels(this.#data, mapping));
  }

  /** Constant-power stereo pan. -1 is hard left, 1 is hard right. */
  pan(position: number): Audio {
    return this.#with(pan(this.#data, position));
  }

  /** Splits into one mono `Audio` per channel. */
  split(): Audio[] {
    return splitChannels(this.#data).map((c) => new Audio(c, this.sampleRate, this.info));
  }

  /** Merges mono buffers into one multi-channel `Audio`. */
  static merge(...parts: readonly Audio[]): Audio {
    if (parts.length === 0) throw new InvalidArgumentError('merge requires at least one input.');
    const rate = parts[0]!.sampleRate;
    for (const part of parts) {
      if (part.sampleRate !== rate) {
        throw new InvalidArgumentError(`Cannot merge audio at differing sample rates.`);
      }
    }
    return new Audio(mergeChannels(parts.map((p) => p.allChannels)), rate);
  }

  // --- Level ---------------------------------------------------------------

  /** Applies a linear gain. */
  gain(linear: number): Audio {
    return this.#with(applyGain(this.#data, linear));
  }

  /** Applies a gain in decibels. */
  gainDb(db: number): Audio {
    return this.#with(applyGain(this.#data, fromDb(db)));
  }

  /**
   * Scales to a target level.
   *
   * ```ts
   * audio.normalize();                              // peak to -1 dBFS
   * audio.normalize({ to: -14, unit: 'LUFS' });     // streaming loudness
   * ```
   */
  normalize(options?: NormalizeOptions): Audio {
    return this.#with(normalizeChannels(this.#data, this.sampleRate, options).channels);
  }

  /** Like {@link normalize}, but also reports what was measured and applied. */
  normalizeWithReport(options?: NormalizeOptions): { audio: Audio; report: Omit<NormalizeResult, 'channels'> } {
    const { channels, ...report } = normalizeChannels(this.#data, this.sampleRate, options);
    return { audio: this.#with(channels), report };
  }

  /** Applies a fade-in and/or fade-out. */
  fade(options: AudioFadeOptions): Audio {
    return this.#with(
      applyFade(this.#data, {
        inFrames: options.in ? toFrameCount(options.in, this.sampleRate) : 0,
        outFrames: options.out ? toFrameCount(options.out, this.sampleRate) : 0,
        curve: options.curve,
      }),
    );
  }

  // --- Filtering -----------------------------------------------------------

  /** Applies a biquad filter. */
  filter(options: FilterOptions): Audio {
    return this.#with(applyFilter(this.#data, options, this.sampleRate));
  }

  /** Applies a soft limiter. */
  limit(options?: LimiterOptions): Audio {
    return this.#with(applyLimiter(this.#data, this.sampleRate, options));
  }

  /** Removes DC offset. */
  removeDcOffset(): Audio {
    return this.#with(removeDcOffset(this.#data));
  }

  /** Trims silence from the start and/or end. */
  trimSilence(options?: TrimSilenceOptions): Audio {
    return this.#with(trimSilence(this.#data, this.sampleRate, options));
  }

  /** Finds silent spans without modifying anything. */
  detectSilence(options?: SilenceOptions): SilentRange[] {
    return detectSilence(this.#data, this.sampleRate, options);
  }

  // --- Time and pitch ------------------------------------------------------

  /** Changes speed and pitch together, like a varispeed tape machine. */
  speed(factor: number): Audio {
    return this.#with(changeSpeed(this.#data, factor));
  }

  /** Changes duration while preserving pitch. */
  tempo(factor: number): Audio {
    return this.#with(changeTempo(this.#data, factor, this.sampleRate));
  }

  /** Shifts pitch while preserving duration. */
  pitch(semitones: number): Audio {
    return this.#with(changePitch(this.#data, semitones, this.sampleRate));
  }

  // --- Measurement ---------------------------------------------------------

  /** Highest absolute sample value, as a linear ratio. */
  peak(): number {
    return measurePeak(this.#data);
  }

  /** Peak in dBFS. */
  peakDb(): number {
    return toDb(measurePeak(this.#data));
  }

  /** Inter-sample peak in dBTP. */
  truePeakDb(): number {
    return toDb(measureTruePeak(this.#data));
  }

  /** RMS level in dBFS. */
  rmsDb(): number {
    return toDb(measureRms(this.#data));
  }

  /** Integrated loudness and range, per ITU-R BS.1770. */
  loudness(): LoudnessResult {
    return measureLoudness(this.#data, this.sampleRate);
  }

  /**
   * Min/max pairs per bucket, for drawing a waveform.
   *
   * Returns extremes rather than averages: averaging washes out transients and
   * produces the flat, lifeless waveform displays that make it impossible to
   * see where the beats are.
   *
   * @param buckets Number of horizontal pixels to draw.
   */
  waveform(buckets: number): { min: Float32Array; max: Float32Array } {
    if (!Number.isInteger(buckets) || buckets < 1) {
      throw new InvalidArgumentError(`buckets must be a positive integer, got ${buckets}.`);
    }
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const { frames } = this;
    const per = frames / buckets;

    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(frames, Math.max(start + 1, Math.floor((b + 1) * per)));
      let lo = 0;
      let hi = 0;
      for (const channel of this.#data) {
        for (let i = start; i < end; i++) {
          const v = channel[i]!;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[b] = lo;
      max[b] = hi;
    }
    return { min, max };
  }

  /** A short human-readable summary, handy when logging. */
  toString(): string {
    return `Audio(${this.durationFormatted}, ${this.sampleRate} Hz, ${this.channels}ch)`;
  }
}

/** Re-exported so callers can build metadata without a second import. */
export type { AudioMetadata };
