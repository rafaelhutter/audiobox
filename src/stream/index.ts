/**
 * Streaming helpers — `audiobox/stream`.
 *
 * The `Audio` API holds an entire file in memory, which is the right default:
 * most audio a web app touches is a few minutes long, and random access makes
 * editing far simpler. It stops being right for long recordings, batch server
 * jobs, and anywhere memory is capped.
 *
 * These transforms work on chunks instead. They use the WHATWG Streams API,
 * available natively in browsers, Node 18+, Deno, Bun, and Cloudflare Workers —
 * so the same pipeline runs everywhere without a shim.
 */

import { encodeWav } from '../formats/wav.ts';
import { decodeWav } from '../formats/wav.ts';
import { encodeInterleaved, decodeInterleaved, bytesPerSample } from '../pcm/convert.ts';
import { resamplePlanar } from '../dsp/resample.ts';
import { applyGain } from '../dsp/gain.ts';
import { toChannelCount } from '../dsp/channels.ts';
import { InvalidArgumentError, UnsupportedRuntimeError } from '../errors.ts';
import type { SampleFormat } from '../types.ts';
import type { ResampleOptions } from '../dsp/resample.ts';

/**
 * Structural view of the global `TransformStream`.
 *
 * Declared rather than imported so core stays free of DOM and Node type
 * libraries. The runtime object is the real one.
 */
type TransformStreamCtor = new <I, O>(transformer: {
  start?: (controller: { enqueue: (chunk: O) => void }) => void;
  transform?: (chunk: I, controller: { enqueue: (chunk: O) => void }) => void | Promise<void>;
  flush?: (controller: { enqueue: (chunk: O) => void }) => void | Promise<void>;
}) => { readable: unknown; writable: unknown };

function transformStreamCtor(): TransformStreamCtor {
  const ctor = (globalThis as Record<string, unknown>)['TransformStream'];
  if (typeof ctor !== 'function') {
    throw new UnsupportedRuntimeError(
      'This runtime has no global TransformStream. audiobox/stream needs Web Streams ' +
        '(browsers, Node 18+, Deno, Bun, Cloudflare Workers).',
    );
  }
  return ctor as TransformStreamCtor;
}

/** A chunk of decoded audio flowing through a pipeline. */
export interface AudioChunk {
  /** Planar samples, one array per channel. */
  channels: Float32Array[];
  sampleRate: number;
  /** Frame index of this chunk's first sample within the whole stream. */
  offset: number;
}

export interface PcmStreamOptions {
  sampleFormat?: SampleFormat;
  channels?: number;
  sampleRate?: number;
  littleEndian?: boolean;
  /** Frames per emitted chunk. Defaults to 8192. */
  chunkFrames?: number;
}

/**
 * Converts a byte stream of raw PCM into {@link AudioChunk}s.
 *
 * Handles chunk boundaries that fall mid-frame — a network or file stream splits
 * wherever it likes, and a decoder that assumes whole frames per chunk produces
 * clicks or channel-swapped audio at every boundary.
 */
export function createPcmDecodeStream(options: PcmStreamOptions = {}): {
  readable: unknown;
  writable: unknown;
} {
  const sampleFormat = options.sampleFormat ?? 's16';
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 44100;
  const littleEndian = options.littleEndian ?? true;
  const frameBytes = bytesPerSample(sampleFormat) * channels;

  let carry = new Uint8Array(0);
  let offset = 0;

  const Ctor = transformStreamCtor();
  return new Ctor<Uint8Array, AudioChunk>({
    transform(chunk, controller) {
      // Prepend whatever partial frame survived the previous chunk.
      let data: Uint8Array;
      if (carry.byteLength > 0) {
        data = new Uint8Array(carry.byteLength + chunk.byteLength);
        data.set(carry, 0);
        data.set(chunk, carry.byteLength);
      } else {
        data = chunk;
      }

      const wholeFrames = Math.floor(data.byteLength / frameBytes);
      const usable = wholeFrames * frameBytes;

      if (wholeFrames > 0) {
        controller.enqueue({
          channels: decodeInterleaved(
            data.subarray(0, usable),
            sampleFormat,
            littleEndian,
            channels,
            wholeFrames,
          ),
          sampleRate,
          offset,
        });
        offset += wholeFrames;
      }

      carry = data.byteLength > usable ? data.slice(usable) : new Uint8Array(0);
    },
    flush() {
      // A trailing partial frame is corrupt input; dropping it is better than
      // emitting a frame with undefined samples in some channels.
      carry = new Uint8Array(0);
    },
  });
}

