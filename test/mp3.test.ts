/**
 * MP3 tests.
 *
 * Decoding is still under construction, so these cover what is implemented:
 * frame headers, tags, probing, and — the part most likely to hide a subtle bug
 * — side-information parsing and the bit reservoir.
 *
 * The reservoir check is the valuable one. If `main_data_begin` handling or the
 * MPEG-1/2 field widths are wrong, granules will claim more bits than the
 * assembled buffer holds, which shows up here rather than as noise in the audio
 * much later.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BitReader } from '../src/io/bits.ts';
import { parseFrameHeader, findFrame, id3v2Size } from '../src/mp3/frame.ts';
import { parseSideInfo, BitReservoir } from '../src/mp3/sideinfo.ts';
import {
  createScalefactors,
  decodeScalefactorsMpeg1,
  decodeScalefactorsMpeg2,
  decodeHuffman,
} from '../src/mp3/huffman.ts';
import {
  HUFFMAN_TABS,
  HUFFMAN_TABLE_INDEX,
  COUNT1_TABLE_A,
  COUNT1_TABLE_B,
} from '../src/mp3/huffman-tables.ts';
import { probeMp3 } from '../src/mp3/probe.ts';
import { decodeMp3 } from '../src/mp3/decoder.ts';
import { decode, encode } from '../src/codec.ts';
import {
  SFB_LONG,
  SFB_SHORT,
  POW43,
  IMDCT_WINDOWS,
  SYNTH_WINDOW,
  ALIAS_CS,
  ALIAS_CA,
  HUFFMAN_LINBITS,
} from '../src/mp3/tables.ts';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();

describe('MP3 tables', () => {
  test('every sample rate has consistent scalefactor bands', () => {
    for (const rate of [44100, 48000, 32000, 22050, 24000, 16000, 11025, 12000, 8000]) {
      const long = SFB_LONG[rate]!;
      const short = SFB_SHORT[rate]!;

      assert.equal(long.length, 23, `${rate} long band count`);
      assert.equal(short.length, 14, `${rate} short band count`);
      assert.equal(long[0], 0, `${rate} long starts at 0`);
      assert.equal(long[22], 576, `${rate} long covers all 576 lines`);
      assert.equal(short[0], 0, `${rate} short starts at 0`);
      assert.equal(short[13], 192, `${rate} short covers 192 lines per window`);

      // Boundaries must be non-decreasing, or band widths go negative.
      for (let i = 1; i < long.length; i++) {
        assert.ok(long[i]! >= long[i - 1]!, `${rate} long band ${i} decreases`);
      }
      for (let i = 1; i < short.length; i++) {
        assert.ok(short[i]! >= short[i - 1]!, `${rate} short band ${i} decreases`);
      }
    }
  });

  test('computed tables have the right shape and values', () => {
    assert.equal(POW43[0], 0);
    assert.equal(POW43[1], 1);
    assert.ok(Math.abs(POW43[8]! - Math.pow(8, 4 / 3)) < 1e-4);

    assert.equal(SYNTH_WINDOW.length, 512);
    assert.equal(IMDCT_WINDOWS.length, 4);
    for (const window of IMDCT_WINDOWS) assert.equal(window.length, 36);

    // The long window is a half-sine: zero-ish at both ends, peak in the middle.
    assert.ok(IMDCT_WINDOWS[0]![17]! > 0.99);
    assert.ok(IMDCT_WINDOWS[0]![0]! < 0.05);
  });

  test('alias-reduction coefficients satisfy cs^2 + ca^2 = 1', () => {
    // They are built from a normalised butterfly, so this identity must hold
    // exactly; a typo in the c[] constants shows up here.
    for (let i = 0; i < 8; i++) {
      const sum = ALIAS_CS[i]! ** 2 + ALIAS_CA[i]! ** 2;
      assert.ok(Math.abs(sum - 1) < 1e-6, `band ${i}: cs²+ca² = ${sum}`);
    }
  });

  test('linbits table matches the specification', () => {
    assert.equal(HUFFMAN_LINBITS.length, 32);
    // Tables 0-15 never use escape bits.
    for (let i = 0; i < 16; i++) assert.equal(HUFFMAN_LINBITS[i], 0, `table ${i}`);
    assert.equal(HUFFMAN_LINBITS[16], 1);
    assert.equal(HUFFMAN_LINBITS[23], 13);
    assert.equal(HUFFMAN_LINBITS[24], 4);
    assert.equal(HUFFMAN_LINBITS[31], 13);
  });
});

describe('MP3 frame headers', () => {
  test('parses a known MPEG-1 Layer III header', () => {
    // FF FB 90 00 = MPEG-1, Layer III, no CRC, 128 kbps, 44.1 kHz, stereo.
    const header = parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0);
    assert.ok(header);
    assert.equal(header.version, 1);
    assert.equal(header.layer, 3);
    assert.equal(header.bitrate, 128000);
    assert.equal(header.sampleRate, 44100);
    assert.equal(header.channels, 2);
    assert.equal(header.samplesPerFrame, 1152);
    assert.equal(header.sideInfoSize, 32);
    assert.equal(header.frameLength, 417);
  });

  test('parses an MPEG-2 header with its halved geometry', () => {
    // FF F3 = MPEG-2, Layer III. 0x50 => 64 kbps at 22.05 kHz.
    const header = parseFrameHeader(new Uint8Array([0xff, 0xf3, 0x50, 0xc0]), 0);
    assert.ok(header);
    assert.equal(header.version, 2);
    assert.equal(header.samplesPerFrame, 576, 'MPEG-2 Layer III halves the granule count');
    assert.equal(header.channels, 1);
    assert.equal(header.sideInfoSize, 9, 'mono MPEG-2 side info is 9 bytes');
  });

  test('rejects reserved and invalid field combinations', () => {
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xeb, 0x90, 0x00]), 0), null, 'reserved version');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xf9, 0x90, 0x00]), 0), null, 'reserved layer');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x00, 0x00]), 0), null, 'free-form bitrate');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0), null, 'invalid bitrate index');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]), 0), null, 'reserved sample rate');
    assert.equal(parseFrameHeader(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 0), null, 'no sync');
  });

  test('sizes an ID3v2 tag using syncsafe integers', () => {
    const tag = new Uint8Array(30);
    tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0); // "ID3", v2.4
    tag[6] = 0x00;
    tag[7] = 0x00;
    tag[8] = 0x01;
    tag[9] = 0x0a; // syncsafe 0x8A = 138
    assert.equal(id3v2Size(tag, 0), 10 + 138);
    assert.equal(id3v2Size(new Uint8Array(30), 0), 0, 'absent tag reports zero');
  });
});

describe('MP3 side information and bit reservoir', () => {
  test('the reservoir returns null until it has enough history', () => {
    const reservoir = new BitReservoir();
    // A frame that references 100 bytes of history it cannot have yet.
    assert.equal(reservoir.read(100, new Uint8Array(50)), null);

    // A self-contained frame always resolves.
    const selfContained = new Uint8Array([1, 2, 3]);
    assert.deepEqual(reservoir.read(0, selfContained), selfContained);
  });

  test('the reservoir concatenates history ahead of the current frame', () => {
    const reservoir = new BitReservoir();
    reservoir.read(0, new Uint8Array([1, 2, 3, 4]));

    const current = new Uint8Array([9, 9]);
    const assembled = reservoir.read(2, current);
    assert.ok(assembled);
    // Two bytes of history (3, 4) then the current payload.
    assert.deepEqual(Array.from(assembled), [3, 4, 9, 9]);
  });

  test('the reservoir stays bounded no matter how much is pushed', () => {
    const reservoir = new BitReservoir(1024);
    for (let i = 0; i < 500; i++) reservoir.read(0, new Uint8Array(400));
    assert.ok(reservoir.length <= 1024, `grew to ${reservoir.length}`);
  });

  test('an oversized payload keeps only the referenceable tail', () => {
    const reservoir = new BitReservoir(64);
    reservoir.read(0, new Uint8Array(200).fill(7));
    assert.equal(reservoir.length, 64);
  });
});

describe('MP3 against real files', { skip: FFMPEG ? false : 'ffmpeg not installed' }, () => {
  let dir: string;

  test('setup', () => {
    dir = mkdtempSync(join(tmpdir(), 'audiobox-mp3-'));
  });

  test.after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function render(name: string, args: string[]): Uint8Array {
    const path = join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', ...args, path, '-y']);
    return new Uint8Array(readFileSync(path));
  }

  /** Walks every frame, parsing side info and resolving the reservoir. */
  function walk(data: Uint8Array) {
    let offset = id3v2Size(data, 0);
    const reservoir = new BitReservoir();
    let frames = 0;
    let resolved = 0;
    let overBudget = 0;
    let maxMainDataBegin = 0;

    for (;;) {
      const found = findFrame(data, offset);
      if (!found) break;
      const header = found.header;

      const sideInfo = parseSideInfo(data, found.offset + 4 + (header.hasCrc ? 2 : 0), header);
      frames++;
      maxMainDataBegin = Math.max(maxMainDataBegin, sideInfo.mainDataBegin);

      const start = found.offset + 4 + (header.hasCrc ? 2 : 0) + header.sideInfoSize;
      const end = Math.min(found.offset + header.frameLength, data.byteLength);
      const assembled = reservoir.read(sideInfo.mainDataBegin, data.subarray(start, end));

      if (assembled) {
        resolved++;
        let bits = 0;
        for (const granule of sideInfo.granules) {
          for (const channel of granule) bits += channel.part2_3_length;
        }
        if (bits > assembled.byteLength * 8) overBudget++;
      }

      offset = found.offset + header.frameLength;
    }

    return { frames, resolved, overBudget, maxMainDataBegin };
  }

  test('CBR stereo: every granule fits inside the data the reservoir assembled', () => {
    const data = render('cbr.mp3', [
      '-i', 'sine=f=440:d=3:r=44100', '-ac', '2', '-b:a', '128k',
    ]);
    const result = walk(data);

    assert.ok(result.frames > 100, `only found ${result.frames} frames`);
    assert.equal(result.resolved, result.frames, 'every frame should resolve');
    // This is the assertion that actually proves the parsing is right: if any
    // field width or the reservoir arithmetic were wrong, granules would claim
    // more bits than exist.
    assert.equal(result.overBudget, 0, 'no granule may exceed its available bits');
    assert.ok(result.maxMainDataBegin <= 511, 'MPEG-1 main_data_begin is 9 bits');
  });

  test('VBR stereo', () => {
    const result = walk(render('vbr.mp3', ['-i', 'sine=f=440:d=3:r=44100', '-ac', '2', '-q:a', '2']));
    assert.equal(result.resolved, result.frames);
    assert.equal(result.overBudget, 0);
  });

  test('MPEG-2 mono uses an 8-bit main_data_begin', () => {
    const result = walk(render('mono2.mp3', [
      '-i', 'sine=f=440:d=3:r=22050', '-ac', '1', '-b:a', '64k',
    ]));
    assert.equal(result.resolved, result.frames);
    assert.equal(result.overBudget, 0);
    assert.ok(result.maxMainDataBegin <= 255, 'MPEG-2 main_data_begin is 8 bits');
  });

  test('joint stereo, the most common real-world mode', () => {
    const result = walk(render('joint.mp3', [
      '-i', 'sine=f=440:d=3:r=44100', '-ac', '2', '-b:a', '192k', '-joint_stereo', '1',
    ]));
    assert.equal(result.resolved, result.frames);
    assert.equal(result.overBudget, 0);
  });

  test('probe agrees with ffprobe on duration', () => {
    const path = join(dir, 'probe.mp3');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=4:r=44100',
      '-ac', '2', '-b:a', '160k', path, '-y',
    ]);
    const expected = Number.parseFloat(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
        .toString()
        .trim(),
    );
    const info = probeMp3(new Uint8Array(readFileSync(path)));
    assert.ok(Math.abs(info.duration - expected) < 0.1, `${info.duration} vs ${expected}`);
  });
});

