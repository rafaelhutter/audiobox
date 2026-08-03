/**
 * Node.js conveniences — `audiobox/node`.
 *
 * Deliberately the *only* module that imports from `node:*`. Core stays free of
 * runtime-specific APIs so it works unchanged in browsers, Deno, Bun, and edge
 * runtimes; the Node-flavoured sugar lives here, behind its own subpath, where
 * a bundler targeting the browser will never pull it in.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { Audio } from '../audio.ts';
import { decode, encode, toBytes } from '../codec.ts';
import type { DecodeOptions } from '../types.ts';
import type { EncodableFormat, EncodeOptionsByFormat } from '../codec.ts';

/** Reads and decodes an audio file from disk. */
export async function readAudioFile(path: string, options?: DecodeOptions): Promise<Audio> {
  return decode(await readFile(path), options);
}

/**
 * Encodes and writes an audio file, choosing the format from the extension.
 *
 * ```ts
 * await writeAudioFile('out.flac', audio);
 * await writeAudioFile('out.wav', audio, { bitDepth: 24 });
 * ```
 */
export async function writeAudioFile<F extends EncodableFormat>(
  path: string,
  audio: Audio,
  options?: EncodeOptionsByFormat[F],
): Promise<void> {
  const format = formatFromPath(path);
  const bytes = await encode(audio, format, options as EncodeOptionsByFormat[typeof format]);
  await writeFile(path, bytes);
}

/** Infers a format from a file extension. Defaults to WAV. */
export function formatFromPath(path: string): EncodableFormat {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  const extension = match?.[1]?.toLowerCase();
  switch (extension) {
    case 'flac':
      return 'flac';
    case 'aif':
    case 'aiff':
    case 'aifc':
      return 'aiff';
    case 'au':
    case 'snd':
      return 'au';
    case 'caf':
      return 'caf';
    case 'wav':
    case 'wave':
    default:
      return 'wav';
  }
}

/**
 * Decodes a Node `Buffer` without copying.
 *
 * A `Buffer` is a `Uint8Array` view over a shared, pooled `ArrayBuffer`. Passing
 * `buffer.buffer` directly would expose unrelated memory from the pool, so the
 * view's offset and length must be respected — which `toBytes` does.
 */
export function fromBuffer(buffer: Uint8Array, options?: DecodeOptions): Promise<Audio> {
  return decode(toBytes(buffer), options);
}

export { decode, encode, Audio };
