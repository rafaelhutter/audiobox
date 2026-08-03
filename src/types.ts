/** Shared public types. Kept dependency-free so every subpath can import it cheaply. */

import type { Limits } from './limits.ts';

/**
 * Structural stand-in for the platform `AbortSignal`.
 *
 * Core is compiled without the DOM and Node type libraries — that is what keeps
 * it honestly isomorphic, since a missing type is the earliest possible warning
 * that a code path has quietly become browser-only or Node-only. A real
 * `AbortSignal` from any runtime satisfies this shape, so callers pass one
 * directly and never notice the indirection.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

/** A format audiobox can read and/or write. */
export type AudioFormat = 'wav' | 'aiff' | 'flac' | 'mp3' | 'caf' | 'au' | 'raw';

/** How individual samples are stored inside a container. */
export type SampleFormat =
  | 'u8' // unsigned 8-bit, offset binary — WAV's 8-bit form
  | 's8' // signed 8-bit — AIFF's 8-bit form
  | 's16'
  | 's24'
  | 's32'
  | 'f32'
  | 'f64'
  | 'alaw' // G.711 A-law, 8-bit companded
  | 'ulaw' // G.711 µ-law, 8-bit companded
  | 'ima-adpcm'; // IMA/DVI ADPCM, 4 bits per sample

/** Byte order for multi-byte samples. */
export type Endianness = 'little' | 'big';

/**
 * Anything acceptable as encoded input.
 *
 * `ArrayBufferView` covers `Uint8Array`, `Int16Array`, Node's `Buffer`, and every
 * other typed-array view, so callers rarely have to convert anything by hand.
 */
export type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;

/** Options accepted by every decode entry point. */
export interface DecodeOptions {
  /** Skip format sniffing and use this decoder. Rarely needed. */
  format?: AudioFormat;
  /** Safety ceilings for untrusted input. See {@link Limits}. */
  limits?: Partial<Limits>;
  /** Cancels a long decode. */
  signal?: AbortSignalLike;
  /** Called with progress in the range 0–1. Not guaranteed to reach exactly 1. */
  onProgress?: (progress: number) => void;
}

/** Metadata read from, or written into, a container. */
export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  /** Free-form comment. Maps to WAV `ICMT`, FLAC `COMMENT`, ID3 `COMM`. */
  comment?: string;
  genre?: string;
  /** Four-digit year where the source provides one. */
  year?: string;
  trackNumber?: number;
  /** Producing software. Defaults to `audiobox` on encode. */
  encoder?: string;
  /** Tags with no cross-format equivalent, preserved verbatim per format. */
  extra?: Record<string, string>;
}

/** Everything a decoder discovered that isn't sample data. */
export interface DecodeInfo {
  /** The container that was actually detected. */
  format: AudioFormat;
  /** Sample storage format inside that container. */
  sampleFormat: SampleFormat;
  /** Bits per sample as stored — 16 for `s16`, 4 for IMA ADPCM. */
  bitDepth: number;
  /** Average bitrate in bits per second, where meaningful (lossy formats). */
  bitrate?: number;
  /** True when the source encoding loses information. */
  lossy: boolean;
  /** Tags found in the container. */
  metadata: AudioMetadata;
  /** Codec-specific details, e.g. MP3 channel mode or FLAC block size. */
  details?: Record<string, unknown>;
}

/** A position in an audio buffer.
 *
 * Accepts whichever unit is natural at the call site: a number of seconds, a
 * `"m:ss"` / `"h:mm:ss.mmm"` timestamp, or an exact sample index. Sample indices
 * are the only form that survives a sample-rate change unambiguously, so
 * anything requiring frame accuracy should use `{ sample: n }`.
 */
export type TimePosition = number | string | { sample: number };

/** Progress and cancellation, accepted by every long-running operation. */
export interface OperationOptions {
  signal?: AbortSignalLike;
  onProgress?: (progress: number) => void;
}
