/**
 * AIFF and AIFF-C reader and writer.
 *
 * Apple's answer to WAV, and structurally its mirror image: the same
 * chunk-plus-size layout, but big-endian throughout, with the sample rate stored
 * as an 80-bit extended float — a format essentially nothing else in computing
 * still uses.
 *
 * AIFF-C adds a compression identifier. The one that catches people out is
 * `sowt` ("twos" backwards), which means *little-endian* PCM inside a big-endian
 * container. It is what macOS writes by default, so any reader that assumes
 * big-endian samples plays real-world Apple files as loud static.
 */

import { Reader } from '../io/reader.ts';
import { encodeUtf8 } from '../io/utf8.ts';
import { Writer } from '../io/writer.ts';
import { DecodeError, InvalidArgumentError } from '../errors.ts';
import { checkDecodeShape, resolveLimits, type Limits } from '../limits.ts';
import { bytesPerSample, decodeInterleaved, encodeInterleaved, bitDepthOf } from '../pcm/convert.ts';
import type { AudioMetadata, SampleFormat } from '../types.ts';
import type { DecodedContainer, ContainerEncodeOptions } from './types.ts';
import { resolveSampleFormat } from './types.ts';

interface CommChunk {
  channels: number;
  frames: number;
  bitsPerSample: number;
  sampleRate: number;
  compression: string;
}

/** Maps an AIFF-C compression type onto a sample format and byte order. */
function formatForCompression(
  compression: string,
  bits: number,
): { format: SampleFormat; littleEndian: boolean } {
  switch (compression) {
    case 'NONE':
    case '':
      return { format: pcmFormat(bits, true), littleEndian: false };
    case 'sowt':
      // Little-endian PCM. macOS writes this constantly.
      return { format: pcmFormat(bits, true), littleEndian: true };
    case 'fl32':
    case 'FL32':
      return { format: 'f32', littleEndian: false };
    case 'fl64':
    case 'FL64':
      return { format: 'f64', littleEndian: false };
    case 'alaw':
    case 'ALAW':
      return { format: 'alaw', littleEndian: false };
    case 'ulaw':
    case 'ULAW':
      return { format: 'ulaw', littleEndian: false };
    default:
      throw new DecodeError(
        `Unsupported AIFF-C compression "${compression}". ` +
          'audiobox reads NONE, sowt, fl32, fl64, alaw and ulaw.',
      );
  }
}

/** AIFF integer PCM is signed at every depth, unlike WAV's unsigned 8-bit. */
function pcmFormat(bits: number, signed: boolean): SampleFormat {
  switch (bits) {
    case 8:
      return signed ? 's8' : 'u8';
    case 16:
      return 's16';
    case 24:
      return 's24';
    case 32:
      return 's32';
    default:
      throw new DecodeError(`Unsupported AIFF bit depth: ${bits}.`);
  }
}

/** Reads a Pascal string (length byte, then bytes, padded to even). */
function pascalString(r: Reader): string {
  const length = r.u8();
  const text = r.ascii(length);
  if ((length + 1) & 1) r.skip(1);
  return text;
}

export interface AiffDecodeOptions {
  limits?: Partial<Limits>;
}

/** Decodes an AIFF or AIFF-C file. */
export function decodeAiff(input: Uint8Array, options?: AiffDecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const r = new Reader(input);

  if (r.fourCC() !== 'FORM') throw new DecodeError('Not an AIFF file: missing "FORM" header.');
  r.u32(false); // form size — recomputed from actual bytes

  const formType = r.fourCC();
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new DecodeError(`Not an AIFF file: form type is "${formType}".`);
  }

  let comm: CommChunk | null = null;
  let ssnd: Uint8Array | null = null;
  const metadata: AudioMetadata = {};

  while (r.remaining >= 8) {
    const id = r.fourCC();
    const declared = r.u32(false);

    if (declared > r.remaining) {
      if (id === 'SSND') {
        // Truncated audio is recoverable; keep what is there.
        ssnd = r.bytesView(r.remaining);
        break;
      }
      throw new DecodeError(
        `AIFF chunk "${id}" declares ${declared} bytes but only ${r.remaining} remain.`,
        { offset: r.offset },
      );
    }

    switch (id) {
      case 'COMM': {
        const sub = r.subReader(declared);
        comm = {
          channels: sub.u16(false),
          frames: sub.u32(false),
          bitsPerSample: sub.u16(false),
          sampleRate: sub.f80(),
          compression: formType === 'AIFC' && sub.remaining >= 4 ? sub.fourCC() : 'NONE',
        };
        break;
      }
      case 'SSND': {
        const sub = r.subReader(declared);
        const offset = sub.u32(false);
        sub.u32(false); // block size, essentially always 0
        if (offset > sub.remaining) {
          throw new DecodeError(`SSND offset ${offset} exceeds the chunk payload.`);
        }
        sub.skip(offset);
        ssnd = sub.bytesView(sub.remaining);
        break;
      }
      case 'NAME':
        metadata.title = r.subReader(declared).ascii(declared);
        break;
      case 'AUTH':
        metadata.artist = r.subReader(declared).ascii(declared);
        break;
      case 'ANNO':
        metadata.comment = r.subReader(declared).ascii(declared);
        break;
      case 'FVER':
        r.skip(declared);
        break;
      default:
        r.skip(declared);
        break;
    }

    r.align2();
  }

  if (!comm) throw new DecodeError('AIFF file has no "COMM" chunk.');
  if (!ssnd) throw new DecodeError('AIFF file has no "SSND" chunk.');

  const { format, littleEndian } = formatForCompression(comm.compression, comm.bitsPerSample);
  const width = bytesPerSample(format);
  const available = Math.floor(ssnd.byteLength / (width * comm.channels));
  const frames = Math.min(comm.frames, available);

  checkDecodeShape(frames, comm.channels, comm.sampleRate, limits);

  return {
    channelData: decodeInterleaved(ssnd, format, littleEndian, comm.channels, frames),
    sampleRate: comm.sampleRate,
    info: {
      format: 'aiff',
      sampleFormat: format,
      bitDepth: bitDepthOf(format),
      lossy: format === 'alaw' || format === 'ulaw',
      metadata,
      details: { compression: comm.compression, aifc: formType === 'AIFC' },
    },
  };
}

