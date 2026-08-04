/**
 * Quantisation and rate control — turning a granule's spectrum into integers
 * that fit a bit budget.
 *
 * This is the encoder's decision-making. Everything before it is a fixed
 * transform and everything after it is bookkeeping; here is where an encoder
 * chooses what to throw away, and it is the only place quality is decided.
 *
 * ## The quantiser
 *
 * Layer III quantises with a power law rather than linearly:
 *
 *     ix = floor( (|xr| / 2^step)^(3/4) + 0.4054 )
 *
 * which the decoder inverts as `ix^(4/3) * 2^step`. The exponent matches the
 * ear's response — loudness grows roughly as the cube root of intensity — so
 * equal quantiser steps are closer to equal perceptual steps than uniform
 * spacing would be. The 0.4054 offset is the rounding point that minimises
 * error in that warped domain; plain rounding at 0.5 biases the result low.
 *
 * `step` comes from two places: `global_gain`, one value for the whole granule
 * in quarter-power-of-two increments, and a per-band `scalefactor` on top of it.
 * That split is the whole design — the granule's overall level is coded once,
 * and only the *shape* of the noise across the spectrum costs extra bits.
 *
 * ## The two loops
 *
 * - **Inner loop (rate).** Find the smallest `global_gain` whose Huffman cost
 *   fits the granule's bit budget. Coarser gain means smaller integers means
 *   fewer bits, so the relationship is monotone and a binary search settles it
 *   in eight trials.
 * - **Outer loop (distortion).** Measure the resulting error per scalefactor
 *   band. Where it exceeds what that band is allowed, raise the band's
 *   scalefactor and run the inner loop again. Amplifying costs bits, so the
 *   inner loop responds by coarsening everything else — the two loops push
 *   against each other and the process is stopped by iteration count, by
 *   scalefactor range, or by success.
 *
 * ## Where the thresholds come from, and what they change
 *
 * `psychoacoustic.ts` supplies the per-band noise allowance. Given it,
 * {@link allocateScalefactors} sets the noise *shape* directly and the loops
 * refine from there; without it (`thresholds: null`) the quantiser runs flat,
 * spreading noise evenly across the spectrum.
 *
 * Shaping raises total squared error on purpose — it moves noise under the
 * signal, where it cannot be heard — so SNR gets *worse* and noise-to-mask gets
 * better. On dense material at 128 kbps, noise-to-mask improves by around 4 dB
 * and the proportion of audible bands falls from roughly half to a fifth, while
 * SNR drops about 8 dB. Any measurement that scores total error will therefore
 * rate a working model as neutral or harmful, which is exactly what happened to
 * the first attempt at this; `test/mp3.test.ts` gates on noise-to-mask instead.
 */

import { SFB_LONG, SFB_SHORT, PRETAB, SLEN1, SLEN2, POW43 } from './tables.ts';
import {
  chooseTableAndCost,
  chooseCount1Table,
  writePair,
  writeCount1,
  MAX_QUANT,
} from './huffman-encode.ts';
import { EncodeError } from '../errors.ts';
import type { BitWriter } from '../io/bits.ts';

/** Rounding offset for the power-law quantiser, from ISO/IEC 11172-3 Annex B. */
const QUANT_ROUNDING = 0.4054;

/**
 * How the 576 lines divide into bands that each carry their own scalefactor.
 *
 * Long and short granules disagree about almost everything here — how many
 * bands there are, where they sit, how many scalefactors are transmitted, and
 * in what order — so the quantiser works through this description rather than
 * branching on block type in every loop.
 *
 * For a short granule the bands run scalefactor-band first, then window, which
 * is the order the bitstream carries and therefore the order the 576 lines are
 * already in by the time they reach here.
 */
interface BandLayout {
  /** Number of bands, each a contiguous run of lines. */
  count: number;
  start: Int32Array;
  end: Int32Array;
  /** Which scalefactor each band uses; several bands may share one. */
  slot: Int32Array;
  /** Short-block window, 0 for long granules. */
  window: Int32Array;
  /** Scalefactor band index, for the pre-emphasis table and slen grouping. */
  band: Int32Array;
  /** How many scalefactors are transmitted. */
  slots: number;
  short: boolean;
}

const LAYOUT_CACHE = new Map<string, BandLayout>();

