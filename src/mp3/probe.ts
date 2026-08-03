/**
 * MP3 inspection without decoding.
 *
 * Reading an MP3's duration, bitrate, and channel layout does not require
 * decoding a single sample — the information is in the frame headers and the
 * Xing/VBRI tag. That makes probing effectively free even for a large file,
 * which is what you want for an upload validator, a media library scan, or a
 * "reject anything over 10 minutes" check.
 *
 * Duration is exact for CBR and for VBR files carrying a frame count. For a VBR
 * file with no tag, every frame header is walked — still far cheaper than
 * decoding, and the result is exact rather than the extrapolated guess most
 * tools return.
 */

import { DecodeError } from '../errors.ts';
import { findFrame, id3v2Size, readVbrHeader, type ChannelMode, type MpegVersion } from './frame.ts';

export interface Mp3Info {
  /** Duration in seconds. */
  duration: number;
  sampleRate: number;
  channels: number;
  channelMode: ChannelMode;
  /** Average bitrate in bits per second. */
  bitrate: number;
  /** True when the file uses variable bitrate. */
  vbr: boolean;
  mpegVersion: MpegVersion;
  layer: number;
  /** Total MPEG frames. */
  frameCount: number;
  /** Byte offset of the first audio frame, past any ID3v2 tag. */
  audioOffset: number;
  /** Encoder delay in samples, when a LAME tag declares it. */
  encoderDelay?: number;
  /** Encoder padding in samples, when a LAME tag declares it. */
  encoderPadding?: number;
}

/**
 * Reads an MP3's properties without decoding it.
 *
 * @param scanAll When a VBR file has no frame-count tag, walk every frame for an
 * exact duration. Defaults to `true`; set `false` to estimate from the first
 * frame instead, which is much faster but wrong for VBR.
 */
export function probeMp3(input: Uint8Array, scanAll = true): Mp3Info {
  const audioOffset = id3v2Size(input, 0);

  const first = findFrame(input, audioOffset);
  if (!first) {
    throw new DecodeError('No valid MPEG audio frame found; this is not a readable MP3.');
  }

  const { header } = first;
  const vbrHeader = readVbrHeader(input, first.offset, header);

  // A file whose first frame carries a Xing/Info tag has that frame as a
  // header-only placeholder — it holds no audio and must not be counted.
  const hasTagFrame = vbrHeader !== null;

  let frameCount: number;
  let audioBytes: number;
  let vbr = vbrHeader?.vbr ?? false;

  if (vbrHeader?.frames !== undefined) {
    frameCount = vbrHeader.frames;
    audioBytes = vbrHeader.bytes ?? input.byteLength - first.offset;
  } else if (scanAll) {
    let count = 0;
    let offset = first.offset;
    let lastBitrate = header.bitrate;
    vbr = false;

    while (offset + 4 <= input.byteLength) {
      const found = findFrame(input, offset, Math.min(input.byteLength, offset + 8192));
      if (!found || found.offset !== offset) {
        // Resync once past unexpected padding, then give up if it persists.
        if (!found) break;
        offset = found.offset;
        continue;
      }
      if (found.header.bitrate !== lastBitrate) {
        vbr = true;
        lastBitrate = found.header.bitrate;
      }
      count++;
      offset += found.header.frameLength;
    }

    frameCount = count - (hasTagFrame ? 1 : 0);
    audioBytes = offset - first.offset;
  } else {
    audioBytes = input.byteLength - first.offset;
    frameCount = Math.floor(audioBytes / header.frameLength);
  }

  let samples = frameCount * header.samplesPerFrame;
  // Gapless metadata: trim the encoder's priming and padding from the duration
  // so it matches the original recording rather than the encoded stream.
  if (vbrHeader?.encoderDelay !== undefined) {
    samples -= vbrHeader.encoderDelay + (vbrHeader.encoderPadding ?? 0);
  }
  const duration = Math.max(0, samples / header.sampleRate);

  return {
    duration,
    sampleRate: header.sampleRate,
    channels: header.channels,
    channelMode: header.mode,
    bitrate: duration > 0 ? Math.round((audioBytes * 8) / duration) : header.bitrate,
    vbr,
    mpegVersion: header.version,
    layer: header.layer,
    frameCount: Math.max(0, frameCount),
    audioOffset: first.offset,
    ...(vbrHeader?.encoderDelay !== undefined ? { encoderDelay: vbrHeader.encoderDelay } : {}),
    ...(vbrHeader?.encoderPadding !== undefined ? { encoderPadding: vbrHeader.encoderPadding } : {}),
  };
}
