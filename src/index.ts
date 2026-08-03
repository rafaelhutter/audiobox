/**
 * audiobox — zero-dependency audio toolkit.
 *
 * ```ts
 * import { decode, encode } from 'audiobox';
 *
 * const audio = await decode(bytes);
 * const clip = audio.cut({ from: '0:10', to: '0:40' }).toMono().resample(16000);
 * const wav = await encode(clip, 'wav', { bitDepth: 16 });
 * ```
 *
 * MP3 and FLAC live behind `audiobox/mp3` and `audiobox/flac` so their tables
 * stay out of bundles that never touch them; `decode`/`encode` load them on
 * demand.
 *
 * @see https://github.com/jmsansan/audiobox
 */

// --- The main surface -------------------------------------------------------

export { Audio } from './audio.ts';
export type { CutOptions, AudioFadeOptions } from './audio.ts';

export { decode, decodeSync, encode, encodeSync, toBytes } from './codec.ts';
export type { EncodableFormat, EncodeOptionsByFormat } from './codec.ts';

// --- Errors -----------------------------------------------------------------

export {
  AudioboxError,
  UnsupportedFormatError,
  DecodeError,
  EncodeError,
  InvalidArgumentError,
  LimitExceededError,
  AbortedError,
  UnsupportedRuntimeError,
  throwIfAborted,
} from './errors.ts';
export type { ErrorCode } from './errors.ts';

// --- Safety limits ----------------------------------------------------------

export { DEFAULT_LIMITS, resolveLimits, checkDecodeShape } from './limits.ts';
export type { Limits } from './limits.ts';

// --- Containers (direct access, when you already know the format) -----------

export { decodeWav, encodeWav } from './formats/wav.ts';
export type { WavDecodeOptions, WavEncodeOptions } from './formats/wav.ts';
export { decodeAiff, encodeAiff } from './formats/aiff.ts';
export type { AiffDecodeOptions, AiffEncodeOptions } from './formats/aiff.ts';
export { decodeAu, encodeAu } from './formats/au.ts';
export { decodeCaf, encodeCaf } from './formats/caf.ts';
export type { DecodedContainer, ContainerEncodeOptions } from './formats/types.ts';

// --- Sample conversion ------------------------------------------------------

export {
  decodeInterleaved,
  encodeInterleaved,
  bytesPerSample,
  bitDepthOf,
  isFloatFormat,
  linearToALaw,
  linearToULaw,
} from './pcm/convert.ts';
export type { DitherOptions } from './pcm/convert.ts';

// --- DSP (for callers who want the functions without the Audio wrapper) -----

export { resampleChannel, resamplePlanar, resampledLength } from './dsp/resample.ts';
export type { ResampleQuality, ResampleOptions } from './dsp/resample.ts';

export { slicePlanar, removeRange, concatPlanar, padPlanar, reversePlanar, mixPlanar } from './dsp/edit.ts';
export type { MixOptions } from './dsp/edit.ts';

export { applyGain, applyFade, crossfade, normalize } from './dsp/gain.ts';
export type { FadeCurve, FadeOptions, NormalizeUnit, NormalizeOptions, NormalizeResult } from './dsp/gain.ts';

export { toMono, toStereo, toChannelCount, mapChannels, pan, splitChannels, mergeChannels } from './dsp/channels.ts';

export { applyFilter, applyLimiter } from './dsp/filter.ts';
export type { FilterType, FilterOptions, LimiterOptions } from './dsp/filter.ts';

export { detectSilence, trimSilence, removeDcOffset } from './dsp/silence.ts';
export type { SilenceOptions, SilentRange, TrimSilenceOptions } from './dsp/silence.ts';

export { changeSpeed, changeTempo, changePitch } from './dsp/timestretch.ts';

export { toSampleIndex, toFrameCount, formatDuration } from './dsp/time.ts';

// --- Measurement ------------------------------------------------------------

export {
  measureLoudness,
  measurePeak,
  measureTruePeak,
  measureRms,
  toDb,
  fromDb,
} from './analyze/loudness.ts';
export type { LoudnessResult } from './analyze/loudness.ts';

// --- Detection --------------------------------------------------------------

export { sniff } from './io/sniff.ts';
export type { SniffResult, KnownUndecodableFormat } from './io/sniff.ts';

// --- Low-level I/O (useful when writing your own container) -----------------

export { Reader } from './io/reader.ts';
export { Writer } from './io/writer.ts';
export { BitReader, BitWriter } from './io/bits.ts';

// --- Types ------------------------------------------------------------------

export type {
  AudioFormat,
  SampleFormat,
  Endianness,
  BinaryInput,
  DecodeOptions,
  DecodeInfo,
  AudioMetadata,
  TimePosition,
  OperationOptions,
  AbortSignalLike,
} from './types.ts';
