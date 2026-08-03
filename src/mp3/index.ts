/**
 * MP3 codec — `audiobox/mp3`.
 *
 * Decodes MPEG-1, MPEG-2 and MPEG-2.5 Layer III: every sample rate from 8 kHz
 * to 48 kHz, CBR and VBR, mono, stereo, dual-channel and joint stereo (both
 * mid/side and intensity), with gapless playback from Xing/VBRI/LAME tags.
 *
 * Verified sample-aligned against ffmpeg at 52–64 dB SNR across that whole
 * matrix. Encoding is not implemented; see the roadmap in the README.
 *
 * Kept out of the core bundle so the Huffman tables and filterbank only load for
 * callers that actually handle MP3.
 */

export { decodeMp3 } from './decoder.ts';
export type { Mp3DecodeOptions } from './decoder.ts';

export { probeMp3 } from './probe.ts';
export type { Mp3Info } from './probe.ts';

export { parseFrameHeader, findFrame, id3v2Size, readVbrHeader } from './frame.ts';
export type { FrameHeader, MpegVersion, ChannelMode, VbrInfo } from './frame.ts';
