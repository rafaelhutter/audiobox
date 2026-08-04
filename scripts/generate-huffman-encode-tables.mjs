/**
 * Generates `src/mp3/huffman-encode-tables.ts` by walking the decode trie.
 *
 * ## Why derive rather than transcribe
 *
 * Encoding needs the inverse of what the decoder has: `(x, y) → (codeword,
 * length)` for 32 tables, plus the two count1 tables. That is another ~5,000
 * specification constants, and this codebase has already paid twice for
 * hand-transcribed tables — once in the Huffman data itself, once in the
 * synthesis window, where a wrong sign convention produced audio that measured
 * almost right and sounded wrong.
 *
 * The decode trie already contains every codeword. Walking it recursively
 * recovers each one exactly: descend through the internal nodes accumulating the
 * bits consumed, and at each leaf the path taken *is* the codeword.
 *
 * ## Why this is self-verifying
 *
 * Every generated `(code, length)` is fed straight back through a decode walk
 * and must return the pair it was generated for, consuming exactly `length`
 * bits. Combined with the Kraft equality check per table — the code lengths of a
 * complete prefix code must satisfy `Σ 2^-len = 1` — a clean run is a proof that
 * the tables are correct and complete, not a spot check.
 *
 * Usage:
 *   node scripts/generate-huffman-encode-tables.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HUFFMAN_TABS,
  HUFFMAN_TABLE_INDEX,
  COUNT1_TABLE_A,
  COUNT1_TABLE_B,
} from '../dist/esm/mp3/huffman-tables.js';

// --- Walk the big-values trie ----------------------------------------------

/**
 * Recovers every codeword in one table.
 *
 * At each level the decoder peeks `width` bits and indexes the table. A negative
 * entry is an internal node carrying the next peek width and a sub-table offset;
 * a positive entry is a leaf whose top byte is the number of bits this level
 * consumes. The codeword is the concatenation of the bits taken along the way.
 */
function walkTable(tableOffset) {
  const found = new Map(); // "x,y" -> { code, length }

  const descend = (consumed, prefix, width, base) => {
    for (let q = 0; q < 1 << width; q++) {
      const entry = HUFFMAN_TABS[tableOffset + base + q];
      if (entry === undefined) continue;

      if (entry < 0) {
        // Internal node: this level consumes all `width` bits.
        descend(consumed + width, (prefix << width) | q, entry & 7, -(entry >> 3));
        continue;
      }

      const levelBits = entry >> 8;
      if (levelBits === 0 || levelBits > width) continue;

      const length = consumed + levelBits;
      // Only the top `levelBits` of q are part of the codeword; the rest of the
      // peek window is why one leaf appears at several indices.
      const code = (prefix << levelBits) | (q >> (width - levelBits));

      const x = entry & 0x0f;
      const y = (entry >> 4) & 0x0f;
      const key = `${x},${y}`;

      const existing = found.get(key);
      if (existing) {
        if (existing.code !== code || existing.length !== length) {
          throw new Error(
            `Table at ${tableOffset}: (${x},${y}) has two different codes — ` +
              `${existing.code}/${existing.length} and ${code}/${length}`,
          );
        }
      } else {
        found.set(key, { code, length, x, y });
      }
    }
  };

  descend(0, 0, 5, 0);
  return found;
}

/** Decodes a codeword back through the trie. Mirrors `readLeaf` in huffman.ts. */
function decodeWord(tableOffset, code, length) {
  // Present the codeword MSB-first in a wide enough window.
  const peek = (position, count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = position + i < length ? (code >> (length - 1 - position - i)) & 1 : 0;
      value = (value << 1) | bit;
    }
    return value;
  };

  let position = 0;
  let width = 5;
  let base = 0;

  for (let guard = 0; guard < 8; guard++) {
    const entry = HUFFMAN_TABS[tableOffset + base + peek(position, width)];
    if (entry === undefined) return null;

    if (entry < 0) {
      position += width;
      width = entry & 7;
      base = -(entry >> 3);
      continue;
    }

    return { x: entry & 0x0f, y: (entry >> 4) & 0x0f, consumed: position + (entry >> 8) };
  }
  return null;
}

// --- Walk the count1 tables -------------------------------------------------

