/**
 * Benchmarks.
 *
 * Reports throughput as a realtime multiple ("×RT"): how many seconds of audio
 * are processed per second of CPU. That is the number that actually predicts
 * whether an operation will block a UI, and unlike raw milliseconds it stays
 * meaningful across machines and clip lengths.
 *
 *   node bench/index.mjs
 */
import { Audio, encode, decode } from '../dist/esm/index.js';
import { encodeFlac, } from '../dist/esm/flac/encoder.js';
import { decodeFlac } from '../dist/esm/flac/decoder.js';
import { resampleChannel } from '../dist/esm/dsp/resample.js';
import { measureLoudness, measureTruePeak } from '../dist/esm/analyze/loudness.js';

const RATE = 44100;
const SECONDS = 30;

/** Music-like content: several partials plus an amplitude envelope. */
function makeSource(seconds, rate, channels = 2) {
  const frames = seconds * rate;
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / rate;
      const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.35 * t);
      out[i] =
        envelope *
        0.6 *
        (Math.sin(2 * Math.PI * (220 + c * 3) * t) * 0.5 +
          Math.sin(2 * Math.PI * 880 * t) * 0.25 +
          Math.sin(2 * Math.PI * 3200 * t) * 0.12);
    }
    return out;
  });
}

const source = makeSource(SECONDS, RATE);
const audio = new Audio(source, RATE);

/** Times `fn`, taking the best of `runs` to reduce scheduling noise. */
async function measure(label, runs, fn) {
  // One untimed pass so JIT warm-up is not attributed to the operation.
  await fn();

  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    best = Math.min(best, performance.now() - start);
  }

  const realtime = (SECONDS * 1000) / best;
  console.log(
    `  ${label.padEnd(34)} ${best.toFixed(0).padStart(6)} ms   ${realtime.toFixed(0).padStart(5)}×RT`,
  );
  return best;
}

console.log(`audiobox benchmarks — ${SECONDS}s of ${RATE} Hz stereo audio`);
console.log(`node ${process.version} on ${process.platform}/${process.arch}\n`);

console.log('Encoding');
await measure('WAV 16-bit', 5, () => encode(audio, 'wav', { bitDepth: 16 }));
await measure('WAV 24-bit', 5, () => encode(audio, 'wav', { bitDepth: 24 }));
await measure('FLAC level 0', 3, () => encodeFlac(audio, { compressionLevel: 0 }));
await measure('FLAC level 5 (default)', 3, () => encodeFlac(audio, { compressionLevel: 5 }));
await measure('FLAC level 8', 2, () => encodeFlac(audio, { compressionLevel: 8 }));

console.log('\nDecoding');
const wavBytes = await encode(audio, 'wav', { bitDepth: 16 });
const flacBytes = encodeFlac(audio, { compressionLevel: 5 });
await measure('WAV 16-bit', 5, () => decode(wavBytes));
await measure('FLAC', 3, () => decodeFlac(flacBytes));

console.log('\nResampling (44.1 kHz source)');
await measure('-> 48 kHz, sinc (default)', 3, () => resampleChannel(source[0], RATE, 48000));
await measure('-> 16 kHz, sinc', 3, () => resampleChannel(source[0], RATE, 16000));
await measure('-> 48 kHz, cubic', 5, () =>
  resampleChannel(source[0], RATE, 48000, { quality: 'good' }),
);
await measure('-> 48 kHz, linear', 5, () =>
  resampleChannel(source[0], RATE, 48000, { quality: 'fast' }),
);

console.log('\nAnalysis');
await measure('EBU R128 loudness', 3, () => measureLoudness(source, RATE));
await measure('true peak (4x oversampled)', 2, () => measureTruePeak(source));
await measure('waveform peaks (2000 buckets)', 5, () => audio.waveform(2000));

console.log('\nProcessing');
await measure('normalize (peak)', 5, () => audio.normalize({ to: -1 }));
await measure('normalize (LUFS)', 2, () => audio.normalize({ to: -14, unit: 'LUFS' }));
await measure('lowpass filter', 5, () => audio.filter({ type: 'lowpass', frequency: 8000 }));
await measure('lookahead limiter', 3, () => audio.limit({ threshold: -1 }));
await measure('stereo -> mono', 5, () => audio.toMono());

const flacRatio = (flacBytes.byteLength / wavBytes.byteLength) * 100;
console.log(`\nFLAC compression: ${flacRatio.toFixed(1)}% of WAV size`);
console.log('\nAnything above ~50×RT will encode a 3-minute track in under 4 seconds.');
