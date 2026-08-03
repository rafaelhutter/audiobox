/**
 * Command-line converter.
 *
 *   node examples/convert.mjs input.wav output.flac
 *   node examples/convert.mjs input.wav output.wav --rate 16000 --mono --normalize
 */
import { readAudioFile, writeAudioFile } from '../dist/esm/node/index.js';

const [input, output, ...flags] = process.argv.slice(2);

if (!input || !output) {
  console.error('Usage: node convert.mjs <input> <output> [--rate N] [--mono] [--normalize] [--trim]');
  process.exit(1);
}

const flag = (name) => flags.includes(name);
const value = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};

let audio = await readAudioFile(input);
console.log(`in :  ${audio.durationFormatted}  ${audio.sampleRate} Hz  ${audio.channels}ch  ` +
            `peak ${audio.peakDb().toFixed(1)} dBFS`);

if (flag('--trim')) audio = audio.trimSilence({ paddingMs: 50 });
if (flag('--mono')) audio = audio.toMono();

const rate = value('--rate');
if (rate) audio = audio.resample(Number(rate));

if (flag('--normalize')) audio = audio.normalize({ to: -1 });

await writeAudioFile(output, audio);
console.log(`out:  ${audio.durationFormatted}  ${audio.sampleRate} Hz  ${audio.channels}ch  ` +
            `peak ${audio.peakDb().toFixed(1)} dBFS  -> ${output}`);
