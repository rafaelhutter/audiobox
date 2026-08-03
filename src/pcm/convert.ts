/**
 * Conversion between packed container bytes and planar `Float32Array` samples.
 *
 * ## Why float32, and what it costs
 *
 * Decoded audio is held as `Float32Array` in the range [-1, 1] — the same
 * representation as Web Audio's `AudioBuffer`, so handing data to and from the
 * browser is a straight copy rather than a conversion pass.
 *
 * A float32 has a 24-bit mantissa. That makes round-trips through 8-, 16-, and
 * 24-bit integer formats **exactly** reversible, which covers essentially all
 * real-world audio. It cannot hold all 32 bits of a `s32` sample or all 53 of an
 * `f64` one, so those two formats round-trip to roughly 24-bit precision — about
 * -145 dBFS of error, far below the noise floor of any microphone or converter,
 * but not bit-exact. This is the same trade Web Audio makes. It is documented
 * rather than hidden because a silent precision loss is worse than a known one.
 *
 * ## Scaling convention
 *
 * Integer to float divides by 2^(bits-1); float to integer multiplies by the
 * same figure and clamps. The asymmetry (`-32768` maps to `-1.0`, while `+1.0`
 * clamps to `+32767`) is deliberate and standard — it is the only convention
 * under which every integer value survives a round-trip unchanged.
 */

import { InvalidArgumentError } from '../errors.ts';
import type { SampleFormat } from '../types.ts';

/** Bytes occupied by one sample of `format`. ADPCM is block-based and has no per-sample size. */
export function bytesPerSample(format: SampleFormat): number {
  switch (format) {
    case 'u8':
    case 's8':
    case 'alaw':
    case 'ulaw':
      return 1;
    case 's16':
      return 2;
    case 's24':
      return 3;
    case 's32':
    case 'f32':
      return 4;
    case 'f64':
      return 8;
    case 'ima-adpcm':
      throw new InvalidArgumentError(
        'IMA ADPCM is block-based and has no fixed bytes-per-sample; decode it via the container.',
      );
  }
}

/** Bit depth as stored on disk. */
export function bitDepthOf(format: SampleFormat): number {
  switch (format) {
    case 'u8':
    case 's8':
    case 'alaw':
    case 'ulaw':
      return 8;
    case 's16':
      return 16;
    case 's24':
      return 24;
    case 's32':
    case 'f32':
      return 32;
    case 'f64':
      return 64;
    case 'ima-adpcm':
      return 4;
  }
}

/** True when `format` stores floating-point samples. */
export function isFloatFormat(format: SampleFormat): boolean {
  return format === 'f32' || format === 'f64';
}

// --- G.711 companding -------------------------------------------------------
//
// A-law and µ-law compress 13/14-bit audio into 8 bits logarithmically. Both are
// pure 256-entry lookups in the decode direction, so the tables are built once at
// module load: generating them costs microseconds and saves ~2 kB of literals in
// every bundle that imports this file.

const ALAW_TO_LINEAR = new Int16Array(256);
const ULAW_TO_LINEAR = new Int16Array(256);

const BIAS = 0x84;

(function buildDecodeTables(): void {
  for (let i = 0; i < 256; i++) {
    // A-law. Note the sign convention: after the 0x55 mask, a *set* sign bit
    // means positive. That is inverted relative to µ-law and to most people's
    // intuition, but it is what the ITU G.711 reference does, and getting it
    // backwards produces a file that plays as inverted noise in every other tool.
    const a = i ^ 0x55;
    const aSeg = (a & 0x70) >> 4;
    let t = (a & 0x0f) << 4;
    if (aSeg === 0) t += 8;
    else if (aSeg === 1) t += 0x108;
    else t = (t + 0x108) << (aSeg - 1);
    ALAW_TO_LINEAR[i] = a & 0x80 ? t : -t;

    // µ-law: the byte is fully inverted on the wire, and a set sign bit means
    // negative.
    const u = ~i & 0xff;
    const uSeg = (u & 0x70) >> 4;
    const ut = (((u & 0x0f) << 3) + BIAS) << uSeg;
    ULAW_TO_LINEAR[i] = u & 0x80 ? BIAS - ut : ut - BIAS;
  }
})();

/** Segment end-points for the A-law and µ-law encoders. */
const SEG_AEND = new Int32Array([0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff]);
const SEG_UEND = new Int32Array([0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff]);

/** Index of the first segment boundary at or above `value`. */
function segmentSearch(value: number, table: Int32Array): number {
  for (let i = 0; i < table.length; i++) {
    if (value <= table[i]!) return i;
  }
  return table.length;
}

