/**
 * Huffman coding on the encode side.
 *
 * The mirror of `huffman.ts`. Two jobs, and the second matters as much as the
 * first: writing the codewords, and *costing* them without writing anything.
 *
 * The quantiser's inner loop works by repeatedly asking "how many bits would
 * this granule take at this step size?" and adjusting until the answer fits the
 * frame. That question gets asked thousands of times per second of audio, so
 * {@link pairCost} and {@link regionCost} exist to answer it by table lookup
 * rather than by encoding into a throwaway buffer.
 */

import { InvalidArgumentError } from '../errors.ts';
import type { BitWriter } from '../io/bits.ts';
import { HUFFMAN_LINBITS } from './tables.ts';
import {
  HUFFMAN_ENCODE,
  HUFFMAN_ENCODE_OFFSET,
  HUFFMAN_ENCODE_XLEN,
  HUFFMAN_ENCODE_YLEN,
  COUNT1_ENCODE_A,
  COUNT1_ENCODE_B,
} from './huffman-encode-tables.ts';

/**
 * Finds the packed codeword for a pair, handling the escape mechanism.
 *
 * Tables 16–31 code magnitudes above 14 as the symbol 15 followed by `linbits`
 * raw bits holding the excess. That caps what each table can represent, which is
 * why table selection has to be able to reject a table rather than assume any
 * table can code anything.
 */
function lookupPair(
  table: number,
  absX: number,
  absY: number,
): { packed: number; extraX: number; extraY: number; linbits: number } | null {
  const ylen = HUFFMAN_ENCODE_YLEN[table]!;
  if (ylen === 0) return null;

  const xlen = HUFFMAN_ENCODE_XLEN[table]!;
  const linbits = HUFFMAN_LINBITS[table]!;

  let x = absX;
  let y = absY;
  let extraX = 0;
  let extraY = 0;

  if (linbits > 0) {
    const limit = 1 << linbits;
    if (x >= 15) {
      extraX = x - 15;
      x = 15;
      if (extraX >= limit) return null;
    }
    if (y >= 15) {
      extraY = y - 15;
      y = 15;
      if (extraY >= limit) return null;
    }
  }

  if (x >= xlen || y >= ylen) return null;

  const packed = HUFFMAN_ENCODE[HUFFMAN_ENCODE_OFFSET[table]! + x * ylen + y]!;
  // A zero word means the pair is absent from this table; a real codeword always
  // has a non-zero length in its high bits.
  if (packed === 0) return null;

  return { packed, extraX, extraY, linbits };
}

/**
 * Bits needed to code one pair with `table`, or `Infinity` if it cannot.
 *
 * Includes the escape bits and the one sign bit each non-zero value carries.
 */
export function pairCost(table: number, x: number, y: number): number {
  const absX = x < 0 ? -x : x;
  const absY = y < 0 ? -y : y;

  const found = lookupPair(table, absX, absY);
  if (!found) return Infinity;

  let bits = found.packed >>> 20;
  if (absX >= 15 && found.linbits > 0) bits += found.linbits;
  if (absX !== 0) bits += 1;
  if (absY >= 15 && found.linbits > 0) bits += found.linbits;
  if (absY !== 0) bits += 1;

  return bits;
}

/** Writes one pair: codeword, then any escape bits and sign bits. */
export function writePair(writer: BitWriter, table: number, x: number, y: number): void {
  const absX = x < 0 ? -x : x;
  const absY = y < 0 ? -y : y;

  const found = lookupPair(table, absX, absY);
  if (!found) {
    throw new InvalidArgumentError(
      `Huffman table ${table} cannot code the pair (${x}, ${y}).`,
    );
  }

  writer.bits(found.packed & 0xfffff, found.packed >>> 20);

  // Order matters: each value's escape bits precede its sign bit, and x comes
  // before y. The decoder reads them in exactly this order.
  if (absX >= 15 && found.linbits > 0) writer.bits(found.extraX, found.linbits);
  if (absX !== 0) writer.bit(x < 0 ? 1 : 0);

  if (absY >= 15 && found.linbits > 0) writer.bits(found.extraY, found.linbits);
  if (absY !== 0) writer.bit(y < 0 ? 1 : 0);
}

/**
 * Largest magnitude each table can represent.
 *
 * Derived from the table dimensions rather than listed: a table without linbits
 * tops out at `xlen - 1`, and one with linbits escapes at 15 and adds up to
 * `2^linbits - 1` on top. This is what lets {@link chooseTable} skip candidates
 * without costing them, and it is also the ceiling the quantiser's gain search
 * has to respect — nothing above `TABLE_MAX[23]` is expressible at all.
 */
export const TABLE_MAX = (() => {
  const max = new Int32Array(32);
  for (let table = 0; table < 32; table++) {
    const xlen = HUFFMAN_ENCODE_XLEN[table]!;
    if (xlen === 0) continue;
    const linbits = HUFFMAN_LINBITS[table]!;
    max[table] = linbits > 0 ? 14 + (1 << linbits) : xlen - 1;
  }
  return max;
})();

/** The largest quantised magnitude any Layer III table can code. */
export const MAX_QUANT = (() => {
  let max = 0;
  for (let table = 0; table < 32; table++) if (TABLE_MAX[table]! > max) max = TABLE_MAX[table]!;
  return max;
})();