/**
 * Recovers the codewords of a count1 table.
 *
 * count1 codes quadruples that are each -1, 0 or +1; the Huffman code carries
 * only *which* of the four are non-zero, as a 4-bit mask, with the signs sent
 * separately. Unlike the big-values tables the leaf's length field is the total,
 * not a per-level figure.
 */
function walkCount1(table) {
  const found = new Map(); // mask -> { code, length }

  const record = (mask, code, length) => {
    const existing = found.get(mask);
    if (existing) {
      if (existing.code !== code || existing.length !== length) {
        throw new Error(`count1 mask ${mask} has two different codes`);
      }
    } else {
      found.set(mask, { code, length });
    }
  };

  for (let p = 0; p < 16; p++) {
    const entry = table[p];

    if (entry & 8) {
      const length = entry & 7;
      if (length === 0 || length > 4) continue;
      record((entry >> 4) & 0x0f, p >> (4 - length), length);
      continue;
    }

    // Two-level: `extra` more bits select within a sub-table.
    const extra = entry & 3;
    const base = entry >> 3;
    for (let q = 0; q < 1 << extra; q++) {
      const leaf = table[base + q];
      if (leaf === undefined) continue;
      const length = leaf & 7;
      const total = 4 + extra;
      if (length === 0 || length > total) continue;
      record((leaf >> 4) & 0x0f, ((p << extra) | q) >> (total - length), length);
    }
  }

  return found;
}

/** Decodes a count1 codeword back, mirroring the decoder's two-level lookup. */
function decodeCount1(table, code, length) {
  const peek = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | (i < length ? (code >> (length - 1 - i)) & 1 : 0);
    }
    return value;
  };

  let leaf = table[peek(4)];
  if (!(leaf & 8)) {
    const extra = leaf & 3;
    leaf = table[(leaf >> 3) + (peek(4 + extra) & ((1 << extra) - 1))];
  }
  return { mask: (leaf >> 4) & 0x0f, consumed: leaf & 7 };
}

// --- Build, verify, emit ----------------------------------------------------

const tables = [];
let totalEntries = 0;

