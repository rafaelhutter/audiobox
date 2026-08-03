/**
 * Format dispatch: the `decode` / `encode` entry points most callers use.
 *
 * ## Why the main entry points are async
 *
 * MP3 and FLAC carry large coefficient and Huffman tables. Statically importing
 * them here would pull that weight into every bundle, including ones that only
 * ever touch WAV. Instead they are loaded with a dynamic `import()`, which
 * bundlers turn into a separate chunk fetched only when a file of that type is
 * actually handled.
 *
 * That is what makes the async signature worth it: `decode()` on a WAV never
 * downloads the MP3 decoder. Synchronous {@link decodeSync} and
 * {@link encodeSync} are available for the built-in containers when a promise is
 * genuinely inconvenient.
 */

import { Audio } from './audio.ts';
import { UnsupportedFormatError, InvalidArgumentError, throwIfAborted } from './errors.ts';
import { sniff } from './io/sniff.ts';
import { decodeWav, encodeWav } from './formats/wav.ts';
import type { WavEncodeOptions } from './formats/wav.ts';
import { decodeAiff, encodeAiff } from './formats/aiff.ts';
import type { AiffEncodeOptions } from './formats/aiff.ts';
import { decodeAu, encodeAu } from './formats/au.ts';
import { decodeCaf, encodeCaf } from './formats/caf.ts';
import type { DecodedContainer, ContainerEncodeOptions } from './formats/types.ts';
import type { AudioFormat, BinaryInput, DecodeOptions } from './types.ts';

/** Normalises any accepted binary input to a `Uint8Array` without copying. */
export function toBytes(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new InvalidArgumentError(
    'Expected a Uint8Array, ArrayBuffer, or typed-array view of encoded audio.',
  );
}

/** Containers built into the core bundle. */
const SYNC_FORMATS = new Set<AudioFormat>(['wav', 'aiff', 'au', 'caf']);

function decodeBuiltin(
  format: AudioFormat,
  bytes: Uint8Array,
  options?: DecodeOptions,
): DecodedContainer {
  const limits = options?.limits ? { limits: options.limits } : undefined;
  switch (format) {
    case 'wav':
      return decodeWav(bytes, limits);
    case 'aiff':
      return decodeAiff(bytes, limits);
    case 'au':
      return decodeAu(bytes, limits);
    case 'caf':
      return decodeCaf(bytes, limits);
    default:
      throw new UnsupportedFormatError(`"${format}" is not a built-in container.`);
  }
}

/** Resolves the format to use, sniffing when one was not supplied. */
function resolveFormat(bytes: Uint8Array, options?: DecodeOptions): AudioFormat {
  if (options?.format) return options.format;

  const result = sniff(bytes);
  if (result.kind === 'supported') return result.format;

  if (result.kind === 'unsupported') {
    throw new UnsupportedFormatError(
      `This looks like ${result.label}, which audiobox cannot decode. ` +
        'It reads WAV, AIFF/AIFF-C, FLAC, MP3, CAF and AU.',
    );
  }

  throw new UnsupportedFormatError(
    'Could not identify this audio format from its contents. ' +
      'If you know what it is, pass `{ format: "wav" }` to skip detection.',
  );
}

/**
 * Decodes any supported format into an {@link Audio}.
 *
 * ```ts
 * const audio = await decode(await file.arrayBuffer());
 * ```
 */
export async function decode(input: BinaryInput, options?: DecodeOptions): Promise<Audio> {
  throwIfAborted(options?.signal);

  const bytes = toBytes(input);
  const format = resolveFormat(bytes, options);

  let decoded: DecodedContainer;

  if (SYNC_FORMATS.has(format)) {
    decoded = decodeBuiltin(format, bytes, options);
  } else if (format === 'mp3') {
    const { decodeMp3 } = await import('./mp3/index.ts');
    decoded = decodeMp3(bytes, options);
  } else if (format === 'flac') {
    const { decodeFlac } = await import('./flac/index.ts');
    decoded = decodeFlac(bytes, options);
  } else {
    throw new UnsupportedFormatError(`No decoder registered for "${format}".`);
  }

  throwIfAborted(options?.signal);
  options?.onProgress?.(1);

  return new Audio(decoded.channelData, decoded.sampleRate, decoded.info);
}