/** Builds — and caches — the band layout for a sample rate and block type. */
function layoutFor(sampleRate: number, short: boolean): BandLayout {
  const key = `${sampleRate}:${short}`;
  const cached = LAYOUT_CACHE.get(key);
  if (cached) return cached;

  const start: number[] = [];
  const end: number[] = [];
  const slot: number[] = [];
  const windowOf: number[] = [];
  const band: number[] = [];

  if (short) {
    const bands = SFB_SHORT[sampleRate];
    if (!bands) throw new EncodeError(`No short scalefactor band table for ${sampleRate} Hz.`);

    let position = 0;
    for (let sfb = 0; sfb < 13; sfb++) {
      const width = bands[sfb + 1]! - bands[sfb]!;
      for (let w = 0; w < 3; w++) {
        start.push(position);
        end.push(Math.min(position + width, 576));
        slot.push(w * 13 + sfb);
        windowOf.push(w);
        band.push(sfb);
        position += width;
      }
    }
  } else {
    const bands = SFB_LONG[sampleRate];
    if (!bands) throw new EncodeError(`No scalefactor band table for ${sampleRate} Hz.`);

    for (let sfb = 0; sfb < 22; sfb++) {
      start.push(bands[sfb]!);
      end.push(Math.min(bands[sfb + 1]!, 576));
      slot.push(sfb);
      windowOf.push(0);
      band.push(sfb);
    }
  }

  const layout: BandLayout = {
    count: start.length,
    start: Int32Array.from(start),
    end: Int32Array.from(end),
    slot: Int32Array.from(slot),
    window: Int32Array.from(windowOf),
    band: Int32Array.from(band),
    slots: short ? 39 : 22,
    short,
  };
  LAYOUT_CACHE.set(key, layout);
  return layout;
}

/**
 * Largest transmissible scalefactor, which is not the same in both groups.
 *
 * `scalefac_compress` picks a pair of widths from a fixed table, and while
 * `slen1` reaches 4 bits, `slen2` never exceeds 3 — so the upper group cannot
 * carry anything above 7 no matter which index is chosen. Exceeding it does not
 * truncate; it leaves *no* legal `scalefac_compress` at all, and the granule is
 * lost. That failure is silent and total, which is how it went unnoticed until
 * an allocation that used the full range turned whole passages into silence.
 *
 * The split falls in a different place for short granules: `slen1` covers
 * scalefactor bands 0–5 and `slen2` bands 6–11, across all three windows.
 */
function maxScalefactor(band: number, short: boolean): number {
  const upper = short ? band >= SHORT_SLEN2_START : band >= GROUP_SLEN2_START;
  return upper ? 7 : 15;
}

/** Bands 0-5 use slen1 in a short granule; 6-11 use slen2. Band 12 is never sent. */
const SHORT_SLEN2_START = 6;
const SHORT_LAST_CODED_BAND = 11;

/** Highest band index that carries a transmitted scalefactor, per block type. */
function lastCodedBand(short: boolean): number {
  return short ? SHORT_LAST_CODED_BAND : LAST_CODED_BAND;
}

/** Highest scalefactor band that has a transmitted scalefactor. Band 21 is always 0. */
const LAST_CODED_BAND = 20;

/** `part2_3_length` is a 12-bit field. */
export const MAX_PART2_3_LENGTH = 4095;

/** How the four long-block scalefactor groups map onto `slen1` / `slen2`. */
const GROUP_SLEN2_START = 11;

/** One granule and channel, coded and ready to write. */
export interface GranuleCoding {
  /** 576 quantised lines, signed. */
  values: Int32Array;
  globalGain: number;
  /** Transmitted scalefactors, bands 0–20. Bands 21–22 are always zero. */
  scalefactors: Int32Array;
  scalefacCompress: number;
  /** The multiplier the decoder applies, 0.5 or 1. */
  scalefacScale: number;
  preflag: boolean;
  bigValues: number;
  tableSelect: [number, number, number];
  region0Count: number;
  region1Count: number;
  count1TableSelect: number;
  /**
   * End of the count1 region. Not transmitted — the decoder infers it by running
   * out of declared bits — but the writer needs it to know when to stop.
   */
  count1End: number;
  scalefactorBits: number;
  huffmanBits: number;
  /** Scalefactor bits plus Huffman bits — what the side information declares. */
  part2_3Length: number;
  /** 0 long, 1 start, 2 three short windows, 3 stop. */
  blockType: number;
  /** Per-window attenuation, short blocks only. */
  subblockGain: Int32Array;
}

/** How the 576 lines divide into the three coding regions. */
interface Partition {
  /** End of the pair-coded region; always even. */
  bigValuesEnd: number;
  /** End of the count1 region, where the implicit zeros begin; always even. */
  rzeroStart: number;
}

/**
 * Splits the spectrum into big_values, count1 and rzero.
 *
 * Walking down from the top: trailing zeros cost nothing at all, and above the
 * point where everything has quantised to -1, 0 or +1 the four-at-a-time count1
 * tables are cheaper than pairs. Both scans step in the granularity the format
 * requires — pairs for big_values, quadruples for count1 — so the boundaries are
 * always legal.
 */
function partition(ix: Int32Array): Partition {
  let i = 576;
  while (i > 1 && ix[i - 1] === 0 && ix[i - 2] === 0) i -= 2;
  const rzeroStart = i;

  while (i > 3) {
    const a = ix[i - 1]!;
    const b = ix[i - 2]!;
    const c = ix[i - 3]!;
    const d = ix[i - 4]!;
    if (a > 1 || a < -1 || b > 1 || b < -1 || c > 1 || c < -1 || d > 1 || d < -1) break;
    i -= 4;
  }

  return { bigValuesEnd: i, rzeroStart };
}

