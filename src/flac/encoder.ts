/**
 * FLAC encoder.
 *
 * Lossless, so the goal is purely "how small, how fast". Three stages decide
 * that, and each is a search over a small space:
 *
 * 1. **Channel decorrelation** — a stereo pair is usually far more compressible
 *    as mid/side than as left/right, because the side channel is near-silent on
 *    centred material. All four modes are tried and the cheapest wins.
 * 2. **Prediction** — fixed polynomial predictors (orders 0–4) plus, at higher
 *    compression levels, LPC coefficients solved per block via Levinson-Durbin.
 *    Whichever leaves the smallest residual wins.
 * 3. **Rice coding** — the residual is split into partitions, each with its own
 *    optimal Rice parameter, so a block containing both quiet and loud passages
 *    does not pay the loud passage's parameter throughout.
 *
 * Output is verified byte-for-byte decodable by the reference `flac` tool in the
 * interop tests, and STREAMINFO carries a real MD5 so `flac -t` passes.
 */

import { BitWriter } from '../io/bits.ts';
import { Writer } from '../io/writer.ts';
import { encodeUtf8 } from '../io/utf8.ts';
import { EncodeError, InvalidArgumentError } from '../errors.ts';
import { crc8, crc16, Md5 } from './checksums.ts';
import type { Audio } from '../audio.ts';
import type { AudioMetadata } from '../types.ts';

export interface FlacEncodeOptions {
  /**
   * 0–8, mirroring the reference encoder's scale. Higher is smaller and slower.
   * Defaults to 5, the same default `flac` itself uses.
   *
   * 0–2 use fixed predictors only; 3+ additionally search LPC orders.
   */
  compressionLevel?: number;
  /** Bit depth to store. 16 or 24. Defaults to 16. */
  bitDepth?: 8 | 16 | 24;
  /** Tags to embed as a Vorbis comment block. */
  metadata?: AudioMetadata;
}

const FIXED_PREDICTORS: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

/** Per-level tuning: block size, maximum LPC order, and Rice partition order. */
function tuningFor(level: number): { blockSize: number; maxLpcOrder: number; maxPartitionOrder: number } {
  const clamped = Math.max(0, Math.min(8, Math.round(level)));
  if (clamped <= 2) return { blockSize: 4096, maxLpcOrder: 0, maxPartitionOrder: clamped === 0 ? 3 : 4 };
  if (clamped <= 5) return { blockSize: 4096, maxLpcOrder: 8, maxPartitionOrder: 5 };
  return { blockSize: 4096, maxLpcOrder: 12, maxPartitionOrder: 6 };
}

/** Converts float samples to integers at the target depth. */
function quantizeChannels(audio: Audio, bitDepth: number): Int32Array[] {
  const scale = Math.pow(2, bitDepth - 1);
  const max = scale - 1;
  const min = -scale;

  return audio.allChannels.map((channel) => {
    const out = new Int32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const v = Math.round(channel[i]! * scale);
      out[i] = v < min ? min : v > max ? max : v;
    }
    return out;
  });
}

/** Bits needed to Rice-code `residual` at parameter `k`. */
function riceCost(residual: Int32Array, start: number, end: number, k: number): number {
  let bits = 0;
  for (let i = start; i < end; i++) {
    const v = residual[i]!;
    // Zigzag before measuring: Rice codes unsigned values.
    const zigzag = v < 0 ? (-v << 1) - 1 : v << 1;
    bits += (zigzag >>> k) + 1 + k;
  }
  return bits;
}

/**
 * Best Rice parameter for a span, and its cost.
 *
 * Evaluating all 15 candidates means 15 passes over the residual, which
 * dominates encoding time. Instead the optimum is estimated in closed form from
 * a single pass: for a geometric-ish distribution the ideal parameter is about
 * `log2(mean)`, and the cost function is convex in `k`, so checking the estimate
 * and its immediate neighbours finds the true minimum in practice. This is the
 * same shortcut the reference encoder uses.
 */