/**
 * Synchronous decode, limited to the containers compiled into core.
 *
 * @throws {UnsupportedFormatError} for MP3 and FLAC — use {@link decode}, or
 * import `decodeMp3` / `decodeFlac` from their subpaths directly.
 */
export function decodeSync(input: BinaryInput, options?: DecodeOptions): Audio {
  const bytes = toBytes(input);
  const format = resolveFormat(bytes, options);

  if (!SYNC_FORMATS.has(format)) {
    throw new UnsupportedFormatError(
      `decodeSync cannot handle ${format} because its decoder is loaded on demand. ` +
        `Use \`await decode(...)\`, or import { decode${format === 'mp3' ? 'Mp3' : 'Flac'} } ` +
        `from "audiobox/${format}".`,
    );
  }

  const decoded = decodeBuiltin(format, bytes, options);
  return new Audio(decoded.channelData, decoded.sampleRate, decoded.info);
}

/** Options accepted by {@link encode}, per target format. */
export interface EncodeOptionsByFormat {
  wav: WavEncodeOptions;
  aiff: AiffEncodeOptions;
  au: ContainerEncodeOptions;
  caf: ContainerEncodeOptions;
  flac: import('./flac/encoder.ts').FlacEncodeOptions;
  raw: ContainerEncodeOptions;
}

/** Any format audiobox can write. */
export type EncodableFormat = keyof EncodeOptionsByFormat;

function encodeBuiltin(
  format: AudioFormat,
  audio: Audio,
  options?: ContainerEncodeOptions,
): Uint8Array {
  switch (format) {
    case 'wav':
      return encodeWav(audio.allChannels, audio.sampleRate, options);
    case 'aiff':
      return encodeAiff(audio.allChannels, audio.sampleRate, options);
    case 'au':
      return encodeAu(audio.allChannels, audio.sampleRate, options);
    case 'caf':
      return encodeCaf(audio.allChannels, audio.sampleRate, options);
    default:
      throw new UnsupportedFormatError(`"${format}" is not a built-in container.`);
  }
}

/**
 * Encodes an {@link Audio} to bytes.
 *
 * ```ts
 * const wav = await encode(audio, 'wav', { bitDepth: 16 });
 * const mp3 = await encode(audio, 'mp3', { bitrate: 192 });
 * ```
 */
export async function encode<F extends EncodableFormat>(
  audio: Audio,
  format: F,
  options?: EncodeOptionsByFormat[F],
): Promise<Uint8Array> {
  if (SYNC_FORMATS.has(format as AudioFormat)) {
    return encodeBuiltin(format as AudioFormat, audio, options as ContainerEncodeOptions);
  }
  if (format === 'flac') {
    const { encodeFlac } = await import('./flac/index.ts');
    return encodeFlac(audio, options as EncodeOptionsByFormat['flac']);
  }
  throw new UnsupportedFormatError(`No encoder registered for "${format}".`);
}

/**
 * Synchronous encode, limited to the containers compiled into core.
 *
 * @throws {UnsupportedFormatError} for MP3 and FLAC — use {@link encode}.
 */
export function encodeSync(
  audio: Audio,
  format: 'wav' | 'aiff' | 'au' | 'caf',
  options?: ContainerEncodeOptions,
): Uint8Array {
  if (!SYNC_FORMATS.has(format)) {
    throw new UnsupportedFormatError(
      `encodeSync cannot write ${format}; its encoder is loaded on demand. Use \`await encode(...)\`.`,
    );
  }
  return encodeBuiltin(format, audio, options);
}
