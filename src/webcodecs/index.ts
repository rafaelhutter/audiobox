/**
 * Optional WebCodecs acceleration — `audiobox/webcodecs`.
 *
 * ## Why this is optional, and only an accelerator
 *
 * WebCodecs gives browsers hardware-accelerated access to codecs the platform
 * already ships — notably Opus and AAC, which audiobox does not implement. It
 * is tempting to build a library on top of it. That does not work for an
 * isomorphic package: **Node has no WebCodecs.** `AudioEncoder`, `AudioDecoder`,
 * and `AudioData` are all undefined there (verified on Node 23; still absent in
 * 24 and 25), and the popular "webcodecs for Node" packages are native FFmpeg
 * bindings — which would mean a dependency, and a heavy one.
 *
 * So the pure-TypeScript path is the real implementation everywhere, and this
 * module is a bonus that lights up when the host provides it. Everything here
 * feature-detects and degrades; nothing in core imports it.
 *
 * Codec availability also varies by browser and cannot be assumed — always check
 * {@link isCodecSupported} rather than trusting a support matrix.
 */

import { UnsupportedRuntimeError } from '../errors.ts';
import { Audio } from '../audio.ts';

/** Minimal structural view of the platform types, so core needs no DOM lib. */
interface AudioEncoderLike {
  configure(config: Record<string, unknown>): void;
  encode(data: unknown): void;
  flush(): Promise<void>;
  close(): void;
  state: string;
}

interface AudioEncoderCtor {
  new (init: { output: (chunk: unknown, metadata?: unknown) => void; error: (e: Error) => void }): AudioEncoderLike;
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

function encoderCtor(): AudioEncoderCtor | null {
  const ctor = (globalThis as Record<string, unknown>)['AudioEncoder'];
  return typeof ctor === 'function' ? (ctor as AudioEncoderCtor) : null;
}

function audioDataCtor(): (new (init: Record<string, unknown>) => unknown) | null {
  const ctor = (globalThis as Record<string, unknown>)['AudioData'];
  return typeof ctor === 'function' ? (ctor as new (init: Record<string, unknown>) => unknown) : null;
}

/** True when this runtime exposes the WebCodecs audio interfaces at all. */
export function isWebCodecsAvailable(): boolean {
  return encoderCtor() !== null && audioDataCtor() !== null;
}

/**
 * Asks the platform whether it can encode a given codec configuration.
 *
 * Returns `false` rather than throwing when WebCodecs is missing entirely, so
 * this can be used directly as a feature check.
 */
export async function isCodecSupported(
  codec: string,
  sampleRate = 48000,
  numberOfChannels = 2,
): Promise<boolean> {
  const Encoder = encoderCtor();
  if (!Encoder) return false;
  try {
    const support = await Encoder.isConfigSupported({ codec, sampleRate, numberOfChannels });
    return support.supported === true;
  } catch {
    return false;
  }
}

/** Codec strings worth probing, in rough order of usefulness. */
export const COMMON_CODECS = Object.freeze({
  /** Opus in a WebM container — the best-supported lossy option on the web. */
  opus: 'opus',
  /** AAC-LC. Widely supported for playback; encode support varies. */
  aac: 'mp4a.40.2',
  /** FLAC via the platform, when you would rather not ship our encoder. */
  flac: 'flac',
  /** G.711 companding, for telephony pipelines. */
  alaw: 'alaw',
  ulaw: 'ulaw',
});

export interface WebCodecsEncodeOptions {
  /** Codec string, e.g. `'opus'`. See {@link COMMON_CODECS}. */
  codec: string;
  /** Target bitrate in bits per second. */
  bitrate?: number;
  /** Frames per encoded chunk. Defaults to 1024. */
  chunkFrames?: number;
}

/**
 * Encodes audio using the platform's own codec implementation.
 *
 * Returns the raw encoded chunks. They are **not** wrapped in a container — a
 * WebM or MP4 muxer is a separate concern, and pretending otherwise would
 * produce files that do not play.
 *
 * @throws {UnsupportedRuntimeError} when WebCodecs or the codec is unavailable.
 */
export async function encodeWithWebCodecs(
  audio: Audio,
  options: WebCodecsEncodeOptions,
): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
  const Encoder = encoderCtor();
  const AudioDataCtor = audioDataCtor();

  if (!Encoder || !AudioDataCtor) {
    throw new UnsupportedRuntimeError(
      'WebCodecs is not available in this runtime. Node has no WebCodecs; use the ' +
        'built-in encoders (wav, flac) instead, which work everywhere.',
    );
  }
  if (!(await isCodecSupported(options.codec, audio.sampleRate, audio.channels))) {
    throw new UnsupportedRuntimeError(
      `This browser cannot encode "${options.codec}" at ${audio.sampleRate} Hz / ` +
        `${audio.channels} channel(s). Check isCodecSupported() before calling.`,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const encoder = new Encoder({
    output: (chunk) => {
      const typed = chunk as { byteLength: number; copyTo(destination: Uint8Array): void };
      const bytes = new Uint8Array(typed.byteLength);
      typed.copyTo(bytes);
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
    },
    error: (error) => {
      throw error;
    },
  });

  encoder.configure({
    codec: options.codec,
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.channels,
    ...(options.bitrate ? { bitrate: options.bitrate } : {}),
  });

  // WebCodecs wants interleaved f32 in a single buffer per AudioData.
  const chunkFrames = options.chunkFrames ?? 1024;
  const interleaved = audio.toInterleaved();
  const channels = audio.channels;

  for (let start = 0; start < audio.frames; start += chunkFrames) {
    const frames = Math.min(chunkFrames, audio.frames - start);
    const slice = interleaved.subarray(start * channels, (start + frames) * channels);

    const data = new AudioDataCtor({
      format: 'f32',
      sampleRate: audio.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      // Microseconds from the start of the stream.
      timestamp: Math.round((start / audio.sampleRate) * 1_000_000),
      data: slice.slice(),
    });

    encoder.encode(data);
    (data as { close?: () => void }).close?.();
  }

  await encoder.flush();
  encoder.close();

  return { chunks, totalBytes };
}
