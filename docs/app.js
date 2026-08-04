/**
 * audiobox playground.
 *
 * Loads the real published package straight from a CDN — no bundler, no build
 * step, no vendored copy. That is deliberate: the page demonstrates the library
 * exactly as a user receives it from npm, and if something here breaks, it broke
 * for them too.
 *
 * Everything runs in the browser. No audio leaves the machine.
 */

// Tracks the latest 1.x release rather than a pinned patch, so the playground
// always demonstrates what `npm install audiobox` actually gives you today.
// jsDelivr serves the package's own files, so the lazily-imported subpaths
// (mp3, flac) resolve relative to this URL without any bundling step.
const CDN = 'https://cdn.jsdelivr.net/npm/audiobox@1/dist/esm/index.js';

/** @type {import('audiobox')} */
let ab;

const $ = (id) => document.getElementById(id);

const el = {
  drop: $('drop'), file: $('file'), demo: $('demo'), loadStatus: $('loadStatus'),
  workspace: $('workspace'), facts: $('facts'), wave: $('wave'),
  apply: $('apply'), reset: $('reset'), status: $('status'), outFacts: $('outFacts'),
  playSrc: $('playSrc'), playOut: $('playOut'), stop: $('stop'), download: $('download'),
  code: $('code'), copyCode: $('copyCode'),
};

const control = {
  trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimSilence: $('trimSilence'),
  channels: $('channels'), rate: $('rate'),
  normMode: $('normMode'), normTarget: $('normTarget'), gain: $('gain'),
  fadeIn: $('fadeIn'), fadeOut: $('fadeOut'), filterType: $('filterType'), filterFreq: $('filterFreq'),
  tempo: $('tempo'), pitch: $('pitch'),
  outFormat: $('outFormat'), outDepth: $('outDepth'),
};

/** Source audio, processed result, and the encoded bytes of the result. */
let source = null;
let result = null;
let encoded = null;
let objectUrl = null;

// ── Library loading ────────────────────────────────────────────────────────

async function library() {
  if (ab) return ab;
  setLoad('Loading audiobox from jsDelivr…');
  try {
    ab = await import(/* @vite-ignore */ CDN);
    setLoad('');
    void checkMp3Support();
    return ab;
  } catch (error) {
    setLoad(`Could not load audiobox from the CDN — ${error.message}`, true);
    throw error;
  }
}

/**
 * Hides the MP3 output option when the loaded build cannot write MP3.
 *
 * This page is deployed from the repository but loads the library from npm, so
 * the two are not always the same version — right after a change lands, and
 * again while the CDN's cache catches up. Offering an option that fails is worse
 * than not offering it, and this re-enables itself as soon as the published
 * build has the encoder.
 */
async function checkMp3Support() {
  const option = control.outFormat.querySelector('option[value="mp3"]');
  if (!option) return;
  try {
    const mp3 = await import(/* @vite-ignore */ CDN.replace('/index.js', '/mp3/index.js'));
    if (mp3.encodeMp3) return;
  } catch {
    /* fall through to hiding it */
  }
  option.disabled = true;
  option.textContent = 'MP3 (not in the published build yet)';
}

function setLoad(message, isError = false) {
  el.loadStatus.textContent = message;
  el.loadStatus.classList.toggle('error', isError);
}

function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`;
}

// ── Formatting helpers ─────────────────────────────────────────────────────

const bytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 ** 2).toFixed(2)} MB`;

const db = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '−∞');

/**
 * Sample rates as kHz.
 *
 * `toLocaleString()` is wrong here: in locales that group with a dot it renders
 * 44100 as "44.100 Hz", which reads as 44.1 Hz — off by a factor of a thousand.
 */
const hz = (rate) => (rate >= 1000 ? `${+(rate / 1000).toFixed(3)} kHz` : `${rate} Hz`);

function renderFacts(target, entries) {
  target.innerHTML = entries
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join('');
  target.hidden = false;
}

// ── Loading audio ──────────────────────────────────────────────────────────

