/**
 * Generates `src/mp3/huffman-tables.ts` from minimp3's packed Huffman tables.
 *
 * ## Why generated rather than hand-written
 *
 * The Layer III Huffman tables are ~1,500 specification constants. Transcribing
 * them by hand is a near-certain source of subtle errors that surface only as
 * distorted audio, and bisecting one bad entry out of 1,500 is miserable. So the
 * data is extracted mechanically from a known-good source and never retyped.
 *
 * ## Provenance and licensing
 *
 * Source: https://github.com/lieff/minimp3 — dedicated to the **public domain**
 * under CC0 1.0 Universal. CC0 imposes no conditions, so incorporating this data
 * into an MIT-licensed project is unencumbered. audiobox credits it anyway.
 *
 * This matters. A codec's tables are the bulk of its substance, and code
 * translated from a copyleft implementation carries those terms with it however
 * far the translation goes. Generating from a CC0 source is what keeps audiobox
 * cleanly MIT — and generating rather than transcribing is what keeps it correct.
 *
 * Usage:
 *   node scripts/generate-huffman-tables.mjs path/to/minimp3.h
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/generate-huffman-tables.mjs <minimp3.h>');
  process.exit(1);
}

const text = await readFile(source, 'utf8');

/** Pulls a C array initialiser out of the source by declaration name. */
function extractArray(name) {
  // Match `... name[...] = { ... };` across newlines.
  const pattern = new RegExp(`${name}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{([^}]*)\\}`, 's');
  const match = pattern.exec(text);
  if (!match) throw new Error(`Could not find array "${name}" in the source.`);

  const values = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`Non-numeric entry "${s}" in ${name}.`);
      return n;
    });

  return values;
}

const tabs = extractArray('tabs');
const tabindex = extractArray('tabindex');
const tab32 = extractArray('tab32');
const tab33 = extractArray('tab33');
const linbits = extractArray('g_linbits');

// --- Sanity checks, so a bad extraction fails here rather than in the decoder ---

if (tabindex.length !== 32) {
  throw new Error(`tabindex should have 32 entries, got ${tabindex.length}`);
}
if (linbits.length !== 32) {
  throw new Error(`g_linbits should have 32 entries, got ${linbits.length}`);
}
if (tab32.length !== 28) throw new Error(`tab32 should have 28 entries, got ${tab32.length}`);
if (tab33.length !== 16) throw new Error(`tab33 should have 16 entries, got ${tab33.length}`);
for (const offset of tabindex) {
  if (offset < 0 || offset >= tabs.length) {
    throw new Error(`tabindex entry ${offset} is outside tabs (length ${tabs.length})`);
  }
}
if (!tabs.every((v) => v >= -32768 && v <= 32767)) {
  throw new Error('tabs contains a value outside int16 range');
}

/** Formats a numeric array as wrapped source lines. */
function format(values, indent = '  ') {
  const lines = [];
  let line = indent;
  for (const value of values) {
    const token = `${value},`;
    if (line.length + token.length > 98) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${token} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}

const output = `/**
 * MPEG-1/2/2.5 Layer III Huffman decoding tables.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generate-huffman-tables.mjs <minimp3.h>
 *
 * ## Provenance
 *
 * Extracted from minimp3 (https://github.com/lieff/minimp3), dedicated to the
 * public domain under CC0 1.0 Universal. CC0 imposes no conditions, so this data
 * is unencumbered in an MIT-licensed project.
 *
 * The tables themselves are specification constants from ISO/IEC 11172-3; what
 * comes from minimp3 is the *packed representation*, which is far more compact
 * and faster to decode than the raw (codeword, length) listings in the standard.
 *
 * ## Representation
 *
 * {@link HUFFMAN_TABS} is a flattened multi-level trie shared by all 32 tables,
 * with {@link HUFFMAN_TABLE_INDEX} giving each table's starting offset.
 *
 * Decoding peeks 5 bits and indexes the table:
 *
 * - A **negative** entry is an internal node. Consume the bits just peeked, then
 *   peek \`entry & 7\` more and index at \`peeked - (entry >> 3)\`. Repeat.
 * - A **positive** entry is a leaf packing three fields:
 *   - \`entry >> 8\`      — codeword length in bits, to consume
 *   - \`entry & 0x0F\`    — magnitude of the first value (x)
 *   - \`(entry >> 4) & 0x0F\` — magnitude of the second value (y)
 *
 * A magnitude of 15 means "escape": read {@link HUFFMAN_LINBITS_TABLE} more bits
 * and add them. Each non-zero magnitude is followed by one sign bit.
 */

/** Packed trie shared by all 32 big-values tables. */
export const HUFFMAN_TABS = new Int16Array([
${format(tabs)}
]);

/** Offset into {@link HUFFMAN_TABS} for each of the 32 tables. */
export const HUFFMAN_TABLE_INDEX = new Uint16Array([
${format(tabindex)}
]);

/** Escape bit counts per table. Table numbers 16-31 use them; 0-15 never do. */
export const HUFFMAN_LINBITS_TABLE = new Uint8Array([
${format(linbits)}
]);

/**
 * count1 table A, used when \`count1_table_select\` is 0.
 *
 * The count1 region codes quadruples of values that are all -1, 0, or +1 — the
 * high-frequency tail where almost everything has quantized to nearly nothing.
 * Bits 128>>s of a leaf mark which of the four values are non-zero, and
 * \`leaf & 7\` is the codeword length.
 */
export const COUNT1_TABLE_A = new Uint8Array([
${format(tab32)}
]);

/** count1 table B, used when \`count1_table_select\` is 1. A flat 4-bit code. */
export const COUNT1_TABLE_B = new Uint8Array([
${format(tab33)}
]);
`;

const target = fileURLToPath(new URL('../src/mp3/huffman-tables.ts', import.meta.url));
await writeFile(target, output);

console.log(`Wrote src/mp3/huffman-tables.ts`);
console.log(`  tabs:      ${tabs.length} entries`);
console.log(`  tabindex:  ${tabindex.length} entries`);
console.log(`  count1 A:  ${tab32.length} entries`);
console.log(`  count1 B:  ${tab33.length} entries`);