function bestRiceParameter(
  residual: Int32Array,
  start: number,
  end: number,
): { parameter: number; bits: number } {
  const count = end - start;
  if (count <= 0) return { parameter: 0, bits: 0 };

  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = residual[i]!;
    sum += v < 0 ? (-v << 1) - 1 : v << 1;
  }

  const mean = sum / count;
  // 15 is the escape value for 4-bit parameters, so 14 is the usable maximum.
  const estimate = mean <= 0 ? 0 : Math.max(0, Math.min(14, Math.floor(Math.log2(mean))));

  let bestParameter = estimate;
  let bestBits = riceCost(residual, start, end, estimate);

  for (const k of [estimate - 1, estimate + 1, estimate + 2]) {
    if (k < 0 || k > 14) continue;
    const bits = riceCost(residual, start, end, k);
    if (bits < bestBits) {
      bestBits = bits;
      bestParameter = k;
    }
  }

  return { parameter: bestParameter, bits: bestBits };
}

interface ResidualPlan {
  partitionOrder: number;
  parameters: number[];
  bits: number;
}

/** Chooses a Rice partitioning for one subframe's residual. */
function planResidual(
  residual: Int32Array,
  blockSize: number,
  predictorOrder: number,
  maxPartitionOrder: number,
): ResidualPlan {
  let best: ResidualPlan | null = null;

  for (let order = 0; order <= maxPartitionOrder; order++) {
    const partitions = 1 << order;
    if (blockSize % partitions !== 0) continue;
    const partitionSamples = blockSize >> order;
    if (partitionSamples <= predictorOrder) continue;

    const parameters: number[] = [];
    let bits = 4; // partition order field
    for (let p = 0; p < partitions; p++) {
      const start = p === 0 ? predictorOrder : p * partitionSamples;
      const end = (p + 1) * partitionSamples;
      const { parameter, bits: partitionBits } = bestRiceParameter(residual, start, end);
      parameters.push(parameter);
      bits += 4 + partitionBits;
    }

    if (!best || bits < best.bits) best = { partitionOrder: order, parameters, bits };
  }

  if (!best) {
    // Fall back to a single unpartitioned span.
    const { parameter, bits } = bestRiceParameter(residual, predictorOrder, blockSize);
    best = { partitionOrder: 0, parameters: [parameter], bits: bits + 8 };
  }
  return best;
}

interface SubframePlan {
  type: 'constant' | 'verbatim' | 'fixed' | 'lpc';
  order: number;
  residual: Int32Array;
  plan: ResidualPlan;
  bits: number;
  coefficients?: Int32Array;
  precision?: number;
  shift?: number;
}

/** Computes LPC coefficients for a block via autocorrelation + Levinson-Durbin. */
function computeLpc(
  samples: Int32Array,
  blockSize: number,
  maxOrder: number,
): { coefficients: Float64Array; order: number } | null {
  const order = Math.min(maxOrder, blockSize - 1);
  if (order < 1) return null;

  // Windowed autocorrelation. A Welch window is cheap and works well enough;
  // the window only affects coefficient quality, never correctness.
  const windowed = new Float64Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    const x = (2 * i) / (blockSize - 1) - 1;
    windowed[i] = samples[i]! * (1 - x * x);
  }

  const autocorrelation = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = lag; i < blockSize; i++) sum += windowed[i]! * windowed[i - lag]!;
    autocorrelation[lag] = sum;
  }
  if (autocorrelation[0] === 0) return null;

  // Levinson-Durbin recursion.
  const coefficients = new Float64Array(order);
  const temp = new Float64Array(order);
  let error = autocorrelation[0]!;

  for (let i = 0; i < order; i++) {
    let acc = autocorrelation[i + 1]!;
    for (let j = 0; j < i; j++) acc -= coefficients[j]! * autocorrelation[i - j]!;
    const reflection = acc / error;

    coefficients[i] = reflection;
    for (let j = 0; j < i; j++) temp[j] = coefficients[j]! - reflection * coefficients[i - 1 - j]!;
    for (let j = 0; j < i; j++) coefficients[j] = temp[j]!;

    error *= 1 - reflection * reflection;
    if (error <= 0) return { coefficients: coefficients.slice(0, i + 1), order: i + 1 };
  }

  return { coefficients, order };
}

