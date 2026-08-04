/**
 * MP3 codec — `audiobox/mp3`.
 *
 * Decodes MPEG-1, MPEG-2 and MPEG-2.5 Layer III: every sample rate from 8 kHz
 * to 48 kHz, CBR and VBR, mono, stereo, dual-channel and joint stereo (both
 * mid/side and intensity), with gapless playback from Xing/VBRI/LAME tags.
 * Verified sample-aligned against ffmpeg at 52–64 dB SNR across that matrix.
 *
 * Encodes MPEG-1 Layer III at 32–320 kbps, mono or stereo, at 32 / 44.1 / 48 kHz,
 * constant or variable bitrate, with a psychoacoustic model, window switching on
 * transients, and a Xing/Info tag so round trips are gapless.
 *
 * Kept out of the core bundle so the Huffman tables and filterbank only load for
 * callers that actually handle MP3.
 */

export { decodeMp3 } from './decoder.ts';
export type { Mp3DecodeOptions } from './decoder.ts';

export { encodeMp3, encodeMp3Channels, ENCODER_DELAY } from './encoder.ts';
export type { Mp3EncodeOptions } from './encoder.ts';

export { probeMp3 } from './probe.ts';
export type { Mp3Info } from './probe.ts';

export { parseFrameHeader, findFrame, id3v2Size, readVbrHeader } from './frame.ts';
export type { FrameHeader, MpegVersion, ChannelMode, VbrInfo } from './frame.ts';
