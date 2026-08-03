/**
 * Frequency-to-time reconstruction: alias reduction, IMDCT, and the synthesis
 * polyphase filterbank.
 *
 * Layer III encodes in two nested transforms. A 32-band polyphase filterbank
 * splits the signal into sub-bands, then an MDCT gives each sub-band 18 finer
 * frequency lines. Decoding runs both in reverse, and three corrections are
 * needed along the way:
 *
 * - **Alias reduction** undoes the overlap between neighbouring polyphase bands.
 *   The filterbank is not perfectly band-limited, so each band leaks into its
 *   neighbours; eight butterflies across every boundary cancel it. Skipped for
 *   short blocks, where the encoder does not apply the matching step.
 * - **Overlap-add** stitches successive IMDCT outputs together. Each transform
 *   produces 36 samples for 18 new ones; the second half is carried into the
 *   next granule. This is what makes the transform critically sampled.
 * - **Frequency inversion** negates alternate samples in odd sub-bands, undoing
 *   the modulation the analysis filterbank applied.
 */

import { IMDCT_COS_36, IMDCT_COS_12, IMDCT_WINDOWS, ALIAS_CS, ALIAS_CA, SYNTH_WINDOW } from './tables.ts';
import type { GranuleInfo } from './sideinfo.ts';

/**
 * Cancels aliasing between adjacent sub-bands.
 *
 * Operates on the boundary between each pair of the 32 sub-bands, mixing the
 * last 8 lines of one with the first 8 of the next.
 */
export function reduceAlias(spectrum: Float32Array, granule: GranuleInfo): void {
  const shortBlock = granule.windowSwitching && granule.blockType === 2;

  // Pure short blocks get no alias reduction at all. Mixed blocks get it only
  // across the first boundary, where the long-coded head meets the short tail.
  if (shortBlock && !granule.mixedBlock) return;
  const boundaries = shortBlock ? 1 : 31;

  for (let boundary = 0; boundary < boundaries; boundary++) {
    const offset = boundary * 18;
    for (let i = 0; i < 8; i++) {
      const lower = spectrum[offset + 17 - i]!;
      const upper = spectrum[offset + 18 + i]!;
      spectrum[offset + 17 - i] = lower * ALIAS_CS[i]! - upper * ALIAS_CA[i]!;
      spectrum[offset + 18 + i] = upper * ALIAS_CS[i]! + lower * ALIAS_CA[i]!;
    }
  }
}

/**
 * Inverse MDCT with windowing and overlap-add.
 *
 * @param spectrum 576 requantized lines, sub-band major.
 * @param overlap 576 carried-over samples from the previous granule, updated in place.
 * @param out 576 time-domain samples, sub-band major (18 per sub-band).
 */
export function imdct(
  spectrum: Float32Array,
  granule: GranuleInfo,
  overlap: Float32Array,
  out: Float32Array,
): void {
  const shortBlock = granule.windowSwitching && granule.blockType === 2;
  // Window shape 0 is also used for the long half of a mixed block.
  const windowType = granule.windowSwitching ? granule.blockType : 0;

  const transformed = new Float32Array(36);

  for (let subband = 0; subband < 32; subband++) {
    const offset = subband * 18;

    // In a mixed block the two lowest sub-bands stay long.
    const useShort = shortBlock && !(granule.mixedBlock && subband < 2);

    if (useShort) {
      imdctShort(spectrum, offset, transformed);
    } else {
      imdctLong(spectrum, offset, transformed, IMDCT_WINDOWS[useShortWindowIndex(windowType, granule, subband)]!);
    }

    // Overlap-add: the first half joins the tail carried from last granule, the
    // second half becomes the tail for the next one.
    for (let i = 0; i < 18; i++) {
      out[offset + i] = transformed[i]! + overlap[offset + i]!;
      overlap[offset + i] = transformed[i + 18]!;
    }
  }
}

/** Picks the window shape for a long-transform sub-band. */
function useShortWindowIndex(windowType: number, granule: GranuleInfo, subband: number): number {
  // A mixed block's long head always uses the normal long window, regardless of
  // the granule's declared block type.
  if (granule.mixedBlock && subband < 2) return 0;
  return windowType;
}

function imdctLong(
  spectrum: Float32Array,
  offset: number,
  out: Float32Array,
  window: Float32Array,
): void {
  for (let p = 0; p < 36; p++) {
    let sum = 0;
    const base = p * 18;
    for (let m = 0; m < 18; m++) {
      sum += spectrum[offset + m]! * IMDCT_COS_36[base + m]!;
    }
    out[p] = sum * window[p]!;
  }
}