for (let t = 0; t < 32; t++) {
  const offset = HUFFMAN_TABLE_INDEX[t];
  // Tables 4 and 14 are unused by the format and share offset 0 with table 0.
  const entries = t === 0 || offset === 0 ? new Map() : walkTable(offset);

  let maxX = 0;
  let maxY = 0;
  for (const { x, y } of entries.values()) {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const xlen = entries.size ? maxX + 1 : 0;
  const ylen = entries.size ? maxY + 1 : 0;

  tables.push({ index: t, offset, entries, xlen, ylen });
  totalEntries += entries.size;
}

// Verification 1: every codeword decodes back to its own pair.
let verified = 0;
for (const { index, offset, entries } of tables) {
  for (const { x, y, code, length } of entries.values()) {
    const back = decodeWord(offset, code, length);
    if (!back || back.x !== x || back.y !== y || back.consumed !== length) {
      throw new Error(
        `Table ${index}: (${x},${y}) code ${code}/${length} decoded as ` +
          `${back ? `(${back.x},${back.y})/${back.consumed}` : 'nothing'}`,
      );
    }
    verified++;
  }
}

// Verification 2: Kraft equality. A complete prefix code sums to exactly 1.
for (const { index, entries } of tables) {
  if (entries.size === 0) continue;
  let kraft = 0;
  for (const { length } of entries.values()) kraft += 2 ** -length;
  if (Math.abs(kraft - 1) > 1e-9) {
    throw new Error(`Table ${index}: Kraft sum is ${kraft}, expected 1 — the table is incomplete`);
  }
}

const count1 = [
  { name: 'A', table: COUNT1_TABLE_A, entries: walkCount1(COUNT1_TABLE_A) },
  { name: 'B', table: COUNT1_TABLE_B, entries: walkCount1(COUNT1_TABLE_B) },
];

for (const { name, table, entries } of count1) {
  for (const [mask, { code, length }] of entries) {
    const back = decodeCount1(table, code, length);
    if (back.mask !== mask || back.consumed !== length) {
      throw new Error(
        `count1 ${name}: mask ${mask} code ${code}/${length} decoded as ${back.mask}/${back.consumed}`,
      );
    }
    verified++;
  }
  let kraft = 0;
  for (const { length } of entries.values()) kraft += 2 ** -length;
  if (Math.abs(kraft - 1) > 1e-9) {
    throw new Error(`count1 ${name}: Kraft sum is ${kraft}, expected 1`);
  }
}

console.log(`Recovered ${totalEntries} big-values codewords across 32 tables`);
console.log(`Recovered ${count1[0].entries.size} + ${count1[1].entries.size} count1 codewords`);
console.log(`Verified ${verified} codewords by decoding each one back`);
console.log('Kraft equality holds for every non-empty table');

// Flat storage: one packed word per (x, y), tables laid end to end.
const offsets = new Uint16Array(32);
const xlens = new Uint8Array(32);
const ylens = new Uint8Array(32);
const packed = [];

for (const { index, entries, xlen, ylen } of tables) {
  offsets[index] = packed.length;
  xlens[index] = xlen;
  ylens[index] = ylen;
  for (let x = 0; x < xlen; x++) {
    for (let y = 0; y < ylen; y++) {
      const entry = entries.get(`${x},${y}`);
      // (length << 20) | code — lengths reach 19 bits, codes 19 bits.
      packed.push(entry ? (entry.length << 20) | entry.code : 0);
    }
  }
}

const packCount1 = (entries) => {
  const out = new Uint16Array(16);
  for (const [mask, { code, length }] of entries) out[mask] = (length << 12) | code;
  return Array.from(out);
};

const format = (values, radix = 10) => {
  const lines = [];
  let line = '  ';
  for (const v of values) {
    const token = `${radix === 16 ? `0x${v.toString(16)}` : v},`;
    if (line.length + token.length > 98) {
      lines.push(line.trimEnd());
      line = '  ';
    }
    line += `${token} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
};

const file = `/**
 * MPEG-1 Layer III Huffman **encoding** tables.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generate-huffman-encode-tables.mjs
 *
 * Derived by walking the decode trie in \`huffman-tables.ts\` rather than
 * transcribed: every codeword the decoder recognises is recovered by descending
 * the trie and recording the path taken to each leaf.
 *
 * Each generated codeword is verified at build time by decoding it back — it
 * must return the pair it was generated for and consume exactly its stated
 * length — and every table is checked for Kraft equality, so a successful
 * generation is a proof of completeness rather than a sample.
 *
 * ## Layout
 *
 * {@link HUFFMAN_ENCODE} holds one packed word per (x, y) pair, with tables laid
 * end to end. For table \`t\`, the entry for \`(x, y)\` is at
 * \`HUFFMAN_ENCODE_OFFSET[t] + x * HUFFMAN_ENCODE_YLEN[t] + y\`, packed as
 * \`(length << 20) | codeword\`. A zero entry means the pair is not in that table.
 */

/** Packed \`(length << 20) | codeword\`, all 32 tables end to end. */
export const HUFFMAN_ENCODE = new Uint32Array([
${format(packed)}
]);

/** Start index of each table within {@link HUFFMAN_ENCODE}. */
export const HUFFMAN_ENCODE_OFFSET = new Uint16Array([
${format(Array.from(offsets))}
]);

/** Number of distinct x values each table codes. Zero for unused tables. */
export const HUFFMAN_ENCODE_XLEN = new Uint8Array([
${format(Array.from(xlens))}
]);

/** Number of distinct y values each table codes; also the row stride. */
export const HUFFMAN_ENCODE_YLEN = new Uint8Array([
${format(Array.from(ylens))}
]);

/**
 * count1 table A, indexed by the 4-bit non-zero mask, packed as
 * \`(length << 12) | codeword\`.
 */
export const COUNT1_ENCODE_A = new Uint16Array([
${format(packCount1(count1[0].entries))}
]);

/** count1 table B — a flat 4-bit code. Same packing as {@link COUNT1_ENCODE_A}. */
export const COUNT1_ENCODE_B = new Uint16Array([
${format(packCount1(count1[1].entries))}
]);
`;

writeFileSync(fileURLToPath(new URL('../src/mp3/huffman-encode-tables.ts', import.meta.url)), file);
console.log(`\nWrote src/mp3/huffman-encode-tables.ts (${packed.length} packed entries)`);
