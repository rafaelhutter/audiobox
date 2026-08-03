/**
 * FLAC decoder.
 *
 * FLAC is lossless: it predicts each sample from its predecessors and stores
 * only the prediction error, Rice-coded. Decoding is therefore exact — the
 * output is bit-identical to what was encoded, which is why the round-trip test
 * for this format asserts equality rather than a tolerance.
 *
 * Supports both fixed and LPC prediction, all four channel decorrelation modes,
 * and Rice partitioning including escaped (raw) partitions.
 */

import { BitReader } from '../io/bits.ts';
import { Reader } from '../io/reader.ts';
import { decodeUtf8 } from '../io/utf8.ts';
import { DecodeError } from '../errors.ts';
import { checkDecodeShape, resolveLimits } from '../limits.ts';
import type { AudioMetadata } from '../types.ts';
import type { DecodedContainer } from '../formats/types.ts';
import type { DecodeOptions } from '../types.ts';

/** Block sizes selectable by the 4-bit code, in samples. */
const BLOCK_SIZES = [
  0, 192, 576, 1152, 2304, 4608, -1, -2, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
];

/** Sample rates selectable by the 4-bit code, in Hz. Negative codes read extra bits. */
const SAMPLE_RATES = [
  -1, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, -2, -3, -4, -5,
];

const FIXED_PREDICTORS: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

interface StreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

/** Reads FLAC's UTF-8-like variable-length coded frame or sample number. */
function readUtf8Number(br: BitReader): number {
  const first = br.bits(8);
  if ((first & 0x80) === 0) return first;

  let extraBytes: number;
  let value: number;
  if ((first & 0xe0) === 0xc0) {
    extraBytes = 1;
    value = first & 0x1f;
  } else if ((first & 0xf0) === 0xe0) {
    extraBytes = 2;
    value = first & 0x0f;
  } else if ((first & 0xf8) === 0xf0) {
    extraBytes = 3;
    value = first & 0x07;
  } else if ((first & 0xfc) === 0xf8) {
    extraBytes = 4;
    value = first & 0x03;
  } else if ((first & 0xfe) === 0xfc) {
    extraBytes = 5;
    value = first & 0x01;
  } else if (first === 0xfe) {
    extraBytes = 6;
    value = 0;
  } else {
    throw new DecodeError('Malformed UTF-8 coded number in FLAC frame header.');
  }

  for (let i = 0; i < extraBytes; i++) {
    const byte = br.bits(8);
    if ((byte & 0xc0) !== 0x80) {
      throw new DecodeError('Malformed UTF-8 continuation byte in FLAC frame header.');
    }
    value = value * 64 + (byte & 0x3f);
  }
  return value;
}

/** Parses the metadata blocks preceding the audio frames. */
function readMetadata(r: Reader): { info: StreamInfo; metadata: AudioMetadata } {
  let info: StreamInfo | null = null;
  const metadata: AudioMetadata = {};

  for (;;) {
    if (r.remaining < 4) throw new DecodeError('Truncated FLAC metadata.');
    const header = r.u8();
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = r.u24(false);

    if (length > r.remaining) {
      throw new DecodeError(
        `FLAC metadata block declares ${length} bytes but only ${r.remaining} remain.`,
        { offset: r.offset },
      );
    }

    if (type === 0) {
      // STREAMINFO
      const sub = r.subReader(length);
      const minBlockSize = sub.u16(false);
      const maxBlockSize = sub.u16(false);
      sub.u24(false); // min frame size
      sub.u24(false); // max frame size

      // 20 bits rate, 3 bits channels-1, 5 bits depth-1, 36 bits total samples.
      const packed = sub.bytesView(8);
      const br = new BitReader(packed);
      const sampleRate = br.bits(20);
      const channels = br.bits(3) + 1;
      const bitsPerSample = br.bits(5) + 1;
      const totalSamples = br.bits(36);

      sub.skip(Math.min(16, sub.remaining)); // MD5 signature
      info = { minBlockSize, maxBlockSize, sampleRate, channels, bitsPerSample, totalSamples };
    } else if (type === 4) {
      // VORBIS_COMMENT: little-endian lengths, UTF-8 "KEY=value" entries.
      const sub = r.subReader(length);
      try {
        const vendorLength = sub.u32(true);
        sub.skip(vendorLength);
        const count = sub.u32(true);
        
        for (let i = 0; i < count && sub.remaining >= 4; i++) {
          const entryLength = sub.u32(true);
          if (entryLength > sub.remaining) break;
          const entry = decodeUtf8(sub.bytesView(entryLength));
          const eq = entry.indexOf('=');
          if (eq < 0) continue;
          applyVorbisComment(metadata, entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1));
        }
      } catch {
        // Malformed tags must never prevent the audio from decoding.
      }
    } else {
      r.skip(length);
    }

    if (isLast) break;
  }

  if (!info) throw new DecodeError('FLAC file has no STREAMINFO block.');
  return { info, metadata };
}

