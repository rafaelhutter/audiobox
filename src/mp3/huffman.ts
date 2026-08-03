/**
 * Layer III scalefactor and Huffman decoding.
 *
 * This is where a granule's 576 frequency lines come from. Three regions, coded
 * differently because their statistics differ:
 *
 * 1. **big_values** — the low and mid frequencies, where real energy lives.
 *    Coded as (x, y) pairs from one of 32 Huffman tables, chosen per region.
 * 2. **count1** — the high-frequency tail, where almost everything has quantized
 *    to -1, 0, or +1. Coded as quadruples, since a general table would waste bits
 *    on values that never occur.
 * 3. **rzero** — everything above that is implicitly zero and costs nothing.
 *
 * The decoder does not know where count1 ends; it decodes until the granule's
 * declared `part2_3_length` bits are consumed. That is why {@link decodeHuffman}
 * takes a bit limit rather than a count.
 */

import { BitReader } from '../io/bits.ts';
import { DecodeError } from '../errors.ts';
import {
  HUFFMAN_TABS,
  HUFFMAN_TABLE_INDEX,
  HUFFMAN_LINBITS_TABLE,
  COUNT1_TABLE_A,
  COUNT1_TABLE_B,
} from './huffman-tables.ts';
import { SLEN1, SLEN2, SFB_LONG } from './tables.ts';
import type { GranuleInfo } from './sideinfo.ts';

/** Decoded scalefactors for one granule and channel. */
export interface Scalefactors {
  /** Per scalefactor band, for long blocks. 22 entries. */
  long: Int32Array;
  /** Per band per window, for short blocks. `short[window][band]`, 13 bands. */
  short: Int32Array[];
}

/** Allocates a reusable scalefactor structure. */
export function createScalefactors(): Scalefactors {
  return {
    long: new Int32Array(23),
    short: [new Int32Array(14), new Int32Array(14), new Int32Array(14)],
  };
}

/**
 * Decodes MPEG-1 scalefactors.
 *
 * `scfsi` lets granule 1 reuse granule 0's scalefactors for a band group rather
 * than retransmitting them — a meaningful saving, since scalefactors are sent
 * for every granule otherwise.
 */
export function decodeScalefactorsMpeg1(
  br: BitReader,
  granule: GranuleInfo,
  scfsi: number[],
  granuleIndex: number,
  previous: Scalefactors,
  out: Scalefactors,
): number {
  const startBits = br.bitsRead;
  const slen1 = SLEN1[granule.scalefacCompress]!;
  const slen2 = SLEN2[granule.scalefacCompress]!;

  if (granule.windowSwitching && granule.blockType === 2) {
    if (granule.mixedBlock) {
      // The lowest 8 bands stay long; the rest are short.
      for (let band = 0; band < 8; band++) out.long[band] = br.bits(slen1);
      for (let band = 3; band < 6; band++) {
        for (let window = 0; window < 3; window++) out.short[window]![band] = br.bits(slen1);
      }
      for (let band = 6; band < 12; band++) {
        for (let window = 0; window < 3; window++) out.short[window]![band] = br.bits(slen2);
      }
    } else {
      for (let band = 0; band < 6; band++) {
        for (let window = 0; window < 3; window++) out.short[window]![band] = br.bits(slen1);
      }
      for (let band = 6; band < 12; band++) {
        for (let window = 0; window < 3; window++) out.short[window]![band] = br.bits(slen2);
      }
    }
    // Band 12 is never transmitted and is always zero.
    for (let window = 0; window < 3; window++) out.short[window]![12] = 0;
  } else {
    // Long blocks: four groups, each optionally inherited from granule 0.
    const groups: Array<[number, number, number]> = [
      [0, 6, slen1],
      [6, 11, slen1],
      [11, 16, slen2],
      [16, 21, slen2],
    ];

    for (let group = 0; group < 4; group++) {
      const [start, end, bits] = groups[group]!;
      if (granuleIndex === 1 && scfsi[group] === 1) {
        // Reuse granule 0's values for this group.
        for (let band = start; band < end; band++) out.long[band] = previous.long[band]!;
      } else {
        for (let band = start; band < end; band++) out.long[band] = bits > 0 ? br.bits(bits) : 0;
      }
    }
    out.long[21] = 0;
    out.long[22] = 0;
  }

  return br.bitsRead - startBits;
}

/**
 * Scalefactor band counts per slot for MPEG-2 / 2.5.
 *
 * Indexed `[index][blockShape][slot]`, where `index` comes from the
 * `scalefac_compress` range and `blockShape` is 0 for long blocks, 1 for short,
 * 2 for mixed.
 */