async function load(bytesIn, label) {
  const lib = await library();
  setLoad(`Decoding ${label}…`);

  const started = performance.now();
  let audio;
  try {
    audio = await lib.decode(bytesIn);
  } catch (error) {
    // AudioboxError carries a stable `code`; show it, since that is what a
    // developer would branch on in their own app.
    const code = error && error.code ? ` [${error.code}]` : '';
    setLoad(`${error.message}${code}`, true);
    return;
  }
  const ms = performance.now() - started;

  source = audio;
  result = null;
  encoded = null;
  el.playOut.disabled = true;
  el.download.hidden = true;
  el.outFacts.hidden = true;
  setStatus('');
  setLoad('');

  const info = audio.info ?? {};
  const loudness = audio.loudness().integrated;

  renderFacts(el.facts, [
    ['File', label],
    ['Format', (info.format ?? '?').toUpperCase() + (info.lossy ? ' (lossy)' : '')],
    ['Duration', audio.durationFormatted],
    ['Sample rate', hz(audio.sampleRate)],
    ['Channels', String(audio.channels)],
    ['Size', bytes(bytesIn.byteLength)],
    ['Peak', db(audio.peakDb())],
    ['True peak', db(audio.truePeakDb())],
    ['Loudness', Number.isFinite(loudness) ? `${loudness.toFixed(1)} LUFS` : '−∞'],
    ['Decoded in', `${ms.toFixed(0)} ms`],
  ]);

  control.trimStart.value = '0';
  control.trimEnd.value = audio.duration.toFixed(2);
  control.trimStart.max = control.trimEnd.max = audio.duration.toFixed(2);

  el.workspace.hidden = false;
  draw();
  updateCode();
  el.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Builds a short test tone locally, so the page needs no sample asset. */
async function demoTone() {
  const lib = await library();
  const rate = 44100;
  const frames = rate * 4;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    // A chord with a slow tremolo and a fade, so every control has something
    // audible to act on.
    const envelope = Math.min(1, t * 4) * Math.min(1, (frames / rate - t) * 2) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t));
    const tone =
      Math.sin(2 * Math.PI * 220 * t) * 0.5 +
      Math.sin(2 * Math.PI * 277.18 * t) * 0.3 +
      Math.sin(2 * Math.PI * 329.63 * t) * 0.25 +
      Math.sin(2 * Math.PI * 3000 * t) * 0.05;
    left[i] = envelope * tone * 0.5;
    right[i] = envelope * tone * 0.5 * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t));
  }

  const audio = new lib.Audio([left, right], rate);
  const wav = await lib.encode(audio, 'wav', { bitDepth: 16 });
  await load(wav, 'test-tone.wav');
}

// ── Waveform ───────────────────────────────────────────────────────────────

function draw() {
  const canvas = el.wave;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = 180;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim() || '#3fd1a7';

  // Zero line.
  ctx.strokeStyle = 'rgba(128,140,160,.28)';
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (source) plot(ctx, source, width, height, '#46536b');
  if (result) plot(ctx, result, width, height, accent);
}

