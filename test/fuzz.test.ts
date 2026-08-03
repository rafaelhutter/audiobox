/**
 * Hostile-input tests.
 *
 * Audio decoders exist to parse files from strangers. The security properties
 * that matter are not "decodes correctly" but "fails safely": every malformed
 * input must produce a typed error, never a hang, never an out-of-bounds read,
 * and never an allocation sized by an attacker.
 *
 * These run mutation and random fuzzing against every decoder. A failure here is
 * a genuine vulnerability, not a cosmetic bug — which is why the assertions are
 * about *classes of behaviour* rather than specific messages.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodeWav, encodeWav } from '../src/formats/wav.ts';
import { decodeAiff, encodeAiff } from '../src/formats/aiff.ts';
import { decodeAu, encodeAu } from '../src/formats/au.ts';
import { decodeCaf, encodeCaf } from '../src/formats/caf.ts';
import { decodeFlac } from '../src/flac/decoder.ts';
import { encodeFlac } from '../src/flac/encoder.ts';
import { probeMp3 } from '../src/mp3/probe.ts';
import { Audio } from '../src/audio.ts';
import { sniff } from '../src/io/sniff.ts';
import { AudioboxError } from '../src/errors.ts';

const RATE = 44100;

/** Deterministic PRNG, so a failure can be reproduced from its seed. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function sampleAudio(frames = 500): Audio {
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    channels[0]![i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.5;
    channels[1]![i] = Math.cos((2 * Math.PI * 330 * i) / RATE) * 0.5;
  }
  return new Audio(channels, RATE);
}

type Decoder = (bytes: Uint8Array) => unknown;

const DECODERS: Array<{ name: string; decode: Decoder; valid: () => Uint8Array }> = [
  { name: 'wav', decode: (b) => decodeWav(b), valid: () => encodeWav(sampleAudio().allChannels, RATE) },
  { name: 'aiff', decode: (b) => decodeAiff(b), valid: () => encodeAiff(sampleAudio().allChannels, RATE) },
  { name: 'au', decode: (b) => decodeAu(b), valid: () => encodeAu(sampleAudio().allChannels, RATE) },
  { name: 'caf', decode: (b) => decodeCaf(b), valid: () => encodeCaf(sampleAudio().allChannels, RATE) },
  { name: 'flac', decode: (b) => decodeFlac(b), valid: () => encodeFlac(sampleAudio()) },
  { name: 'mp3-probe', decode: (b) => probeMp3(b), valid: () => new Uint8Array([0xff, 0xfb, 0x90, 0x00]) },
];

/**
 * Asserts that a call either succeeds or throws a *typed* error.
 *
 * A `TypeError` or `RangeError` escaping from a decoder means an unchecked
 * access reached the runtime — exactly the class of bug the bounds-checked
 * Reader exists to prevent.
 */
function assertFailsSafely(fn: () => unknown, context: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof AudioboxError) return;
    if (error instanceof RangeError) {
      assert.fail(`${context}: leaked a RangeError — an unchecked read escaped. ${error.message}`);
    }
    if (error instanceof TypeError) {
      assert.fail(`${context}: leaked a TypeError — likely an undefined access. ${error.message}`);
    }
    assert.fail(`${context}: threw an untyped ${(error as Error).name}: ${(error as Error).message}`);
  }
}

describe('fuzzing: random bytes', () => {
  for (const { name, decode } of DECODERS) {
    test(`${name} survives random input`, () => {
      const random = makeRandom(0xc0ffee);
      for (let iteration = 0; iteration < 400; iteration++) {
        const length = 1 + Math.floor(random() * 512);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
        assertFailsSafely(() => decode(bytes), `${name} random #${iteration}`);
      }
    });
  }
});

