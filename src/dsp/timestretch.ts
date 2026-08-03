/**
 * Tempo and pitch manipulation.
 *
 * Two distinct operations that are easy to confuse:
 *
 * - **`changeSpeed`** resamples. Playing a record faster raises its pitch; this
 *   does the digital equivalent. Cheap, and correct when you want the
 *   "chipmunk" behaviour.
 * - **`changeTempo`** uses WSOLA (Waveform Similarity Overlap-Add) to change
 *   duration while holding pitch constant — a podcast at 1.5× that still sounds
 *   like the same person.
 *
 * WSOLA works by cutting the signal into overlapping windows and reassembling
 * them at a different spacing. The "waveform similarity" part is what makes it
 * usable: naively overlapping windows at arbitrary offsets causes phase
 * cancellation that sounds like flanging or echo, so each window is nudged
 * within a small search range to the position where it best correlates with the
 * natural continuation of the previous one.
 */

import { InvalidArgumentError } from '../errors.ts';
import { resampleChannel } from './resample.ts';

/**
 * Changes playback speed, altering pitch with it.
 *
 * @param factor `2` plays twice as fast and an octave higher; `0.5` halves both.
 */
export function changeSpeed(
  channels: readonly Float32Array[],
  factor: number,
): Float32Array[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new InvalidArgumentError(`Speed factor must be positive, got ${factor}.`);
  }
  if (factor === 1) return channels.map((c) => c.slice());
  // Resampling by 1/factor and reinterpreting at the original rate is exactly
  // "play it faster": the samples are the same, there are just fewer of them.
  return channels.map((c) => resampleChannel(c, 1, 1 / factor, { quality: 'best' }));
}

/**
 * Changes duration while preserving pitch.
 *
 * @param factor `1.5` makes it 1.5× faster (shorter); `0.5` makes it twice as long.
 */
export function changeTempo(
  channels: readonly Float32Array[],
  factor: number,
  sampleRate: number,
): Float32Array[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new InvalidArgumentError(`Tempo factor must be positive, got ${factor}.`);
  }
  if (factor === 1) return channels.map((c) => c.slice());

  // ~50 ms windows: long enough to contain a full cycle of even low bass, short
  // enough that transients are not smeared across the window.
  const windowSize = Math.max(256, Math.round(0.05 * sampleRate) & ~1);
  const synthesisHop = windowSize >> 1;
  const analysisHop = Math.max(1, Math.round(synthesisHop * factor));
  // Search ±1/8 window. Wider finds better matches but costs proportionally more.
  const searchRadius = windowSize >> 3;

  // Hann window; at 50% overlap successive Hann windows sum to unity, so the
  // overlap-add needs no separate normalisation pass.
  const window = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1));
  }

  const inputFrames = channels[0]?.length ?? 0;
  const outputFrames = Math.max(0, Math.round(inputFrames / factor));

  // The search is driven by channel 0 and the same offset is applied to every
  // channel. Choosing offsets per channel would break phase coherence between
  // them and collapse the stereo image.
  const reference = channels[0] ?? new Float32Array(0);

  const out = channels.map(() => new Float32Array(outputFrames + windowSize));

  let previousInput = 0;
  let outputPos = 0;
  let frameIndex = 0;

  while (outputPos + windowSize < outputFrames + windowSize) {
    const target = Math.round(frameIndex * analysisHop);
    if (target + windowSize >= inputFrames) break;

    let chosen = target;

    if (frameIndex > 0) {
      // Template: what would have naturally followed the previous window.
      const templateStart = previousInput + synthesisHop;
      let bestScore = -Infinity;

      for (let d = -searchRadius; d <= searchRadius; d++) {
        const candidate = target + d;
        if (candidate < 0 || candidate + synthesisHop >= inputFrames) continue;
        if (templateStart + synthesisHop >= inputFrames) break;

        // Normalised cross-correlation over the overlap region.
        let dot = 0;
        let energy = 0;
        for (let i = 0; i < synthesisHop; i += 2) {
          const a = reference[templateStart + i]!;
          const b = reference[candidate + i]!;
          dot += a * b;
          energy += b * b;
        }
        const score = energy > 0 ? dot / Math.sqrt(energy) : 0;
        if (score > bestScore) {
          bestScore = score;
          chosen = candidate;
        }
      }
    }

    for (let c = 0; c < channels.length; c++) {
      const src = channels[c]!;
      const dst = out[c]!;
      for (let i = 0; i < windowSize; i++) {
        const s = chosen + i;
        if (s >= src.length) break;
        dst[outputPos + i]! += src[s]! * window[i]!;
      }
    }

    previousInput = chosen;
    outputPos += synthesisHop;
    frameIndex++;
  }

  return out.map((c) => c.slice(0, outputFrames));
}

/**
 * Shifts pitch without changing duration.
 *
 * Implemented as tempo change followed by resampling: stretch the audio, then
 * play the stretched version at a rate that restores the original length. The
 * pitch change survives; the duration change cancels out.
 *
 * @param semitones Positive raises pitch, negative lowers it.
 */
export function changePitch(
  channels: readonly Float32Array[],
  semitones: number,
  sampleRate: number,
): Float32Array[] {
  if (semitones === 0) return channels.map((c) => c.slice());

  const ratio = Math.pow(2, semitones / 12);
  const stretched = changeTempo(channels, 1 / ratio, sampleRate);
  const shifted = stretched.map((c) => resampleChannel(c, 1, 1 / ratio, { quality: 'best' }));

  // Rounding in the two stages can leave the result a sample or two off; pin it
  // to the original length so pitch shifting is exactly duration-preserving.
  const target = channels[0]?.length ?? 0;
  return shifted.map((c) => {
    if (c.length === target) return c;
    const out = new Float32Array(target);
    out.set(c.subarray(0, Math.min(c.length, target)));
    return out;
  });
}