/** Smallest scalefactor band index whose start is at or above `position`. */
function bandAtOrAbove(bands: Int16Array, position: number): number {
  let band = 0;
  while (band < 22 && bands[band]! < position) band++;
  return band;
}

/**
 * Picks where the three big_values regions divide.
 *
 * Each region gets its own Huffman table because low frequencies have very
 * different statistics from high ones. Splitting the coded range into rough
 * thirds by scalefactor band captures most of that: the exhaustive search over
 * all 16 × 8 legal splits buys another percent or two of bitrate and costs far
 * more than it returns at this stage, so it is left for the VBR work.
 */
function chooseRegions(bigValuesEnd: number, bands: Int16Array): [number, number] {
  if (bigValuesEnd <= 0) return [0, 0];

  const first = Math.max(1, bandAtOrAbove(bands, Math.floor(bigValuesEnd / 3)));
  const second = Math.max(first + 1, bandAtOrAbove(bands, Math.floor((2 * bigValuesEnd) / 3)));

  // region0Count is the *count* of bands in region 0, so the boundary band index
  // is one higher; the same offset by two applies to region 1.
  const region0Count = Math.min(15, first - 1);
  const region1Count = Math.min(7, Math.max(0, second - region0Count - 2));

  // The two counts index SFB_LONG together and must stay inside it.
  if (region0Count + region1Count + 2 > 22) {
    return [region0Count, Math.max(0, 20 - region0Count)];
  }
  return [region0Count, region1Count];
}

/** The Huffman layout and cost for one already-quantised granule. */
interface HuffmanCoding {
  bits: number;
  bigValues: number;
  tableSelect: [number, number, number];
  region0Count: number;
  region1Count: number;
  count1TableSelect: number;
  count1End: number;
}

/**
 * Where the three big_values regions begin, as sample positions.
 *
 * Shared by the cost estimator and the writer so the two cannot disagree — the
 * decoder picks a table purely from position, so a one-band difference between
 * what we costed and what we wrote would desynchronise the whole granule.
 *
 * Clamping to `bigValuesEnd` changes nothing the decoder sees: a boundary above
 * the coded range only means the region above it is empty either way.
 */
function regionStarts(
  region0Count: number,
  region1Count: number,
  bigValuesEnd: number,
  bands: Int16Array,
  blockType = 0,
): [number, number] {
  // With window switching — *any* of it, not just short blocks — the boundaries
  // are implied rather than transmitted, and only two table selects are sent.
  // The decoder never reads region0_count or region1_count for these granules,
  // so choosing them freely here produces a stream that parses and decodes to
  // noise: the encoder codes a pair with one table and the decoder reads it with
  // another. Transition blocks (types 1 and 3) lay their spectrum out like a
  // long block, so their split is a scalefactor band rather than line 36.
  if (blockType !== 0) {
    const implied = blockType === 2 ? 36 : (bands[8] ?? 36);
    return [Math.min(implied, bigValuesEnd), bigValuesEnd];
  }

  const first = Math.min(bands[Math.min(region0Count + 1, 22)]!, bigValuesEnd);
  const second = Math.min(
    bands[Math.min(region0Count + region1Count + 2, 22)]!,
    bigValuesEnd,
  );
  return [first, Math.max(first, second)];
}

/**
 * Chooses regions, tables and the count1 variant, and returns the total cost.
 *
 * Runs once per step-size trial, so it is the encoder's hot path.
 */
function codeGranule(ix: Int32Array, bands: Int16Array, blockType = 0): HuffmanCoding {
  const { bigValuesEnd, rzeroStart } = partition(ix);
  // Fixed when window switching is on; the decoder implies these and reads
  // neither from the bitstream.
  const switching = blockType !== 0;
  const impliedRegion0 = blockType === 2 ? 8 : 7;
  const [region0Count, region1Count] = switching
    ? [impliedRegion0, 20 - impliedRegion0]
    : chooseRegions(bigValuesEnd, bands);

  const [region1Start, region2Start] = regionStarts(
    region0Count,
    region1Count,
    bigValuesEnd,
    bands,
    blockType,
  );

  const r0 = chooseTableAndCost(ix, 0, region1Start);
  const r1 = chooseTableAndCost(ix, region1Start, region2Start);
  const r2 = chooseTableAndCost(ix, region2Start, bigValuesEnd);
  const count1 = chooseCount1Table(ix, bigValuesEnd, rzeroStart);

  return {
    bits: r0.bits + r1.bits + r2.bits + count1.bits,
    bigValues: bigValuesEnd / 2,
    tableSelect: [r0.table, r1.table, r2.table],
    region0Count,
    region1Count,
    count1TableSelect: count1.table,
    count1End: rzeroStart,
  };
}

/**
 * Writes one granule's Huffman data.
 *
 * The table for each pair follows from its position, exactly as the decoder
 * derives it. Nothing above `count1End` is written — the decoder treats the rest
 * as zero once the declared bits run out.
 *
 * @returns Bits written, which must equal the coding's `huffmanBits`.
 */
