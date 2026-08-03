/**
 * Cross-runtime smoke test.
 *
 * Runs against the built output on Node, Deno and Bun in CI. It touches the
 * paths most likely to break on a different runtime — typed arrays, DataView
 * endianness, and the dynamic import used for lazy codec loading — rather than
 * trying to be a second test suite.
 */
import { Audio, decode, encode, sniff } from '../dist/esm/index.js';

let failures = 0;
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures++;
  }
};

console.log('audiobox smoke test');

const rate = 44100;
const frames = rate;
const left = new Float32Array(frames);
const right = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  left[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
  right[i] = Math.sin((2 * Math.PI * 554 * i) / rate) * 0.5;
}

const audio = new Audio([left, right], rate);
check('constructs an Audio', audio.channels === 2 && audio.duration === 1);

const edited = audio.cut({ from: 0.25, to: 0.75 }).toMono().resample(16000).normalize({ to: -1 });
check('cut halves the duration', Math.abs(edited.duration - 0.5) < 0.01);
check('toMono collapses channels', edited.channels === 1);
check('resample changes the rate', edited.sampleRate === 16000);
check('normalize hits the target', Math.abs(edited.peakDb() + 1) < 0.05);

for (const format of ['wav', 'aiff', 'au', 'caf']) {
  const bytes = await encode(audio, format);
  const back = await decode(bytes);
  check(`${format} round-trips`, back.frames === frames && back.sampleRate === rate);
  check(`${format} is detected by content`, sniff(bytes).format === format);
}

// FLAC exercises the lazy dynamic import, which is the part most likely to
// differ between bundlers and runtimes.
const flac = await encode(audio, 'flac');
const decodedFlac = await decode(flac);
check('flac loads lazily and round-trips', decodedFlac.frames === frames);
check('flac actually compresses', flac.byteLength < frames * 2 * 2);

const loudness = audio.loudness();
check('loudness is measurable', Number.isFinite(loudness.integrated));

const { min, max } = audio.waveform(64);
check('waveform returns extremes', min.length === 64 && max.length === 64 && max[10] > 0);

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
if (failures > 0) throw new Error(`${failures} smoke check(s) failed`);