const MPEG2_NR_TABLE: number[][][] = [
  [[6, 5, 5, 5], [9, 9, 9, 9], [6, 9, 9, 9]],
  [[6, 5, 7, 3], [9, 9, 12, 6], [6, 9, 12, 6]],
  [[11, 10, 0, 0], [18, 18, 0, 0], [15, 18, 0, 0]],
  [[7, 7, 7, 0], [12, 12, 12, 0], [6, 15, 12, 0]],
  [[6, 6, 6, 3], [12, 9, 9, 6], [6, 12, 9, 6]],
  [[8, 8, 5, 0], [15, 12, 9, 0], [6, 18, 9, 0]],
];

/**
 * Decodes MPEG-2 / 2.5 scalefactors.
 *
 * A different scheme entirely: `scalefac_compress` is 9 bits and encodes both the
 * band partitioning and the bit widths, rather than indexing a small table.
 */
export function decodeScalefactorsMpeg2(
  br: BitReader,
  granule: GranuleInfo,
  isIntensityRight: boolean,
  out: Scalefactors,
): number {
  const startBits = br.bitsRead;
  const shortBlock = granule.windowSwitching && granule.blockType === 2;
  const compress = granule.scalefacCompress;

  // Bit widths per slot. These formulas are from ISO/IEC 13818-3 §2.4.3.4.5 —
  // note the mixed radix (÷5, %5, ÷4, %4), which is easy to get subtly wrong and
  // shows up as granules missing their declared bit count by one or two bits.
  let slots: number[];
  let index: number;

  if (!isIntensityRight) {
    if (compress < 400) {
      const c = compress >> 4;
      slots = [Math.floor(c / 5), c % 5, (compress % 16) >> 2, compress % 4];
      index = 0;
    } else if (compress < 500) {
      const c = (compress - 400) >> 2;
      slots = [Math.floor(c / 5), c % 5, (compress - 400) % 4, 0];
      index = 1;
    } else {
      const c = compress - 500;
      slots = [Math.floor(c / 3), c % 3, 0, 0];
      index = 2;
    }
  } else {
    // The intensity-stereo right channel halves scalefac_compress first.
    const c = compress >> 1;
    if (c < 180) {
      slots = [Math.floor(c / 36), Math.floor((c % 36) / 6), (c % 36) % 6, 0];
      index = 3;
    } else if (c < 244) {
      const d = c - 180;
      slots = [(d % 64) >> 4, (d % 16) >> 2, d % 4, 0];
      index = 4;
    } else {
      const d = c - 244;
      slots = [Math.floor(d / 3), d % 3, 0, 0];
      index = 5;
    }
  }

  const blockShape = shortBlock ? (granule.mixedBlock ? 2 : 1) : 0;
  const bandCounts = MPEG2_NR_TABLE[index]![blockShape]!;

  let band = 0;
  let shortBand = 0;
  for (let slot = 0; slot < 4; slot++) {
    const bits = slots[slot]!;
    const count = bandCounts[slot]!;

    for (let i = 0; i < count; i++) {
      const value = bits > 0 ? br.bits(bits) : 0;
      if (shortBlock) {
        const window = shortBand % 3;
        const targetBand = Math.floor(shortBand / 3);
        if (targetBand < 13) out.short[window]![targetBand] = value;
        shortBand++;
      } else {
        if (band < 22) out.long[band] = value;
        band++;
      }
    }
  }

  return br.bitsRead - startBits;
}

/**
 * Boundaries between the three big_values regions, as **sample positions**.
 *
 * Each region uses its own Huffman table, because low frequencies have very
 * different statistics from high ones. The boundaries are given in sample
 * positions rather than scalefactor bands — a distinction that matters for short
 * blocks, where the 576 lines are three interleaved 192-line windows and "band
 * index" no longer maps onto a single position.
 *
 * When window switching is active only two tables are transmitted and the split
 * is fixed at sample 36.
 */
function regionBoundaries(granule: GranuleInfo, sampleRate: number): [number, number] {
  const bands = SFB_LONG[sampleRate]!;

  if (granule.windowSwitching) {
    // Only genuine short blocks use the fixed split at sample 36. The two
    // transition types (1 and 3) still lay their spectrum out like a long block,
    // so region 0 ends at scalefactor band 8.
    //
    // At 44.1 kHz SFB_LONG[8] is itself 36, so getting this wrong is invisible
    // in the most common case and only shows up on MPEG-2/2.5 material, where
    // the band boundary is 54.
    if (granule.blockType === 2) return [36, 576];
    return [bands[8] ?? 36, 576];
  }

  const region1 = bands[Math.min(granule.region0Count + 1, 22)] ?? 576;
  const region2 = bands[Math.min(granule.region0Count + granule.region1Count + 2, 22)] ?? 576;
  return [region1, region2];
}

