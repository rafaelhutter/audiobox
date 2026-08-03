import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Audio } from '../src/audio.ts';
import { resampleChannel } from '../src/dsp/resample.ts';
import { toSampleIndex, toFrameCount, formatDuration } from '../src/dsp/time.ts';
import { measureLoudness, measurePeak, measureTruePeak, toDb } from '../src/analyze/loudness.ts';
import { InvalidArgumentError } from '../src/errors.ts';

const RATE = 48000;

function sine(frames: number, hz: number, rate = RATE, amplitude = 0.5): Float32Array {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amplitude;
  return a;
}

/** Signal-to-noise ratio in dB between a signal and a reference. */
function snr(signal: Float32Array, reference: Float32Array, skip = 0): number {
  let signalPower = 0;
  let noisePower = 0;
  for (let i = skip; i < Math.min(signal.length, reference.length) - skip; i++) {
    signalPower += reference[i]! * reference[i]!;
    const error = signal[i]! - reference[i]!;
    noisePower += error * error;
  }
  return noisePower === 0 ? Infinity : 10 * Math.log10(signalPower / noisePower);
}

describe('time positions', () => {
  test('parses every accepted notation', () => {
    assert.equal(toSampleIndex(1, 1000, 10000), 1000);
    assert.equal(toSampleIndex('1:30', 1000, 1e9), 90_000);
    assert.equal(toSampleIndex('1:02:03', 1000, 1e9), 3_723_000);
    assert.equal(toSampleIndex('500ms', 1000, 10000), 500);
    assert.equal(toSampleIndex('1.5s', 1000, 10000), 1500);
    assert.equal(toSampleIndex({ sample: 4242 }, 1000, 10000), 4242);
  });

  test('negative positions count back from the end, like Array.slice', () => {
    assert.equal(toSampleIndex(-2, 1000, 10000), 8000);
    assert.equal(toSampleIndex({ sample: -100 }, 1000, 10000), 9900);
  });

  test('clamps rather than throwing on out-of-range positions', () => {
    assert.equal(toSampleIndex(999, 1000, 5000), 5000);
    assert.equal(toSampleIndex(-999, 1000, 5000), 0);
  });

  test('rejects unparseable input with a message naming the accepted forms', () => {
    assert.throws(() => toSampleIndex('half past four', 1000, 100), /Cannot parse time/);
    assert.throws(() => toFrameCount(-1, 1000), /non-negative/);
  });

  test('formats durations readably', () => {
    assert.equal(formatDuration(90.5), '1:30.500');
    assert.equal(formatDuration(3723.25), '1:02:03.250');
  });
});

describe('resampling', () => {
  test('preserves a sine wave when downsampling 48k -> 16k', () => {
    // 1 kHz is well below 8 kHz Nyquist, so it must survive essentially intact.
    const source = sine(RATE, 1000);
    const resampled = resampleChannel(source, RATE, 16000);
    assert.equal(resampled.length, 16000);

    const expected = sine(16000, 1000, 16000);
    // Skip the edges, where any finite filter kernel is truncated.
    assert.ok(snr(resampled, expected, 64) > 55, `SNR was ${snr(resampled, expected, 64).toFixed(1)} dB`);
  });

  test('anti-aliases: content above the new Nyquist is removed, not folded', () => {
    // 7 kHz downsampled to 8 kHz (4 kHz Nyquist) must not reappear as a 1 kHz
    // alias. This is the single most common resampling bug.
    const source = sine(RATE, 7000, RATE, 0.9);
    const resampled = resampleChannel(source, RATE, 8000);

    // Any surviving energy would be aliased garbage; the result should be near-silent.
    let peak = 0;
    for (let i = 200; i < resampled.length - 200; i++) peak = Math.max(peak, Math.abs(resampled[i]!));
    assert.ok(peak < 0.05, `aliased energy leaked through: peak ${peak.toFixed(4)}`);
  });

  test('a fast-quality resample is measurably worse at a non-integer ratio', () => {
    // The ratio matters. At an exact 3:1 (48k -> 16k) every output sample lands
    // on an input sample, so even linear interpolation is bit-perfect and the
    // comparison says nothing. 44.1k -> 48k forces real interpolation, which is
    // where the difference between the two kernels actually shows up.
    const source = sine(44100, 6000, 44100);
    const best = resampleChannel(source, 44100, 48000, { quality: 'best' });
    const fast = resampleChannel(source, 44100, 48000, { quality: 'fast' });
    assert.equal(best.length, 48000);

    const reference = sine(48000, 6000, 48000);
    const bestSnr = snr(best, reference, 128);
    const fastSnr = snr(fast, reference, 128);
    assert.ok(
      bestSnr > fastSnr + 20,
      `sinc (${bestSnr.toFixed(1)} dB) must clearly beat linear (${fastSnr.toFixed(1)} dB)`,
    );
  });

  test('an exact integer ratio is handled losslessly by every quality', () => {
    // Documents the degenerate case above: 3:1 decimation of in-band content
    // should be essentially perfect regardless of kernel.
    const source = sine(RATE, 1000);
    const reference = sine(16000, 1000, 16000);
    for (const quality of ['fast', 'good', 'best'] as const) {
      const out = resampleChannel(source, RATE, 16000, { quality });
      assert.ok(snr(out, reference, 64) > 80, `${quality} scored ${snr(out, reference, 64).toFixed(0)} dB`);
    }
  });

  test('upsampling round-trips back to the original', () => {
    const source = sine(4800, 500, RATE);
    const up = resampleChannel(source, RATE, 96000);
    const back = resampleChannel(up, 96000, RATE);
    assert.ok(snr(back, source, 64) > 60);
  });

  test('preserves level rather than drifting in gain', () => {
    const source = sine(RATE, 440, RATE, 0.7);
    for (const rate of [8000, 16000, 22050, 44100, 96000]) {
      const out = resampleChannel(source, RATE, rate);
      let peak = 0;
      for (let i = 100; i < out.length - 100; i++) peak = Math.max(peak, Math.abs(out[i]!));
      assert.ok(Math.abs(peak - 0.7) < 0.02, `${rate} Hz peak drifted to ${peak.toFixed(4)}`);
    }
  });

  test('is a no-op at the same rate, and handles empty input', () => {
    const source = sine(100, 440);
    assert.deepEqual(resampleChannel(source, RATE, RATE), source);
    assert.equal(resampleChannel(new Float32Array(0), RATE, 16000).length, 0);
  });
});