export function writeGranuleData(
  writer: BitWriter,
  coding: GranuleCoding,
  sampleRate: number,
): number {
  const bands = SFB_LONG[sampleRate];
  if (!bands) throw new EncodeError(`No scalefactor band table for ${sampleRate} Hz.`);

  const before = writer.bitLength;
  const bigValuesEnd = coding.bigValues * 2;
  const [region1Start, region2Start] = regionStarts(
    coding.region0Count,
    coding.region1Count,
    bigValuesEnd,
    bands,
    coding.blockType,
  );
  const values = coding.values;

  for (let i = 0; i < bigValuesEnd; i += 2) {
    const region = i < region1Start ? 0 : i < region2Start ? 1 : 2;
    const table = coding.tableSelect[region]!;
    if (table === 0) continue;
    writePair(writer, table, values[i]!, values[i + 1]!);
  }

  for (let i = bigValuesEnd; i < coding.count1End; i += 4) {
    writeCount1(
      writer,
      coding.count1TableSelect,
      values[i]!,
      values[i + 1]!,
      values[i + 2]!,
      values[i + 3]!,
    );
  }

  return writer.bitLength - before;
}

/**
 * Bits needed to hold a scalefactor of `value`.
 *
 * Returns 5 for anything above 15, which no `slen` provides — so the caller gets
 * `null` and reduces, rather than writing a value the field would truncate.
 */
function widthFor(value: number): number {
  if (value <= 0) return 0;
  if (value <= 1) return 1;
  if (value <= 3) return 2;
  if (value <= 7) return 3;
  if (value <= 15) return 4;
  return 5;
}

/**
 * Picks the cheapest `scalefac_compress` that can carry these scalefactors.
 *
 * The field selects a pair of bit widths — one for bands 0–10, one for 11–20 —
 * from a fixed table, so not every combination of widths is available and the
 * cheapest legal pair has to be searched for.
 *
 * @returns The index and its cost in bits, or `null` if the values do not fit.
 */
function chooseScalefacCompress(
  scalefactors: Int32Array,
  short = false,
): { index: number; bits: number } | null {
  let need1 = 0;
  let need2 = 0;
  // Counts differ with the block type: a long granule sends 11 then 10 values,
  // a short one sends six bands across three windows in each group.
  let count1: number;
  let count2: number;

  if (short) {
    for (let w = 0; w < 3; w++) {
      for (let band = 0; band < SHORT_SLEN2_START; band++) {
        need1 = Math.max(need1, widthFor(scalefactors[w * 13 + band]!));
      }
      for (let band = SHORT_SLEN2_START; band <= SHORT_LAST_CODED_BAND; band++) {
        need2 = Math.max(need2, widthFor(scalefactors[w * 13 + band]!));
      }
    }
    count1 = 3 * SHORT_SLEN2_START;
    count2 = 3 * (SHORT_LAST_CODED_BAND - SHORT_SLEN2_START + 1);
  } else {
    for (let band = 0; band < GROUP_SLEN2_START; band++) {
      need1 = Math.max(need1, widthFor(scalefactors[band]!));
    }
    for (let band = GROUP_SLEN2_START; band <= LAST_CODED_BAND; band++) {
      need2 = Math.max(need2, widthFor(scalefactors[band]!));
    }
    count1 = 11;
    count2 = 10;
  }

  let best: { index: number; bits: number } | null = null;
  for (let index = 0; index < 16; index++) {
    const slen1 = SLEN1[index]!;
    const slen2 = SLEN2[index]!;
    if (slen1 < need1 || slen2 < need2) continue;
    const bits = count1 * slen1 + count2 * slen2;
    if (!best || bits < best.bits) best = { index, bits };
  }
  return best;
}

/**
 * Fills `ix` from the spectrum at the given per-band step sizes.
 *
 * @param xr34 `|xr|^(3/4)`, precomputed once per granule — the expensive part of
 * the quantiser, and independent of the step size the loops are searching over.
 * @returns The largest magnitude produced, so the caller can reject a step size
 * that overflows the Huffman tables.
 */
function quantizeInto(
  xr: Float32Array,
  xr34: Float32Array,
  bandScale: Float32Array,
  layout: BandLayout,
  ix: Int32Array,
): number {
  let max = 0;
  const overflow = MAX_QUANT + 1;

  for (let b = 0; b < layout.count; b++) {
    const scale = bandScale[b]!;
    const end = layout.end[b]!;

    for (let i = layout.start[b]!; i < end; i++) {
      const q = xr34[i]! * scale + QUANT_ROUNDING;
      // Guard the truncation: `| 0` is only defined below 2^31, and a step size
      // far too fine can easily exceed that. The sentinel makes the caller
      // reject this trial rather than producing nonsense.
      const magnitude = q >= overflow ? overflow : q | 0;
      if (magnitude > max) max = magnitude;
      ix[i] = xr[i]! < 0 ? -magnitude : magnitude;
    }
  }

  return max;
}

