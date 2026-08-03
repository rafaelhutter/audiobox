/**
 * Requantization, reordering, and stereo reconstruction.
 *
 * The Huffman stage produced integers. This stage turns them back into the
 * floating-point spectrum the encoder started from, undoing three things in
 * order:
 *
 * 1. **Requantization** — the encoder divided each line by a step size chosen
 *    per scalefactor band, then rounded. Reversing it applies `|x|^(4/3)` (the
 *    quantizer is a power law, not linear, because the ear's loudness response
 *    is) and multiplies by the band's step size back.
 * 2. **Reordering** — short blocks are transmitted grouped by scalefactor band,
 *    but the IMDCT needs them grouped by sub-band. The interleaving has to be
 *    undone before the transform.
 * 3. **Stereo reconstruction** — joint stereo transmits mid/side or an intensity
 *    position instead of left/right, because the two channels of real music are
 *    highly correlated and the difference signal is cheap to code.
 */

import { POW43, GAIN_POW2, PRETAB, SFB_LONG, SFB_SHORT, INTENSITY_RATIOS } from './tables.ts';
import type { GranuleInfo } from './sideinfo.ts';
import type { Scalefactors } from './huffman.ts';

/** `|value|^(4/3)`, from the table where possible. */
function pow43(value: number): number {
  const magnitude = value < 0 ? -value : value;
  const result = magnitude < POW43.length ? POW43[magnitude]! : Math.pow(magnitude, 4 / 3);
  return value < 0 ? -result : result;
}

/**
 * Converts quantized integers into the requantized spectrum.
 *
 * @param values 576 quantized lines from the Huffman stage.
 * @param out 576 requantized floats.
 */
export function requantize(
  values: Int32Array,
  granule: GranuleInfo,
  scalefactors: Scalefactors,
  sampleRate: number,
  nonZeroCount: number,
  out: Float32Array,
): void {
  out.fill(0);

  const shortBlock = granule.windowSwitching && granule.blockType === 2;
  // The 210 offset is defined by the specification; GAIN_POW2 is offset by 256
  // so the index stays non-negative for every legal global_gain.
  const baseGainIndex = granule.globalGain - 210 + 256;

  if (!shortBlock) {
    requantizeLong(values, granule, scalefactors, sampleRate, nonZeroCount, baseGainIndex, out, 0, 0);
    return;
  }

  // Mixed blocks keep the lowest two sub-bands (36 lines) as a long block.
  const mixedLines = granule.mixedBlock ? 36 : 0;
  if (mixedLines > 0) {
    requantizeLong(values, granule, scalefactors, sampleRate, Math.min(nonZeroCount, mixedLines), baseGainIndex, out, 0, 8);
  }

  requantizeShort(values, granule, scalefactors, sampleRate, nonZeroCount, baseGainIndex, out, mixedLines);
}

function requantizeLong(
  values: Int32Array,
  granule: GranuleInfo,
  scalefactors: Scalefactors,
  sampleRate: number,
  limit: number,
  baseGainIndex: number,
  out: Float32Array,
  start: number,
  maxBand: number,
): void {
  const bands = SFB_LONG[sampleRate]!;
  const bandCount = maxBand > 0 ? maxBand : 22;

  for (let sfb = 0; sfb < bandCount; sfb++) {
    const bandStart = bands[sfb]!;
    const bandEnd = Math.min(bands[sfb + 1]!, 576);
    if (bandStart >= limit) break;

    // Scalefactor attenuation for this band, plus the optional high-frequency
    // emphasis the encoder can switch on with `preflag`.
    const scalefactor = scalefactors.long[sfb]! + (granule.preflag ? PRETAB[sfb]! : 0);
    const attenuation = Math.pow(2, -granule.scalefacScale * scalefactor);
    const gain = GAIN_POW2[baseGainIndex]! * attenuation;

    for (let i = Math.max(bandStart, start); i < bandEnd && i < limit; i++) {
      const value = values[i]!;
      if (value !== 0) out[i] = pow43(value) * gain;
    }
  }
}

function requantizeShort(
  values: Int32Array,
  granule: GranuleInfo,
  scalefactors: Scalefactors,
  sampleRate: number,
  limit: number,
  baseGainIndex: number,
  out: Float32Array,
  startLine: number,
): void {
  const bands = SFB_SHORT[sampleRate]!;
  const firstBand = granule.mixedBlock ? 3 : 0;

  // Walk the transmitted order: scalefactor band, then window, then line.
  let position = startLine;

  for (let sfb = firstBand; sfb < 13; sfb++) {
    const bandStart = bands[sfb]!;
    const width = bands[sfb + 1]! - bandStart;

    for (let window = 0; window < 3; window++) {
      // Each short window carries its own extra gain, which is how the encoder
      // controls pre-echo within a single granule.
      const gainIndex = baseGainIndex - 8 * granule.subblockGain[window]!;
      const scalefactor = scalefactors.short[window]![sfb]!;
      const gain =
        (GAIN_POW2[gainIndex] ?? Math.pow(2, (gainIndex - 256) / 4)) *
        Math.pow(2, -granule.scalefacScale * scalefactor);

      for (let j = 0; j < width; j++) {
        if (position >= 576) return;
        if (position < limit) {
          const value = values[position]!;
          if (value !== 0) out[position] = pow43(value) * gain;
        }
        position++;
      }
    }
  }
}

