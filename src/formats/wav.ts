/**
 * RIFF/WAVE reader and writer.
 *
 * Covers plain RIFF, RF64/BW64 (the 64-bit extension used for files above 4 GB),
 * `WAVE_FORMAT_EXTENSIBLE`, IEEE float, A-law, µ-law, and IMA ADPCM.
 *
 * WAV is a chunked format, and the chunk sizes are attacker-controlled. Every
 * size is validated against the bytes actually present before it is used, and
 * unrecognised chunks are skipped rather than trusted — a decoder that seeks
 * blindly to a declared offset is the classic way these parsers get exploited.
 */

import { Reader } from '../io/reader.ts';
import { encodeUtf8 } from '../io/utf8.ts';
import { Writer } from '../io/writer.ts';
import { DecodeError, InvalidArgumentError } from '../errors.ts';
import { checkDecodeShape, resolveLimits, type Limits } from '../limits.ts';
import { bytesPerSample, decodeInterleaved, encodeInterleaved, bitDepthOf } from '../pcm/convert.ts';
import { decodeImaAdpcm, adpcmSamplesPerBlock } from '../pcm/adpcm.ts';
import type { AudioMetadata, SampleFormat } from '../types.ts';
import type { DecodedContainer, ContainerEncodeOptions } from './types.ts';
import { resolveSampleFormat } from './types.ts';

/** Microsoft `wFormatTag` values. */
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_ALAW = 0x0006;
const WAVE_FORMAT_MULAW = 0x0007;
const WAVE_FORMAT_IMA_ADPCM = 0x0011;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** RIFF INFO tags mapped onto our metadata fields. */
const INFO_TAGS: Record<string, keyof AudioMetadata> = Object.assign(Object.create(null), {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  ICMT: 'comment',
  IGNR: 'genre',
  ICRD: 'year',
  ITRK: 'trackNumber',
  ISFT: 'encoder',
});

const METADATA_TO_INFO: ReadonlyArray<[keyof AudioMetadata, string]> = [
  ['title', 'INAM'],
  ['artist', 'IART'],
  ['album', 'IPRD'],
  ['comment', 'ICMT'],
  ['genre', 'IGNR'],
  ['year', 'ICRD'],
  ['trackNumber', 'ITRK'],
  ['encoder', 'ISFT'],
];

interface FmtChunk {
  formatTag: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** Valid bits from the EXTENSIBLE extension, when present. */
  validBits?: number;
  channelMask?: number;
}

/** Maps a `fmt ` chunk onto the sample format the PCM layer understands. */
function sampleFormatFor(fmt: FmtChunk): SampleFormat {
  switch (fmt.formatTag) {
    case WAVE_FORMAT_PCM:
      switch (fmt.bitsPerSample) {
        case 8:
          return 'u8'; // 8-bit WAV is unsigned; 8-bit AIFF is signed.
        case 16:
          return 's16';
        case 24:
          return 's24';
        case 32:
          return 's32';
        default:
          throw new DecodeError(`Unsupported PCM bit depth: ${fmt.bitsPerSample}.`);
      }
    case WAVE_FORMAT_IEEE_FLOAT:
      if (fmt.bitsPerSample === 32) return 'f32';
      if (fmt.bitsPerSample === 64) return 'f64';
      throw new DecodeError(`Unsupported float bit depth: ${fmt.bitsPerSample}.`);
    case WAVE_FORMAT_ALAW:
      return 'alaw';
    case WAVE_FORMAT_MULAW:
      return 'ulaw';
    case WAVE_FORMAT_IMA_ADPCM:
      return 'ima-adpcm';
    default:
      throw new DecodeError(
        `Unsupported WAV format tag 0x${fmt.formatTag.toString(16).padStart(4, '0')}. ` +
          'audiobox reads PCM, IEEE float, A-law, µ-law and IMA ADPCM.',
      );
  }
}

function parseFmt(r: Reader, size: number): FmtChunk {
  if (size < 16) throw new DecodeError(`fmt chunk is ${size} bytes; at least 16 required.`);

  const fmt: FmtChunk = {
    formatTag: r.u16(true),
    channels: r.u16(true),
    sampleRate: r.u32(true),
    blockAlign: 0,
    bitsPerSample: 0,
  };
  r.u32(true); // byte rate — derivable, and routinely wrong in the wild, so ignored
  fmt.blockAlign = r.u16(true);
  fmt.bitsPerSample = r.u16(true);

  let consumed = 16;

  if (size >= 18) {
    const extSize = r.u16(true);
    consumed += 2;

    if (fmt.formatTag === WAVE_FORMAT_EXTENSIBLE) {
      if (extSize < 22) {
        throw new DecodeError(`EXTENSIBLE fmt extension is ${extSize} bytes; 22 required.`);
      }
      fmt.validBits = r.u16(true);
      fmt.channelMask = r.u32(true);
      // The real format tag is the first two bytes of the SubFormat GUID.
      fmt.formatTag = r.u16(true);
      r.skip(14); // remainder of the GUID
      consumed += 22;
    }
  }

  // Skip any trailing extension bytes so the caller lands on the next chunk.
  if (size > consumed) r.skip(size - consumed);

  return fmt;
}