/**
 * Fills the per-band step exponent, scale and gain for a trial.
 *
 * Short granules carry a third term: `subblock_gain` attenuates a whole window
 * at once, which is how the encoder keeps a transient's noise out of the two
 * quiet windows beside it without spending scalefactors on every band.
 */
function computeBandGains(
  globalGain: number,
  scalefactors: Int32Array,
  scalefacScale: number,
  preflag: boolean,
  layout: BandLayout,
  subblockGain: Int32Array,
  bandScale: Float32Array,
  bandGain: Float32Array,
): void {
  const base = (globalGain - 210) / 4;
  const last = lastCodedBand(layout.short);

  for (let b = 0; b < layout.count; b++) {
    const band = layout.band[b]!;
    const scalefactor =
      (band <= last ? scalefactors[layout.slot[b]!]! : 0) +
      (preflag && !layout.short ? PRETAB[band]! : 0);

    // The decoder subtracts 8 from the gain index per unit, and the index is in
    // quarter powers of two — so one unit is 2 in the exponent.
    const step =
      base - scalefacScale * scalefactor - (layout.short ? 2 * subblockGain[layout.window[b]!]! : 0);

    bandScale[b] = Math.pow(2, -0.75 * step);
    bandGain[b] = Math.pow(2, step);
  }
}

/** Scratch buffers reused across granules, so the encoder allocates nothing per frame. */
interface Workspace {
  xr34: Float32Array;
  ix: Int32Array;
  bandScale: Float32Array;
  bandGain: Float32Array;
  scalefactors: Int32Array;
  bestValues: Int32Array;
  bestScalefactors: Int32Array;
  distortion: Float32Array;
  subblockGain: Int32Array;
  bestSubblockGain: Int32Array;
}

/** Allocates the scratch buffers {@link quantizeGranule} needs. */
export function createWorkspace(): Workspace {
  return {
    xr34: new Float32Array(576),
    ix: new Int32Array(576),
    // Sized for the short layout, which has the most bands: 13 scalefactor
    // bands across three windows.
    bandScale: new Float32Array(39),
    bandGain: new Float32Array(39),
    scalefactors: new Int32Array(39),
    bestValues: new Int32Array(576),
    bestScalefactors: new Int32Array(39),
    distortion: new Float32Array(39),
    subblockGain: new Int32Array(3),
    bestSubblockGain: new Int32Array(3),
  };
}

export type { Workspace };


/**
 * Sets scalefactors so quantisation noise follows the masking curve.
 *
 * This is what makes a psychoacoustic model worth having at constant bitrate,
 * and it is not the same thing as the amplification loop below.
 *
 * The loop only ever *raises* precision in bands that exceed their threshold. If
 * the budget is comfortable enough that every band already passes — which it is,
 * for most material at 128 kbps and above — then nothing exceeds anything, the
 * loop exits on its first pass, and the model has changed precisely nothing.
 * Measured that way it looks worthless. The bits were never the problem; the
 * *distribution* was, and amplification alone cannot redistribute.
 *
 * Setting the scalefactors directly does. One scalefactor step is a factor of
 * two in noise power, so asking for noise proportional to the threshold is
 * simply
 *
 *     scalefactor = log2(loosest threshold / this band's threshold)
 *
 * with the loosest band pinned at zero. Every band then carries noise the same
 * distance below what masks it, the inner loop moves `global_gain` to make the
 * total fit, and the budget lands where the ear needs it rather than spread flat.
 */
function allocateScalefactors(
  thresholds: Float32Array,
  layout: BandLayout,
  spectrum: Float32Array,
  out: Int32Array,
): void {
  out.fill(0);
  const last = lastCodedBand(layout.short);

  // The reference is the most permissive band that actually carries signal; a
  // silent band would otherwise set an arbitrary ceiling and flatten everything.
  let loosest = 0;
  for (let b = 0; b < layout.count; b++) {
    if (layout.band[b]! > last) continue;

    let energy = 0;
    for (let i = layout.start[b]!; i < layout.end[b]!; i++) {
      energy += spectrum[i]! * spectrum[i]!;
    }
    if (energy <= 0) continue;

    const threshold = thresholds[layout.band[b]!]!;
    if (threshold > loosest) loosest = threshold;
  }

  if (loosest <= 0) return;

  for (let b = 0; b < layout.count; b++) {
    const band = layout.band[b]!;
    if (band > last) continue;
    const threshold = thresholds[band]!;
    if (threshold <= 0) continue;
    const steps = Math.log2(loosest / threshold);
    out[layout.slot[b]!] = Math.max(
      0,
      Math.min(maxScalefactor(band, layout.short), Math.round(steps)),
    );
  }
}

/**
 * Attenuates the quiet windows of a short granule.
 *
 * The three windows of a short block share one `global_gain`, so without this a
 * quiet window either side of a transient is quantised at the step size the loud
 * one needs — which is exactly the pre-echo short blocks exist to prevent, just
 * confined to 4 ms instead of 24. `subblock_gain` drops a window by whole steps
 * of 2 in the exponent, so each window can sit near its own level.
 *
 * The loudest window is pinned at zero, since `global_gain` covers it.
 */
