/**
 * Sun/NeXT AU reader and writer.
 *
 * The simplest audio container in common use: a 24-byte big-endian header and
 * then raw samples. Still turns up from Java's `javax.sound`, older Unix tools,
 * and telephony systems, and it costs almost nothing to support.
 */

import { Reader } from '../io/reader.ts';
import { encodeUtf8 } from '../io/utf8.ts';
import { Writer } from '../io/writer.ts';
import { DecodeError, InvalidArgumentError } from '../errors.ts';
import { checkDecodeShape, resolveLimits, type Limits } from '../limits.ts';
import { bytesPerSample, decodeInterleaved, encodeInterleaved, bitDepthOf } from '../pcm/convert.ts';
import type { SampleFormat } from '../types.ts';
import type { DecodedContainer, ContainerEncodeOptions } from './types.ts';
import { resolveSampleFormat } from './types.ts';

/** AU encoding identifiers. */
const ENCODINGS: Record<number, SampleFormat> = Object.assign(Object.create(null), {
  1: 'ulaw',
  2: 's8',
  3: 's16',
  4: 's24',
  5: 's32',
  6: 'f32',
  7: 'f64',
  27: 'alaw',
});

const ENCODING_IDS: Partial<Record<SampleFormat, number>> = {
  ulaw: 1,
  s8: 2,
  s16: 3,
  s24: 4,
  s32: 5,
  f32: 6,
  f64: 7,
  alaw: 27,
};

export interface AuDecodeOptions {
  limits?: Partial<Limits>;
}

/** Decodes a Sun/NeXT AU file. */
export function decodeAu(input: Uint8Array, options?: AuDecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const r = new Reader(input);

  if (r.fourCC() !== '.snd') throw new DecodeError('Not an AU file: missing ".snd" magic.');

  const dataOffset = r.u32(false);
  const declaredSize = r.u32(false);
  const encoding = r.u32(false);
  const sampleRate = r.u32(false);
  const channels = r.u32(false);

  const sampleFormat = ENCODINGS[encoding];
  if (!sampleFormat) {
    throw new DecodeError(
      `Unsupported AU encoding ${encoding}. ` +
        'audiobox reads µ-law, A-law, and 8/16/24/32-bit PCM plus 32/64-bit float.',
    );
  }

  if (dataOffset < 24 || dataOffset > input.byteLength) {
    throw new DecodeError(`AU data offset ${dataOffset} is outside the file.`);
  }
  r.seek(dataOffset);

  // 0xFFFFFFFF is the documented "unknown size" sentinel, and a wrong size is
  // common besides, so the remaining bytes are the authority.
  const available = r.remaining;
  const size = declaredSize === 0xffffffff ? available : Math.min(declaredSize, available);
  const data = r.bytesView(size);

  const width = bytesPerSample(sampleFormat);
  const frames = Math.floor(data.byteLength / (width * channels));
  checkDecodeShape(frames, channels, sampleRate, limits);

  return {
    channelData: decodeInterleaved(data, sampleFormat, false, channels, frames),
    sampleRate,
    info: {
      format: 'au',
      sampleFormat,
      bitDepth: bitDepthOf(sampleFormat),
      lossy: sampleFormat === 'alaw' || sampleFormat === 'ulaw',
      metadata: {},
      details: { encoding },
    },
  };
}

/** Encodes planar float channels as a Sun/NeXT AU file. */
export function encodeAu(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options?: ContainerEncodeOptions,
): Uint8Array {
  if (channelData.length === 0) throw new InvalidArgumentError('At least one channel is required.');

  let sampleFormat = resolveSampleFormat(options);
  if (sampleFormat === 'u8') sampleFormat = 's8'; // AU 8-bit PCM is signed

  const encoding = ENCODING_IDS[sampleFormat];
  if (encoding === undefined) {
    throw new InvalidArgumentError(
      `audiobox cannot write ${sampleFormat} to AU. Supported: s8, s16, s24, s32, f32, f64, alaw, ulaw.`,
    );
  }

  const audio = encodeInterleaved(channelData, sampleFormat, false, options?.dither);
  // An annotation field is optional; a single NUL keeps the header at 24 bytes
  // and satisfies readers that expect the field to be NUL-terminated.
  const annotation = encodeUtf8(options?.metadata?.comment ?? '');
  const annotationLength = (annotation.byteLength + 8) & ~7; // pad to 8 bytes
  const dataOffset = 24 + annotationLength;

  const w = new Writer(audio.byteLength + dataOffset + 16);
  w.ascii('.snd');
  w.u32(dataOffset, false);
  w.u32(audio.byteLength, false);
  w.u32(encoding, false);
  w.u32(Math.round(sampleRate), false);
  w.u32(channelData.length, false);
  w.write(annotation);
  w.zeros(annotationLength - annotation.byteLength);
  w.write(audio);

  return w.finish();
}