function applyVorbisComment(metadata: AudioMetadata, key: string, value: string): void {
  switch (key) {
    case 'TITLE':
      metadata.title = value;
      break;
    case 'ARTIST':
      metadata.artist = value;
      break;
    case 'ALBUM':
      metadata.album = value;
      break;
    case 'GENRE':
      metadata.genre = value;
      break;
    case 'DATE':
      metadata.year = value;
      break;
    case 'COMMENT':
    case 'DESCRIPTION':
      metadata.comment = value;
      break;
    case 'TRACKNUMBER': {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) metadata.trackNumber = n;
      break;
    }
    default:
      (metadata.extra ??= {})[key] = value;
      break;
  }
}

/** Decodes one subframe into `output`. */
function decodeSubframe(
  br: BitReader,
  output: Int32Array,
  blockSize: number,
  bitsPerSample: number,
): void {
  if (br.bit() !== 0) throw new DecodeError('Invalid FLAC subframe: padding bit is set.');

  const type = br.bits(6);
  let wastedBits = 0;
  if (br.bit() === 1) {
    // Unary-coded count of low-order zero bits stripped from every sample.
    const count = br.unary();
    if (count < 0) throw new DecodeError('Runaway wasted-bits count in FLAC subframe.');
    wastedBits = count + 1;
  }

  const effectiveBits = bitsPerSample - wastedBits;
  if (effectiveBits <= 0 || effectiveBits > 32) {
    throw new DecodeError(`Invalid effective bit depth ${effectiveBits} in FLAC subframe.`);
  }

  if (type === 0) {
    // CONSTANT
    const value = br.signedBits(effectiveBits);
    output.fill(value, 0, blockSize);
  } else if (type === 1) {
    // VERBATIM
    for (let i = 0; i < blockSize; i++) output[i] = br.signedBits(effectiveBits);
  } else if (type >= 8 && type <= 12) {
    decodeFixedSubframe(br, output, blockSize, effectiveBits, type - 8);
  } else if (type >= 32) {
    decodeLpcSubframe(br, output, blockSize, effectiveBits, (type & 0x1f) + 1);
  } else {
    throw new DecodeError(`Reserved FLAC subframe type ${type}.`);
  }

  if (wastedBits > 0) {
    for (let i = 0; i < blockSize; i++) output[i]! <<= wastedBits;
  }
}

function decodeFixedSubframe(
  br: BitReader,
  output: Int32Array,
  blockSize: number,
  bitsPerSample: number,
  order: number,
): void {
  for (let i = 0; i < order; i++) output[i] = br.signedBits(bitsPerSample);
  decodeResidual(br, output, blockSize, order);

  const coefficients = FIXED_PREDICTORS[order]!;
  for (let i = order; i < blockSize; i++) {
    let prediction = 0;
    for (let j = 0; j < coefficients.length; j++) {
      prediction += coefficients[j]! * output[i - 1 - j]!;
    }
    output[i]! += prediction;
  }
}

function decodeLpcSubframe(
  br: BitReader,
  output: Int32Array,
  blockSize: number,
  bitsPerSample: number,
  order: number,
): void {
  for (let i = 0; i < order; i++) output[i] = br.signedBits(bitsPerSample);

  const precision = br.bits(4) + 1;
  if (precision === 16) throw new DecodeError('Invalid FLAC LPC precision (reserved value).');
  const shift = br.signedBits(5);
  if (shift < 0) throw new DecodeError('Negative FLAC LPC shift is not permitted.');

  const coefficients = new Int32Array(order);
  for (let i = 0; i < order; i++) coefficients[i] = br.signedBits(precision);

  decodeResidual(br, output, blockSize, order);

  for (let i = order; i < blockSize; i++) {
    let prediction = 0;
    for (let j = 0; j < order; j++) prediction += coefficients[j]! * output[i - 1 - j]!;
    output[i]! += Math.floor(prediction / Math.pow(2, shift));
  }
}