function chooseSubblockGain(
  spectrum: Float32Array,
  layout: BandLayout,
  out: Int32Array,
): void {
  const energy = [0, 0, 0];
  for (let b = 0; b < layout.count; b++) {
    let sum = 0;
    for (let i = layout.start[b]!; i < layout.end[b]!; i++) sum += spectrum[i]! * spectrum[i]!;
    energy[layout.window[b]!]! += sum;
  }

  const loudest = Math.max(energy[0]!, energy[1]!, energy[2]!);
  if (loudest <= 0) {
    out.fill(0);
    return;
  }

  for (let w = 0; w < 3; w++) {
    if (energy[w]! <= 0) {
      out[w] = 7;
      continue;
    }
    // One unit is 2 in the exponent, so 4 in amplitude and 12 dB in power.
    const steps = Math.log2(loudest / energy[w]!) / 4;
    out[w] = Math.max(0, Math.min(7, Math.floor(steps)));
  }
}

/** Mean squared error per line in each band. */
function measureDistortion(
  xr: Float32Array,
  ix: Int32Array,
  bandGain: Float32Array,
  layout: BandLayout,
  out: Float32Array,
): void {
  for (let b = 0; b < layout.count; b++) {
    const start = layout.start[b]!;
    const end = layout.end[b]!;
    const gain = bandGain[b]!;

    let sum = 0;
    for (let i = start; i < end; i++) {
      const magnitude = ix[i]! < 0 ? -ix[i]! : ix[i]!;
      const reconstructed =
        (magnitude < POW43.length ? POW43[magnitude]! : Math.pow(magnitude, 4 / 3)) * gain;
      const source = xr[i]! < 0 ? -xr[i]! : xr[i]!;
      const error = source - reconstructed;
      sum += error * error;
    }

    out[b] = sum / Math.max(1, end - start);
  }
}

export interface QuantizeRequest {
  /** 576 spectral lines from the analysis filterbank. */
  spectrum: Float32Array;
  sampleRate: number;
  /** Bits available for scalefactors and Huffman data together. */
  budgetBits: number;
  /** How many times the outer loop may amplify bands. Only used with `thresholds`. */
  maxOuterIterations?: number;
  /**
   * Per-band noise allowance, as mean squared error per line. Indexed by
   * scalefactor band — 22 for a long granule, 13 for a short one, where all
   * three windows of a band share an entry.
   *
   * Defaults to `null` — no shaping, noise spread evenly. `PsychoacousticModel`
   * produces these; the encoder supplies them unless asked not to.
   */
  thresholds?: Float32Array | null;
  /**
   * 0 for a long granule, 2 for three short windows. Types 1 and 3 are the
   * transition windows and are quantised exactly like long blocks — only the
   * MDCT window differs, and that has already been applied by the analysis.
   */
  blockType?: number;
  /**
   * Spend as few bits as the thresholds allow, instead of as many as the budget
   * allows. Requires `thresholds`; `budgetBits` becomes a ceiling rather than a
   * target.
   *
   * This is the whole difference between constant and variable bitrate. Constant
   * bitrate asks "how good can this granule be in 417 bytes?" and always answers
   * with 417 bytes, whether the granule is a cymbal crash or a held note.
   * Variable bitrate asks "how few bytes make this granule transparent?" and
   * lets the size follow the material.
   */
  minimiseBits?: boolean;
}

/**
 * Codes one granule and channel into a bit budget.
 *
 * Always succeeds: if the budget cannot be met even at the coarsest step size —
 * which in practice means the budget is a handful of bits — the result is
 * silence rather than an exception, because dropping a granule is preferable to
 * emitting a frame no decoder can parse.
 */