/**
 * Three 12-point transforms, windowed and overlapped within the 36-sample frame.
 *
 * The short windows sit at offsets 6, 12 and 18, which is what limits a
 * transient's quantization noise to a 4 ms window instead of smearing it across
 * the full 24 ms of a long block.
 */
function imdctShort(spectrum: Float32Array, offset: number, out: Float32Array): void {
  out.fill(0);
  const window = IMDCT_WINDOWS[2]!;

  for (let sub = 0; sub < 3; sub++) {
    for (let p = 0; p < 12; p++) {
      let sum = 0;
      const base = p * 6;
      for (let m = 0; m < 6; m++) {
        // `reorderShortBlock` lays each sub-band out as three contiguous runs of
        // six — one per window — so window `sub` starts at `offset + sub * 6`.
        // Reading these interleaved instead is silently wrong: the transform
        // still produces plausible audio, which is exactly what makes it hard to
        // spot.
        sum += spectrum[offset + sub * 6 + m]! * IMDCT_COS_12[base + m]!;
      }
      out[6 + sub * 6 + p]! += sum * window[p]!;
    }
  }
}

/**
 * Negates every other sample in odd sub-bands.
 *
 * The analysis filterbank modulates alternate bands; this undoes it. Omitting it
 * produces audio that is recognisable but harsh, because half the sub-bands come
 * out phase-inverted.
 */
export function invertFrequency(samples: Float32Array): void {
  for (let subband = 1; subband < 32; subband += 2) {
    const offset = subband * 18;
    for (let i = 1; i < 18; i += 2) {
      samples[offset + i] = -samples[offset + i]!;
    }
  }
}

/** Cosine matrix for the synthesis filterbank: `N[i][k] = cos((16+i)(2k+1)π/64)`. */
const SYNTH_COS = (() => {
  const table = new Float32Array(64 * 32);
  for (let i = 0; i < 64; i++) {
    for (let k = 0; k < 32; k++) {
      table[i * 32 + k] = Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64);
    }
  }
  return table;
})();

/**
 * The synthesis polyphase filterbank.
 *
 * Turns 32 sub-band samples into 32 PCM samples, using a 1024-sample history so
 * the reconstruction filter has the past it needs. One instance per channel —
 * the history is stateful and must not be shared.
 */
export class SynthesisFilterbank {
  /** Rolling history of transformed sub-band vectors. */
  readonly #v = new Float32Array(1024);
  #offset = 0;

  /** Discards history, e.g. after a seek. */
  reset(): void {
    this.#v.fill(0);
    this.#offset = 0;
  }

  /**
   * Produces 32 PCM samples from 32 sub-band samples.
   *
   * @param subbands 32 sub-band values for one time slot.
   * @param out Destination for 32 PCM samples.
   * @param outOffset Where to write in `out`.
   */
  process(subbands: Float32Array, out: Float32Array, outOffset: number): void {
    // Advance the ring buffer by one 64-sample vector.
    this.#offset = (this.#offset - 64 + 1024) & 1023;
    const v = this.#v;
    const base = this.#offset;

    // Hoisted: these are module-level bindings, and the inner loops run tens of
    // millions of times per minute of audio, so the lookup cost is not noise.
    const cos = SYNTH_COS;
    const window = SYNTH_WINDOW;

    // Matrix the 32 sub-bands into 64 values.
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      const row = i << 5;
      for (let k = 0; k < 32; k++) sum += subbands[k]! * cos[row + k]!;
      v[base + i] = sum;
    }

    // Gather the 512 window taps from the history. The spec's U[] build: eight
    // groups, each taking 32 values from one half of a 128-sample span.
    //
    // The wrap uses `& 1023` rather than `% 1024`. They are equivalent here
    // because the buffer length is a power of two and every index is
    // non-negative, but this loop runs 512 times per 32 output samples — the
    // modulo was the single hottest instruction in the decoder.
    for (let j = 0; j < 32; j++) {
      let sum = 0;
      let evenIndex = (base + j) & 1023;
      let oddIndex = (base + 96 + j) & 1023;
      let tap = j;

      for (let i = 0; i < 8; i++) {
        sum += v[evenIndex]! * window[tap]!;
        sum += v[oddIndex]! * window[tap + 32]!;
        // Step forward one 128-sample span instead of recomputing from `base`.
        evenIndex = (evenIndex + 128) & 1023;
        oddIndex = (oddIndex + 128) & 1023;
        tap += 64;
      }
      out[outOffset + j] = sum;
    }
  }
}