/**
 * Total bits to code `values[start..end)` as pairs with `table`.
 *
 * `Infinity` when any pair is out of the table's range, which is what lets
 * {@link chooseTable} reject candidates cheaply.
 *
 * `ceiling` abandons the count as soon as it is exceeded. The caller is
 * searching for a minimum and does not care how much worse a losing candidate
 * is, and this runs inside the quantiser's inner loop.
 */
export function regionCost(
  values: Int32Array,
  start: number,
  end: number,
  table: number,
  ceiling = Infinity,
): number {
  if (table === 0) {
    // Table 0 codes nothing and costs nothing, but only if the region is silent.
    for (let i = start; i < end; i++) if (values[i] !== 0) return Infinity;
    return 0;
  }

  let bits = 0;
  for (let i = start; i < end; i += 2) {
    bits += pairCost(table, values[i]!, values[i + 1] ?? 0);
    if (bits >= ceiling) return Infinity;
  }
  return bits;
}

/** Largest magnitude in `values[start..end)`. */
export function regionMax(values: Int32Array, start: number, end: number): number {
  let max = 0;
  for (let i = start; i < end; i++) {
    const v = values[i]!;
    const magnitude = v < 0 ? -v : v;
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/**
 * Picks the cheapest table for a region.
 *
 * Tables 4 and 14 are not used by the format — the specification leaves those
 * slots empty — so they are skipped rather than costed. Candidates that cannot
 * reach the region's largest magnitude are skipped too, and the escape tables
 * (16–31) are only considered when something actually needs escaping: their
 * whole point is coding values above 15, and below that they lose to the plain
 * tables on every real signal.
 */
export function chooseTable(values: Int32Array, start: number, end: number): number {
  return chooseTableAndCost(values, start, end).table;
}

/**
 * As {@link chooseTable}, but also returns what the winning table costs.
 *
 * The rate control needs both, and getting them from one pass rather than two
 * matters: this runs once per region per step-size trial.
 */
export function chooseTableAndCost(
  values: Int32Array,
  start: number,
  end: number,
): { table: number; bits: number } {
  const max = regionMax(values, start, end);
  if (max === 0) return { table: 0, bits: 0 };

  let best = -1;
  let bestCost = Infinity;
  const first = max > 15 ? 16 : 1;
  const last = max > 15 ? 32 : 16;

  for (let table = first; table < last; table++) {
    if (table === 4 || table === 14) continue;
    if (TABLE_MAX[table]! < max) continue;

    const cost = regionCost(values, start, end, table, bestCost);
    if (cost < bestCost) {
      bestCost = cost;
      best = table;
    }
  }

  if (best < 0) {
    throw new InvalidArgumentError(
      `No Huffman table can code a magnitude of ${max}; the format tops out at ${MAX_QUANT}.`,
    );
  }
  return { table: best, bits: bestCost };
}

/** The 4-bit non-zero mask a count1 quadruple codes. */
function count1Mask(v: number, w: number, x: number, y: number): number {
  return (v !== 0 ? 8 : 0) | (w !== 0 ? 4 : 0) | (x !== 0 ? 2 : 0) | (y !== 0 ? 1 : 0);
}

/** Bits to code one count1 quadruple with the selected table. */
export function count1Cost(
  tableSelect: number,
  v: number,
  w: number,
  x: number,
  y: number,
): number {
  const table = tableSelect === 1 ? COUNT1_ENCODE_B : COUNT1_ENCODE_A;
  const packed = table[count1Mask(v, w, x, y)]!;
  if (packed === 0) return Infinity;

  let bits = packed >>> 12;
  if (v !== 0) bits++;
  if (w !== 0) bits++;
  if (x !== 0) bits++;
  if (y !== 0) bits++;
  return bits;
}

/**
 * Writes one count1 quadruple.
 *
 * Values must already be limited to -1, 0 or +1 — the count1 region exists
 * precisely because the high-frequency tail quantises to nothing else, and a
 * larger value here means the quantiser placed the region boundary wrongly.
 */
export function writeCount1(
  writer: BitWriter,
  tableSelect: number,
  v: number,
  w: number,
  x: number,
  y: number,
): void {
  const table = tableSelect === 1 ? COUNT1_ENCODE_B : COUNT1_ENCODE_A;
  const mask = count1Mask(v, w, x, y);
  const packed = table[mask]!;

  if (packed === 0) {
    throw new InvalidArgumentError(`count1 table ${tableSelect} cannot code mask ${mask}.`);
  }

  writer.bits(packed & 0x0fff, packed >>> 12);

  // Signs follow the codeword, in order, only for the non-zero values.
  if (v !== 0) writer.bit(v < 0 ? 1 : 0);
  if (w !== 0) writer.bit(w < 0 ? 1 : 0);
  if (x !== 0) writer.bit(x < 0 ? 1 : 0);
  if (y !== 0) writer.bit(y < 0 ? 1 : 0);
}

/** Whichever count1 table codes `values[start..end)` in fewer bits. */
export function chooseCount1Table(
  values: Int32Array,
  start: number,
  end: number,
): { table: number; bits: number } {
  let costA = 0;
  let costB = 0;

  for (let i = start; i + 3 < end; i += 4) {
    const v = values[i]!;
    const w = values[i + 1]!;
    const x = values[i + 2]!;
    const y = values[i + 3]!;
    costA += count1Cost(0, v, w, x, y);
    costB += count1Cost(1, v, w, x, y);
  }

  return costA <= costB ? { table: 0, bits: costA } : { table: 1, bits: costB };
}