export function quantizeGranule(
  request: QuantizeRequest,
  workspace: Workspace,
): GranuleCoding {
  const { spectrum, sampleRate, budgetBits } = request;
  const blockType = request.blockType ?? 0;
  const short = blockType === 2;
  const bands = SFB_LONG[sampleRate];
  if (!bands) {
    throw new EncodeError(`No scalefactor band table for ${sampleRate} Hz.`);
  }
  const layout = layoutFor(sampleRate, short);

  const {
    xr34,
    ix,
    bandScale,
    bandGain,
    scalefactors,
    bestValues,
    bestScalefactors,
    distortion,
    subblockGain,
    bestSubblockGain,
  } = workspace;
  subblockGain.fill(0);

  for (let i = 0; i < 576; i++) {
    const magnitude = spectrum[i]! < 0 ? -spectrum[i]! : spectrum[i]!;
    xr34[i] = Math.pow(magnitude, 0.75);
  }

  // An all-zero granule still needs a legal side-information block.
  if (regionMaxFloat(spectrum) === 0) {
    return silentGranule(workspace, blockType);
  }

  const shaping = request.thresholds ?? null;

  if (shaping) allocateScalefactors(shaping, layout, spectrum, scalefactors);
  else scalefactors.fill(0);

  if (short) chooseSubblockGain(spectrum, layout, subblockGain);

  // Minimising bits needs thresholds to minimise against, and its own search
  // already lands on the coarsest transparent step — so the amplification loop
  // has nothing left to do and runs once.
  const minimise = Boolean(request.minimiseBits && shaping);
  const maxOuter = shaping && !minimise ? (request.maxOuterIterations ?? 6) : 1;

  let best: GranuleCoding | null = null;
  let bestOver = Infinity;
  let gainHint = -1;

  for (let iteration = 0; iteration < maxOuter; iteration++) {
    const compress = chooseScalefacCompress(scalefactors, short);
    if (!compress) break;

    const huffmanBudget = budgetBits - compress.bits;
    if (huffmanBudget <= 0) break;

    const trial = minimise
      ? searchGainForQuality(
          spectrum,
          xr34,
          scalefactors,
          bands,
          blockType,
          layout,
          subblockGain,
          shaping!,
          ix,
          bandScale,
          bandGain,
          distortion,
          huffmanBudget,
        )
      : searchGain(
          spectrum,
          xr34,
          scalefactors,
          bands,
          blockType,
          layout,
          subblockGain,
          ix,
          bandScale,
          bandGain,
          huffmanBudget,
          gainHint,
        );
    if (!trial) break;
    gainHint = trial.globalGain;

    const total = compress.bits + trial.coding.bits;
    if (total > MAX_PART2_3_LENGTH) break;

    measureDistortion(spectrum, ix, bandGain, layout, distortion);

    const last = lastCodedBand(short);
    let over = 0;
    for (let b = 0; b < layout.count; b++) {
      if (layout.band[b]! > last) continue;
      if (shaping && distortion[b]! > shaping[layout.band[b]!]!) over++;
    }

    if (!best || over < bestOver) {
      bestOver = over;
      bestValues.set(ix);
      bestScalefactors.set(scalefactors);
      bestSubblockGain.set(subblockGain);
      best = {
        values: bestValues,
        globalGain: trial.globalGain,
        scalefactors: bestScalefactors,
        scalefacCompress: compress.index,
        scalefacScale: 0.5,
        preflag: false,
        bigValues: trial.coding.bigValues,
        tableSelect: trial.coding.tableSelect,
        region0Count: trial.coding.region0Count,
        region1Count: trial.coding.region1Count,
        count1TableSelect: trial.coding.count1TableSelect,
        count1End: trial.coding.count1End,
        scalefactorBits: compress.bits,
        huffmanBits: trial.coding.bits,
        part2_3Length: total,
        blockType,
        subblockGain: bestSubblockGain,
      };
    }

    if (!shaping || over === 0) break;

    // Amplifying every band at once is indistinguishable from lowering
    // global_gain, so it cannot improve anything — the classic stopping rule.
    let amplified = 0;
    let overflowed = false;
    for (let b = 0; b < layout.count; b++) {
      const band = layout.band[b]!;
      if (band > last) continue;
      if (distortion[b]! <= shaping[band]!) continue;
      const slot = layout.slot[b]!;
      if (scalefactors[slot]! >= maxScalefactor(band, short)) {
        overflowed = true;
        continue;
      }
      scalefactors[slot]!++;
      amplified++;
    }
    if (amplified === 0 || overflowed) break;
  }

  if (best) return best;

  // Nothing survived the shaping path. Rather than drop a granule that has real
  // audio in it — which is what silence would mean, and it is inaudible in
  // testing until whole passages go missing — fall back to quantising flat.
  if (shaping) {
    return quantizeGranule({ ...request, thresholds: null }, workspace);
  }
  return silentGranule(workspace, blockType);
}