function plot(ctx, audio, width, height, colour) {
  // `waveform()` returns per-bucket extremes rather than averages, which is what
  // keeps transients visible.
  const { min, max } = audio.waveform(Math.max(1, Math.floor(width)));
  ctx.fillStyle = colour;
  for (let x = 0; x < min.length; x++) {
    const top = (0.5 - max[x] / 2) * height;
    const bottom = (0.5 - min[x] / 2) * height;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

// ── The pipeline ───────────────────────────────────────────────────────────

/**
 * Reads the controls into a plain description of the pipeline.
 * Used both to run the transform and to generate the code sample, so the two
 * can never drift apart.
 */
function pipeline() {
  const steps = [];
  const number = (input, fallback = 0) => {
    const value = Number.parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const start = number(control.trimStart, 0);
  const end = number(control.trimEnd, source ? source.duration : 0);
  if (source && (start > 0.001 || end < source.duration - 0.001)) {
    steps.push({ call: 'cut', args: `{ from: ${start}, to: ${end} }` });
  }
  if (control.trimSilence.checked) steps.push({ call: 'trimSilence', args: '{ paddingMs: 50 }' });

  if (control.channels.value === '1') steps.push({ call: 'toMono', args: '' });
  else if (control.channels.value === '2') steps.push({ call: 'toStereo', args: '' });

  if (control.rate.value !== 'keep') steps.push({ call: 'resample', args: control.rate.value });

  const gain = number(control.gain, 0);
  if (gain !== 0) steps.push({ call: 'gainDb', args: String(gain) });

  if (control.filterType.value !== 'none') {
    steps.push({
      call: 'filter',
      args: `{ type: '${control.filterType.value}', frequency: ${number(control.filterFreq, 8000)} }`,
    });
  }

  const tempo = number(control.tempo, 1);
  if (tempo !== 1) steps.push({ call: 'tempo', args: String(tempo) });

  const pitch = number(control.pitch, 0);
  if (pitch !== 0) steps.push({ call: 'pitch', args: String(pitch) });

  const fadeIn = number(control.fadeIn, 0);
  const fadeOut = number(control.fadeOut, 0);
  if (fadeIn > 0 || fadeOut > 0) {
    const parts = [];
    if (fadeIn > 0) parts.push(`in: ${fadeIn}`);
    if (fadeOut > 0) parts.push(`out: ${fadeOut}`);
    steps.push({ call: 'fade', args: `{ ${parts.join(', ')} }` });
  }

  // Normalisation runs last so it accounts for everything before it.
  if (control.normMode.value !== 'off') {
    const target = number(control.normTarget, -1);
    const unit = control.normMode.value;
    steps.push({
      call: 'normalize',
      args: unit === 'peak' ? `{ to: ${target} }` : `{ to: ${target}, unit: '${unit}' }`,
    });
  }

  return steps;
}

/** Media types for the output blob, so the browser will play it back. */
const MEDIA_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  au: 'audio/basic',
};

function encodeOptions() {
  const format = control.outFormat.value;
  const depth = control.outDepth.value;
  if (format === 'flac') return { js: '{ compressionLevel: 5 }', obj: { compressionLevel: 5 } };
  // MP3 is lossy, so bit depth means nothing to it; variable bitrate is the
  // setting that matters and the one worth showing.
  if (format === 'mp3') {
    return { js: '{ vbr: true, quality: 4 }', obj: { vbr: true, quality: 4 } };
  }
  return { js: `{ bitDepth: ${depth} }`, obj: { bitDepth: Number(depth) } };
}

async function apply() {
  if (!source) return;
  const lib = await library();

  el.apply.disabled = true;
  setStatus('Working…');
  // Yield so the button state paints before the synchronous DSP runs.
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    const started = performance.now();
    let audio = source;
    for (const step of pipeline()) {
      audio = applyStep(audio, step);
    }

    const format = control.outFormat.value;
    const options = encodeOptions();
    const output = await lib.encode(audio, format, options.obj);
    const ms = performance.now() - started;

    result = audio;
    encoded = output;

    const loudness = audio.loudness().integrated;
    renderFacts(el.outFacts, [
      ['Duration', audio.durationFormatted],
      ['Sample rate', hz(audio.sampleRate)],
      ['Channels', String(audio.channels)],
      ['Peak', db(audio.peakDb())],
      ['Loudness', Number.isFinite(loudness) ? `${loudness.toFixed(1)} LUFS` : '−∞'],
      ['Encoded size', bytes(output.byteLength)],
    ]);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    // A real media type, so "Play output" works rather than the browser
    // refusing to touch an octet-stream.
    objectUrl = URL.createObjectURL(new Blob([output], { type: MEDIA_TYPES[format] ?? 'application/octet-stream' }));
    el.download.href = objectUrl;
    el.download.download = `audiobox-output.${format === 'aiff' ? 'aif' : format}`;
    el.download.hidden = false;
    el.playOut.disabled = false;

    setStatus(`Done in ${ms.toFixed(0)} ms — ${bytes(output.byteLength)} of ${format.toUpperCase()}.`, 'ok');
    draw();
  } catch (error) {
    const code = error && error.code ? ` [${error.code}]` : '';
    setStatus(`${error.message}${code}`, 'error');
  } finally {
    el.apply.disabled = false;
  }
}

function applyStep(audio, step) {
  switch (step.call) {
    case 'cut': {
      const [, from, to] = step.args.match(/from: ([\d.]+), to: ([\d.]+)/);
      return audio.cut({ from: Number(from), to: Number(to) });
    }
    case 'trimSilence': return audio.trimSilence({ paddingMs: 50 });
    case 'toMono': return audio.toMono();
    case 'toStereo': return audio.toStereo();
    case 'resample': return audio.resample(Number(step.args));
    case 'gainDb': return audio.gainDb(Number(step.args));
    case 'filter': {
      const type = step.args.match(/type: '(\w+)'/)[1];
      const frequency = Number(step.args.match(/frequency: ([\d.]+)/)[1]);
      return audio.filter({ type, frequency });
    }
    case 'tempo': return audio.tempo(Number(step.args));
    case 'pitch': return audio.pitch(Number(step.args));
    case 'fade': {
      const options = {};
      const inMatch = step.args.match(/in: ([\d.]+)/);
      const outMatch = step.args.match(/out: ([\d.]+)/);
      if (inMatch) options.in = Number(inMatch[1]);
      if (outMatch) options.out = Number(outMatch[1]);
      return audio.fade(options);
    }
    case 'normalize': {
      const to = Number(step.args.match(/to: (-?[\d.]+)/)[1]);
      const unit = step.args.match(/unit: '(\w+)'/);
      return audio.normalize(unit ? { to, unit: unit[1] } : { to });
    }
    default: return audio;
  }
}

// ── Generated code ─────────────────────────────────────────────────────────

function updateCode() {
  const steps = pipeline();
  const format = control.outFormat.value;
  const options = encodeOptions();

  const chain = steps.length
    ? `\n\nconst clip = audio\n${steps.map((s) => `  .${s.call}(${s.args})`).join('\n')};`
    : '\n\nconst clip = audio;   // no transforms selected';

  el.code.textContent =
    `import { decode, encode } from 'audiobox';

const audio = await decode(bytes);${chain}

const output = await encode(clip, '${format}', ${options.js});`;
}

// ── Playback ───────────────────────────────────────────────────────────────

let audioContext = null;
let playing = null;

function play(audio) {
  stop();
  if (!audio) return;

  audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
  const buffer = audioContext.createBuffer(audio.channels, audio.frames, audio.sampleRate);
  for (let c = 0; c < audio.channels; c++) buffer.copyToChannel(audio.channelData(c), c);

  const node = audioContext.createBufferSource();
  node.buffer = buffer;
  node.connect(audioContext.destination);
  node.start();
  playing = node;
}

function stop() {
  if (playing) {
    try { playing.stop(); } catch { /* already ended */ }
    playing = null;
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────

el.file.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) await load(new Uint8Array(await file.arrayBuffer()), file.name);
});