/** Reads a LIST/INFO chunk into metadata. */
function parseListInfo(r: Reader, size: number, metadata: AudioMetadata): void {
  const sub = r.subReader(size);
  if (sub.remaining < 4) return;
  if (sub.fourCC() !== 'INFO') return;

  while (sub.remaining >= 8) {
    const id = sub.fourCC();
    const len = sub.u32(true);
    if (len > sub.remaining) return; // truncated tag list; keep what was parsed
    const raw = sub.ascii(len).replace(/\0+$/, '');
    sub.align2();

    const field = INFO_TAGS[id];
    if (field === 'trackNumber') {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) metadata.trackNumber = n;
    } else if (field) {
      (metadata as Record<string, unknown>)[field] = raw;
    } else {
      (metadata.extra ??= {})[id] = raw;
    }
  }
}

export interface WavDecodeOptions {
  limits?: Partial<Limits>;
}

/** Decodes a RIFF/WAVE, RF64, BW64, or Wave64 file. */
export function decodeWav(input: Uint8Array, options?: WavDecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const r = new Reader(input);

  const riffId = r.fourCC();
  if (riffId !== 'RIFF' && riffId !== 'RF64' && riffId !== 'BW64') {
    throw new DecodeError(`Not a RIFF file: expected "RIFF", found "${riffId}".`);
  }
  r.u32(true); // container size — recomputed from actual bytes, never trusted

  const waveId = r.fourCC();
  if (waveId !== 'WAVE') {
    throw new DecodeError(`Not a WAVE file: RIFF form type is "${waveId}".`);
  }

  let fmt: FmtChunk | null = null;
  let dataBytes: Uint8Array | null = null;
  let factFrames: number | null = null;
  // RF64 moves the real sizes into a ds64 chunk because the 32-bit fields overflow.
  let ds64DataSize: number | null = null;
  const metadata: AudioMetadata = {};

  while (r.remaining >= 8) {
    const id = r.fourCC();
    const declared = r.u32(true);

    // The single most important check in this file: a chunk may not claim more
    // bytes than the buffer holds. Without it, every later read is unbounded.
    const size = Math.min(declared, r.remaining);
    if (declared > r.remaining && id === 'data') {
      // Truncated `data` is common (interrupted recordings) and recoverable —
      // take what exists. Any other oversized chunk means real corruption.
      dataBytes = r.bytesView(size);
      break;
    }
    if (declared > r.remaining) {
      throw new DecodeError(
        `Chunk "${id}" declares ${declared} bytes but only ${r.remaining} remain.`,
        { offset: r.offset },
      );
    }

    switch (id) {
      case 'fmt ':
        fmt = parseFmt(r, size);
        break;
      case 'data':
        dataBytes = r.bytesView(size);
        break;
      case 'ds64': {
        const sub = r.subReader(size);
        sub.u64(true); // RIFF size
        ds64DataSize = sub.u64(true);
        break;
      }
      case 'fact': {
        const sub = r.subReader(size);
        if (sub.remaining >= 4) factFrames = sub.u32(true);
        break;
      }
      case 'LIST':
        parseListInfo(r, size, metadata);
        break;
      default:
        r.skip(size);
        break;
    }

    r.align2(); // RIFF pads odd-sized chunks to an even boundary
  }

  if (!fmt) throw new DecodeError('WAV file has no "fmt " chunk.');
  if (!dataBytes) throw new DecodeError('WAV file has no "data" chunk.');

  if (ds64DataSize !== null && ds64DataSize <= dataBytes.byteLength) {
    dataBytes = dataBytes.subarray(0, ds64DataSize);
  }

  const sampleFormat = sampleFormatFor(fmt);

  let channelData: Float32Array[];
  let frames: number;

  if (sampleFormat === 'ima-adpcm') {
    if (fmt.blockAlign <= 0) throw new DecodeError('ADPCM requires a non-zero blockAlign.');
    const perBlock = adpcmSamplesPerBlock(fmt.blockAlign, fmt.channels);
    const blocks = Math.floor(dataBytes.byteLength / fmt.blockAlign);
    frames = factFrames ?? blocks * perBlock;
    frames = Math.min(frames, blocks * perBlock);
    checkDecodeShape(frames, fmt.channels, fmt.sampleRate, limits);
    channelData = decodeImaAdpcm(dataBytes, fmt.channels, fmt.blockAlign, frames);
  } else {
    const width = bytesPerSample(sampleFormat);
    frames = Math.floor(dataBytes.byteLength / (width * fmt.channels));
    checkDecodeShape(frames, fmt.channels, fmt.sampleRate, limits);
    channelData = decodeInterleaved(dataBytes, sampleFormat, true, fmt.channels, frames);
  }

  return {
    channelData,
    sampleRate: fmt.sampleRate,
    info: {
      format: 'wav',
      sampleFormat,
      bitDepth: fmt.validBits ?? bitDepthOf(sampleFormat),
      lossy: sampleFormat === 'ima-adpcm' || sampleFormat === 'alaw' || sampleFormat === 'ulaw',
      metadata,
      details: {
        formatTag: fmt.formatTag,
        blockAlign: fmt.blockAlign,
        ...(fmt.channelMask !== undefined ? { channelMask: fmt.channelMask } : {}),
      },
    },
  };
}