describe('Audio', () => {
  const audio = new Audio([sine(RATE * 2, 440), sine(RATE * 2, 880)], RATE);

  test('reports its shape', () => {
    assert.equal(audio.channels, 2);
    assert.equal(audio.frames, RATE * 2);
    assert.equal(audio.duration, 2);
    assert.equal(audio.durationFormatted, '0:02.000');
    assert.equal(String(audio), 'Audio(0:02.000, 48000 Hz, 2ch)');
  });

  test('is immutable — transforms never touch the original', () => {
    const before = audio.channelData(0).slice();
    const quiet = audio.gainDb(-20);
    assert.deepEqual(Array.from(audio.channelData(0)), Array.from(before));
    assert.notEqual(quiet.channelData(0)[100], audio.channelData(0)[100]);
    assert.ok(Object.isFrozen(audio));
  });

  test('cut extracts an exact sample range', () => {
    const clip = audio.cut({ from: 0.5, to: 1.5 });
    assert.equal(clip.frames, RATE);
    assert.equal(clip.duration, 1);
    // The first sample of the clip must be the source sample at 0.5 s exactly.
    assert.equal(clip.channelData(0)[0], audio.channelData(0)[RATE / 2]);
  });

  test('cut accepts timestamps and negative offsets', () => {
    assert.equal(audio.cut({ from: '0:01' }).frames, RATE);
    assert.equal(audio.cut({ from: -0.5 }).frames, RATE / 2);
    assert.equal(audio.cut({ to: { sample: 480 } }).frames, 480);
  });

  test('cut rejects a reversed range instead of silently returning nothing', () => {
    assert.throws(() => audio.cut({ from: 1.5, to: 0.5 }), /is before/);
  });

  test('remove closes the gap', () => {
    const edited = audio.remove({ from: 0.5, to: 1.5 });
    assert.equal(edited.frames, RATE);
  });

  test('concat joins and rejects mismatched rates', () => {
    const joined = audio.cut({ to: 0.5 }).concat(audio.cut({ to: 0.5 }));
    assert.equal(joined.frames, RATE);
    assert.throws(() => audio.concat(audio.resample(16000)), /Call \.resample\(48000\)/);
  });

  test('pad, reverse and mix behave', () => {
    assert.equal(audio.pad({ start: 1, end: 1 }).duration, 4);

    const reversed = audio.reverse();
    assert.equal(reversed.channelData(0)[0], audio.channelData(0)[audio.frames - 1]);

    const mixed = audio.mix(audio);
    assert.ok(Math.abs(mixed.channelData(0)[100]! - audio.channelData(0)[100]! * 2) < 1e-6);
  });

  test('toMono averages instead of summing, so it cannot clip', () => {
    const hot = new Audio([new Float32Array(10).fill(0.9), new Float32Array(10).fill(0.9)], RATE);
    assert.ok(hot.toMono().peak() <= 1);
    assert.ok(Math.abs(hot.toMono().channelData(0)[0]! - 0.9) < 1e-6);
  });

  test('channel conversions', () => {
    assert.equal(audio.toMono().channels, 1);
    assert.equal(audio.toMono().toStereo().channels, 2);
    assert.equal(audio.toChannels(6).channels, 6);
    assert.equal(audio.split().length, 2);
    assert.equal(Audio.merge(...audio.split()).channels, 2);

    // mapChannels swaps a stereo pair.
    const swapped = audio.mapChannels([1, 0]);
    assert.deepEqual(Array.from(swapped.channelData(0)), Array.from(audio.channelData(1)));
  });

  test('normalize hits a peak target precisely', () => {
    const quiet = audio.gainDb(-30);
    const normalized = quiet.normalize({ to: -1, unit: 'peak' });
    assert.ok(Math.abs(normalized.peakDb() - -1) < 0.01, `got ${normalized.peakDb()}`);
  });

  test('normalize hits a LUFS target and reports peak limiting', () => {
    const { audio: loud, report } = audio
      .gainDb(-30)
      .normalizeWithReport({ to: -14, unit: 'LUFS', truePeakCeiling: null });
    assert.ok(Math.abs(loud.loudness().integrated - -14) < 0.5, `got ${loud.loudness().integrated}`);
    assert.equal(report.limitedByPeak, false);

    // With a ceiling in force, a already-hot signal must be held back and say so.
    const { report: limited } = audio.normalizeWithReport({ to: 0, unit: 'LUFS', truePeakCeiling: -3 });
    assert.equal(limited.limitedByPeak, true);
  });

  test('normalize leaves digital silence alone', () => {
    const silent = Audio.silence(1, RATE, 1);
    assert.equal(silent.normalize({ to: -1 }).peak(), 0);
    assert.equal(silent.normalize({ to: -14, unit: 'LUFS' }).peak(), 0);
  });

  test('fade reaches zero at the outer edge and full level in the middle', () => {
    const faded = audio.fade({ in: 0.5, out: 0.5 });
    assert.equal(faded.channelData(0)[0], 0);
    assert.ok(Math.abs(faded.channelData(0)[RATE]! - audio.channelData(0)[RATE]!) < 1e-6);
    assert.ok(Math.abs(faded.channelData(0)[faded.frames - 1]!) < 0.01);
  });

  test('trimSilence removes leading and trailing quiet', () => {
    const padded = Audio.silence(1, RATE, 1)
      .concat(new Audio([sine(RATE, 440)], RATE))
      .concat(Audio.silence(1, RATE, 1));
    assert.equal(padded.duration, 3);

    const trimmed = padded.trimSilence();
    assert.ok(Math.abs(trimmed.duration - 1) < 0.05, `got ${trimmed.duration}`);
  });

  test('detectSilence finds the quiet spans', () => {
    const withGap = new Audio([sine(RATE, 440)], RATE)
      .concat(Audio.silence(1, RATE, 1))
      .concat(new Audio([sine(RATE, 440)], RATE));
    const ranges = withGap.detectSilence();
    assert.equal(ranges.length, 1);
    assert.ok(Math.abs(ranges[0]!.start - RATE) < RATE * 0.05);
  });

  test('removeDcOffset centres the waveform', () => {
    const offset = new Audio([new Float32Array(1000).fill(0.25)], RATE);
    const fixed = offset.removeDcOffset();
    let sum = 0;
    for (const v of fixed.channelData(0)) sum += v;
    assert.ok(Math.abs(sum / 1000) < 1e-6);
  });

  test('filters attenuate the correct side of the corner frequency', () => {
    const low = new Audio([sine(RATE, 100)], RATE);
    const high = new Audio([sine(RATE, 10000)], RATE);

    const lp = { type: 'lowpass' as const, frequency: 1000 };
    assert.ok(low.filter(lp).peak() > 0.4, 'lowpass must pass 100 Hz');
    assert.ok(high.filter(lp).peak() < 0.05, 'lowpass must stop 10 kHz');

    const hp = { type: 'highpass' as const, frequency: 1000 };
    assert.ok(high.filter(hp).peak() > 0.4, 'highpass must pass 10 kHz');
    assert.ok(low.filter(hp).peak() < 0.05, 'highpass must stop 100 Hz');
  });

  test('limiter guarantees its ceiling, including on the very first transient', () => {
    const hot = new Audio([sine(RATE, 440, RATE, 1.0)], RATE);
    const limited = hot.limit({ threshold: -6 });
    // A hard ceiling, not a target. A feedback limiter without lookahead lets
    // the opening transient through at full level — that is the bug this guards.
    assert.ok(limited.peakDb() <= -6 + 0.01, `peak was ${limited.peakDb().toFixed(2)} dBFS`);

    // A signal already under the ceiling must pass through untouched.
    const quiet = new Audio([sine(RATE, 440, RATE, 0.1)], RATE);
    assert.ok(Math.abs(quiet.limit({ threshold: -6 }).peakDb() - quiet.peakDb()) < 1e-6);
  });

  test('limiter catches a transient that starts at full scale on sample 0', () => {
    const click = new Float32Array(1000);
    click[0] = 1.0; // worst case: no lead-in at all
    const limited = new Audio([click], RATE).limit({ threshold: -3 });
    assert.ok(limited.peakDb() <= -3 + 0.01, `peak was ${limited.peakDb().toFixed(2)} dBFS`);
  });

  test('speed changes duration and pitch together', () => {
    const fast = audio.speed(2);
    assert.ok(Math.abs(fast.duration - 1) < 0.01);
  });

  test('tempo changes duration while holding pitch', () => {
    const source = new Audio([sine(RATE * 2, 440)], RATE);
    const faster = source.tempo(2);
    assert.ok(Math.abs(faster.duration - 1) < 0.05, `duration ${faster.duration}`);

    // Pitch check: the dominant frequency must still be near 440 Hz. Count zero
    // crossings, which is enough to tell 440 from 880.
    let crossings = 0;
    const data = faster.channelData(0);
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1]! < 0 && data[i]! >= 0) crossings++;
    }
    const hz = crossings / faster.duration;
    assert.ok(Math.abs(hz - 440) < 60, `pitch drifted to about ${hz.toFixed(0)} Hz`);
  });

  test('pitch shift preserves duration exactly', () => {
    const source = new Audio([sine(RATE, 440)], RATE);
    assert.equal(source.pitch(12).frames, source.frames);
    assert.equal(source.pitch(-5).frames, source.frames);
  });

  test('waveform returns per-bucket extremes', () => {
    const peaks = audio.waveform(100);
    assert.equal(peaks.min.length, 100);
    assert.equal(peaks.max.length, 100);
    for (let i = 0; i < 100; i++) {
      assert.ok(peaks.min[i]! <= 0 && peaks.max[i]! >= 0);
      assert.ok(peaks.max[i]! <= 1 && peaks.min[i]! >= -1);
    }
    assert.throws(() => audio.waveform(0), InvalidArgumentError);
  });

  test('interleaving round-trips', () => {
    const interleaved = audio.toInterleaved();
    assert.equal(interleaved.length, audio.frames * 2);
    const rebuilt = Audio.fromInterleaved(interleaved, 2, RATE);
    assert.deepEqual(Array.from(rebuilt.channelData(1)), Array.from(audio.channelData(1)));
  });

  test('rejects malformed construction', () => {
    assert.throws(() => new Audio([], RATE), /at least one channel/);
    assert.throws(() => new Audio([new Float32Array(10), new Float32Array(9)], RATE), /frames/);
    assert.throws(() => new Audio([new Float32Array(10)], 0), /Sample rate/);
    assert.throws(() => audio.channelData(5), /does not exist/);
  });
});

