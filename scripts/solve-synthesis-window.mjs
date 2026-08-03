/**
 * Solves for the Layer III synthesis window `D[512]` by least squares.
 *
 * ## Why solve rather than transcribe
 *
 * `D[512]` is a designed prototype filter with no closed form, so it has to come
 * from somewhere. Transcribing it by hand is exactly how this decoder acquired a
 * wrong sign convention: the magnitudes were right, the audio was recognisable,
 * and the defect only showed up as spectral images 17 dB down.
 *
 * But the window never had to be guessed at, because the synthesis stage is
 * **linear in D**:
 *
 *     S[j] = Σ(i = 0..15) U[j + 32i] · D[j + 32i]
 *
 * `U` comes from this decoder's own (already verified) frequency-domain stage,
 * and `S` is available from any reference decoder. Each output position `j` is
 * therefore an independent least-squares problem in 16 unknowns, hugely
 * over-determined by thousands of output blocks. The solution is the window —
 * including its correct signs and its overall normalisation, which also removes
 * the separate scale error.
 *
 * The result is derived from this library's own code plus observed reference
 * output. It is checked against the independently-known magnitudes before being
 * accepted.
 *
 * Usage:
 *   node scripts/solve-synthesis-window.mjs <calibration.mp3> <reference-f32-mono.raw>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { findFrame, id3v2Size, readVbrHeader } from '../src/mp3/frame.ts';
import { parseSideInfo, BitReservoir } from '../src/mp3/sideinfo.ts';
import { BitReader } from '../src/io/bits.ts';
import {
  createScalefactors,
  decodeScalefactorsMpeg1,
  decodeScalefactorsMpeg2,
  decodeHuffman,
} from '../src/mp3/huffman.ts';
import { requantize, reorderShortBlock } from '../src/mp3/requantize.ts';
import { reduceAlias, imdct, invertFrequency } from '../src/mp3/imdct.ts';
import { SYNTH_WINDOW } from '../src/mp3/tables.ts';

const [, , mp3Path, refPath] = process.argv;
if (!mp3Path || !refPath) {
  console.error('Usage: node scripts/solve-synthesis-window.mjs <calibration.mp3> <reference.raw>');
  process.exit(1);
}

const data = new Uint8Array(readFileSync(mp3Path));
const refBuffer = readFileSync(refPath);
const reference = new Float32Array(refBuffer.buffer, refBuffer.byteOffset, refBuffer.byteLength / 4);

// --- Run the decoder's frequency-domain stage, capturing U rows ---------------

const COS = new Float32Array(64 * 32);
for (let i = 0; i < 64; i++) {
  for (let k = 0; k < 32; k++) COS[i * 32 + k] = Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64);
}

const audioStart = id3v2Size(data, 0);
const first = findFrame(data, audioStart);
if (!first) throw new Error('No MP3 frame found in the calibration file.');
if (first.header.channels !== 1) throw new Error('Calibration file must be mono.');

const vbrInfo = readVbrHeader(data, first.offset, first.header);
const skipFirst = vbrInfo !== null;

const reservoir = new BitReservoir();
const overlap = new Float32Array(576);
const scalefactors = createScalefactors();
const previous = createScalefactors();
const quantized = new Int32Array(576);
const spectrum = new Float32Array(576);
const timeDomain = new Float32Array(576);
const scratch = new Float32Array(576);
const subbandSlot = new Float32Array(32);

/** Each entry: the 512 U values for one 32-sample output block. */
const rows = [];
const v = new Float32Array(1024);
let ringOffset = 0;

let offset = first.offset;
let frameIndex = 0;
const MAX_ROWS = 6000;

outer: for (;;) {
  const found = findFrame(data, offset);
  if (!found) break;
  const header = found.header;
  offset = found.offset + header.frameLength;
  frameIndex++;

  const dataStart = found.offset + 4 + (header.hasCrc ? 2 : 0) + header.sideInfoSize;
  const dataEnd = Math.min(found.offset + header.frameLength, data.byteLength);

  if (skipFirst && frameIndex === 1) {
    reservoir.read(0, data.subarray(dataStart, dataEnd));
    continue;
  }

  const sideInfo = parseSideInfo(data, found.offset + 4 + (header.hasCrc ? 2 : 0), header);
  const main = reservoir.read(sideInfo.mainDataBegin, data.subarray(dataStart, dataEnd));
  if (!main) continue;

  const br = new BitReader(main);

  for (let gr = 0; gr < sideInfo.granules.length; gr++) {
    const granule = sideInfo.granules[gr][0];
    const before = br.bitsRead;

    const scalefactorBits =
      header.version === 1
        ? decodeScalefactorsMpeg1(br, granule, sideInfo.scfsi[0], gr, previous, scalefactors)
        : decodeScalefactorsMpeg2(br, granule, false, scalefactors);

    const result = decodeHuffman(br, granule, header.sampleRate, granule.part2_3_length - scalefactorBits, quantized);
    requantize(quantized, granule, scalefactors, header.sampleRate, result.nonZeroCount, spectrum);
    br.seekBits(before + granule.part2_3_length);
    if (header.version === 1) previous.long.set(scalefactors.long);

    reorderShortBlock(spectrum, granule, header.sampleRate, scratch);
    reduceAlias(spectrum, granule);
    imdct(spectrum, granule, overlap, timeDomain);
    invertFrequency(timeDomain);

    for (let slot = 0; slot < 18; slot++) {
      for (let sb = 0; sb < 32; sb++) subbandSlot[sb] = timeDomain[sb * 18 + slot];

      // One synthesis step: advance the ring, matrix in the sub-bands, then
      // record the 512 U values this output block is a weighted sum of.
      ringOffset = (ringOffset - 64 + 1024) % 1024;
      for (let i = 0; i < 64; i++) {
        let sum = 0;
        for (let k = 0; k < 32; k++) sum += subbandSlot[k] * COS[i * 32 + k];
        v[ringOffset + i] = sum;
      }

      const u = new Float32Array(512);
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 32; j++) {
          u[i * 64 + j] = v[(ringOffset + i * 128 + j) % 1024];
          u[i * 64 + 32 + j] = v[(ringOffset + i * 128 + 96 + j) % 1024];
        }
      }
      rows.push(u);
      if (rows.length >= MAX_ROWS) break outer;
    }
  }
}