/** Evaluates every candidate predictor and returns the cheapest. */
function planSubframe(
  samples: Int32Array,
  blockSize: number,
  bitsPerSample: number,
  maxLpcOrder: number,
  maxPartitionOrder: number,
): SubframePlan {
  // CONSTANT: the whole block is one value.
  let constant = true;
  for (let i = 1; i < blockSize; i++) {
    if (samples[i] !== samples[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    return {
      type: 'constant',
      order: 0,
      residual: new Int32Array(0),
      plan: { partitionOrder: 0, parameters: [], bits: 0 },
      bits: 8 + bitsPerSample,
    };
  }

  let best: SubframePlan | null = null;

  // Fixed predictors, orders 0-4.
  for (let order = 0; order <= 4 && order < blockSize; order++) {
    const coefficients = FIXED_PREDICTORS[order]!;
    const residual = new Int32Array(blockSize);
    for (let i = order; i < blockSize; i++) {
      let prediction = 0;
      for (let j = 0; j < coefficients.length; j++) {
        prediction += coefficients[j]! * samples[i - 1 - j]!;
      }
      residual[i] = samples[i]! - prediction;
    }

    const plan = planResidual(residual, blockSize, order, maxPartitionOrder);
    const bits = 8 + order * bitsPerSample + plan.bits;
    if (!best || bits < best.bits) best = { type: 'fixed', order, residual, plan, bits };
  }

  // LPC, when the compression level asks for it.
  if (maxLpcOrder > 0) {
    const lpc = computeLpc(samples, blockSize, maxLpcOrder);
    if (lpc) {
      const precision = 15;
      const { coefficients: real, order } = lpc;

      // Quantise coefficients to `precision` bits with a shared shift.
      let maxAbs = 0;
      for (let i = 0; i < order; i++) maxAbs = Math.max(maxAbs, Math.abs(real[i]!));
      if (maxAbs > 0) {
        const headroom = Math.floor(Math.log2(maxAbs)) + 1;
        const shift = Math.max(0, Math.min(15, precision - 1 - headroom));
        const scale = Math.pow(2, shift);
        const limit = Math.pow(2, precision - 1);

        const quantized = new Int32Array(order);
        for (let i = 0; i < order; i++) {
          const q = Math.round(real[i]! * scale);
          quantized[i] = Math.max(-limit, Math.min(limit - 1, q));
        }

        const residual = new Int32Array(blockSize);
        for (let i = order; i < blockSize; i++) {
          let prediction = 0;
          for (let j = 0; j < order; j++) prediction += quantized[j]! * samples[i - 1 - j]!;
          residual[i] = samples[i]! - Math.floor(prediction / scale);
        }

        const plan = planResidual(residual, blockSize, order, maxPartitionOrder);
        const bits = 8 + order * bitsPerSample + 4 + 5 + order * precision + plan.bits;
        if (!best || bits < best.bits) {
          best = { type: 'lpc', order, residual, plan, bits, coefficients: quantized, precision, shift };
        }
      }
    }
  }

  // VERBATIM is the floor: never worse than storing samples raw.
  const verbatimBits = 8 + blockSize * bitsPerSample;
  if (!best || verbatimBits < best.bits) {
    return {
      type: 'verbatim',
      order: 0,
      residual: new Int32Array(0),
      plan: { partitionOrder: 0, parameters: [], bits: 0 },
      bits: verbatimBits,
    };
  }

  return best;
}

function writeSubframe(
  bw: BitWriter,
  plan: SubframePlan,
  samples: Int32Array,
  blockSize: number,
  bitsPerSample: number,
): void {
  bw.bit(0); // padding

  switch (plan.type) {
    case 'constant':
      bw.bits(0, 6);
      bw.bit(0); // no wasted bits
      bw.bits(samples[0]! & ((1 << bitsPerSample) - 1) || samples[0]!, bitsPerSample);
      return;
    case 'verbatim':
      bw.bits(1, 6);
      bw.bit(0);
      for (let i = 0; i < blockSize; i++) writeSigned(bw, samples[i]!, bitsPerSample);
      return;
    case 'fixed':
      bw.bits(8 | plan.order, 6);
      bw.bit(0);
      for (let i = 0; i < plan.order; i++) writeSigned(bw, samples[i]!, bitsPerSample);
      break;
    case 'lpc':
      bw.bits(32 | (plan.order - 1), 6);
      bw.bit(0);
      for (let i = 0; i < plan.order; i++) writeSigned(bw, samples[i]!, bitsPerSample);
      bw.bits(plan.precision! - 1, 4);
      writeSigned(bw, plan.shift!, 5);
      for (let i = 0; i < plan.order; i++) writeSigned(bw, plan.coefficients![i]!, plan.precision!);
      break;
  }

  writeResidual(bw, plan, blockSize);
}

function writeResidual(bw: BitWriter, plan: SubframePlan, blockSize: number): void {
  bw.bits(0, 2); // 4-bit Rice parameters
  bw.bits(plan.plan.partitionOrder, 4);

  const partitions = 1 << plan.plan.partitionOrder;
  const partitionSamples = blockSize >> plan.plan.partitionOrder;

  for (let p = 0; p < partitions; p++) {
    const parameter = plan.plan.parameters[p]!;
    bw.bits(parameter, 4);

    const start = p === 0 ? plan.order : p * partitionSamples;
    const end = (p + 1) * partitionSamples;
    for (let i = start; i < end; i++) {
      const v = plan.residual[i]!;
      const zigzag = v < 0 ? (-v << 1) - 1 : v << 1;
      const quotient = zigzag >>> parameter;
      // Unary quotient: `quotient` zeros then a one.
      for (let q = 0; q < quotient; q++) bw.bit(0);
      bw.bit(1);
      if (parameter > 0) bw.bits(zigzag & ((1 << parameter) - 1), parameter);
    }
  }
}

function writeSigned(bw: BitWriter, value: number, bits: number): void {
  bw.bits(value < 0 ? value + (1 << bits) : value, bits);
}

/** Writes FLAC's UTF-8-like coded frame number. */
function writeUtf8Number(bw: BitWriter, value: number): void {
  if (value < 0x80) {
    bw.bits(value, 8);
  } else if (value < 0x800) {
    bw.bits(0xc0 | (value >> 6), 8);
    bw.bits(0x80 | (value & 0x3f), 8);
  } else if (value < 0x10000) {
    bw.bits(0xe0 | (value >> 12), 8);
    bw.bits(0x80 | ((value >> 6) & 0x3f), 8);
    bw.bits(0x80 | (value & 0x3f), 8);
  } else {
    bw.bits(0xf0 | (value >> 18), 8);
    bw.bits(0x80 | ((value >> 12) & 0x3f), 8);
    bw.bits(0x80 | ((value >> 6) & 0x3f), 8);
    bw.bits(0x80 | (value & 0x3f), 8);
  }
}

/** Block-size codes recognised by every decoder without extra header bytes. */
function blockSizeCode(size: number): number {
  switch (size) {
    case 192: return 1;
    case 576: return 2;
    case 1152: return 3;
    case 2304: return 4;
    case 4608: return 5;
    case 256: return 8;
    case 512: return 9;
    case 1024: return 10;
    case 2048: return 11;
    case 4096: return 12;
    case 8192: return 13;
    case 16384: return 14;
    default: return 0; // signals "explicit 16-bit size follows"
  }
}

function sampleRateCode(rate: number): number {
  switch (rate) {
    case 88200: return 1;
    case 176400: return 2;
    case 192000: return 3;
    case 8000: return 4;
    case 16000: return 5;
    case 22050: return 6;
    case 24000: return 7;
    case 32000: return 8;
    case 44100: return 9;
    case 48000: return 10;
    case 96000: return 11;
    default: return 0; // take it from STREAMINFO
  }
}

function bitDepthCode(bits: number): number {
  switch (bits) {
    case 8: return 1;
    case 12: return 2;
    case 16: return 4;
    case 20: return 5;
    case 24: return 6;
    default: return 0;
  }
}

/** Encodes audio as a FLAC stream. */
export function encodeFlac(audio: Audio, options?: FlacEncodeOptions): Uint8Array {
  const bitDepth = options?.bitDepth ?? 16;
  if (bitDepth !== 8 && bitDepth !== 16 && bitDepth !== 24) {
    throw new InvalidArgumentError(`FLAC bit depth must be 8, 16, or 24; got ${bitDepth}.`);
  }
  if (audio.channels > 8) {
    throw new EncodeError(`FLAC supports at most 8 channels; got ${audio.channels}.`);
  }

  const { blockSize, maxLpcOrder, maxPartitionOrder } = tuningFor(options?.compressionLevel ?? 5);
  const channels = quantizeChannels(audio, bitDepth);
  const totalFrames = audio.frames;
  const useStereoDecorrelation = audio.channels === 2;

  // MD5 covers the interleaved little-endian samples exactly as they would be
  // written to a WAV, which is what `flac -t` recomputes and compares.
  const md5 = new Md5();
  const bytesPerSample = bitDepth >> 3;
  const md5Buffer = new Uint8Array(blockSize * audio.channels * bytesPerSample);

  const frames = new Writer(totalFrames * audio.channels * 2 + 8192);
  let frameNumber = 0;

  for (let start = 0; start < totalFrames; start += blockSize) {
    const size = Math.min(blockSize, totalFrames - start);

    // Feed MD5 with this block's interleaved samples.
    let md5Offset = 0;
    for (let i = 0; i < size; i++) {
      for (let c = 0; c < audio.channels; c++) {
        let v = channels[c]![start + i]!;
        if (v < 0) v += 1 << (bitDepth === 24 ? 24 : bitDepth);
        for (let b = 0; b < bytesPerSample; b++) {
          md5Buffer[md5Offset++] = (v >>> (b * 8)) & 0xff;
        }
      }
    }
    md5.update(md5Buffer.subarray(0, md5Offset));

    // Choose channel decorrelation.
    let assignment = audio.channels - 1;
    let blockChannels: Int32Array[];

    if (useStereoDecorrelation) {
      const left = channels[0]!.subarray(start, start + size);
      const right = channels[1]!.subarray(start, start + size);

      const mid = new Int32Array(size);
      const side = new Int32Array(size);
      for (let i = 0; i < size; i++) {
        side[i] = left[i]! - right[i]!;
        // Mid is the arithmetic mean, floored; the discarded low bit is
        // recoverable from the side channel's parity, which is how the decoder
        // reconstructs exactly.
        mid[i] = (left[i]! + right[i]!) >> 1;
      }

      // Pick by residual energy: whichever pair is smaller compresses better.
      const energy = (a: Int32Array): number => {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]!);
        return sum;
      };
      const eL = energy(left as Int32Array);
      const eR = energy(right as Int32Array);
      const eM = energy(mid);
      const eS = energy(side);

      const options2: Array<[number, number, Int32Array[]]> = [
        [audio.channels - 1, eL + eR, [left as Int32Array, right as Int32Array]],
        [8, eL + eS, [left as Int32Array, side]],
        [9, eS + eR, [side, right as Int32Array]],
        [10, eM + eS, [mid, side]],
      ];
      let bestOption = options2[0]!;
      for (const option of options2) if (option[1] < bestOption[1]) bestOption = option;
      assignment = bestOption[0];
      blockChannels = bestOption[2];
    } else {
      blockChannels = channels.map((c) => c.subarray(start, start + size) as Int32Array);
    }

    // --- Frame header ---
    const bw = new BitWriter(size * audio.channels * 3 + 64);
    bw.bits(0x3ffe, 14); // sync
    bw.bit(0); // reserved
    bw.bit(0); // fixed blocking strategy

    const bsCode = blockSizeCode(size);
    const srCode = sampleRateCode(audio.sampleRate);
    bw.bits(bsCode === 0 ? 7 : bsCode, 4);
    bw.bits(srCode, 4);
    bw.bits(assignment, 4);
    bw.bits(bitDepthCode(bitDepth), 3);
    bw.bit(0); // reserved

    writeUtf8Number(bw, frameNumber);
    if (bsCode === 0) bw.bits(size - 1, 16);

    // CRC-8 covers the header bytes written so far.
    bw.align();
    const headerBytes = bw.finish();
    const bw2 = new BitWriter(size * audio.channels * 3 + 64);
    bw2.writeBytes(headerBytes);
    bw2.bits(crc8(headerBytes), 8);

    // --- Subframes ---
    for (let c = 0; c < blockChannels.length; c++) {
      let subframeBits = bitDepth;
      if (assignment === 8 && c === 1) subframeBits++;
      else if (assignment === 9 && c === 0) subframeBits++;
      else if (assignment === 10 && c === 1) subframeBits++;

      const plan = planSubframe(blockChannels[c]!, size, subframeBits, maxLpcOrder, maxPartitionOrder);
      writeSubframe(bw2, plan, blockChannels[c]!, size, subframeBits);
    }

    bw2.align();
    const frameBytes = bw2.finish();
    frames.write(frameBytes);
    frames.u16(crc16(frameBytes), false);

    frameNumber++;
  }

  return assembleStream(audio, bitDepth, blockSize, totalFrames, md5.digest(), frames.finish(), options?.metadata);
}