describe('measurement', () => {
  test('peak and true peak agree on a slow sine, and true peak is never lower', () => {
    const audio = new Audio([sine(RATE, 100, RATE, 0.5)], RATE);
    assert.ok(Math.abs(toDb(measurePeak(audio.allChannels)) - toDb(0.5)) < 0.01);
    assert.ok(measureTruePeak(audio.allChannels) >= measurePeak(audio.allChannels));
  });

  test('a -23 dBFS 1 kHz tone measures -23 LUFS (EBU Tech 3341 case 1)', () => {
    const amplitude = Math.pow(10, -23 / 20);
    const stereo = new Audio([sine(RATE * 5, 1000, RATE, amplitude), sine(RATE * 5, 1000, RATE, amplitude)], RATE);
    const { integrated } = measureLoudness(stereo.allChannels, RATE);
    assert.ok(Math.abs(integrated - -23) < 0.1, `measured ${integrated.toFixed(2)} LUFS`);
  });

  test('gating: a long silent tail must not drag the measurement down', () => {
    const tone = new Audio([sine(RATE * 3, 1000, RATE, 0.5), sine(RATE * 3, 1000, RATE, 0.5)], RATE);
    const withSilence = tone.concat(Audio.silence(10, RATE, 2));
    assert.ok(
      Math.abs(tone.loudness().integrated - withSilence.loudness().integrated) < 0.5,
      'the relative gate should discard the silence',
    );
  });

  test('digital silence reports -Infinity rather than a misleading number', () => {
    assert.equal(Audio.silence(1, RATE, 2).loudness().integrated, -Infinity);
  });
});
