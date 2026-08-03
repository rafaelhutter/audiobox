/**
 * Prints a loudness and level report, and draws a waveform in the terminal.
 *
 *   node examples/analyze.mjs track.flac
 */
import { readAudioFile } from '../dist/esm/node/index.js';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node analyze.mjs <file>');
  process.exit(1);
}

const audio = await readAudioFile(path);
const loudness = audio.loudness();

console.log(`file        ${path}`);
console.log(`format      ${audio.info?.format} (${audio.info?.sampleFormat}, ${audio.info?.bitDepth}-bit)`);
console.log(`duration    ${audio.durationFormatted}`);
console.log(`rate        ${audio.sampleRate} Hz, ${audio.channels} channel(s)`);
console.log(`peak        ${audio.peakDb().toFixed(2)} dBFS`);
console.log(`true peak   ${audio.truePeakDb().toFixed(2)} dBTP`);
console.log(`RMS         ${audio.rmsDb().toFixed(2)} dBFS`);
console.log(`loudness    ${loudness.integrated.toFixed(2)} LUFS  (range ${loudness.range.toFixed(1)} LU)`);

const silence = audio.detectSilence({ threshold: -50 });
if (silence.length > 0) {
  console.log(`silence     ${silence.length} span(s), longest ` +
    `${(Math.max(...silence.map(s => s.end - s.start)) / audio.sampleRate).toFixed(2)}s`);
}

// A rough waveform, drawn with block characters.
const width = 72;
const { min, max } = audio.waveform(width);
const blocks = ' ▁▂▃▄▅▆▇█';
console.log('\nwaveform');
let line = '';
for (let x = 0; x < width; x++) {
  const amplitude = Math.max(Math.abs(min[x]), Math.abs(max[x]));
  line += blocks[Math.min(blocks.length - 1, Math.round(amplitude * (blocks.length - 1)))];
}
console.log(line);