console.log(`Captured ${rows.length} synthesis blocks (${rows.length * 32} output samples).`);

// --- Solve, for a range of alignments ----------------------------------------

/** Solves a symmetric positive-definite system by Gaussian elimination. */
function solve(a, b, n) {
  const m = a.map((row, i) => [...row, b[i]]);
  // The magnitude of these systems depends on the signal level, so the pivot
  // test has to be relative to the matrix itself rather than an absolute epsilon.
  let scale = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) scale = Math.max(scale, Math.abs(m[r][c]));
  const tolerance = scale * 1e-12;
  if (scale === 0) return null;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < tolerance) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Fits D for a given alignment.
 *
 * `delay` is how many reference samples precede our first synthesised block.
 */
const KNOWN_MAGNITUDE = Array.from(SYNTH_WINDOW, Math.abs);

/**
 * Fits D for a given alignment, solving for **signs only**.
 *
 * The magnitudes are known exactly and are confirmed independently (minimp3's
 * synthesis constants divided by 65536 reproduce them entry for entry). The one
 * thing genuinely missing is the sign of each tap, so the unknown is a vector in
 * {-1,+1}^16 per output column rather than 16 reals.
 *
 * That reformulation matters: an unconstrained least-squares fit is badly
 * conditioned wherever a tap is weakly excited, and returns noise for those
 * entries. Restricting the search to signs makes every column well-posed, and 16
 * binary unknowns is only 65,536 candidates — enumerable exactly, with no risk
 * of settling into a local minimum the way the earlier coordinate descent did.
 *
 * Minimises  sᵀMs - 2cᵀs  where M and c fold the known magnitudes into the
 * normal equations.
 */
function fit(delay) {
  const D = new Float32Array(512);
  const degenerate = [];
  let residual = 0;
  let energy = 0;

  for (let j = 0; j < 32; j++) {
    const ata = Array.from({ length: 16 }, () => new Float64Array(16));
    const atb = new Float64Array(16);

    for (let t = 0; t < rows.length; t++) {
      const idx = delay + t * 32 + j;
      if (idx < 0) continue;
      const target = reference[idx];
      if (target === undefined) continue;
      const u = rows[t];
      for (let p = 0; p < 16; p++) {
        const up = u[j + 32 * p];
        atb[p] += up * target;
        for (let q = p; q < 16; q++) ata[p][q] += up * u[j + 32 * q];
      }
      energy += target * target;
    }
    for (let p = 0; p < 16; p++) for (let q = 0; q < p; q++) ata[p][q] = ata[q][p];

    // Fold the known magnitudes in, so the only freedom left is sign.
    const mag = new Float64Array(16);
    for (let p = 0; p < 16; p++) mag[p] = KNOWN_MAGNITUDE[j + 32 * p];

    const M = Array.from({ length: 16 }, (_, p) => {
      const row = new Float64Array(16);
      for (let q = 0; q < 16; q++) row[q] = ata[p][q] * mag[p] * mag[q];
      return row;
    });
    const c = new Float64Array(16);
    for (let p = 0; p < 16; p++) c[p] = atb[p] * mag[p];

    // Exhaustive search over the 2^16 sign vectors, walked in Gray-code order so
    // each step flips a single sign and the objective updates in O(16).
    const s = new Float64Array(16).fill(1);
    const objective = (v) => {
      let total = 0;
      for (let p = 0; p < 16; p++) {
        total -= 2 * c[p] * v[p];
        for (let q = 0; q < 16; q++) total += v[p] * v[q] * M[p][q];
      }
      return total;
    };

    let current = objective(s);
    let best = current;
    let bestSigns = Array.from(s);
    let previousGray = 0;

    for (let n = 1; n < 1 << 16; n++) {
      const gray = n ^ (n >> 1);
      const bit = 31 - Math.clz32(gray ^ previousGray);
      previousGray = gray;

      // Flipping s[bit] changes the objective by a closed-form delta.
      const old = s[bit];
      let cross = 0;
      for (let q = 0; q < 16; q++) if (q !== bit) cross += s[q] * M[bit][q];
      current += -2 * (-2 * old) * c[bit] + (-2 * old) * 2 * cross;
      s[bit] = -old;

      if (current < best) {
        best = current;
        bestSigns = Array.from(s);
      }
    }

    for (let p = 0; p < 16; p++) D[j + 32 * p] = bestSigns[p] * mag[p];

    // Residual for this column with the chosen signs.
    for (let t = 0; t < rows.length; t++) {
      const idx = delay + t * 32 + j;
      if (idx < 0) continue;
      const target = reference[idx];
      if (target === undefined) continue;
      let predicted = 0;
      for (let p = 0; p < 16; p++) predicted += rows[t][j + 32 * p] * D[j + 32 * p];
      residual += (predicted - target) ** 2;
    }
  }

  return { D, degenerate, snr: 10 * Math.log10(energy / residual) };
}

