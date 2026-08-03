/**
 * MPEG-1/2/2.5 Layer III constant tables, from ISO/IEC 11172-3 and 13818-3.
 *
 * These are specification data, not design decisions — the values are fixed by
 * the format and every conforming decoder uses exactly these. They live in their
 * own module so the `audiobox/mp3` bundle only pays for them when MP3 is
 * actually used.
 *
 * Where a table can be *computed* rather than listed, it is: the requantization
 * power table, the IMDCT windows, and the synthesis cosine matrix are all
 * generated at module load. That is a few microseconds of arithmetic in exchange
 * for several kilobytes of literals in every bundle, and it removes an entire
 * category of transcription error.
 */

/** Scalefactor band boundaries for long blocks, per sample rate. 22 bands + end. */
export const SFB_LONG: Record<number, Int16Array> = {
  // MPEG-1
  44100: new Int16Array([0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 52, 62, 74, 90, 110, 134, 162, 196, 238, 288, 342, 418, 576]),
  48000: new Int16Array([0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 50, 60, 72, 88, 106, 128, 156, 190, 230, 276, 330, 384, 576]),
  32000: new Int16Array([0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 54, 66, 82, 102, 126, 156, 194, 240, 296, 364, 448, 550, 576]),
  // MPEG-2
  22050: new Int16Array([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464, 522, 576]),
  24000: new Int16Array([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 114, 136, 162, 194, 232, 278, 332, 394, 464, 540, 576]),
  16000: new Int16Array([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464, 522, 576]),
  // MPEG-2.5
  11025: new Int16Array([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464, 522, 576]),
  12000: new Int16Array([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464, 522, 576]),
  8000: new Int16Array([0, 12, 24, 36, 48, 60, 72, 88, 108, 132, 160, 192, 232, 280, 336, 400, 476, 566, 568, 570, 572, 574, 576]),
};

/** Scalefactor band boundaries for short blocks, per sample rate. 13 bands + end. */
export const SFB_SHORT: Record<number, Int16Array> = {
  44100: new Int16Array([0, 4, 8, 12, 16, 22, 30, 40, 52, 66, 84, 106, 136, 192]),
  48000: new Int16Array([0, 4, 8, 12, 16, 22, 28, 38, 50, 64, 80, 100, 126, 192]),
  32000: new Int16Array([0, 4, 8, 12, 16, 22, 30, 42, 58, 78, 104, 138, 180, 192]),
  22050: new Int16Array([0, 4, 8, 12, 18, 24, 32, 42, 56, 74, 100, 132, 174, 192]),
  24000: new Int16Array([0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 136, 180, 192]),
  16000: new Int16Array([0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192]),
  11025: new Int16Array([0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192]),
  12000: new Int16Array([0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192]),
  8000: new Int16Array([0, 8, 16, 24, 36, 52, 72, 96, 124, 160, 162, 164, 166, 192]),
};

/**
 * Scalefactor bit lengths, selected by `scalefac_compress` (MPEG-1 only).
 *
 * `slen1` applies to bands 0–10, `slen2` to bands 11–20.
 */
export const SLEN1 = new Uint8Array([0, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4]);
export const SLEN2 = new Uint8Array([0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 2, 3]);

/**
 * Additional high-frequency emphasis, applied when `preflag` is set.
 *
 * A cheap way for the encoder to boost the top bands without spending
 * scalefactor bits on them.
 */
export const PRETAB = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 2, 0,
]);

/** How many scalefactor bands each of the two MPEG-1 groups covers. */
export const SFB_GROUP_BOUNDARY = 11;

/**
 * Number of linearly-coded extra bits for Huffman tables 16–31.
 *
 * Large values are coded as a Huffman escape followed by this many raw bits, so
 * the tables stay small while still covering the full dynamic range.
 */
export const HUFFMAN_LINBITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 2, 3, 4, 6, 8, 10, 13, 4, 5, 6, 7, 8, 9, 11, 13,
]);

// --- Computed tables --------------------------------------------------------

/**
 * `x^(4/3)` for every quantized magnitude, precomputed.
 *
 * Requantization applies this to every one of 576 lines per granule, tens of
 * thousands of times per second of audio. `Math.pow` in that loop is the single
 * biggest avoidable cost in an MP3 decoder.
 *
 * 8207 entries covers the largest value representable with 13 linbits.
 */
export const POW43 = (() => {
  const table = new Float32Array(8207);
  for (let i = 0; i < table.length; i++) table[i] = Math.pow(i, 4 / 3);
  return table;
})();