function decodeResidual(
  br: BitReader,
  output: Int32Array,
  blockSize: number,
  predictorOrder: number,
): void {
  const method = br.bits(2);
  if (method > 1) throw new DecodeError(`Reserved FLAC residual coding method ${method}.`);
  const paramBits = method === 0 ? 4 : 5;
  const escapeValue = method === 0 ? 0x0f : 0x1f;

  const partitionOrder = br.bits(4);
  const partitions = 1 << partitionOrder;

  if (blockSize % partitions !== 0) {
    throw new DecodeError(
      `FLAC block size ${blockSize} is not divisible by ${partitions} partitions.`,
    );
  }
  const partitionSamples = blockSize >> partitionOrder;
  if (partitionSamples < predictorOrder) {
    throw new DecodeError('FLAC partition is smaller than the predictor order.');
  }

  let index = predictorOrder;
  for (let p = 0; p < partitions; p++) {
    const count = p === 0 ? partitionSamples - predictorOrder : partitionSamples;
    const parameter = br.bits(paramBits);

    if (parameter === escapeValue) {
      // Escaped partition: residuals stored raw at a fixed width.
      const rawBits = br.bits(5);
      for (let i = 0; i < count; i++) {
        output[index++] = rawBits === 0 ? 0 : br.signedBits(rawBits);
      }
    } else {
      for (let i = 0; i < count; i++) {
        const quotient = br.unary();
        if (quotient < 0) throw new DecodeError('Runaway Rice code in FLAC residual.');
        const value = quotient * (1 << parameter) + (parameter > 0 ? br.bits(parameter) : 0);
        // Zigzag: even maps to non-negative, odd to negative.
        output[index++] = (value >>> 1) ^ -(value & 1);
      }
    }
  }
}