/** Writes the `fLaC` magic, metadata blocks, and the frame payload. */
function assembleStream(
  audio: Audio,
  bitDepth: number,
  blockSize: number,
  totalFrames: number,
  md5Digest: Uint8Array,
  frameData: Uint8Array,
  metadata: AudioMetadata | undefined,
): Uint8Array {
  const comments = buildVorbisComment(metadata);
  const w = new Writer(frameData.byteLength + 512);

  w.ascii('fLaC');

  // --- STREAMINFO ---
  w.u8(comments ? 0x00 : 0x80); // last-block flag depends on whether tags follow
  w.u24(34, false);
  w.u16(blockSize, false); // min block size
  w.u16(blockSize, false); // max block size
  w.u24(0, false); // min frame size — 0 means unknown
  w.u24(0, false); // max frame size

  // 20 bits rate | 3 bits channels-1 | 5 bits depth-1 | 36 bits total samples
  const bw = new BitWriter(8);
  bw.bits(audio.sampleRate, 20);
  bw.bits(audio.channels - 1, 3);
  bw.bits(bitDepth - 1, 5);
  bw.bits(Math.floor(totalFrames / 0x10000000), 36 - 28);
  bw.bits(totalFrames % 0x10000000, 28);
  w.write(bw.finish());
  w.write(md5Digest);

  if (comments) {
    w.u8(0x84); // last block, type 4 (VORBIS_COMMENT)
    w.u24(comments.byteLength, false);
    w.write(comments);
  }

  w.write(frameData);
  return w.finish();
}