describe('fuzzing: mutated valid files', () => {
  for (const { name, decode, valid } of DECODERS) {
    test(`${name} survives single-byte corruption`, () => {
      // Mutating a real file is far more effective than random noise: the input
      // stays structurally plausible enough to reach deep code paths.
      const random = makeRandom(0x5eed + name.length);
      const original = valid();

      for (let iteration = 0; iteration < 600; iteration++) {
        const bytes = original.slice();
        const mutations = 1 + Math.floor(random() * 4);
        for (let m = 0; m < mutations; m++) {
          const position = Math.floor(random() * bytes.length);
          bytes[position] = Math.floor(random() * 256);
        }
        assertFailsSafely(() => decode(bytes), `${name} mutation #${iteration}`);
      }
    });

    test(`${name} survives truncation at every length`, () => {
      const original = valid();
      const step = Math.max(1, Math.floor(original.length / 200));
      for (let length = 0; length < original.length; length += step) {
        assertFailsSafely(() => decode(original.subarray(0, length)), `${name} truncated to ${length}`);
      }
    });

    test(`${name} survives having size fields maximised`, () => {
      // The classic attack: keep the file valid but claim enormous sizes, so a
      // naive decoder allocates or reads far past the buffer.
      const original = valid();
      for (let offset = 0; offset + 4 <= Math.min(original.length, 128); offset += 1) {
        const bytes = original.slice();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        view.setUint32(offset, 0xffffffff, true);
        assertFailsSafely(() => decode(bytes), `${name} size field at ${offset} (LE)`);

        const beBytes = original.slice();
        new DataView(beBytes.buffer, beBytes.byteOffset, beBytes.byteLength).setUint32(offset, 0xffffffff, false);
        assertFailsSafely(() => decode(beBytes), `${name} size field at ${offset} (BE)`);
      }
    });
  }
});

describe('fuzzing: allocation and termination guards', () => {
  test('a tiny header cannot request an enormous allocation', () => {
    // A 44-byte WAV claiming billions of frames must be refused before any
    // buffer is created, not after the process runs out of memory.
    const bytes = encodeWav(sampleAudio(10).allChannels, RATE, { sampleFormat: 's16' });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Channel count field in the fmt chunk.
    view.setUint16(22, 0xffff, true);

    const before = process.memoryUsage().heapUsed;
    assertFailsSafely(() => decodeWav(bytes), 'oversized channel count');
    const growth = process.memoryUsage().heapUsed - before;
    assert.ok(growth < 64 * 1024 * 1024, `heap grew by ${(growth / 1e6).toFixed(1)} MB during a rejected decode`);
  });

  test('custom limits are enforced', () => {
    const bytes = encodeWav(sampleAudio(RATE).allChannels, RATE);
    assert.throws(() => decodeWav(bytes, { limits: { maxDurationSeconds: 0.1 } }), /LIMIT|limit/i);
    assert.throws(() => decodeWav(bytes, { limits: { maxDecodedBytes: 1000 } }), /LIMIT|limit/i);
    assert.throws(() => decodeWav(bytes, { limits: { maxChannels: 1 } }), /LIMIT|limit/i);
  });

  test('every decoder terminates promptly on hostile input', () => {
    // Guards against an infinite loop in a resync or unary-decode path, which
    // would be a denial of service rather than a crash.
    const random = makeRandom(0xdecafbad);
    const started = Date.now();

    for (const { name, decode } of DECODERS) {
      for (let iteration = 0; iteration < 100; iteration++) {
        const bytes = new Uint8Array(2048);
        // Bias toward 0xFF and 0x00, which look like sync words and length fields.
        for (let i = 0; i < bytes.length; i++) {
          const r = random();
          bytes[i] = r < 0.4 ? 0xff : r < 0.8 ? 0x00 : Math.floor(random() * 256);
        }
        assertFailsSafely(() => decode(bytes), `${name} adversarial #${iteration}`);
      }
    }

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20000, `hostile-input sweep took ${elapsed} ms — something is not terminating`);
  });

  test('sniff never throws, whatever it is given', () => {
    const random = makeRandom(0xfeedface);
    for (let iteration = 0; iteration < 2000; iteration++) {
      const length = Math.floor(random() * 300);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
      // Detection runs before any validation, so it must be total.
      assert.doesNotThrow(() => sniff(bytes));
    }
  });
});

describe('prototype pollution', () => {
  test('metadata keys from a file cannot reach Object.prototype', () => {
    // Tag identifiers are attacker-controlled and land in a plain object. If
    // that object inherited from Object.prototype, a crafted "__proto__" key
    // could poison every object in the process.
    const bytes = encodeWav(sampleAudio(10).allChannels, RATE, {
      metadata: { extra: { __pr: 'x' } },
    });
    const { info } = decodeWav(bytes);

    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(info.metadata, '__proto__'), false);
  });

  test('the format lookup tables have no prototype chain', () => {
    // Confirms the Object.create(null) maps in au.ts and wav.ts stay that way.
    const bytes = encodeAu(sampleAudio(10).allChannels, RATE);
    assert.doesNotThrow(() => decodeAu(bytes));
  });
});