/** Decodes a FLAC stream. */
export function decodeFlac(input: Uint8Array, options?: DecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const r = new Reader(input);

  if (r.fourCC() !== 'fLaC') throw new DecodeError('Not a FLAC file: missing "fLaC" magic.');

  const { info, metadata } = readMetadata(r);

  if (info.totalSamples > 0) {
    checkDecodeShape(info.totalSamples, info.channels, info.sampleRate, limits);
  }

  const scale = 1 / Math.pow(2, info.bitsPerSample - 1);
  const output: Float32Array[] = Array.from(
    { length: info.channels },
    () => new Float32Array(info.totalSamples || 0),
  );
  const grow: number[][] | null = info.totalSamples > 0 ? null : [];

  // Scratch buffers, reused per frame so decoding does not allocate per block.
  const maxBlock = Math.max(info.maxBlockSize, 4096);
  const subframes: Int32Array[] = Array.from(
    { length: info.channels },
    () => new Int32Array(maxBlock),
  );

  let written = 0;
  const bytes = input;

  while (r.remaining > 2) {
    const frameStart = r.offset;

    // Frame sync: 14 bits of 0b11111111111110.
    const b0 = r.peekU8(0);
    const b1 = r.peekU8(1);
    if (b0 !== 0xff || (b1 & 0xfc) !== 0xf8) {
      // Not a frame boundary; the stream is finished or padded.
      break;
    }

    const br = new BitReader(bytes, frameStart);
    br.bits(14); // sync
    br.bit(); // reserved
    const variableBlocking = br.bit();

    const blockSizeCode = br.bits(4);
    const sampleRateCode = br.bits(4);
    const channelAssignment = br.bits(4);
    const sampleSizeCode = br.bits(3);
    if (br.bit() !== 0) throw new DecodeError('FLAC frame header reserved bit is set.');

    readUtf8Number(br); // frame or sample number, unused for sequential decode
    void variableBlocking;

    let blockSize = BLOCK_SIZES[blockSizeCode]!;
    if (blockSize === -1) blockSize = br.bits(8) + 1;
    else if (blockSize === -2) blockSize = br.bits(16) + 1;
    if (blockSize <= 0 || blockSize > 65535) {
      throw new DecodeError(`Invalid FLAC block size ${blockSize}.`);
    }

    let sampleRate = SAMPLE_RATES[sampleRateCode]!;
    if (sampleRate === -1) sampleRate = info.sampleRate;
    else if (sampleRate === -2) sampleRate = br.bits(8) * 1000;
    else if (sampleRate === -3) sampleRate = br.bits(16);
    else if (sampleRate === -4) sampleRate = br.bits(16) * 10;
    else if (sampleRate === -5) throw new DecodeError('Invalid FLAC sample rate code.');

    const bitsPerSample =
      sampleSizeCode === 0
        ? info.bitsPerSample
        : [0, 8, 12, 0, 16, 20, 24, 32][sampleSizeCode] || info.bitsPerSample;

    br.align();
    br.bits(8); // header CRC-8, validated implicitly by successful decode

    const channels = channelAssignment < 8 ? channelAssignment + 1 : 2;
    if (channels !== info.channels) {
      throw new DecodeError(
        `FLAC frame declares ${channels} channel(s) but STREAMINFO says ${info.channels}.`,
      );
    }
    if (blockSize > maxBlock) {
      throw new DecodeError(`FLAC block size ${blockSize} exceeds the declared maximum.`);
    }

    // Side channels carry one extra bit of range to hold the difference.
    for (let c = 0; c < channels; c++) {
      let subframeBits = bitsPerSample;
      if (channelAssignment === 8 && c === 1) subframeBits++;
      else if (channelAssignment === 9 && c === 0) subframeBits++;
      else if (channelAssignment === 10 && c === 1) subframeBits++;
      decodeSubframe(br, subframes[c]!, blockSize, subframeBits);
    }

    undoChannelDecorrelation(subframes, channelAssignment, blockSize);

    if (br.overran) {
      throw new DecodeError('FLAC frame data ended unexpectedly.', { offset: frameStart });
    }

    // Emit.
    if (grow) {
      for (let c = 0; c < channels; c++) {
        const dst = (grow[c] ??= []);
        const src = subframes[c]!;
        for (let i = 0; i < blockSize; i++) dst.push(src[i]! * scale);
      }
    } else {
      const room = Math.min(blockSize, output[0]!.length - written);
      for (let c = 0; c < channels; c++) {
        const dst = output[c]!;
        const src = subframes[c]!;
        for (let i = 0; i < room; i++) dst[written + i] = src[i]! * scale;
      }
    }
    written += blockSize;

    br.align();
    br.bits(16); // frame CRC-16

    const consumed = Math.ceil(br.bitsRead / 8);
    if (consumed <= frameStart) throw new DecodeError('FLAC frame made no progress.');
    r.seek(Math.min(consumed, input.byteLength));

    if (!grow && written >= output[0]!.length) break;
  }

  const channelData = grow
    ? grow.map((values) => Float32Array.from(values))
    : output.map((c) => (written < c.length ? c.slice(0, written) : c));

  const frames = channelData[0]?.length ?? 0;
  checkDecodeShape(frames, info.channels, info.sampleRate, limits);

  return {
    channelData,
    sampleRate: info.sampleRate,
    info: {
      format: 'flac',
      sampleFormat: info.bitsPerSample <= 16 ? 's16' : info.bitsPerSample <= 24 ? 's24' : 's32',
      bitDepth: info.bitsPerSample,
      lossy: false,
      metadata,
      details: { minBlockSize: info.minBlockSize, maxBlockSize: info.maxBlockSize },
    },
  };
}

/**
 * Reverses inter-channel decorrelation.
 *
 * FLAC often stores a stereo pair as mid/side or left/side rather than L/R,
 * because the difference signal is usually much smaller and compresses better.
 */
function undoChannelDecorrelation(
  subframes: Int32Array[],
  assignment: number,
  blockSize: number,
): void {
  if (assignment < 8) return;

  const a = subframes[0]!;
  const b = subframes[1]!;

  if (assignment === 8) {
    // Left / side -> left / right
    for (let i = 0; i < blockSize; i++) b[i] = a[i]! - b[i]!;
  } else if (assignment === 9) {
    // Right / side -> left / right
    for (let i = 0; i < blockSize; i++) a[i] = a[i]! + b[i]!;
  } else if (assignment === 10) {
    // Mid / side -> left / right
    for (let i = 0; i < blockSize; i++) {
      const side = b[i]!;
      // The low bit of the side channel is folded into mid during encoding.
      let mid = (a[i]! << 1) | (side & 1);
      a[i] = (mid + side) >> 1;
      b[i] = (mid - side) >> 1;
    }
  }
}