/**
 * Encodes a 16-bit linear sample to A-law.
 *
 * Ported from the ITU-T G.711 reference implementation rather than derived, so
 * that output is byte-identical to every other conforming encoder.
 */
export function linearToALaw(sample: number): number {
  let pcm = sample >> 3;
  let mask: number;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }

  const seg = segmentSearch(pcm, SEG_AEND);
  if (seg >= 8) return 0x7f ^ mask; // clipped

  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return aval ^ mask;
}

/** Encodes a 16-bit linear sample to µ-law. Ported from the G.711 reference. */
export function linearToULaw(sample: number): number {
  const CLIP = 8159;

  let pcm = sample >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS >> 2;

  const seg = segmentSearch(pcm, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask; // clipped

  return (((seg << 4) | ((pcm >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

// --- Dither -----------------------------------------------------------------

/**
 * Deterministic PRNG (xorshift32).
 *
 * Dither must be random enough to decorrelate quantization error from the
 * signal, but tests need reproducibility. A seeded generator gives both, and
 * avoids depending on `Math.random`, whose quality varies by engine.
 */
function makeRandom(seed: number): () => number {
  let s = seed | 0 || 0x2545f491;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export interface DitherOptions {
  /**
   * `'none'` for bit-exact output, `'tpdf'` for triangular-PDF dither.
   *
   * Reducing bit depth without dither produces *correlated* quantization error,
   * heard as harmonic distortion on quiet passages rather than as hiss. TPDF
   * dither trades a tiny, constant noise floor for the removal of that
   * distortion, which is why mastering practice always applies it. Default is
   * `'none'` so that round-trips stay reversible unless a caller opts in.
   */
  type?: 'none' | 'tpdf';
  /** Seed for reproducible output. */
  seed?: number;
}

// --- Decode: packed bytes -> planar float ----------------------------------

/**
 * Decodes interleaved packed samples into one `Float32Array` per channel.
 *
 * @param bytes  Packed sample data, starting at sample 0.
 * @param format Storage format of each sample.
 * @param littleEndian Byte order for multi-byte formats.
 * @param channels Channel count; samples are interleaved by frame.
 * @param frames Number of frames to decode.
 */
export function decodeInterleaved(
  bytes: Uint8Array,
  format: SampleFormat,
  littleEndian: boolean,
  channels: number,
  frames: number,
): Float32Array[] {
  if (channels < 1) throw new InvalidArgumentError(`channels must be >= 1, got ${channels}`);

  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

  const width = bytesPerSample(format);
  const available = Math.floor(bytes.byteLength / (width * channels));
  // Truncated files are common; decode what is actually present and leave the
  // remainder as silence rather than throwing away the whole recording.
  const n = Math.min(frames, available);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let c = 0; c < channels; c++) {
    const dst = out[c]!;
    let off = c * width;
    const stride = channels * width;

    switch (format) {
      case 'u8':
        for (let i = 0; i < n; i++, off += stride) dst[i] = (bytes[off]! - 128) / 128;
        break;
      case 's8':
        for (let i = 0; i < n; i++, off += stride) dst[i] = view.getInt8(off) / 128;
        break;
      case 's16':
        for (let i = 0; i < n; i++, off += stride) dst[i] = view.getInt16(off, littleEndian) / 32768;
        break;
      case 's24':
        for (let i = 0; i < n; i++, off += stride) {
          const a = bytes[off]!;
          const b = bytes[off + 1]!;
          const c2 = bytes[off + 2]!;
          const raw = littleEndian ? a | (b << 8) | (c2 << 16) : (a << 16) | (b << 8) | c2;
          dst[i] = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
        }
        break;
      case 's32':
        for (let i = 0; i < n; i++, off += stride) {
          dst[i] = view.getInt32(off, littleEndian) / 2147483648;
        }
        break;
      case 'f32':
        for (let i = 0; i < n; i++, off += stride) dst[i] = view.getFloat32(off, littleEndian);
        break;
      case 'f64':
        for (let i = 0; i < n; i++, off += stride) dst[i] = view.getFloat64(off, littleEndian);
        break;
      case 'alaw':
        for (let i = 0; i < n; i++, off += stride) dst[i] = ALAW_TO_LINEAR[bytes[off]!]! / 32768;
        break;
      case 'ulaw':
        for (let i = 0; i < n; i++, off += stride) dst[i] = ULAW_TO_LINEAR[bytes[off]!]! / 32768;
        break;
      case 'ima-adpcm':
        throw new InvalidArgumentError('IMA ADPCM must be decoded block-wise; see pcm/adpcm.ts.');
    }
  }

  return out;
}

// --- Encode: planar float -> packed bytes -----------------------------------

/** Clamps to [-1, 1]. Applied before scaling so overshoot cannot wrap. */
function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Encodes planar float channels into interleaved packed samples.
 *
 * @param channelData One `Float32Array` per channel; all must be the same length.
 */
export function encodeInterleaved(
  channelData: readonly Float32Array[],
  format: SampleFormat,
  littleEndian: boolean,
  dither?: DitherOptions,
): Uint8Array {
  const channels = channelData.length;
  if (channels === 0) throw new InvalidArgumentError('At least one channel is required.');

  const frames = channelData[0]!.length;
  for (let c = 1; c < channels; c++) {
    if (channelData[c]!.length !== frames) {
      throw new InvalidArgumentError(
        `Channel ${c} has ${channelData[c]!.length} frames but channel 0 has ${frames}; ` +
          'all channels must be the same length.',
      );
    }
  }

  const width = bytesPerSample(format);
  const out = new Uint8Array(frames * channels * width);
  const view = new DataView(out.buffer);

  // Dither is meaningful only when quantizing to integers.
  const useDither = dither?.type === 'tpdf' && !isFloatFormat(format);
  const rand = useDither ? makeRandom(dither?.seed ?? 0x9e3779b9) : null;

  for (let c = 0; c < channels; c++) {
    const src = channelData[c]!;
    let off = c * width;
    const stride = channels * width;

    switch (format) {
      case 'u8':
        for (let i = 0; i < frames; i++, off += stride) {
          out[off] = quantize(src[i]!, 128, rand) + 128;
        }
        break;
      case 's8':
        for (let i = 0; i < frames; i++, off += stride) {
          view.setInt8(off, quantize(src[i]!, 128, rand));
        }
        break;
      case 's16':
        for (let i = 0; i < frames; i++, off += stride) {
          view.setInt16(off, quantize(src[i]!, 32768, rand), littleEndian);
        }
        break;
      case 's24':
        for (let i = 0; i < frames; i++, off += stride) {
          const v = quantize(src[i]!, 8388608, rand);
          const u = v < 0 ? v + 0x1000000 : v;
          if (littleEndian) {
            out[off] = u & 0xff;
            out[off + 1] = (u >>> 8) & 0xff;
            out[off + 2] = (u >>> 16) & 0xff;
          } else {
            out[off] = (u >>> 16) & 0xff;
            out[off + 1] = (u >>> 8) & 0xff;
            out[off + 2] = u & 0xff;
          }
        }
        break;
      case 's32':
        for (let i = 0; i < frames; i++, off += stride) {
          // Math.round on a value this large is exact in float64, which is what
          // JS arithmetic uses regardless of the Float32Array source.
          const v = Math.max(-2147483648, Math.min(2147483647, Math.round(clamp1(src[i]!) * 2147483648)));
          view.setInt32(off, v, littleEndian);
        }
        break;
      case 'f32':
        for (let i = 0; i < frames; i++, off += stride) {
          view.setFloat32(off, src[i]!, littleEndian);
        }
        break;
      case 'f64':
        for (let i = 0; i < frames; i++, off += stride) {
          view.setFloat64(off, src[i]!, littleEndian);
        }
        break;
      case 'alaw':
        for (let i = 0; i < frames; i++, off += stride) {
          out[off] = linearToALaw(quantize(src[i]!, 32768, rand));
        }
        break;
      case 'ulaw':
        for (let i = 0; i < frames; i++, off += stride) {
          out[off] = linearToULaw(quantize(src[i]!, 32768, rand));
        }
        break;
      case 'ima-adpcm':
        throw new InvalidArgumentError('IMA ADPCM must be encoded block-wise; see pcm/adpcm.ts.');
    }
  }

  return out;
}

/**
 * Scales a float sample to an integer of the given full-scale magnitude,
 * optionally adding TPDF dither, then clamps into range.
 */
function quantize(sample: number, scale: number, rand: (() => number) | null): number {
  let v = clamp1(sample) * scale;
  if (rand) {
    // Triangular PDF: the difference of two uniform variates, spanning ±1 LSB.
    v += rand() - rand();
  }
  const r = Math.round(v);
  return r < -scale ? -scale : r > scale - 1 ? scale - 1 : r;
}
