import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Reader } from '../src/io/reader.ts';
import { Writer } from '../src/io/writer.ts';
import { BitReader, BitWriter } from '../src/io/bits.ts';
import { sniff } from '../src/io/sniff.ts';
import { DecodeError } from '../src/errors.ts';

describe('Reader', () => {
  test('reads integers in both byte orders', () => {
    const r = new Reader(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    assert.equal(r.u16(true), 0x0201);
    assert.equal(r.u16(false), 0x0304);
  });

  test('reads 24-bit values, signed and unsigned', () => {
    assert.equal(new Reader(new Uint8Array([0x00, 0x00, 0x80])).u24(true), 0x800000);
    assert.equal(new Reader(new Uint8Array([0x00, 0x00, 0x80])).i24(true), -8388608);
    assert.equal(new Reader(new Uint8Array([0xff, 0xff, 0x7f])).i24(true), 8388607);
    assert.equal(new Reader(new Uint8Array([0x80, 0x00, 0x00])).i24(false), -8388608);
  });

  test('throws DecodeError with an offset instead of overrunning', () => {
    const r = new Reader(new Uint8Array([1, 2]));
    r.u8();
    assert.throws(
      () => r.u32(true),
      (err: unknown) => {
        assert.ok(err instanceof DecodeError);
        assert.equal(err.code, 'DECODE_ERROR');
        assert.equal(err.offset, 1);
        return true;
      },
    );
  });

  test('rejects a seek outside the buffer', () => {
    const r = new Reader(new Uint8Array(4));
    assert.throws(() => r.seek(5), DecodeError);
    assert.throws(() => r.seek(-1), DecodeError);
    r.seek(4); // landing exactly at the end is legal
    assert.equal(r.remaining, 0);
  });

  test('rejects 64-bit sizes above the safe integer range', () => {
    // A hostile RF64 size field: truncating this silently would defeat every
    // downstream bounds check that trusts it.
    const bytes = new Uint8Array(8).fill(0xff);
    assert.throws(() => new Reader(bytes).u64(true), DecodeError);
  });

  test('round-trips an 80-bit float at the sample rates AIFF actually uses', () => {
    for (const rate of [8000, 11025, 22050, 44100, 48000, 96000, 192000]) {
      const w = new Writer();
      w.f80(rate);
      assert.equal(new Reader(w.finish()).f80(), rate, `rate ${rate}`);
    }
  });

  test('subReader is scoped to its slice', () => {
    const r = new Reader(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const sub = r.subReader(2);
    assert.equal(sub.length, 2);
    assert.throws(() => sub.u32(true), DecodeError);
    assert.equal(r.offset, 2);
  });
});

describe('Writer', () => {
  test('grows past its initial capacity without corrupting data', () => {
    const w = new Writer(16);
    for (let i = 0; i < 1000; i++) w.u32(i, true);
    const r = new Reader(w.finish());
    for (let i = 0; i < 1000; i++) assert.equal(r.u32(true), i);
  });

  test('patches a reserved slot after the fact', () => {
    const w = new Writer();
    w.ascii('RIFF');
    const sizeAt = w.reserve(4);
    w.ascii('WAVE');
    w.patchU32(sizeAt, 4, true);

    const r = new Reader(w.finish());
    assert.equal(r.fourCC(), 'RIFF');
    assert.equal(r.u32(true), 4);
    assert.equal(r.fourCC(), 'WAVE');
  });

  test('align2 pads only odd lengths', () => {
    const odd = new Writer();
    odd.ascii('abc');
    odd.align2();
    assert.equal(odd.length, 4);

    const even = new Writer();
    even.ascii('abcd');
    even.align2();
    assert.equal(even.length, 4);
  });
});

describe('BitReader / BitWriter', () => {
  test('round-trips fields of every width from 1 to 32 bits', () => {
    const widths = Array.from({ length: 32 }, (_, i) => i + 1);
    const values = widths.map((n) => (n >= 32 ? 0xdeadbeef : (0xdeadbeef >>> 0) % 2 ** n));

    const w = new BitWriter();
    widths.forEach((n, i) => w.bits(values[i]!, n));
    const r = new BitReader(w.finish());
    widths.forEach((n, i) => assert.equal(r.bits(n), values[i]!, `${n}-bit field`));
  });

  test('handles widths above 25 without sign-flipping', () => {
    // A single 32-bit shift chain would wrap into negative territory here.
    const w = new BitWriter();
    w.bits(0xffffffff, 32);
    assert.equal(new BitReader(w.finish()).bits(32), 0xffffffff);
  });

  test('reads past the end as zeros and reports the overrun', () => {
    // MP3's bit reservoir legitimately reads slightly past a frame boundary, so
    // this must not throw — but the caller has to be able to tell it happened.
    const r = new BitReader(new Uint8Array([0xff]));
    assert.equal(r.bits(8), 0xff);
    assert.equal(r.overran, false);
    assert.equal(r.bits(8), 0);
    assert.equal(r.overran, true);
  });

  test('decodes unary codes and gives up on a runaway stream', () => {
    const w = new BitWriter();
    w.bits(0, 5);
    w.bit(1); // five zeros then a terminator => 5
    assert.equal(new BitReader(w.finish()).unary(), 5);

    // All-zero input must terminate rather than scan forever.
    assert.equal(new BitReader(new Uint8Array(4)).unary(), -1);
  });

  test('signedBits sign-extends', () => {
    const w = new BitWriter();
    w.bits(0b1101, 4); // -3 in 4-bit two's complement
    assert.equal(new BitReader(w.finish()).signedBits(4), -3);
  });

  test('peek does not consume', () => {
    const r = new BitReader(new Uint8Array([0b10110000]));
    assert.equal(r.peek(3), 0b101);
    assert.equal(r.peek(3), 0b101);
    assert.equal(r.bits(3), 0b101);
  });
});

describe('sniff', () => {
  const wav = (): Uint8Array => {
    const w = new Writer();
    w.ascii('RIFF');
    w.u32(36, true);
    w.ascii('WAVE');
    return w.finish();
  };

  test('identifies supported containers by magic bytes', () => {
    assert.deepEqual(sniff(wav()), { kind: 'supported', format: 'wav' });

    const aiff = new Writer();
    aiff.ascii('FORM');
    aiff.u32(0, false);
    aiff.ascii('AIFF');
    assert.deepEqual(sniff(aiff.finish()), { kind: 'supported', format: 'aiff' });

    assert.deepEqual(sniff(new TextEncoder().encode('fLaC____')), {
      kind: 'supported',
      format: 'flac',
    });
    assert.deepEqual(sniff(new TextEncoder().encode('caff____')), {
      kind: 'supported',
      format: 'caf',
    });
  });

  test('names formats it recognises but cannot decode', () => {
    const ogg = sniff(new TextEncoder().encode('OggS____'));
    assert.equal(ogg.kind, 'unsupported');
    assert.equal(ogg.kind === 'unsupported' && ogg.format, 'ogg');

    const mp4 = new Uint8Array(12);
    mp4.set(new TextEncoder().encode('ftyp'), 4);
    assert.equal(sniff(mp4).kind, 'unsupported');
  });

  test('detects MP3 by ID3 tag and by a validated frame sync', () => {
    const id3 = new Uint8Array(16);
    id3.set(new TextEncoder().encode('ID3'), 0);
    assert.deepEqual(sniff(id3), { kind: 'supported', format: 'mp3' });

    // 0xFF 0xFB: MPEG-1 Layer III, 128 kbps, 44.1 kHz.
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
    assert.deepEqual(sniff(frame), { kind: 'supported', format: 'mp3' });
  });

  test('rejects a frame sync whose header fields are invalid', () => {
    // Sync bits present, but bitrate index 0x0F and a reserved sample rate.
    const bogus = new Uint8Array([0xff, 0xfb, 0xfc, 0x00, 0, 0, 0, 0]);
    assert.equal(sniff(bogus).kind, 'unknown');
  });

  test('returns unknown for short or unrecognised input', () => {
    assert.deepEqual(sniff(new Uint8Array([1, 2])), { kind: 'unknown' });
    assert.deepEqual(sniff(new Uint8Array(64)), { kind: 'unknown' });
  });
});