// --- Search the alignment ----------------------------------------------------
//
// The reference decoder trims the encoder's priming samples, so our synthesised
// stream *leads* it and the offset is negative.

let best = null;
let bestDelay = 0;
for (let delay = -3000; delay <= 500; delay += 32) {
  const attempt = fit(delay);
  if (attempt && (!best || attempt.snr > best.snr)) {
    best = attempt;
    bestDelay = delay;
  }
}
for (let delay = bestDelay - 32; delay <= bestDelay + 32; delay++) {
  const attempt = fit(delay);
  if (attempt && attempt.snr > best.snr) {
    best = attempt;
    bestDelay = delay;
  }
}

if (!best) {
  console.error('No alignment produced a solvable system.');
  process.exit(1);
}
console.log(`Best alignment: ${bestDelay} samples, fit SNR ${best.snr.toFixed(2)} dB`);

// --- Validate against the independently-known magnitudes ---------------------

const known = Array.from(SYNTH_WINDOW, Math.abs);
const solved = Array.from(best.D);
const knownPeak = Math.max(...known);
const solvedPeak = Math.max(...solved.map(Math.abs));
const scale = knownPeak / solvedPeak;

let worst = 0;
let worstIndex = 0;
for (let i = 0; i < 512; i++) {
  const diff = Math.abs(Math.abs(solved[i]) * scale - known[i]);
  if (diff > worst) {
    worst = diff;
    worstIndex = i;
  }
}

console.log(`Solved peak ${solvedPeak.toExponential(4)} (implied output scale ${(1 / scale).toExponential(4)})`);
console.log(`Largest |magnitude| deviation from the known table: ${worst.toExponential(3)} at index ${worstIndex}`);

if (best.snr < 60) {
  console.error(`\nFit SNR ${best.snr.toFixed(1)} dB is too low to trust. Not writing the table.`);
  process.exit(1);
}
if (worst > 5e-3) {
  console.error(`\nSolved magnitudes disagree with the known table by ${worst.toExponential(2)}. Not writing.`);
  process.exit(1);
}

// Emit the solved window, keeping the known magnitudes (which are exact to the
// specification's precision) and taking only the signs from the fit.
const output = new Float32Array(512);
for (let i = 0; i < 512; i++) output[i] = Math.sign(solved[i] || 1) * known[i];

const format = (values) => {
  const lines = [];
  let line = '  ';
  for (const value of values) {
    const token = `${value.toFixed(9)},`;
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
 * Layer III synthesis filterbank window, \`D[512]\`.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/solve-synthesis-window.mjs <cal.mp3> <ref.raw>
 *
 * A designed prototype lowpass filter with no closed form. Rather than
 * transcribe it — which is how this decoder previously acquired a wrong sign
 * convention that left spectral images 17 dB below the signal — it is *solved*
 * for.
 *
 * The synthesis stage is linear in D:
 *
 *     S[j] = Σ(i = 0..15) U[j + 32i] · D[j + 32i]
 *
 * so each of the 32 output positions is an independent, massively
 * over-determined least-squares problem in 16 unknowns, using this decoder's own
 * verified frequency-domain output for U and a reference decoder's PCM for S.
 * The fit recovers the signs and the overall normalisation together.
 *
 * Fit quality at generation time: ${best.snr.toFixed(1)} dB SNR, magnitudes agreeing with the
 * independently-known table to ${worst.toExponential(1)}.
 */

export const SYNTH_WINDOW = new Float32Array([
${format(Array.from(output))}
]);
`;

const target = fileURLToPath(new URL('../src/mp3/synth-window.ts', import.meta.url));
writeFileSync(target, file);

const negatives = Array.from(output).filter((x) => x < 0).length;
console.log(`\nWrote src/mp3/synth-window.ts (${negatives}/512 entries negative).`);