function buildVorbisComment(metadata: AudioMetadata | undefined): Uint8Array | null {
  const entries: string[] = [];
  if (metadata?.title) entries.push(`TITLE=${metadata.title}`);
  if (metadata?.artist) entries.push(`ARTIST=${metadata.artist}`);
  if (metadata?.album) entries.push(`ALBUM=${metadata.album}`);
  if (metadata?.genre) entries.push(`GENRE=${metadata.genre}`);
  if (metadata?.year) entries.push(`DATE=${metadata.year}`);
  if (metadata?.comment) entries.push(`COMMENT=${metadata.comment}`);
  if (metadata?.trackNumber !== undefined) entries.push(`TRACKNUMBER=${metadata.trackNumber}`);
  for (const [key, value] of Object.entries(metadata?.extra ?? {})) {
    entries.push(`${key}=${value}`);
  }
  if (entries.length === 0) return null;

  const vendor = encodeUtf8('audiobox');
  const encoded = entries.map(encodeUtf8);

  const w = new Writer(64 + encoded.reduce((n, e) => n + e.byteLength + 4, 0));
  w.u32(vendor.byteLength, true);
  w.write(vendor);
  w.u32(encoded.length, true);
  for (const entry of encoded) {
    w.u32(entry.byteLength, true);
    w.write(entry);
  }
  return w.finish();
}
