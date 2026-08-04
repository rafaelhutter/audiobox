/**
 * Encoder-side analysis: polyphase filterbank, MDCT, and the aliasing butterfly.
 *
 * This is the decoder's chain run backwards. Where decoding goes
 *
 *     dequantise → alias reduction → IMDCT → frequency inversion → synthesis
 *
 * encoding goes
 *
 *     analysis → frequency inversion → MDCT → aliasing butterfly → quantise
 *
 * ## The analysis window
 *
 * `C[512]` lives in the generated `analysis-window.ts`. Its magnitudes are the
 * synthesis window's, shifted 64 taps and scaled by 1/32 — the two share a
 * prototype filter — but its *signs* are solved, and that distinction turned out
 * to matter more than anything else in the encoder.
 *
 * Plain `C = D/32` was what this shipped first, on the reasoning that a window
 * solved by least squares would be fitted to this implementation's own synthesis
 * error and would therefore diverge from the specification, hurting interop with
 * real decoders. Sound reasoning, and wrong. The two differ in 28 of 512 signs,
 * and the test that settles it is to encode with each and let *ffmpeg* decode:
 *
 *     window        ffmpeg vs source     audiobox vs source
 *     C = D/32           41.8 dB              41.6 dB
 *     solved             73.1 dB              54.0 dB
 *
 * An overfitted window would have made ffmpeg worse. Instead ffmpeg gains 31 dB
 * — more than our own decoder gains — which is only possible if the solved signs
 * are the specification's. Our own round trip now sits 19 dB below ffmpeg's
 * because the *synthesis* window has become the limiting term, exactly the
 * margin by which the decoder already differed from ffmpeg.
 *
 * The lesson worth keeping: a round trip through a matched pair cannot tell a
 * correct transform from two compensating errors. Only an independent decoder
 * can, and the cost of not asking was 31 dB.
 */

import { IMDCT_WINDOWS, ALIAS_CS, ALIAS_CA, SFB_SHORT } from './tables.ts';

export { ANALYSIS_WINDOW, FILTERBANK_DELAY } from './analysis-window.ts';
import { ANALYSIS_WINDOW } from './analysis-window.ts';

/** Analysis matrixing: `M[k][i] = cos((2k+1)(i-16)π/64)`. */
const ANALYSIS_COS = (() => {
  const table = new Float32Array(32 * 64);
  for (let k = 0; k < 32; k++) {
    for (let i = 0; i < 64; i++) {
      table[k * 64 + i] = Math.cos(((2 * k + 1) * (i - 16) * Math.PI) / 64);
    }
  }
  return table;
})();

/**
 * Forward MDCT cosine basis, 36 inputs to 18 outputs.
 *
 * The `2 / 18` is the transform's normalisation, and it belongs here because the
 * specification's IMDCT omits it: the decoder computes a bare sum of cosines, so
 * for the pair to reconstruct at unity the forward direction has to carry the
 * whole factor. Folding it into the basis costs nothing at run time.
 *
 * Getting this wrong is not subtle in effect but is easy to miss in testing —
 * output nine times too loud still correlates perfectly with the input, so any
 * check that fits a gain before scoring will report a clean reconstruction.
 */
const MDCT_COS_36 = (() => {
  const table = new Float32Array(18 * 36);
  const norm = 2 / 18;
  for (let k = 0; k < 18; k++) {
    for (let n = 0; n < 36; n++) {
      table[k * 36 + n] = norm * Math.cos((Math.PI / 72) * (2 * n + 1 + 18) * (2 * k + 1));
    }
  }
  return table;
})();

/**
 * The 32-band polyphase analysis filterbank.
 *
 * Stateful — it carries a 512-sample delay line — so one instance per channel,
 * and never share them.
 */
export class AnalysisFilterbank {
  readonly #delay = new Float32Array(512);
  readonly #z = new Float32Array(512);
  readonly #y = new Float32Array(64);

  /** Discards history, e.g. when starting a new stream. */
  reset(): void {
    this.#delay.fill(0);
  }

