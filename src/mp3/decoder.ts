/**
 * MP3 decoder.
 *
 * Walks the frame sequence, assembles main data through the bit reservoir, and
 * runs each granule through the full Layer III chain:
 *
 * ```
 * side info -> scalefactors -> Huffman -> requantize -> reorder
 *   -> stereo -> alias reduction -> IMDCT -> frequency inversion
 *   -> polyphase synthesis -> PCM
 * ```
 *
 * ## Gapless playback
 *
 * An MP3 never contains exactly the audio that went in. The encoder's
 * filterbank needs priming, so it prepends silence, and it pads the final frame
 * out to a whole 1152 samples. LAME records both figures in a tag, and honouring
 * them is the difference between a seamless album and a click between every
 * track. When the tag is present those samples are trimmed; when it is absent a
 * conservative default delay is used.
 */

import { DecodeError } from '../errors.ts';
import { BitReader } from '../io/bits.ts';
import { checkDecodeShape, resolveLimits } from '../limits.ts';
import { throwIfAborted } from '../errors.ts';
import type { DecodeOptions, AudioMetadata } from '../types.ts';
import type { DecodedContainer } from '../formats/types.ts';

import { findFrame, id3v2Size, readVbrHeader, type FrameHeader } from './frame.ts';
import { parseSideInfo, BitReservoir } from './sideinfo.ts';
import {
  createScalefactors,
  decodeScalefactorsMpeg1,
  decodeScalefactorsMpeg2,
  decodeHuffman,
  type Scalefactors,
} from './huffman.ts';
import { requantize, reorderShortBlock, applyJointStereo } from './requantize.ts';
import { reduceAlias, imdct, invertFrequency, SynthesisFilterbank } from './imdct.ts';

/**
 * The encoder delay every Layer III encoder introduces, in samples.
 *
 * 529 is the filterbank's own latency, present regardless of encoder. LAME adds
 * a further 576 on top, which is why its tag reports 1105.
 */
const DECODER_DELAY = 529;

/**
 * Extra group delay from this implementation's synthesis tap ordering.
 *
 * The window is indexed one 64-tap group away from the specification's own
 * layout (see `synth-window.ts`), which advances the output by exactly 64
 * samples. Compensating here keeps the decoded stream sample-aligned with other
 * decoders instead of pushing the discrepancy onto callers.
 */
const FILTERBANK_OFFSET = 64;

/** Per-channel state that must persist across granules. */
interface ChannelState {
  overlap: Float32Array;
  filterbank: SynthesisFilterbank;
  scalefactors: Scalefactors;
  previousScalefactors: Scalefactors;
}

function createChannelState(): ChannelState {
  return {
    overlap: new Float32Array(576),
    filterbank: new SynthesisFilterbank(),
    scalefactors: createScalefactors(),
    previousScalefactors: createScalefactors(),
  };
}

/** Growable planar output, so a stream of unknown length can be decoded. */
class PcmSink {
  #channels: Float32Array[];
  #capacity: number;
  #length = 0;

  constructor(channelCount: number, initialCapacity: number) {
    this.#capacity = Math.max(1152, initialCapacity);
    this.#channels = Array.from({ length: channelCount }, () => new Float32Array(this.#capacity));
  }

  get length(): number {
    return this.#length;
  }

