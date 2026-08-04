/**
 * The psychoacoustic model: how much quantisation noise each scalefactor band
 * can hide.
 *
 * Everything else in the encoder is arithmetic with a right answer. This is the
 * part that decides what a listener will not notice, and it is the difference
 * between an MP3 that is merely valid and one that sounds acceptable at 128 kbps.
 *
 * ## What it computes
 *
 * A loud tone raises the threshold of audibility around itself: noise that would
 * be obvious in silence is inaudible next to it. The model estimates that
 * threshold per band, and the quantiser is then free to be as coarse as the
 * threshold allows — spending bits where they are heard and saving them where
 * they are not.
 *
 * Four things set the threshold:
 *
 * 1. **Spreading.** Masking is not confined to the band that causes it; it
 *    spreads across the cochlea, further upward in frequency than downward. Band
 *    energies are convolved with a spreading function on the bark scale.
 * 2. **Tonality.** A pure tone masks much less noise than a noise band of the
 *    same energy does — roughly 29 dB against 6 dB. Tonality is estimated per
 *    band from spectral flatness: a flat band is noise-like, a peaky one tonal.
 * 3. **Absolute threshold.** Below the quiet threshold of hearing nothing is
 *    audible whatever else is happening, which matters most at the extremes of
 *    the spectrum where the ear is least sensitive.
 * 4. **Time.** A threshold may not rise faster than the ear's forward masking
 *    allows, or the quantiser would spread a transient's noise backwards in time
 *    into the silence before it — pre-echo, the most recognisable MP3 artefact.
 *
 * ## Why the partitions are finer than the bands
 *
 * Thresholds are wanted per scalefactor band, and computing them there directly
 * is the obvious shortcut. It does not work: a scalefactor band is roughly a
 * bark wide, and the spreading function is almost flat across ±1 bark, so a
 * quiet band adjacent to a loud one inherits nearly all of its energy and comes
 * out with a threshold at its own signal level. Measured that way the model
 * declared every band already masked at 128 kbps, and the encoder did nothing.
 *
 * So energy is partitioned at about a third of a bark, where the spreading
 * function's shape is actually resolved, and each scalefactor band then takes
 * the *lowest* threshold among the partitions it covers. Taking the minimum is
 * the conservative choice, and the right one: a band is only as maskable as its
 * most exposed part.
 *
 * ## Two deliberate simplifications
 *
 * **Tonality from spectral flatness**, not from the unpredictability measure of
 * ISO model 2. The unpredictability measure needs magnitude and phase histories
 * for two previous granules and is markedly better on transients; flatness needs
 * only the current spectrum. Short blocks are what really answers transients,
 * and those arrive with window switching.
 *
 * **Thresholds are used as ratios, not absolute levels.** The model works on an
 * FFT of the input while the quantiser works on MDCT lines, and the two do not
 * share a scale. Rather than calibrate between them — which would be a constant
 * fitted to this implementation, and wrong the moment either side changed — each
 * band's signal-to-mask ratio is applied to that band's *own* MDCT energy. The
 * absolute threshold of hearing is the one part that needs a real level, and it
 * assumes the usual convention that full scale is 96 dB SPL.
 */

import { fft } from '../analyze/fft.ts';
import { SFB_LONG, SFB_SHORT } from './tables.ts';
import { EncodeError } from '../errors.ts';

/** Samples per analysis window. 1024 spans a granule with room either side. */
const FFT_SIZE = 1024;
const BINS = FFT_SIZE / 2 + 1;

/** Signal-to-mask ratio a pure tone demands, in dB. */
const TONE_MASKING_NOISE = 29;
/** Signal-to-mask ratio a noise band demands, in dB. Noise masks far better. */
const NOISE_MASKING_TONE = 6;

/**
 * Spectral flatness, in dB, at which a band counts as fully noise-like.
 *
 * Flatness runs from 0 dB (perfectly flat, noise) downwards without bound; -60
 * is the conventional point to call a band purely tonal.
 */
const FLATNESS_FLOOR_DB = -60;

/**
 * Fewest bins spectral flatness may be measured over.
 *
 * Flatness compares a geometric mean with an arithmetic one, and over a single
 * bin those are equal — so a narrow partition always reports "perfectly flat",
 * which reads as noise. Low-frequency partitions are exactly one bin wide at a
 * third of a bark, so without this floor every bass tone in the material would
 * be treated as noise and allowed 6 dB of masking instead of 29. Tonality is a
 * property of the local spectral shape and needs a neighbourhood to be visible
 * at all; a Hann-windowed sine occupies about three bins, so this is several
 * times the width of the thing being detected.
 */