export interface AiffEncodeOptions extends ContainerEncodeOptions {
  /**
   * Write AIFF-C instead of plain AIFF. Forced on for float and companded
   * formats, which classic AIFF cannot express.
   */
  aifc?: boolean;
}

function compressionFor(format: SampleFormat): { id: string; name: string } {
  switch (format) {
    case 's8':
    case 's16':
    case 's24':
    case 's32':
      return { id: 'NONE', name: 'not compressed' };
    case 'f32':
      return { id: 'fl32', name: '32-bit floating point' };
    case 'f64':
      return { id: 'fl64', name: '64-bit floating point' };
    case 'alaw':
      return { id: 'alaw', name: 'ALaw 2:1' };
    case 'ulaw':
      return { id: 'ulaw', name: 'µLaw 2:1' };
    default:
      throw new InvalidArgumentError(
        `audiobox cannot write ${format} to AIFF. Supported: s8, s16, s24, s32, f32, f64, alaw, ulaw.`,
      );
  }
}

/** Encodes planar float channels as AIFF or AIFF-C. */
export function encodeAiff(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options?: AiffEncodeOptions,
): Uint8Array {
  if (channelData.length === 0) throw new InvalidArgumentError('At least one channel is required.');

  let sampleFormat = resolveSampleFormat(options);
  // AIFF has no unsigned 8-bit form; silently promoting to signed is the only
  // correct reading of "8-bit AIFF".
  if (sampleFormat === 'u8') sampleFormat = 's8';

  const compression = compressionFor(sampleFormat);
  const aifc = options?.aifc ?? compression.id !== 'NONE';
  const channels = channelData.length;
  const frames = channelData[0]!.length;

  const audio = encodeInterleaved(channelData, sampleFormat, false, options?.dither);

  const w = new Writer(audio.byteLength + 512);
  w.ascii('FORM');
  const formSizeAt = w.reserve(4);
  const formStart = w.length;
  w.ascii(aifc ? 'AIFC' : 'AIFF');

  if (aifc) {
    w.ascii('FVER');
    w.u32(4, false);
    w.u32(0xa2805140, false); // AIFC version 1 timestamp, fixed by the spec
  }

  // --- COMM ---
  w.ascii('COMM');
  const commSizeAt = w.reserve(4);
  const commStart = w.length;
  w.u16(channels, false);
  w.u32(frames, false);
  w.u16(bitDepthOf(sampleFormat), false);
  w.f80(sampleRate);
  if (aifc) {
    w.ascii(compression.id, 4);
    // Compression name as a Pascal string, padded to even length.
    w.u8(compression.name.length);
    w.ascii(compression.name);
    if ((compression.name.length + 1) & 1) w.u8(0);
  }
  w.patchU32(commSizeAt, w.length - commStart, false);
  w.align2();

  writeTextChunk(w, 'NAME', options?.metadata?.title);
  writeTextChunk(w, 'AUTH', options?.metadata?.artist);
  writeTextChunk(w, 'ANNO', options?.metadata?.comment);

  // --- SSND ---
  w.ascii('SSND');
  w.u32(audio.byteLength + 8, false);
  w.u32(0, false); // offset
  w.u32(0, false); // block size
  w.write(audio);
  w.align2();

  w.patchU32(formSizeAt, w.length - formStart, false);
  return w.finish();
}

function writeTextChunk(w: Writer, id: string, value: string | undefined): void {
  if (!value) return;
  const bytes = encodeUtf8(value);
  w.ascii(id, 4);
  w.u32(bytes.byteLength, false);
  w.write(bytes);
  w.align2();
}

/** Exposed for the AIFF tests; not part of the public surface. */
export const __internal = { pascalString };