/** Largest magnitude in a float spectrum. */
function regionMaxFloat(spectrum: Float32Array): number {
  let max = 0;
  for (let i = 0; i < spectrum.length; i++) {
    const magnitude = spectrum[i]! < 0 ? -spectrum[i]! : spectrum[i]!;
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/** A granule that codes nothing: legal, costs no main data, decodes to silence. */
function silentGranule(workspace: Workspace, blockType = 0): GranuleCoding {
  workspace.bestValues.fill(0);
  workspace.bestScalefactors.fill(0);
  workspace.bestSubblockGain.fill(0);
  return {
    blockType,
    subblockGain: workspace.bestSubblockGain,
    values: workspace.bestValues,
    globalGain: 210,
    scalefactors: workspace.bestScalefactors,
    scalefacCompress: 0,
    scalefacScale: 0.5,
    preflag: false,
    bigValues: 0,
    tableSelect: [0, 0, 0],
    region0Count: 0,
    region1Count: 0,
    count1TableSelect: 0,
    count1End: 0,
    scalefactorBits: 0,
    huffmanBits: 0,
    part2_3Length: 0,
  };
}

/**
 * The inner loop: smallest `global_gain` whose coded size fits `budgetBits`.
 *
 * Both constraints the gain has to satisfy — the bit budget, and the Huffman
 * tables' ceiling on magnitude — relax as the gain rises, so the predicate is
 * monotone and a binary search over the 8-bit field settles it in eight trials.
 * Table switching makes it very slightly non-monotone in practice, so the result
 * is verified and walked upwards if the search landed a step short.
 *
 * `hint` skips the search entirely when a previous outer-loop iteration already
 * found a nearby answer, which is the common case after the first amplification.
 */
function searchGain(
  xr: Float32Array,
  xr34: Float32Array,
  scalefactors: Int32Array,
  bands: Int16Array,
  blockType: number,
  layout: BandLayout,
  subblockGain: Int32Array,
  ix: Int32Array,
  bandScale: Float32Array,
  bandGain: Float32Array,
  budgetBits: number,
  hint: number,
): { globalGain: number; coding: HuffmanCoding } | null {
  const evaluate = (gain: number): HuffmanCoding | null => {
    computeBandGains(gain, scalefactors, 0.5, false, layout, subblockGain, bandScale, bandGain);
    const max = quantizeInto(xr, xr34, bandScale, layout, ix);
    if (max > MAX_QUANT) return null;
    const coding = codeGranule(ix, bands, blockType);
    return coding.bits <= budgetBits ? coding : null;
  };

  let candidate: number;

  if (hint >= 0) {
    // Amplification only ever needs *more* gain, and usually one or two steps.
    candidate = hint;
    let found: HuffmanCoding | null = null;
    for (let step = 0; step < 24 && candidate <= 255; step++) {
      found = evaluate(candidate);
      if (found) return { globalGain: candidate, coding: found };
      candidate++;
    }
    return null;
  }

  let low = 0;
  let high = 255;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (evaluate(mid)) high = mid;
    else low = mid + 1;
  }

  candidate = low;
  for (let step = 0; step < 8 && candidate <= 255; step++) {
    const coding = evaluate(candidate);
    if (coding) return { globalGain: candidate, coding };
    candidate++;
  }
  return null;
}

/**
 * The variable-bitrate inner loop: the *coarsest* step size that still meets
 * every band's threshold.
 *
 * The constant-bitrate search above finds the finest step the budget allows, so
 * it always spends the whole budget. This one runs the other way and spends
 * whatever transparency costs — which on quiet or simple material is far less.
 *
 * The predicate is not monotone across the whole range: below some gain the
 * quantised values overflow the Huffman tables, so the pattern is fail, pass,
 * fail rather than pass, fail. The lower bound is established first, and the
 * binary search runs only above it, where "meets the thresholds" does decrease
 * monotonically with gain.
 */
function searchGainForQuality(
  xr: Float32Array,
  xr34: Float32Array,
  scalefactors: Int32Array,
  bands: Int16Array,
  blockType: number,
  layout: BandLayout,
  subblockGain: Int32Array,
  thresholds: Float32Array,
  ix: Int32Array,
  bandScale: Float32Array,
  bandGain: Float32Array,
  distortion: Float32Array,
  ceilingBits: number,
): { globalGain: number; coding: HuffmanCoding } | null {
  const last = lastCodedBand(layout.short);

  const code = (gain: number): HuffmanCoding | null => {
    computeBandGains(gain, scalefactors, 0.5, false, layout, subblockGain, bandScale, bandGain);
    const max = quantizeInto(xr, xr34, bandScale, layout, ix);
    if (max > MAX_QUANT) return null;
    return codeGranule(ix, bands, blockType);
  };

  const transparent = (): boolean => {
    measureDistortion(xr, ix, bandGain, layout, distortion);
    for (let b = 0; b < layout.count; b++) {
      const band = layout.band[b]!;
      if (band > last) continue;
      if (distortion[b]! > thresholds[band]!) return false;
    }
    return true;
  };

  // Smallest gain whose values fit the Huffman tables at all.
  let low = 0;
  let high = 255;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (code(mid)) high = mid;
    else low = mid + 1;
  }
  const floor = low;
  if (!code(floor)) return null;

  // Largest gain that is still transparent, searched above that floor.
  let best = -1;
  let lo = floor;
  let hi = 255;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const coding = code(mid);
    if (coding && transparent()) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Nothing was transparent — the thresholds cannot be met at any step size, so
  // fall back to the finest the ceiling allows and accept the audible noise.
  if (best < 0) best = floor;

  let candidate = best;
  for (let step = 0; step < 32 && candidate <= 255; step++) {
    const coding = code(candidate);
    if (coding && coding.bits <= ceilingBits) {
      return { globalGain: candidate, coding };
    }
    // Over the ceiling: coarsen until it fits. This is the only place variable
    // bitrate gives ground, and it happens when a granule wants more than the
    // format's largest frame can hold.
    candidate++;
  }
  return null;
}

export { partition, chooseRegions, chooseScalefacCompress, codeGranule, regionStarts };
export type { HuffmanCoding, Partition };