/** Converts {@link AudioChunk}s back into raw PCM bytes. */
export function createPcmEncodeStream(options: PcmStreamOptions = {}): {
  readable: unknown;
  writable: unknown;
} {
  const sampleFormat = options.sampleFormat ?? 's16';
  const littleEndian = options.littleEndian ?? true;

  const Ctor = transformStreamCtor();
  return new Ctor<AudioChunk, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encodeInterleaved(chunk.channels, sampleFormat, littleEndian));
    },
  });
}

/** Applies a gain, in decibels, to every chunk. */
export function createGainStream(db: number): { readable: unknown; writable: unknown } {
  const linear = Math.pow(10, db / 20);
  const Ctor = transformStreamCtor();
  return new Ctor<AudioChunk, AudioChunk>({
    transform(chunk, controller) {
      controller.enqueue({ ...chunk, channels: applyGain(chunk.channels, linear) });
    },
  });
}

/** Converts every chunk to a different channel count. */
export function createChannelStream(count: number): { readable: unknown; writable: unknown } {
  const Ctor = transformStreamCtor();
  return new Ctor<AudioChunk, AudioChunk>({
    transform(chunk, controller) {
      controller.enqueue({ ...chunk, channels: toChannelCount(chunk.channels, count) });
    },
  });
}

/**
 * Resamples a stream.
 *
 * Note the caveat: each chunk is resampled independently, so the filter has no
 * history across boundaries and a faint discontinuity can appear there. That is
 * an acceptable trade for constant memory on a long stream, but for a file you
 * will keep, decode fully and use `Audio.resample()`, which is continuous.
 */
export function createResampleStream(
  targetRate: number,
  options?: ResampleOptions,
): { readable: unknown; writable: unknown } {
  let outputOffset = 0;
  const Ctor = transformStreamCtor();

  return new Ctor<AudioChunk, AudioChunk>({
    transform(chunk, controller) {
      if (chunk.sampleRate === targetRate) {
        controller.enqueue(chunk);
        outputOffset += chunk.channels[0]?.length ?? 0;
        return;
      }
      const channels = resamplePlanar(chunk.channels, chunk.sampleRate, targetRate, options);
      controller.enqueue({ channels, sampleRate: targetRate, offset: outputOffset });
      outputOffset += channels[0]?.length ?? 0;
    },
  });
}

/**
 * Collects a stream of chunks into a single WAV file.
 *
 * WAV's header declares the data length, which is not known until the stream
 * ends — so this buffers. It is a convenience for "stream in, file out", not a
 * constant-memory path.
 */
export async function collectToWav(
  chunks: AsyncIterable<AudioChunk>,
  options?: { sampleFormat?: SampleFormat },
): Promise<Uint8Array> {
  const collected: Float32Array[][] = [];
  let sampleRate = 44100;
  let channelCount = 0;

  for await (const chunk of chunks) {
    sampleRate = chunk.sampleRate;
    channelCount = Math.max(channelCount, chunk.channels.length);
    collected.push(chunk.channels);
  }

  if (collected.length === 0) {
    throw new InvalidArgumentError('The stream produced no audio.');
  }

  const total = collected.reduce((n, c) => n + (c[0]?.length ?? 0), 0);
  const merged = Array.from({ length: channelCount }, () => new Float32Array(total));
  let position = 0;
  for (const chunk of collected) {
    for (let c = 0; c < channelCount; c++) {
      const source = chunk[c] ?? chunk[0]!;
      merged[c]!.set(source, position);
    }
    position += chunk[0]?.length ?? 0;
  }

  return encodeWav(merged, sampleRate, options);
}

/** Re-exported so a streaming pipeline can finish with a normal decode. */
export { decodeWav };