  /**
   * Consumes 32 input samples and produces 32 sub-band values.
   *
   * @param input Source samples.
   * @param offset Index of the first of the 32 samples to consume.
   * @param out Destination for 32 sub-band values.
   */
  process(input: Float32Array, offset: number, out: Float32Array): void {
    const delay = this.#delay;
    const z = this.#z;
    const y = this.#y;
    const window = ANALYSIS_WINDOW;
    const cos = ANALYSIS_COS;

    // Shift the delay line and insert the new block, newest first.
    delay.copyWithin(32, 0, 480);
    for (let i = 0; i < 32; i++) {
      const index = offset + i;
      delay[31 - i] = index < input.length ? input[index]! : 0;
    }

    for (let i = 0; i < 512; i++) z[i] = delay[i]! * window[i]!;

    // Fold the 512 windowed taps down to 64.
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) sum += z[i + 64 * j]!;
      y[i] = sum;
    }

    for (let k = 0; k < 32; k++) {
      let sum = 0;
      const row = k * 64;
      for (let i = 0; i < 64; i++) sum += cos[row + i]! * y[i]!;
      out[k] = sum;
    }
  }
}

/**
 * Negates every other sample in odd sub-bands.
 *
 * Mirrors `invertFrequency` in the decoder. Self-inverse, so the same operation
 * serves both directions — but it has to happen at the mirrored point in the
 * chain, between the filterbank and the MDCT.
 */
export function invertFrequency(samples: Float32Array): void {
  for (let subband = 1; subband < 32; subband += 2) {
    const offset = subband * 18;
    for (let i = 1; i < 18; i += 2) {
      samples[offset + i] = -samples[offset + i]!;
    }
  }
}

/**
 * Forward MDCT basis for the 12-point short transform, 12 inputs to 6 outputs.
 *
 * Carries `2 / 6` for the same reason the long basis carries `2 / 18`: the
 * specification's inverse transform is a bare cosine sum.
 */
const MDCT_COS_12 = (() => {
  const table = new Float32Array(6 * 12);
  const norm = 2 / 6;
  for (let m = 0; m < 6; m++) {
    for (let p = 0; p < 12; p++) {
      table[m * 12 + p] = norm * Math.cos((Math.PI / 24) * (2 * p + 1 + 6) * (2 * m + 1));
    }
  }
  return table;
})();

/**
 * Forward MDCT over one granule.
 *
 * Each sub-band's 18 new sub-band samples are windowed together with the
 * previous granule's 18 — the 50% overlap that makes the transform critically
 * sampled — and transformed to 18 spectral lines.
 *
 * @param subbands 576 sub-band samples, sub-band major (18 per sub-band).
 * @param overlap The previous granule's 18 samples per sub-band, updated here.
 * @param out 576 spectral lines, sub-band major.
 */
export function mdct(
  subbands: Float32Array,
  overlap: Float32Array,
  out: Float32Array,
  blockType = 0,
): void {
  const short = blockType === 2;
  const window = IMDCT_WINDOWS[blockType]!;
  const shortWindow = IMDCT_WINDOWS[2]!;
  const frame = new Float32Array(36);

  for (let subband = 0; subband < 32; subband++) {
    const offset = subband * 18;

    // First half is the previous granule's tail, second half is new.
    for (let i = 0; i < 18; i++) {
      frame[i] = overlap[offset + i]!;
      frame[i + 18] = subbands[offset + i]!;
    }

    if (short) {
      // Three 12-sample transforms at offsets 6, 12 and 18 — the same places
      // `imdctShort` writes them back to. Each produces six lines, and the three
      // runs of six sit contiguously within the sub-band's 18, which is the
      // layout the decoder reads after reordering.
      for (let sub = 0; sub < 3; sub++) {
        const base = 6 + sub * 6;
        for (let m = 0; m < 6; m++) {
          let sum = 0;
          const row = m * 12;
          for (let p = 0; p < 12; p++) {
            sum += frame[base + p]! * shortWindow[p]! * MDCT_COS_12[row + p]!;
          }
          out[offset + sub * 6 + m] = sum;
        }
      }
    } else {
      for (let k = 0; k < 18; k++) {
        let sum = 0;
        const base = k * 36;
        for (let n = 0; n < 36; n++) sum += frame[n]! * window[n]! * MDCT_COS_36[base + n]!;
        out[offset + k] = sum;
      }
    }

    // Carry this granule's samples forward.
    for (let i = 0; i < 18; i++) overlap[offset + i] = subbands[offset + i]!;
  }
}

