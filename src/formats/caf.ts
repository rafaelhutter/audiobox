/**
 * Apple CoreAudio Format (CAF) reader and writer.
 *
 * CAF exists because AIFF and WAV both cap out at 4 GB — their sizes are 32-bit.
 * CAF uses 64-bit chunk sizes, so it is what Logic, Final Cut, and macOS
 * recording tools produce for long or high-resolution material.
 *
 * Chunk sizes here are 64-bit *signed*, and -1 is a legal "size unknown, runs to
 * end of file" marker. That sentinel has to be handled explicitly, or it becomes
 * an enormous unsigned length and a bounds check that never fires.
 */

import { Reader } from '../io/reader.ts';
import { Writer } from '../io/writer.ts';
import { DecodeError, InvalidArgumentError } from '../errors.ts';
import { checkDecodeShape, resolveLimits, type Limits } from '../limits.ts';
import { bytesPerSample, decodeInterleaved, encodeInterleaved, bitDepthOf } from '../pcm/convert.ts';
import type { SampleFormat } from '../types.ts';
import type { DecodedContainer, ContainerEncodeOptions } from './types.ts';
import { resolveSampleFormat } from './types.ts';

/** `mFormatFlags` bits for the `lpcm` format. */
const FLAG_IS_FLOAT = 1 << 0;
const FLAG_IS_LITTLE_ENDIAN = 1 << 1;

interface CafDescription {
  sampleRate: number;
  formatId: string;
  formatFlags: number;
  bytesPerPacket: number;
  framesPerPacket: number;
  channels: number;
  bitsPerChannel: number;
}

function sampleFormatFor(desc: CafDescription): { format: SampleFormat; littleEndian: boolean } {
  const littleEndian = (desc.formatFlags & FLAG_IS_LITTLE_ENDIAN) !== 0;

  switch (desc.formatId) {
    case 'lpcm': {
      if (desc.formatFlags & FLAG_IS_FLOAT) {
        if (desc.bitsPerChannel === 32) return { format: 'f32', littleEndian };
        if (desc.bitsPerChannel === 64) return { format: 'f64', littleEndian };
        throw new DecodeError(`Unsupported CAF float depth: ${desc.bitsPerChannel}.`);
      }
      switch (desc.bitsPerChannel) {
        case 8:
          return { format: 's8', littleEndian };
        case 16:
          return { format: 's16', littleEndian };
        case 24:
          return { format: 's24', littleEndian };
        case 32:
          return { format: 's32', littleEndian };
        default:
          throw new DecodeError(`Unsupported CAF bit depth: ${desc.bitsPerChannel}.`);
      }
    }
    case 'alaw':
      return { format: 'alaw', littleEndian: false };
    case 'ulaw':
      return { format: 'ulaw', littleEndian: false };
    default:
      throw new DecodeError(
        `Unsupported CAF format "${desc.formatId}". audiobox reads lpcm, alaw and ulaw ` +
          '(not AAC or Apple Lossless).',
      );
  }
}

export interface CafDecodeOptions {
  limits?: Partial<Limits>;
}

/** Decodes an Apple CoreAudio Format file. */
export function decodeCaf(input: Uint8Array, options?: CafDecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const r = new Reader(input);

  if (r.fourCC() !== 'caff') throw new DecodeError('Not a CAF file: missing "caff" magic.');
  r.u16(false); // file version
  r.u16(false); // file flags

  let desc: CafDescription | null = null;
  let data: Uint8Array | null = null;

  while (r.remaining >= 12) {
    const id = r.fourCC();
    // 64-bit signed size; -1 means "to end of file".
    const high = r.i32(false);
    const low = r.u32(false);
    const isSentinel = high === -1 && low === 0xffffffff;
    const size = isSentinel ? r.remaining : high * 0x100000000 + low;

    if (!isSentinel && (size < 0 || size > r.remaining)) {
      throw new DecodeError(
        `CAF chunk "${id}" declares ${size} bytes but only ${r.remaining} remain.`,
        { offset: r.offset },
      );
    }

    switch (id) {
      case 'desc': {
        const sub = r.subReader(size);
        desc = {
          sampleRate: sub.f64(false),
          formatId: sub.fourCC(),
          formatFlags: sub.u32(false),
          bytesPerPacket: sub.u32(false),
          framesPerPacket: sub.u32(false),
          channels: sub.u32(false),
          bitsPerChannel: sub.u32(false),
        };
        break;
      }
      case 'data': {
        const sub = r.subReader(size);
        sub.u32(false); // edit count
        data = sub.bytesView(sub.remaining);
        break;
      }
      default:
        r.skip(size);
        break;
    }
  }

  if (!desc) throw new DecodeError('CAF file has no "desc" chunk.');
  if (!data) throw new DecodeError('CAF file has no "data" chunk.');

  const { format, littleEndian } = sampleFormatFor(desc);
  const width = bytesPerSample(format);
  const frames = Math.floor(data.byteLength / (width * desc.channels));
  checkDecodeShape(frames, desc.channels, desc.sampleRate, limits);

  return {
    channelData: decodeInterleaved(data, format, littleEndian, desc.channels, frames),
    sampleRate: desc.sampleRate,
    info: {
      format: 'caf',
      sampleFormat: format,
      bitDepth: bitDepthOf(format),
      lossy: format === 'alaw' || format === 'ulaw',
      metadata: {},
      details: { formatId: desc.formatId, formatFlags: desc.formatFlags },
    },
  };
}

/** Encodes planar float channels as a CAF file. */
export function encodeCaf(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options?: ContainerEncodeOptions,
): Uint8Array {
  if (channelData.length === 0) throw new InvalidArgumentError('At least one channel is required.');

  let sampleFormat = resolveSampleFormat(options);
  if (sampleFormat === 'u8') sampleFormat = 's8'; // CAF integer PCM is signed

  let formatId = 'lpcm';
  let flags = 0;
  switch (sampleFormat) {
    case 'f32':
    case 'f64':
      flags |= FLAG_IS_FLOAT;
      break;
    case 'alaw':
      formatId = 'alaw';
      break;
    case 'ulaw':
      formatId = 'ulaw';
      break;
    case 's8':
    case 's16':
    case 's24':
    case 's32':
      break;
    default:
      throw new InvalidArgumentError(`audiobox cannot write ${sampleFormat} to CAF.`);
  }

  // Little-endian is what Apple's own tools write for lpcm.
  const littleEndian = formatId === 'lpcm';
  if (littleEndian) flags |= FLAG_IS_LITTLE_ENDIAN;

  const channels = channelData.length;
  const bits = bitDepthOf(sampleFormat);
  const bytesPerFrame = bytesPerSample(sampleFormat) * channels;
  const audio = encodeInterleaved(channelData, sampleFormat, littleEndian, options?.dither);

  const w = new Writer(audio.byteLength + 128);
  w.ascii('caff');
  w.u16(1, false); // version
  w.u16(0, false); // flags

  // --- desc ---
  w.ascii('desc');
  w.u64(32, false);
  w.f64(sampleRate, false);
  w.ascii(formatId, 4);
  w.u32(flags, false);
  w.u32(bytesPerFrame, false); // bytes per packet
  w.u32(1, false); // frames per packet
  w.u32(channels, false);
  w.u32(bits, false);

  // --- data ---
  w.ascii('data');
  w.u64(audio.byteLength + 4, false);
  w.u32(0, false); // edit count
  w.write(audio);

  return w.finish();
}