export interface HuffmanResult {
  /** Quantized values, signed. Always 576 entries. */
  values: Int32Array;
  /** Index one past the last non-zero value. */
  nonZeroCount: number;
  /** Bits actually consumed. */
  bitsUsed: number;
}

/**
 * Decodes one granule's quantized frequency lines.
 *
 * @param br Positioned at the start of this granule's Huffman data.
 * @param maxBits `part2_3_length` minus the scalefactor bits already read.
 */
export function decodeHuffman(
  br: BitReader,
  granule: GranuleInfo,
  sampleRate: number,
  maxBits: number,
  out: Int32Array,
): HuffmanResult {
  out.fill(0);

  const startBits = br.bitsRead;
  const limit = startBits + maxBits;
  const [region1Start, region2Start] = regionBoundaries(granule, sampleRate);

  let position = 0;
  const valuesTotal = Math.min(granule.bigValues * 2, 576);

  // --- big_values ---
  while (position < valuesTotal) {
    if (br.bitsRead >= limit) {
      // Ran out of declared bits. Real files do this at the tail; whatever
      // remains stays zero rather than being treated as corruption.
      return finish(out, br, startBits, position);
    }

    // The table is chosen by where this pair sits in the spectrum.
    const region = position < region1Start ? 0 : position < region2Start ? 1 : 2;
    const tableNumber = granule.tableSelect[region] ?? 0;

    if (tableNumber === 0) {
      // Table 0 codes nothing; this region is all zeros.
      position += 2;
      continue;
    }

    const tableOffset = HUFFMAN_TABLE_INDEX[tableNumber]!;
    const linbits = HUFFMAN_LINBITS_TABLE[tableNumber]!;

    const leaf = readLeaf(br, tableOffset);
    let x = leaf & 0x0f;
    let y = (leaf >> 4) & 0x0f;

    if (x === 15 && linbits > 0) x += br.bits(linbits);
    if (x !== 0 && br.bit() === 1) x = -x;

    if (y === 15 && linbits > 0) y += br.bits(linbits);
    if (y !== 0 && br.bit() === 1) y = -y;

    out[position++] = x;
    out[position++] = y;
  }

  // --- count1 ---
  const countTable = granule.count1TableSelect === 1 ? COUNT1_TABLE_B : COUNT1_TABLE_A;

  while (br.bitsRead < limit && position + 4 <= 576) {
    let leaf = countTable[br.peek(4)]!;

    if ((leaf & 8) === 0) {
      // Two-level lookup: the first entry points at a sub-table.
      const extra = leaf & 3;
      const base = leaf >> 3;
      // Bits 4..4+extra of the lookahead select within the sub-table.
      const lookahead = br.peek(4 + extra);
      leaf = countTable[base + (lookahead & ((1 << extra) - 1))]!;
    }

    br.skip(leaf & 7);
    if (br.bitsRead > limit) break;

    for (let s = 0; s < 4; s++) {
      let value = 0;
      if (leaf & (128 >> s)) {
        value = br.bit() === 1 ? -1 : 1;
      }
      out[position++] = value;
    }
  }

  return finish(out, br, startBits, position);
}

function finish(
  out: Int32Array,
  br: BitReader,
  startBits: number,
  position: number,
): HuffmanResult {
  let nonZero = Math.min(position, 576);
  while (nonZero > 0 && out[nonZero - 1] === 0) nonZero--;
  return { values: out, nonZeroCount: nonZero, bitsUsed: br.bitsRead - startBits };
}

/**
 * Walks the packed trie for one (x, y) pair.
 *
 * Negative entries are internal nodes carrying the next peek width in their low
 * three bits and a table offset in the rest.
 */
function readLeaf(br: BitReader, tableOffset: number): number {
  let width = 5;
  let leaf = HUFFMAN_TABS[tableOffset + br.peek(width)]!;

  let guard = 0;
  while (leaf < 0) {
    br.skip(width);
    width = leaf & 7;
    // `leaf >> 3` is negative here, so subtracting it adds the sub-table offset.
    leaf = HUFFMAN_TABS[tableOffset + br.peek(width) - (leaf >> 3)]!;

    if (++guard > 8) {
      throw new DecodeError('MP3 Huffman trie did not terminate; the table index is corrupt.');
    }
  }

  br.skip(leaf >> 8);
  return leaf;
}