el.demo.addEventListener('click', () => {
  demoTone().catch((error) => setLoad(error.message, true));
});

for (const event of ['dragenter', 'dragover']) {
  el.drop.addEventListener(event, (e) => {
    e.preventDefault();
    el.drop.classList.add('over');
  });
}
for (const event of ['dragleave', 'drop']) {
  el.drop.addEventListener(event, (e) => {
    e.preventDefault();
    el.drop.classList.remove('over');
  });
}
el.drop.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) await load(new Uint8Array(await file.arrayBuffer()), file.name);
});

el.apply.addEventListener('click', apply);

el.reset.addEventListener('click', () => {
  for (const [name, input] of Object.entries(control)) {
    if (input.type === 'checkbox') input.checked = false;
    else if (input.tagName === 'SELECT') input.selectedIndex = 0;
    else if (name === 'tempo') input.value = '1';
    else if (name === 'normTarget') input.value = '-1';
    else if (name === 'filterFreq') input.value = '8000';
    else input.value = '0';
  }
  if (source) control.trimEnd.value = source.duration.toFixed(2);
  result = null;
  encoded = null;
  el.playOut.disabled = true;
  el.download.hidden = true;
  el.outFacts.hidden = true;
  setStatus('');
  draw();
  updateCode();
});

el.playSrc.addEventListener('click', () => play(source));
el.playOut.addEventListener('click', () => play(result));
el.stop.addEventListener('click', stop);

for (const input of Object.values(control)) {
  input.addEventListener('input', updateCode);
  input.addEventListener('change', updateCode);
}

// Copy buttons.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy');
  if (!button) return;
  const text = button.dataset.copy ?? el.code.textContent;
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1400);
  } catch {
    /* clipboard unavailable — nothing useful to do */
  }
});

window.addEventListener('resize', () => { if (source) draw(); });

updateCode();
