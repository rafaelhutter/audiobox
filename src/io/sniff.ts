/**
 * Format detection by magic bytes.
 *
 * Never trust a file extension — uploads are routinely mislabelled, and a
 * `.wav` that is really an MP3 is common enough that content sniffing is the
 * only reliable path.
 *
 * Formats audiobox cannot decode are still *detected*, so the error can say
 * "this is an Ogg file, which audiobox doesn't read" instead of the useless
 * "unrecognised data". Knowing what you handed over is most of the debugging.
 */

import type { AudioFormat } from '../types.ts';

/** A container audiobox recognises but does not decode. */
export type KnownUndecodableFormat =
  | 'ogg'
  | 'mp4'
  | 'webm'
  | 'wavpack'
  | 'ape'
  | 'musepack'
  | 'amr'
  | 'midi';

export type SniffResult =
  | { kind: 'supported'; format: AudioFormat }
  | { kind: 'unsupported'; format: KnownUndecodableFormat; label: string }
  | { kind: 'unknown' };

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (offset + length > b.byteLength) return '';
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(b[offset + i]!);
  return s;
}

/**
 * Looks for an MPEG audio frame sync within the first `limit` bytes.
 *
 * MP3 has no file-level magic number — an untagged file simply begins with a
 * frame. A bare 11-bit sync pattern gives false positives on random data, so the
 * candidate's version, layer, bitrate, and sample-rate fields must all be valid
 * before it counts.
 */
function findMpegFrame(b: Uint8Array, limit: number): boolean {
  const end = Math.min(b.byteLength - 4, limit);
  for (let i = 0; i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) continue;

    const versionBits = (b[i + 1]! >> 3) & 0x03;
    const layerBits = (b[i + 1]! >> 1) & 0x03;
    const bitrateIndex = (b[i + 2]! >> 4) & 0x0f;
    const sampleRateIndex = (b[i + 2]! >> 2) & 0x03;

    if (versionBits === 1) continue; // reserved MPEG version
    if (layerBits === 0) continue; // reserved layer
    if (bitrateIndex === 0 || bitrateIndex === 0x0f) continue; // free-form or invalid
    if (sampleRateIndex === 3) continue; // reserved sample rate

    return true;
  }
  return false;
}

/** Identifies the container in `input` from its leading bytes. */
export function sniff(input: Uint8Array): SniffResult {
  const b = input;
  if (b.byteLength < 4) return { kind: 'unknown' };

  const magic4 = ascii(b, 0, 4);

  // RIFF-family. The form type at offset 8 separates WAVE from AVI and friends.
  if (magic4 === 'RIFF' || magic4 === 'RF64' || magic4 === 'BW64') {
    if (ascii(b, 8, 4) === 'WAVE') return { kind: 'supported', format: 'wav' };
    return { kind: 'unknown' };
  }

  // Sony Wave64 opens with a 16-byte GUID whose first four bytes spell "riff".
  if (magic4 === 'riff' && ascii(b, 24, 4) === 'wave') {
    return { kind: 'supported', format: 'wav' };
  }

  // IFF-family: AIFF and AIFF-C.
  if (magic4 === 'FORM') {
    const form = ascii(b, 8, 4);
    if (form === 'AIFF' || form === 'AIFC') {
      return { kind: 'supported', format: 'aiff' };
    }
    return { kind: 'unknown' };
  }

  if (magic4 === 'fLaC') return { kind: 'supported', format: 'flac' };
  if (magic4 === 'caff') return { kind: 'supported', format: 'caf' };
  if (magic4 === '.snd') return { kind: 'supported', format: 'au' };

  // Recognised, not decoded — reported so the error message can be specific.
  if (magic4 === 'OggS') {
    return { kind: 'unsupported', format: 'ogg', label: 'Ogg (Vorbis/Opus/FLAC)' };
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    return { kind: 'unsupported', format: 'mp4', label: 'MP4/M4A (AAC or ALAC)' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { kind: 'unsupported', format: 'webm', label: 'Matroska/WebM' };
  }
  if (magic4 === 'wvpk') return { kind: 'unsupported', format: 'wavpack', label: 'WavPack' };
  if (magic4 === 'MAC ') return { kind: 'unsupported', format: 'ape', label: "Monkey's Audio" };
  if (magic4 === 'MPCK' || ascii(b, 0, 3) === 'MP+') {
    return { kind: 'unsupported', format: 'musepack', label: 'Musepack' };
  }
  if (ascii(b, 0, 5) === '#!AMR') {
    return { kind: 'unsupported', format: 'amr', label: 'AMR' };
  }
  if (magic4 === 'MThd') return { kind: 'unsupported', format: 'midi', label: 'MIDI' };

  // MP3 last: an ID3v2 tag is a strong signal, and a bare frame sync is a weak
  // one, so both are only considered once every explicit magic number has missed.
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'supported', format: 'mp3' };
  if (findMpegFrame(b, 8192)) return { kind: 'supported', format: 'mp3' };

  // An ID3v1 tag sits in the final 128 bytes; a file carrying one is MP3 in
  // practice even when its leading bytes are unhelpful.
  if (b.byteLength >= 128 && ascii(b, b.byteLength - 128, 3) === 'TAG') {
    return { kind: 'supported', format: 'mp3' };
  }

  return { kind: 'unknown' };
}