export interface WavEncodeOptions extends ContainerEncodeOptions {
  /**
   * Force `WAVE_FORMAT_EXTENSIBLE`.
   *
   * Written automatically above 2 channels or above 16 bits, where plain RIFF is
   * ambiguous about channel order. Rarely worth setting by hand.
   */
  extensible?: boolean;
}

/** Format tag and whether EXTENSIBLE framing is required. */
function formatTagFor(sampleFormat: SampleFormat): number {
  switch (sampleFormat) {
    case 'u8':
    case 's16':
    case 's24':
    case 's32':
      return WAVE_FORMAT_PCM;
    case 'f32':
    case 'f64':
      return WAVE_FORMAT_IEEE_FLOAT;
    case 'alaw':
      return WAVE_FORMAT_ALAW;
    case 'ulaw':
      return WAVE_FORMAT_MULAW;
    default:
      throw new InvalidArgumentError(
        `audiobox cannot write ${sampleFormat} to WAV. Supported: u8, s16, s24, s32, f32, f64, alaw, ulaw.`,
      );
  }
}

function writeInfoChunk(w: Writer, metadata: AudioMetadata): void {
  const fields: Array<[string, string]> = [];
  for (const [key, tag] of METADATA_TO_INFO) {
    const value = metadata[key];
    if (value !== undefined && value !== null && `${value}` !== '') {
      fields.push([tag, `${value}`]);
    }
  }
  for (const [id, value] of Object.entries(metadata.extra ?? {})) {
    if (id.length === 4) fields.push([id, value]);
  }
  if (fields.length === 0) return;

  w.ascii('LIST');
  const sizeAt = w.reserve(4);
  const start = w.length;
  w.ascii('INFO');

  for (const [id, value] of fields) {
    w.ascii(id, 4);
    // RIFF INFO strings are NUL-terminated, and the terminator counts.
    const bytes = encodeUtf8(value);
    w.u32(bytes.byteLength + 1, true);
    w.write(bytes);
    w.u8(0);
    w.align2();
  }

  w.patchU32(sizeAt, w.length - start, true);
  w.align2();
}

/** Encodes planar float channels as a RIFF/WAVE file. */
export function encodeWav(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options?: WavEncodeOptions,
): Uint8Array {
  if (channelData.length === 0) {
    throw new InvalidArgumentError('At least one channel is required.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new InvalidArgumentError(`Invalid sample rate: ${sampleRate}.`);
  }

  const sampleFormat = resolveSampleFormat(options);
  const formatTag = formatTagFor(sampleFormat);
  const channels = channelData.length;

  const bits = bitDepthOf(sampleFormat);
  const blockAlign = bytesPerSample(sampleFormat) * channels;

  // Above stereo or above 16 bits, plain RIFF leaves channel order undefined;
  // EXTENSIBLE is what makes the file unambiguous to other tools.
  const extensible = options?.extensible ?? (channels > 2 || bits > 16);

  const audio = encodeInterleaved(channelData, sampleFormat, true, options?.dither);

  const w = new Writer(audio.byteLength + 512);
  w.ascii('RIFF');
  const riffSizeAt = w.reserve(4);
  const riffStart = w.length;
  w.ascii('WAVE');

  // --- fmt ---
  w.ascii('fmt ');
  w.u32(extensible ? 40 : 16, true);
  w.u16(extensible ? WAVE_FORMAT_EXTENSIBLE : formatTag, true);
  w.u16(channels, true);
  w.u32(sampleRate, true);
  w.u32(sampleRate * blockAlign, true); // byte rate
  w.u16(blockAlign, true);
  w.u16(bits, true);

  if (extensible) {
    w.u16(22, true); // extension size
    w.u16(bits, true); // valid bits per sample
    w.u32(defaultChannelMask(channels), true);
    // SubFormat GUID: the real tag followed by the fixed KSDATAFORMAT suffix.
    w.u16(formatTag, true);
    w.write(
      new Uint8Array([
        0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
      ]),
    );
  }

  if (options?.metadata) writeInfoChunk(w, options.metadata);

  // --- data ---
  w.ascii('data');
  w.u32(audio.byteLength, true);
  w.write(audio);
  w.align2();

  w.patchU32(riffSizeAt, w.length - riffStart, true);
  return w.finish();
}

/** Standard speaker mask for common channel counts. */
function defaultChannelMask(channels: number): number {
  switch (channels) {
    case 1:
      return 0x4; // FRONT_CENTER
    case 2:
      return 0x3; // FRONT_LEFT | FRONT_RIGHT
    case 4:
      return 0x33; // quad
    case 6:
      return 0x3f; // 5.1
    case 8:
      return 0x63f; // 7.1
    default:
      return 0; // "any", which is legal and honest for unusual layouts
  }
}