/**
 * Interleaves a short-block granule into the order it is transmitted in.
 *
 * The MDCT leaves each sub-band's three windows contiguous, which is what the
 * decoder's IMDCT wants back. The bitstream carries them the other way round —
 * scalefactor band first, then window, then line — because that is the order the
 * scalefactors apply in. This is the exact inverse of `reorderShortBlock`.
 *
 * @param spectrum 576 lines, sub-band major, rewritten in place.
 * @param scratch 576 floats of working space.
 */
export function reorderForTransmission(
  spectrum: Float32Array,
  sampleRate: number,
  scratch: Float32Array,
): void {
  const bands = SFB_SHORT[sampleRate]!;
  let position = 0;

  for (let sfb = 0; sfb < 13; sfb++) {
    const bandStart = bands[sfb]!;
    const width = bands[sfb + 1]! - bandStart;

    for (let window = 0; window < 3; window++) {
      for (let j = 0; j < width; j++) {
        const frequency = bandStart + j;
        const source = Math.floor(frequency / 6) * 18 + window * 6 + (frequency % 6);
        scratch[position++] = source < 576 ? spectrum[source]! : 0;
      }
    }
  }

  for (; position < 576; position++) scratch[position] = 0;
  spectrum.set(scratch);
}

/**
 * The aliasing butterfly, applied on the encode side.
 *
 * The polyphase bands overlap, so the decoder cancels the resulting aliasing
 * with eight butterflies across each sub-band boundary. The encoder applies the
 * inverse rotation so that cancellation lands correctly — the same coefficients,
 * with the cross terms swapped in sign.
 */
export function applyAliasing(spectrum: Float32Array): void {
  for (let boundary = 0; boundary < 31; boundary++) {
    const offset = boundary * 18;
    for (let i = 0; i < 8; i++) {
      const lower = spectrum[offset + 17 - i]!;
      const upper = spectrum[offset + 18 + i]!;
      spectrum[offset + 17 - i] = lower * ALIAS_CS[i]! + upper * ALIAS_CA[i]!;
      spectrum[offset + 18 + i] = upper * ALIAS_CS[i]! - lower * ALIAS_CA[i]!;
    }
  }
}

/**
 * Runs one channel's full analysis for a granule: 576 input samples to 576
 * spectral lines, ready for quantisation.
 *
 * State lives in `filterbank` and `overlap`, so successive calls must pass the
 * same objects for the same channel.
 */
export function analyseGranule(
  input: Float32Array,
  startSample: number,
  filterbank: AnalysisFilterbank,
  overlap: Float32Array,
  subbandScratch: Float32Array,
  slotScratch: Float32Array,
  out: Float32Array,
  blockType = 0,
  sampleRate = 44100,
): void {
  // 18 time slots of 32 sub-bands each.
  for (let slot = 0; slot < 18; slot++) {
    filterbank.process(input, startSample + slot * 32, slotScratch);
    for (let subband = 0; subband < 32; subband++) {
      subbandScratch[subband * 18 + slot] = slotScratch[subband]!;
    }
  }

  invertFrequency(subbandScratch);
  mdct(subbandScratch, overlap, out, blockType);

  if (blockType === 2) {
    // No aliasing butterfly for short blocks: the decoder skips its own alias
    // reduction there, so applying ours would leave a rotation nothing undoes.
    // Transmission order differs too, and the reorder has to come last —
    // afterwards the array is no longer sub-band major.
    reorderForTransmission(out, sampleRate, subbandScratch);
  } else {
    applyAliasing(out);
  }
}