/**
 * `2^(i/4)` for the global gain exponent, offset so the index is never negative.
 *
 * `global_gain` is 8 bits and the exponent it produces spans roughly -256..+118,
 * so the table is offset by 256.
 */
export const GAIN_POW2 = (() => {
  const table = new Float32Array(384);
  for (let i = 0; i < table.length; i++) table[i] = Math.pow(2, (i - 256) / 4);
  return table;
})();

/**
 * The four IMDCT window shapes.
 *
 * Layer III switches between a 36-sample long window and three 12-sample short
 * windows to control pre-echo — a long window smears a sharp transient's
 * quantization noise backwards in time, which is audible as a click before a
 * drum hit. Types 1 and 3 are the asymmetric transitions between the two.
 */
export const IMDCT_WINDOWS = (() => {
  const windows: Float32Array[] = [
    new Float32Array(36),
    new Float32Array(36),
    new Float32Array(36),
    new Float32Array(36),
  ];

  // Type 0: normal long window.
  for (let i = 0; i < 36; i++) {
    windows[0]![i] = Math.sin((Math.PI / 36) * (i + 0.5));
  }

  // Type 1: long -> short transition.
  for (let i = 0; i < 18; i++) windows[1]![i] = Math.sin((Math.PI / 36) * (i + 0.5));
  for (let i = 18; i < 24; i++) windows[1]![i] = 1;
  for (let i = 24; i < 30; i++) windows[1]![i] = Math.sin((Math.PI / 12) * (i - 18 + 0.5));
  for (let i = 30; i < 36; i++) windows[1]![i] = 0;

  // Type 2: three short windows. Only the first 12 slots are meaningful; the
  // caller applies this window to each of the three sub-blocks in turn.
  for (let i = 0; i < 12; i++) windows[2]![i] = Math.sin((Math.PI / 12) * (i + 0.5));
  for (let i = 12; i < 36; i++) windows[2]![i] = 0;

  // Type 3: short -> long transition.
  for (let i = 0; i < 6; i++) windows[3]![i] = 0;
  for (let i = 6; i < 12; i++) windows[3]![i] = Math.sin((Math.PI / 12) * (i - 6 + 0.5));
  for (let i = 12; i < 18; i++) windows[3]![i] = 1;
  for (let i = 18; i < 36; i++) windows[3]![i] = Math.sin((Math.PI / 36) * (i + 0.5));

  return windows;
})();

/**
 * Alias-reduction butterfly coefficients.
 *
 * The polyphase filterbank's sub-bands overlap, which introduces aliasing
 * between neighbours. These eight butterflies across each sub-band boundary
 * cancel it. Derived from the specification's `c[]` constants.
 */
export const ALIAS_CS = new Float32Array(8);
export const ALIAS_CA = new Float32Array(8);

(() => {
  const c = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
  for (let i = 0; i < 8; i++) {
    const denominator = Math.sqrt(1 + c[i]! * c[i]!);
    ALIAS_CS[i] = 1 / denominator;
    ALIAS_CA[i] = c[i]! / denominator;
  }
})();

/**
 * Intensity-stereo position ratios, indexed by `is_pos`.
 *
 * In intensity stereo the encoder discards the side channel above some band and
 * stores only a panning position; the decoder reconstructs both channels from
 * the mid signal and this ratio.
 */
export const INTENSITY_RATIOS = (() => {
  const table = new Float32Array(32);
  for (let i = 0; i < 32; i++) table[i] = Math.tan((i * Math.PI) / 12);
  return table;
})();

/** IMDCT cosine basis for the 36-point (long) transform. */
export const IMDCT_COS_36 = (() => {
  const table = new Float32Array(18 * 36);
  for (let p = 0; p < 36; p++) {
    for (let m = 0; m < 18; m++) {
      table[p * 18 + m] = Math.cos((Math.PI / 72) * (2 * p + 1 + 18) * (2 * m + 1));
    }
  }
  return table;
})();

/** IMDCT cosine basis for the 12-point (short) transform. */
export const IMDCT_COS_12 = (() => {
  const table = new Float32Array(6 * 12);
  for (let p = 0; p < 12; p++) {
    for (let m = 0; m < 6; m++) {
      table[p * 6 + m] = Math.cos((Math.PI / 24) * (2 * p + 1 + 6) * (2 * m + 1));
    }
  }
  return table;
})();

/**
 * The synthesis filterbank window is generated rather than listed here — see
 * `synth-window.ts` for why, and for how it is derived.
 */
export { SYNTH_WINDOW } from './synth-window.ts';