  /** Ensures room for `frames` more samples. */
  reserve(frames: number): void {
    if (this.#length + frames <= this.#capacity) return;
    let capacity = this.#capacity * 2;
    while (capacity < this.#length + frames) capacity *= 2;
    this.#channels = this.#channels.map((channel) => {
      const next = new Float32Array(capacity);
      next.set(channel.subarray(0, this.#length));
      return next;
    });
    this.#capacity = capacity;
  }

  write(channel: number, samples: Float32Array, count: number, at: number): void {
    this.#channels[channel]!.set(samples.subarray(0, count), at);
  }

  advance(frames: number): void {
    this.#length += frames;
  }

  /** Extracts the final buffers, trimming the encoder's priming and padding. */
  finish(skipStart: number, skipEnd: number): Float32Array[] {
    const start = Math.min(skipStart, this.#length);
    const end = Math.max(start, this.#length - skipEnd);
    return this.#channels.map((channel) => channel.slice(start, end));
  }
}

export interface Mp3DecodeOptions extends DecodeOptions {
  /**
   * Honour the encoder delay and padding for gapless playback. Defaults to
   * `true`. Turn it off when you need the decoded stream to line up
   * sample-for-sample with another decoder that ignores the tag.
   */
  gapless?: boolean;
}

/** Decodes an MP3 stream. */
export function decodeMp3(input: Uint8Array, options?: Mp3DecodeOptions): DecodedContainer {
  const limits = resolveLimits(options?.limits);
  const gapless = options?.gapless !== false;

  const audioStart = id3v2Size(input, 0);
  const first = findFrame(input, audioStart);
  if (!first) {
    throw new DecodeError('No valid MPEG audio frame found; this is not a readable MP3.');
  }
  if (first.header.layer !== 3) {
    throw new DecodeError(
      `This is MPEG Layer ${first.header.layer}, not Layer III. audiobox decodes Layer III (MP3) only.`,
    );
  }

  const vbrInfo = readVbrHeader(input, first.offset, first.header);
  // A frame carrying a Xing/Info tag holds no audio and must be skipped.
  const skipFirstFrame = vbrInfo !== null;

  const sampleRate = first.header.sampleRate;
  const channelCount = first.header.channels;

  // Pre-size the output from the declared frame count where available.
  const estimatedFrames = vbrInfo?.frames
    ? vbrInfo.frames * first.header.samplesPerFrame
    : Math.ceil((input.byteLength / Math.max(first.header.frameLength, 1)) * first.header.samplesPerFrame);
  checkDecodeShape(Math.min(estimatedFrames, limits.maxFrames), channelCount, sampleRate, limits);

  const sink = new PcmSink(channelCount, Math.min(estimatedFrames + 4608, 1 << 24));
  const reservoir = new BitReservoir();
  const state = Array.from({ length: channelCount }, createChannelState);

  // Scratch buffers, reused across every granule so decoding does not allocate
  // in its inner loop.
  const quantized = new Int32Array(576);
  const spectrum = [new Float32Array(576), new Float32Array(576)];
  const timeDomain = [new Float32Array(576), new Float32Array(576)];
  const reorderScratch = new Float32Array(576);
  const subbandSlot = new Float32Array(32);
  const pcm = new Float32Array(1152);
  const nonZero = [0, 0];

  let offset = first.offset;
  let frameIndex = 0;
  let decodedFrames = 0;
  let lastHeader: FrameHeader = first.header;

  for (;;) {
    throwIfAborted(options?.signal);

    const found = findFrame(input, offset);
    if (!found) break;
    const header = found.header;
    offset = found.offset + header.frameLength;
    frameIndex++;

    if (header.layer !== 3) continue;
    if (skipFirstFrame && frameIndex === 1) {
      // Still feed the reservoir: the tag frame's payload is legal history.
      const start = found.offset + 4 + (header.hasCrc ? 2 : 0) + header.sideInfoSize;
      reservoir.read(0, input.subarray(start, Math.min(found.offset + header.frameLength, input.byteLength)));
      continue;
    }

    // A mid-stream change of rate or channel count is a different stream; stop
    // rather than silently producing garbage.
    if (header.sampleRate !== sampleRate || header.channels !== channelCount) break;
    lastHeader = header;

    let sideInfo;
    try {
      sideInfo = parseSideInfo(input, found.offset + 4 + (header.hasCrc ? 2 : 0), header);
    } catch {
      continue; // corrupt frame; skip it rather than abandoning the file
    }

    const dataStart = found.offset + 4 + (header.hasCrc ? 2 : 0) + header.sideInfoSize;
    const dataEnd = Math.min(found.offset + header.frameLength, input.byteLength);
    const main = reservoir.read(sideInfo.mainDataBegin, input.subarray(dataStart, dataEnd));
    // Not enough history yet — normal for the first frames and after a seek.
    if (!main) continue;

    const br = new BitReader(main);
    const granuleCount = sideInfo.granules.length;

    sink.reserve(granuleCount * 576);

    for (let gr = 0; gr < granuleCount; gr++) {
      // --- frequency domain, per channel ---
      for (let ch = 0; ch < channelCount; ch++) {
        const granule = sideInfo.granules[gr]![ch]!;
        const channelState = state[ch]!;
        const before = br.bitsRead;

        const scalefactorBits =
          header.version === 1
            ? decodeScalefactorsMpeg1(
                br,
                granule,
                sideInfo.scfsi[ch]!,
                gr,
                channelState.previousScalefactors,
                channelState.scalefactors,
              )
            : decodeScalefactorsMpeg2(
                br,
                granule,
                ch === 1 && (header.modeExtension & 0x01) !== 0,
                channelState.scalefactors,
              );

        const result = decodeHuffman(
          br,
          granule,
          sampleRate,
          granule.part2_3_length - scalefactorBits,
          quantized,
        );
        nonZero[ch] = result.nonZeroCount;

        requantize(
          quantized,
          granule,
          channelState.scalefactors,
          sampleRate,
          result.nonZeroCount,
          spectrum[ch]!,
        );

        // Realign to the declared boundary so one bad granule cannot desync the
        // rest of the frame.
        br.seekBits(before + granule.part2_3_length);

        if (header.version === 1) {
          channelState.previousScalefactors.long.set(channelState.scalefactors.long);
        }
      }

      // --- stereo, then per-channel time domain ---
      if (channelCount === 2 && header.mode === 'joint') {
        applyJointStereo(
          spectrum[0]!,
          spectrum[1]!,
          header.modeExtension,
          sideInfo.granules[gr]![1]!,
          state[1]!.scalefactors,
          sampleRate,
          nonZero[1]!,
          header.version === 1,
        );
      }

      for (let ch = 0; ch < channelCount; ch++) {
        const granule = sideInfo.granules[gr]![ch]!;
        const channelState = state[ch]!;

        reorderShortBlock(spectrum[ch]!, granule, sampleRate, reorderScratch);
        reduceAlias(spectrum[ch]!, granule);
        imdct(spectrum[ch]!, granule, channelState.overlap, timeDomain[ch]!);
        invertFrequency(timeDomain[ch]!);

        // 18 time slots of 32 sub-bands each.
        for (let slot = 0; slot < 18; slot++) {
          for (let subband = 0; subband < 32; subband++) {
            subbandSlot[subband] = timeDomain[ch]![subband * 18 + slot]!;
          }
          channelState.filterbank.process(subbandSlot, pcm, slot * 32);
        }

        sink.write(ch, pcm, 576, sink.length);
      }

      sink.advance(576);
    }

    decodedFrames++;
  }

  if (decodedFrames === 0) {
    throw new DecodeError('No decodable MP3 frames; the file may be truncated or corrupt.');
  }

  // Trim the encoder's priming and padding.
  let skipStart = 0;
  let skipEnd = 0;
  if (gapless) {
    skipStart = (vbrInfo?.encoderDelay ?? 0) + DECODER_DELAY + FILTERBANK_OFFSET;
    // The tag's padding figure already accounts for the encoder's own delay, so
    // the decoder's share has to come back off it — otherwise the tail is
    // over-trimmed by exactly DECODER_DELAY samples.
    skipEnd = Math.max(0, (vbrInfo?.encoderPadding ?? 0) - DECODER_DELAY);
    // Padding is only trustworthy alongside a declared frame count.
    if (skipEnd > 0 && skipEnd + skipStart >= sink.length) skipEnd = 0;
  }

  const channelData = sink.finish(skipStart, skipEnd);
  const frames = channelData[0]?.length ?? 0;
  checkDecodeShape(frames, channelCount, sampleRate, limits);

  const metadata: AudioMetadata = {};
  const duration = frames / sampleRate;

  options?.onProgress?.(1);

  return {
    channelData,
    sampleRate,
    info: {
      format: 'mp3',
      // MP3 is not stored as PCM; report what it decodes to.
      sampleFormat: 's16',
      bitDepth: 16,
      bitrate: duration > 0 ? Math.round((input.byteLength * 8) / duration) : lastHeader.bitrate,
      lossy: true,
      metadata,
      details: {
        mpegVersion: lastHeader.version,
        layer: lastHeader.layer,
        channelMode: lastHeader.mode,
        vbr: vbrInfo?.vbr ?? false,
        frameCount: decodedFrames,
        ...(vbrInfo?.encoderDelay !== undefined ? { encoderDelay: vbrInfo.encoderDelay } : {}),
        ...(vbrInfo?.encoderPadding !== undefined ? { encoderPadding: vbrInfo.encoderPadding } : {}),
      },
    },
  };
}