const MIN_FLATNESS_BINS = 12;

/** Full-scale amplitude taken as this many dB SPL, for the absolute threshold. */
const FULL_SCALE_DB_SPL = 96;

/**
 * How much a band's threshold may rise between consecutive granules.
 *
 * Forward masking is generous and backward masking is not: the ear tolerates
 * noise after a loud sound far better than before it. Capping the rise stops the
 * model from raising a threshold for a transient that has not happened yet.
 */
const MAX_THRESHOLD_RISE = 2;

/**
 * Marks the granules that contain an attack sharp enough to need short blocks.
 *
 * Pre-echo is a consequence of the transform's length: a long block spreads its
 * quantisation noise across all 576 samples it covers, so noise belonging to a
 * drum hit arrives up to 12 ms *before* the hit does, in what should be silence.
 * The ear notices that far more readily than noise during the hit itself.
 *
 * Detection compares each short segment's energy against a decaying average of
 * what came before. A ratio threshold rather than a fixed level, because the
 * effect is relative: a loud attack in loud music is masked, and a modest one
 * after silence is not.
 *
 * @param out One flag per granule. Sized by the caller.
 */
export function detectAttacks(
  input: Float32Array,
  granuleCount: number,
  out: Uint8Array,
): void {
  const SEGMENTS = 3;
  const SEGMENT = 576 / SEGMENTS;
  /** How far a segment must exceed recent history to count as an attack. */
  const ATTACK_RATIO = 10;
  /** Below this there is nothing to pre-echo into. */
  const FLOOR = 1e-7;

  // Negative until the first segment has been seen. An attack is a *rise*
  // relative to what came before, and before the first sample there is nothing
  // to have risen from — starting the average at zero instead makes every
  // signal begin with a spurious attack, however gently it fades in.
  let history = -1;

  for (let g = 0; g < granuleCount; g++) {
    let attack = false;

    for (let s = 0; s < SEGMENTS; s++) {
      const start = g * 576 + s * SEGMENT;
      let energy = 0;
      for (let i = 0; i < SEGMENT; i++) {
        const sample = input[start + i] ?? 0;
        energy += sample * sample;
      }
      energy /= SEGMENT;

      if (history < 0) {
        history = energy;
        continue;
      }

      if (energy > FLOOR && energy > history * ATTACK_RATIO) attack = true;

      // Decaying average, so a sustained loud passage stops looking like an
      // attack after the first segment while a single hit still stands out.
      history = history * 0.6 + energy * 0.4;
    }

    out[g] = attack ? 1 : 0;
  }
}

/**
 * Turns attack flags into a legal sequence of block types.
 *
 * The format does not allow jumping between window shapes: a short block has to
 * be introduced by a start block and left by a stop block, because those are the
 * asymmetric windows whose overlap adds back to unity against their neighbours.
 * Emitting a short block straight after a long one produces a stream that parses
 * and decodes to a click.
 *
 * So a detected attack in granule N forces granule N-1 to become a start block —
 * one granule of lookahead, which is why detection runs over the whole input
 * before any of it is coded.
 *
 * @param attacks One flag per granule, consumed here.
 * @param out Block type per granule: 0 long, 1 start, 2 short, 3 stop.
 */