describe('MP3 Huffman tables', () => {
  test('the packed trie is internally consistent', () => {
    assert.equal(HUFFMAN_TABLE_INDEX.length, 32);
    assert.equal(COUNT1_TABLE_A.length, 28);
    assert.equal(COUNT1_TABLE_B.length, 16);

    for (let table = 0; table < 32; table++) {
      const offset = HUFFMAN_TABLE_INDEX[table]!;
      assert.ok(offset < HUFFMAN_TABS.length, `table ${table} offset out of range`);
    }
  });

  test('count1 table B is a flat 4-bit code', () => {
    // Every entry must be a leaf (bit 3 set) with length 4, or the two-level
    // path would be taken for a table that has no second level.
    for (let i = 0; i < COUNT1_TABLE_B.length; i++) {
      const entry = COUNT1_TABLE_B[i]!;
      assert.ok((entry & 8) !== 0, `entry ${i} is not a leaf`);
      assert.equal(entry & 7, 4, `entry ${i} should be a 4-bit code`);
    }
  });
});

describe('MP3 Huffman decoding against real files', { skip: FFMPEG ? false : 'ffmpeg not installed' }, () => {
  let dir: string;

  test('setup', () => {
    dir = mkdtempSync(join(tmpdir(), 'audiobox-huff-'));
  });

  test.after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Decodes every granule and checks the bit accounting.
   *
   * `part2_3_length` declares exactly how many bits a granule's scalefactors
   * plus Huffman data occupy, which makes the bitstream self-checking: if the
   * tables, the trie walk, the scalefactor widths, or the region boundaries were
   * wrong, the bits consumed would not land on the declared total. Getting this
   * to 100% is strong evidence of correctness without needing reference PCM.
   */
  function checkBitAccounting(data: Uint8Array): { granules: number; exact: number; overshoot: number } {
    let offset = id3v2Size(data, 0);
    const reservoir = new BitReservoir();
    const values = new Int32Array(576);
    let granules = 0;
    let exact = 0;
    let overshoot = 0;

    for (;;) {
      const found = findFrame(data, offset);
      if (!found) break;
      const header = found.header;

      const sideInfo = parseSideInfo(data, found.offset + 4 + (header.hasCrc ? 2 : 0), header);
      const start = found.offset + 4 + (header.hasCrc ? 2 : 0) + header.sideInfoSize;
      const end = Math.min(found.offset + header.frameLength, data.byteLength);
      const main = reservoir.read(sideInfo.mainDataBegin, data.subarray(start, end));
      offset = found.offset + header.frameLength;
      if (!main) continue;

      const br = new BitReader(main);
      const previous = createScalefactors();

      for (let gr = 0; gr < sideInfo.granules.length; gr++) {
        for (let ch = 0; ch < header.channels; ch++) {
          const granule = sideInfo.granules[gr]![ch]!;
          const scalefactors = createScalefactors();
          const before = br.bitsRead;

          const scalefactorBits =
            header.version === 1
              ? decodeScalefactorsMpeg1(br, granule, sideInfo.scfsi[ch]!, gr, previous, scalefactors)
              : decodeScalefactorsMpeg2(br, granule, false, scalefactors);

          const result = decodeHuffman(
            br,
            granule,
            header.sampleRate,
            granule.part2_3_length - scalefactorBits,
            values,
          );

          const consumed = scalefactorBits + result.bitsUsed;
          granules++;
          if (consumed === granule.part2_3_length) exact++;
          if (consumed > granule.part2_3_length) overshoot++;

          br.seekBits(before + granule.part2_3_length);
          if (header.version === 1) previous.long.set(scalefactors.long);
        }
      }
    }

    return { granules, exact, overshoot };
  }

  function render(name: string, filter: string, args: string[]): Uint8Array {
    const path = join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, ...args, path, '-y']);
    return new Uint8Array(readFileSync(path));
  }

  const cases: Array<[string, string, string[]]> = [
    ['tone-128k.mp3', 'sine=f=440:d=3', ['-ac', '2', '-b:a', '128k']],
    ['pink-320k.mp3', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-b:a', '320k']],
    ['brown-32k.mp3', 'anoisesrc=d=3:c=brown', ['-ac', '2', '-ar', '32000', '-b:a', '128k']],
    // Tremolo forces frequent long/short window switching, which exercises the
    // transition block types and their region boundaries.
    ['tremolo.mp3', 'sine=f=1000:d=3,aeval=val(0)*(1+0.9*sin(2*PI*17*t))', ['-ac', '2', '-ar', '48000', '-b:a', '256k']],
    ['mpeg2-mono.mp3', 'anoisesrc=d=3:c=white', ['-ac', '1', '-ar', '22050', '-b:a', '64k']],
    ['mpeg2-stereo.mp3', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-ar', '24000', '-b:a', '96k']],
    ['mpeg25.mp3', 'sine=f=300:d=3', ['-ac', '1', '-ar', '11025', '-b:a', '32k']],
    ['low-16k.mp3', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-ar', '16000', '-b:a', '48k']],
  ];

  for (const [name, filter, args] of cases) {
    test(`${name}: every granule consumes exactly part2_3_length`, () => {
      const result = checkBitAccounting(render(name, filter, args));

      assert.ok(result.granules > 50, `only ${result.granules} granules decoded`);
      assert.equal(
        result.overshoot,
        0,
        'a granule consumed more bits than it declared, which means the tables are wrong',
      );
      assert.equal(
        result.exact,
        result.granules,
        `${result.granules - result.exact}/${result.granules} granules missed their declared bit count`,
      );
    });
  }
});

describe('MP3 decoding against ffmpeg', { skip: FFMPEG ? false : 'ffmpeg not installed' }, () => {
  let dir: string;

  test('setup', () => {
    dir = mkdtempSync(join(tmpdir(), 'audiobox-mp3dec-'));
  });

  test.after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Decodes with both audiobox and ffmpeg and compares sample by sample.
   *
   * Two ISO-compliant decoders never agree bit-for-bit — they differ in float
   * precision and rounding — so the bar is SNR, not equality. Above ~50 dB the
   * difference is far below the noise floor of the lossy encoding itself.
   * `lag` is asserted to be 0: a decoder can be spectrally perfect and still be
   * useless for editing if it does not agree on where the audio starts.
   */
  function compare(name: string, filter: string, args: string[]) {
    const mp3Path = join(dir, `${name}.mp3`);
    const rawPath = join(dir, `${name}.raw`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, ...args, mp3Path, '-y']);
    execFileSync('ffmpeg', ['-v', 'error', '-i', mp3Path, '-f', 'f32le', rawPath, '-y']);

    const decoded = decodeMp3(new Uint8Array(readFileSync(mp3Path)));
    const buffer = readFileSync(rawPath);
    const reference = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    const channels = decoded.channelData.length;

    let bestSnr = -Infinity;
    let bestLag = 0;
    for (let lag = -200; lag <= 200; lag++) {
      let signal = 0;
      let noise = 0;
      const limit = Math.min(decoded.channelData[0]!.length - 4000, 50000);
      for (let i = 4000; i < limit; i++) {
        for (let c = 0; c < channels; c++) {
          const ours = decoded.channelData[c]![i]!;
          const theirs = reference[(i + lag) * channels + c];
          if (theirs === undefined) continue;
          signal += theirs * theirs;
          noise += (ours - theirs) ** 2;
        }
      }
      const snr = noise > 0 ? 10 * Math.log10(signal / noise) : Infinity;
      if (snr > bestSnr) {
        bestSnr = snr;
        bestLag = lag;
      }
    }

    return { decoded, snr: bestSnr, lag: bestLag, referenceFrames: reference.length / channels };
  }

  const cases: Array<[string, string, string[], number, number]> = [
    // name, filter, ffmpeg args, expected channels, expected rate
    ['cbr-128k-stereo', 'sine=f=440:d=3', ['-ac', '2', '-b:a', '128k'], 2, 44100],
    ['cbr-320k-pink', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-b:a', '320k'], 2, 48000],
    ['vbr-stereo', 'anoisesrc=d=3:c=brown', ['-ac', '2', '-q:a', '2'], 2, 48000],
    // Tremolo forces window switching, exercising short and transition blocks.
    ['joint-192k', 'sine=f=800:d=3,aeval=val(0)*(1+0.8*sin(2*PI*11*t))', ['-ac', '2', '-b:a', '192k'], 2, 44100],
    ['mono-64k', 'anoisesrc=d=3:c=white', ['-ac', '1', '-b:a', '64k'], 1, 48000],
    ['mpeg2-22k', 'anoisesrc=d=3:c=pink', ['-ac', '1', '-ar', '22050', '-b:a', '64k'], 1, 22050],
    ['mpeg2-24k-stereo', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-ar', '24000', '-b:a', '96k'], 2, 24000],
    ['mpeg25-11k', 'sine=f=300:d=3', ['-ac', '1', '-ar', '11025', '-b:a', '32k'], 1, 11025],
    ['48k-256k', 'anoisesrc=d=3:c=pink', ['-ac', '2', '-ar', '48000', '-b:a', '256k'], 2, 48000],
    ['32k-128k', 'anoisesrc=d=3:c=brown', ['-ac', '2', '-ar', '32000', '-b:a', '128k'], 2, 32000],
  ];

  for (const [name, filter, args, channels, rate] of cases) {
    test(`${name} matches ffmpeg`, () => {
      const { decoded, snr, lag, referenceFrames } = compare(name, filter, args);

      assert.equal(decoded.channelData.length, channels, 'channel count');
      assert.equal(decoded.sampleRate, rate, 'sample rate');
      assert.equal(decoded.info.format, 'mp3');
      assert.equal(decoded.info.lossy, true);

      assert.equal(lag, 0, `decoded audio is offset from ffmpeg by ${lag} samples`);
      assert.ok(snr > 45, `SNR against ffmpeg was only ${snr.toFixed(1)} dB`);

      // Gapless trimming should land within a few ms of the true length.
      const drift = Math.abs(decoded.channelData[0]!.length - referenceFrames);
      assert.ok(drift < 0.01 * rate, `length differs from ffmpeg by ${drift} samples`);
    });
  }

  test('gapless trimming can be turned off', () => {
    const path = join(dir, 'gapless.mp3');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ac', '2', '-b:a', '128k', path, '-y',
    ]);
    const bytes = new Uint8Array(readFileSync(path));

    const trimmed = decodeMp3(bytes);
    const untrimmed = decodeMp3(bytes, { gapless: false });
    assert.ok(
      untrimmed.channelData[0]!.length > trimmed.channelData[0]!.length,
      'disabling gapless should keep the encoder priming samples',
    );
  });

  test('a truncated file still decodes what survived', () => {
    const path = join(dir, 'truncated.mp3');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-ac', '2', '-b:a', '128k', path, '-y',
    ]);
    const full = new Uint8Array(readFileSync(path));
    const half = full.subarray(0, Math.floor(full.byteLength / 2));

    const decoded = decodeMp3(half);
    assert.ok(decoded.channelData[0]!.length > 1000, 'should recover the frames that are present');
    assert.ok(decoded.channelData[0]!.length < decodeMp3(full).channelData[0]!.length);
  });

  test('decode() routes MP3 automatically', async () => {
    const path = join(dir, 'auto.mp3');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-ac', '2', '-b:a', '128k', path, '-y',
    ]);
    const audio = await decode(readFileSync(path));
    assert.equal(audio.info?.format, 'mp3');
    assert.equal(audio.channels, 2);
    assert.ok(Math.abs(audio.duration - 1) < 0.05, `duration ${audio.duration}`);

    // And it composes with the rest of the library.
    const wav = await encode(audio.toMono().resample(16000), 'wav', { bitDepth: 16 });
    assert.ok(wav.byteLength > 0);
    assert.equal((await decode(wav)).sampleRate, 16000);
  });
});