/**
 * Undoes the short-block interleaving.
 *
 * Transmitted order is scalefactor-band-major: band 0's three windows, then band
 * 1's three windows, and so on. The IMDCT needs sub-band-major order, where each
 * sub-band's 18 values are window 0's six lines, then window 1's, then window 2's.
 */
export function reorderShortBlock(
  spectrum: Float32Array,
  granule: GranuleInfo,
  sampleRate: number,
  scratch: Float32Array,
): void {
  if (!granule.windowSwitching || granule.blockType !== 2) return;

  const bands = SFB_SHORT[sampleRate]!;
  const firstBand = granule.mixedBlock ? 3 : 0;
  const startLine = granule.mixedBlock ? 36 : 0;

  scratch.set(spectrum);
  // Mixed blocks leave the long-coded head untouched.
  for (let i = 0; i < startLine; i++) scratch[i] = spectrum[i]!;

  let source = startLine;

  for (let sfb = firstBand; sfb < 13; sfb++) {
    const bandStart = bands[sfb]!;
    const width = bands[sfb + 1]! - bandStart;

    for (let window = 0; window < 3; window++) {
      for (let j = 0; j < width; j++) {
        const frequency = bandStart + j;
        // Six frequency lines per window per sub-band.
        const target = Math.floor(frequency / 6) * 18 + window * 6 + (frequency % 6);
        if (target < 576 && source < 576) scratch[target] = spectrum[source]!;
        source++;
      }
    }
  }

  spectrum.set(scratch);
}

/**
 * Reconstructs left and right from a joint-stereo pair.
 *
 * Two independent mechanisms, which can both be active:
 *
 * - **MS (mid/side)**: the encoder sent `(L+R)/√2` and `(L-R)/√2`. Lossless, and
 *   very effective on centred material where the side signal is near-silent.
 * - **Intensity**: above some band the encoder discarded the side information
 *   entirely and sent only a stereo *position*. Both channels are rebuilt from
 *   the mid signal scaled by that position — lossy, and audible as a collapsed
 *   image if applied too low.
 */
export function applyJointStereo(
  left: Float32Array,
  right: Float32Array,
  modeExtension: number,
  granule: GranuleInfo,
  rightScalefactors: Scalefactors,
  sampleRate: number,
  nonZeroRight: number,
  isMpeg1: boolean,
): void {
  const msStereo = (modeExtension & 0x02) !== 0;
  const intensityStereo = (modeExtension & 0x01) !== 0;

  if (intensityStereo) {
    applyIntensityStereo(left, right, granule, rightScalefactors, sampleRate, nonZeroRight, isMpeg1, msStereo);
    return;
  }

  if (msStereo) {
    const invSqrt2 = Math.SQRT1_2;
    for (let i = 0; i < 576; i++) {
      const mid = left[i]!;
      const side = right[i]!;
      left[i] = (mid + side) * invSqrt2;
      right[i] = (mid - side) * invSqrt2;
    }
  }
}

function applyIntensityStereo(
  left: Float32Array,
  right: Float32Array,
  granule: GranuleInfo,
  rightScalefactors: Scalefactors,
  sampleRate: number,
  nonZeroRight: number,
  isMpeg1: boolean,
  msStereo: boolean,
): void {
  const shortBlock = granule.windowSwitching && granule.blockType === 2;
  const invSqrt2 = Math.SQRT1_2;

  // Everything below the first intensity band is ordinary (optionally MS) stereo.
  const bands = shortBlock ? SFB_SHORT[sampleRate]! : SFB_LONG[sampleRate]!;
  const bandCount = shortBlock ? 13 : 22;

  // The intensity region starts where the right channel stopped carrying data.
  let intensityStart = 576;
  for (let sfb = 0; sfb < bandCount; sfb++) {
    const start = shortBlock ? bands[sfb]! * 3 : bands[sfb]!;
    if (start >= nonZeroRight) {
      intensityStart = start;
      break;
    }
  }

  for (let i = 0; i < intensityStart && i < 576; i++) {
    if (msStereo) {
      const mid = left[i]!;
      const side = right[i]!;
      left[i] = (mid + side) * invSqrt2;
      right[i] = (mid - side) * invSqrt2;
    }
  }

  for (let sfb = 0; sfb < bandCount; sfb++) {
    const bandStart = shortBlock ? bands[sfb]! * 3 : bands[sfb]!;
    const bandEnd = shortBlock ? bands[sfb + 1]! * 3 : bands[sfb + 1]!;
    if (bandStart < intensityStart) continue;

    // MPEG-1 stores the position in the right channel's scalefactor slot.
    const position = shortBlock ? rightScalefactors.short[0]![sfb]! : rightScalefactors.long[sfb]!;

    if (isMpeg1 && position === 7) {
      // 7 is the "illegal" marker: leave the band as ordinary stereo.
      continue;
    }

    const ratio = INTENSITY_RATIOS[Math.min(position, 31)]!;
    const leftGain = ratio / (1 + ratio);
    const rightGain = 1 / (1 + ratio);

    for (let i = bandStart; i < bandEnd && i < 576; i++) {
      const mid = left[i]!;
      left[i] = mid * leftGain;
      right[i] = mid * rightGain;
    }
  }
}