export function sequenceBlockTypes(attacks: Uint8Array, out: Uint8Array): void {
  const count = attacks.length;
  const isShort = new Uint8Array(count);

  // An attack threatens two granules, not one. Each MDCT window spans the
  // granule being coded and the one before it, so a hit anywhere in granule g
  // has its noise spread across the transforms centred on both g and g + 1.
  // Shortening only the first leaves the second to smear the decay backwards.
  for (let g = 0; g < count; g++) {
    if (attacks[g]) {
      isShort[g] = 1;
      if (g + 1 < count) isShort[g + 1] = 1;
    }
  }

  // Granule 0 has no predecessor to turn into a start block.
  if (count > 0) isShort[0] = 0;

  // A granule between two short runs would have to be both a stop and a start
  // at once. Making it short instead is the only legal resolution, and it can
  // cascade, so this runs to a fixed point.
  for (let pass = 0; pass < count; pass++) {
    let changed = false;
    for (let g = 1; g + 1 < count; g++) {
      if (!isShort[g] && isShort[g - 1] && isShort[g + 1]) {
        isShort[g] = 1;
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (let g = 0; g < count; g++) {
    if (isShort[g]) out[g] = 2;
    else if (g + 1 < count && isShort[g + 1]) out[g] = 1;
    else if (g > 0 && isShort[g - 1]) out[g] = 3;
    else out[g] = 0;
  }
}

/** Bark-scale frequency, the ear's own frequency axis. */
function toBark(hz: number): number {
  return 13 * Math.atan(0.00076 * hz) + 3.5 * Math.atan((hz / 7500) ** 2);
}

/**
 * Absolute threshold of hearing in dB SPL (Terhardt's approximation).
 *
 * Rises steeply below ~500 Hz and above ~10 kHz, with the familiar dip around
 * 3–4 kHz where the ear is most sensitive.
 */
function absoluteThresholdDb(hz: number): number {
  const k = Math.max(hz, 20) / 1000;
  return 3.64 * k ** -0.8 - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4;
}

/**
 * The spreading function, in dB, for a masker `dz` barks away.
 *
 * Schroeder's expression, asymmetric by construction: the rise below the masker
 * is steep and the fall above it is gradual, which is why a loud low tone masks
 * the band above it far more than the band below.
 */
function spreadingDb(dz: number): number {
  const x = dz + 0.474;
  return 15.81 + 7.5 * x - 17.5 * Math.sqrt(1 + x * x);
}

/**
 * Per-granule masking thresholds for one channel.
 *
 * Stateful — it remembers the previous granule's thresholds for the temporal
 * cap — so one instance per channel, never shared.
 */
export class PsychoacousticModel {
  readonly #bands: Int16Array;
  readonly #shortBands: Int16Array;
  readonly #bandCount = 22;

  /** Hann window over the analysis frame. */
  readonly #window = new Float64Array(FFT_SIZE);
  readonly #real = new Float64Array(FFT_SIZE);
  readonly #imag = new Float64Array(FFT_SIZE);
  readonly #power = new Float64Array(BINS);

  /** Threshold partitions, about a third of a bark each. */
  readonly #partitionCount: number;
  readonly #partitionFirst: Int32Array;
  readonly #partitionLast: Int32Array;

  /** `spread[to * n + from]`, normalised so the convolution cannot add energy. */
  readonly #spread: Float64Array;
  /** Absolute hearing threshold per partition, as power per bin, full scale = 1. */
  readonly #absolute: Float64Array;

  readonly #energy: Float64Array;
  readonly #flatness: Float64Array;
  readonly #spreadEnergy: Float64Array;
  readonly #threshold: Float64Array;
  readonly #previous: Float64Array;
  #hasPrevious = false;

  constructor(sampleRate: number) {
    const bands = SFB_LONG[sampleRate];
    if (!bands) throw new EncodeError(`No scalefactor band table for ${sampleRate} Hz.`);
    this.#bands = bands;

    const shortBands = SFB_SHORT[sampleRate];
    if (!shortBands) {
      throw new EncodeError(`No short scalefactor band table for ${sampleRate} Hz.`);
    }
    this.#shortBands = shortBands;

    for (let i = 0; i < FFT_SIZE; i++) {
      this.#window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    }

    // Partition the spectrum at roughly a third of a bark. Below a few hundred
    // hertz a third of a bark is narrower than one FFT bin, so partitions there
    // are single bins and the walk simply advances.
    const first: number[] = [];
    const last: number[] = [];
    const centres: number[] = [];
    const binHz = sampleRate / FFT_SIZE;

    let bin = 1; // bin 0 is DC and carries no pitch
    while (bin < BINS) {
      const startBark = toBark(bin * binHz);
      let end = bin;
      while (end + 1 < BINS && toBark((end + 1) * binHz) - startBark < 1 / 3) end++;
      first.push(bin);
      last.push(end);
      centres.push(toBark(((bin + end) / 2) * binHz));
      bin = end + 1;
    }

    this.#partitionCount = first.length;
    this.#partitionFirst = Int32Array.from(first);
    this.#partitionLast = Int32Array.from(last);

    const n = this.#partitionCount;
    this.#energy = new Float64Array(n);
    this.#flatness = new Float64Array(n);
    this.#spreadEnergy = new Float64Array(n);
    this.#threshold = new Float64Array(n);
    this.#previous = new Float64Array(n);
    this.#absolute = new Float64Array(n);

    this.#spread = new Float64Array(n * n);
    for (let to = 0; to < n; to++) {
      let total = 0;
      for (let from = 0; from < n; from++) {
        const weight = 10 ** (spreadingDb(centres[to]! - centres[from]!) / 10);
        this.#spread[to * n + from] = weight;
        total += weight;
      }
      // Dividing by the row sum undoes the gain the convolution would otherwise
      // add, so a flat spectrum spreads to its own level rather than louder.
      if (total > 0) {
        for (let from = 0; from < n; from++) this.#spread[to * n + from]! /= total;
      }
    }

    for (let p = 0; p < n; p++) {
      const hz = ((this.#partitionFirst[p]! + this.#partitionLast[p]!) / 2) * binHz;
      this.#absolute[p] = 10 ** ((absoluteThresholdDb(hz) - FULL_SCALE_DB_SPL) / 10);
    }
  }

  /** Forgets history, e.g. when starting a new stream. */
  reset(): void {
    this.#hasPrevious = false;
  }

  /**
   * Masking thresholds for one granule, as allowed mean squared error per MDCT
   * line — the units {@link quantizeGranule} expects.
   *
   * @param input The channel's samples.
   * @param startSample First sample of the granule being coded.
   * @param spectrum The granule's 576 MDCT lines, which set the scale.
   * @param out 22 thresholds, one per scalefactor band.
   */
  analyse(
    input: Float32Array,
    startSample: number,
    spectrum: Float32Array,
    out: Float32Array,
    short = false,
  ): void {
    this.#transform(input, startSample);
    this.#measureBands();
    this.#spreadAndMask();
    this.#toMdctScale(spectrum, out, short);
  }

  /** Windows 1024 samples centred on the granule and takes their power spectrum. */
  #transform(input: Float32Array, startSample: number): void {
    // Centred on the granule: the threshold should describe the audio being
    // coded, not the audio before it.
    const begin = startSample + 288 - FFT_SIZE / 2;

    for (let i = 0; i < FFT_SIZE; i++) {
      const index = begin + i;
      const sample = index >= 0 && index < input.length ? input[index]! : 0;
      this.#real[i] = sample * this.#window[i]!;
      this.#imag[i] = 0;
    }

    fft(this.#real, this.#imag);

    const scale = 2 / FFT_SIZE;
    for (let bin = 0; bin < BINS; bin++) {
      const re = this.#real[bin]! * scale;
      const im = this.#imag[bin]! * scale;
      this.#power[bin] = re * re + im * im;
    }
  }

  /** Mean power and spectral flatness for each partition. */
  #measureBands(): void {
    for (let sfb = 0; sfb < this.#partitionCount; sfb++) {
      const first = this.#partitionFirst[sfb]!;
      const last = this.#partitionLast[sfb]!;
      const width = last - first + 1;

      let sum = 0;
      for (let bin = first; bin <= last; bin++) sum += this.#power[bin]!;
      this.#energy[sfb] = sum / width;

      // Flatness gets its own, wider window; see MIN_FLATNESS_BINS.
      const pad = Math.max(0, Math.ceil((MIN_FLATNESS_BINS - width) / 2));
      const from = Math.max(1, first - pad);
      const to = Math.min(BINS - 1, last + pad);

      let flatSum = 0;
      let logSum = 0;
      for (let bin = from; bin <= to; bin++) {
        // The floor keeps the geometric mean finite when a bin is exactly zero,
        // which happens constantly on synthetic material.
        const power = this.#power[bin]! + 1e-30;
        flatSum += power;
        logSum += Math.log(power);
      }

      const span = to - from + 1;
      const arithmetic = flatSum / span;
      const geometric = Math.exp(logSum / span);

      // Spectral flatness: 1 for noise, towards 0 for a pure tone.
      this.#flatness[sfb] = arithmetic > 0 ? geometric / arithmetic : 1;
    }
  }

  /** Spreads energy across partitions, then converts it to a masking threshold. */
  #spreadAndMask(): void {
    const count = this.#partitionCount;

    for (let to = 0; to < count; to++) {
      let spread = 0;
      for (let from = 0; from < count; from++) {
        spread += this.#spread[to * count + from]! * this.#energy[from]!;
      }
      this.#spreadEnergy[to] = spread;
    }

    for (let sfb = 0; sfb < count; sfb++) {
      // Flatness in dB, clamped to the range where it maps onto tonality.
      const flatnessDb = 10 * Math.log10(Math.max(this.#flatness[sfb]!, 1e-12));
      const tonality = Math.min(1, Math.max(0, flatnessDb / FLATNESS_FLOOR_DB));

      // A tonal band demands a high signal-to-mask ratio; a noisy one does not.
      const requiredSnrDb =
        tonality * TONE_MASKING_NOISE + (1 - tonality) * NOISE_MASKING_TONE;

      let threshold = this.#spreadEnergy[sfb]! / 10 ** (requiredSnrDb / 10);

      // Nothing below the quiet threshold of hearing is audible regardless.
      threshold = Math.max(threshold, this.#absolute[sfb]!);

      // A threshold above the partition's own energy would license destroying
      // it outright on the strength of its neighbours. Real masking does reach
      // that far, but not from an estimate this coarse.
      threshold = Math.min(threshold, this.#energy[sfb]!);

      // Forward masking only: a threshold may fall freely but rise slowly, so a
      // transient cannot license noise in the quiet that precedes it.
      if (this.#hasPrevious) {
        threshold = Math.min(threshold, this.#previous[sfb]! * MAX_THRESHOLD_RISE);
        threshold = Math.max(threshold, this.#absolute[sfb]!);
      }

      this.#threshold[sfb] = threshold;
    }

    this.#previous.set(this.#threshold);
    this.#hasPrevious = true;
  }

  /**
   * Converts thresholds into allowed error on the MDCT lines.
   *
   * Each band's signal-to-mask ratio is dimensionless, so applying it to that
   * band's own MDCT energy carries the threshold across without ever needing a
   * constant relating the two transforms.
   */
  #toMdctScale(spectrum: Float32Array, out: Float32Array, short: boolean): void {
    // A short granule's 576 lines are three 192-line windows interleaved by
    // band, so a band's frequency range is a fraction of 192 rather than 576 and
    // its three windows sit contiguously. They share one threshold: the model
    // runs on a long window and cannot resolve which of the three a masker fell
    // in. Distinguishing them is what `subblock_gain` is for.
    const bands = short ? this.#shortBands : this.#bands;
    const bandCount = short ? 13 : this.#bandCount;
    const lines = short ? 192 : 576;
    const binsPerLine = FFT_SIZE / 2 / lines;
    const windows = short ? 3 : 1;

    // One scale factor for the whole granule, fitted from total energy, rather
    // than a signal-to-mask ratio per band.
    //
    // Per-band ratios seem tidier and are wrong: multiplying each band's own
    // energy by its own ratio throws away the absolute threshold of hearing,
    // because a band that is inaudibly quiet still ends up with a threshold
    // proportional to its own tiny energy. The encoder then spends its precision
    // on bands nobody can hear, and at 128 kbps there is not enough left for the
    // ones they can — measured, that produced silence.
    //
    // Calibrating level once per granule keeps the threshold *curve* intact,
    // absolute floor included, and only fits the one constant the FFT and MDCT
    // domains genuinely do not share.
    let mdctEnergy = 0;
    for (let i = 0; i < 576; i++) mdctEnergy += spectrum[i]! * spectrum[i]!;

    let fftEnergy = 0;
    let fftBins = 0;
    for (let p = 0; p < this.#partitionCount; p++) {
      const width = this.#partitionLast[p]! - this.#partitionFirst[p]! + 1;
      fftEnergy += this.#energy[p]! * width;
      fftBins += width;
    }

    const mdctMean = mdctEnergy / 576;
    const fftMean = fftEnergy / Math.max(1, fftBins);
    const scale = fftMean > 0 ? mdctMean / fftMean : 0;

    for (let sfb = 0; sfb < bandCount; sfb++) {
      const start = bands[sfb]!;
      const end = Math.min(bands[sfb + 1]!, lines);

      // All three windows of a short band, which are contiguous.
      const from = start * windows;
      const to = Math.min(end * windows, 576);

      let energy = 0;
      for (let i = from; i < to; i++) energy += spectrum[i]! * spectrum[i]!;
      const mean = energy / Math.max(1, to - from);

      // A band is only as maskable as its most exposed part, so it takes the
      // lowest threshold among the partitions it spans. Averaging would let a
      // masked partition excuse an audible one beside it.
      const firstBin = Math.floor(start * binsPerLine);
      const lastBin = Math.max(firstBin, Math.ceil(end * binsPerLine) - 1);

      let threshold = Infinity;
      for (let p = 0; p < this.#partitionCount; p++) {
        if (this.#partitionLast[p]! < firstBin) continue;
        if (this.#partitionFirst[p]! > lastBin) break;
        if (this.#threshold[p]! < threshold) threshold = this.#threshold[p]!;
      }
      if (!Number.isFinite(threshold)) threshold = 0;

      // Capped at the band's own energy: allowing more noise than signal would
      // ask the quantiser to do worse than simply zeroing the band, and zeroing
      // is what it will choose anyway once the threshold is that high.
      out[sfb] = Math.min(threshold * scale, mean);
    }
  }
}
