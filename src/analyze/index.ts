/**
 * Measurement and analysis — `audiobox/analyze`.
 *
 * Everything here is read-only: it inspects audio and returns numbers. Useful on
 * its own for validating uploads, building meters, or drawing waveforms without
 * pulling in the editing machinery.
 */

export {
  measureLoudness,
  measurePeak,
  measureTruePeak,
  measureRms,
  toDb,
  fromDb,
} from './loudness.ts';
export type { LoudnessResult } from './loudness.ts';

export { fft, spectrum, spectrogram } from './fft.ts';
export type { SpectrumOptions } from './fft.ts';

export { detectSilence } from '../dsp/silence.ts';
export type { SilenceOptions, SilentRange } from '../dsp/silence.ts';
