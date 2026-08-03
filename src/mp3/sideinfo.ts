/**
 * Layer III side information and the bit reservoir.
 *
 * ## The bit reservoir, and why decoding is not frame-by-frame
 *
 * An MP3 frame has a fixed byte length set by its bitrate, but the audio in it
 * does not need a fixed number of bits. A quiet passage leaves bits unused; a
 * dense one needs more than its frame allows. Layer III lets a frame *borrow*
 * the unused tail of earlier frames — the "bit reservoir".
 *
 * The practical consequence: a frame's Huffman data usually does not start
 * inside that frame. `main_data_begin` says how many bytes *backwards* from the
 * end of this frame's header the data actually begins. So a decoder must keep a
 * rolling buffer of recent frame payloads, and cannot decode frame N without
 * having seen the frames before it.
 *
 * This is also why seeking into the middle of an MP3 produces a brief artefact,
 * and why the first frame after a seek is usually discarded.
 */

import { BitReader } from '../io/bits.ts';
import { DecodeError } from '../errors.ts';
import type { FrameHeader } from './frame.ts';

/** Per-granule, per-channel coding parameters. */
export interface GranuleInfo {
  /** Bits of main data used by this granule and channel. */
  part2_3_length: number;
  /** Number of Huffman-coded value pairs in the "big values" region. */
  bigValues: number;
  /** Quantizer step size for the whole granule. */
  globalGain: number;
  /** Selects the scalefactor bit-length pair. */
  scalefacCompress: number;
  /** True when this granule does not use a single long window. */
  windowSwitching: boolean;
  /** 0 = normal long, 1 = long-to-short, 2 = three short, 3 = short-to-long. */
  blockType: number;
  /** True when the two lowest sub-bands stay long while the rest are short. */
  mixedBlock: boolean;
  /** Huffman table per region. */
  tableSelect: [number, number, number];
  /** Extra gain per short sub-block. */
  subblockGain: [number, number, number];
  /** Scalefactor band where region 0 ends. */
  region0Count: number;
  /** Scalefactor band where region 1 ends. */
  region1Count: number;
  /** Apply the high-frequency emphasis in PRETAB. */
  preflag: boolean;
  /** Scalefactor multiplier: 0.5 when clear, 1.0 when set. */
  scalefacScale: number;
  /** Which table decodes the count1 region. */
  count1TableSelect: number;
}

export interface SideInfo {
  /** Bytes to look backwards for the start of this frame's main data. */
  mainDataBegin: number;
  /** Scalefactor selection info: which bands are shared between granules. */
  scfsi: number[][];
  /** `[granule][channel]`. MPEG-1 has two granules; MPEG-2/2.5 has one. */
  granules: GranuleInfo[][];
}

/**
 * Parses the side information block that follows a frame header.
 *
 * MPEG-2 and 2.5 use a different, smaller layout than MPEG-1: one granule
 * instead of two, no `scfsi`, and an extra `intensity_stereo` flag.
 */
export function parseSideInfo(
  data: Uint8Array,
  offset: number,
  header: FrameHeader,
): SideInfo {
  if (offset + header.sideInfoSize > data.byteLength) {
    throw new DecodeError('Truncated MP3 side information.', { offset });
  }

  const br = new BitReader(data, offset);
  const channels = header.channels;
  const isMpeg1 = header.version === 1;
  const granuleCount = isMpeg1 ? 2 : 1;

  const mainDataBegin = br.bits(isMpeg1 ? 9 : 8);

  // Private bits, ignored by decoders.
  br.bits(isMpeg1 ? (channels === 1 ? 5 : 3) : (channels === 1 ? 1 : 2));

  const scfsi: number[][] = [];
  if (isMpeg1) {
    for (let ch = 0; ch < channels; ch++) {
      const perChannel: number[] = [];
      for (let band = 0; band < 4; band++) perChannel.push(br.bit());
      scfsi.push(perChannel);
    }
  } else {
    for (let ch = 0; ch < channels; ch++) scfsi.push([0, 0, 0, 0]);
  }

  const granules: GranuleInfo[][] = [];

  for (let gr = 0; gr < granuleCount; gr++) {
    const perGranule: GranuleInfo[] = [];

    for (let ch = 0; ch < channels; ch++) {
      const part2_3_length = br.bits(12);
      const bigValues = br.bits(9);
      const globalGain = br.bits(8);
      const scalefacCompress = br.bits(isMpeg1 ? 4 : 9);
      const windowSwitching = br.bit() === 1;

      let blockType = 0;
      let mixedBlock = false;
      const tableSelect: [number, number, number] = [0, 0, 0];
      const subblockGain: [number, number, number] = [0, 0, 0];
      let region0Count: number;
      let region1Count: number;

      if (windowSwitching) {
        blockType = br.bits(2);
        mixedBlock = br.bit() === 1;
        tableSelect[0] = br.bits(5);
        tableSelect[1] = br.bits(5);
        subblockGain[0] = br.bits(3);
        subblockGain[1] = br.bits(3);
        subblockGain[2] = br.bits(3);

        // With window switching there are only two regions, and the boundaries
        // are implied rather than transmitted.
        region0Count = blockType === 2 && !mixedBlock ? 8 : 7;
        region1Count = 20 - region0Count;
      } else {
        tableSelect[0] = br.bits(5);
        tableSelect[1] = br.bits(5);
        tableSelect[2] = br.bits(5);
        region0Count = br.bits(4);
        region1Count = br.bits(3);
      }

      // `bigValues` counts pairs, so it can never exceed half of 576.
      if (bigValues > 288) {
        throw new DecodeError(
          `Invalid MP3 big_values ${bigValues}: at most 288 value pairs fit in a granule.`,
          { offset },
        );
      }
      if (blockType === 0 && windowSwitching) {
        throw new DecodeError('Invalid MP3 granule: window switching with block type 0.', { offset });
      }

      perGranule.push({
        part2_3_length,
        bigValues,
        globalGain,
        scalefacCompress,
        windowSwitching,
        blockType,
        mixedBlock,
        tableSelect,
        subblockGain,
        region0Count,
        region1Count,
        preflag: isMpeg1 ? br.bit() === 1 : false,
        scalefacScale: br.bit() === 1 ? 1 : 0.5,
        count1TableSelect: br.bit(),
      });
    }

    granules.push(perGranule);
  }

  if (br.overran) {
    throw new DecodeError('MP3 side information ended unexpectedly.', { offset });
  }

  return { mainDataBegin, scfsi, granules };
}

/**
 * Rolling buffer of recent frame payloads, so `main_data_begin` can reach back
 * into earlier frames.
 *
 * The specification caps the look-back at 511 bytes (MPEG-1), so a buffer a
 * little larger than that is always sufficient. Older bytes are discarded, which
 * bounds memory regardless of file length.
 */
export class BitReservoir {
  #buffer: Uint8Array;
  #length = 0;

  constructor(capacity = 4096) {
    this.#buffer = new Uint8Array(capacity);
  }

  /** Bytes currently held. */
  get length(): number {
    return this.#length;
  }

  /** Discards everything, e.g. after a seek. */
  reset(): void {
    this.#length = 0;
  }

  /** Appends one frame's main-data payload. */
  push(data: Uint8Array): void {
    if (data.byteLength >= this.#buffer.byteLength) {
      // A single payload larger than the whole buffer: keep only its tail, which
      // is all any subsequent frame can legally reference.
      this.#buffer.set(data.subarray(data.byteLength - this.#buffer.byteLength));
      this.#length = this.#buffer.byteLength;
      return;
    }

    if (this.#length + data.byteLength > this.#buffer.byteLength) {
      // Slide the window, dropping the oldest bytes.
      const keep = this.#buffer.byteLength - data.byteLength;
      this.#buffer.copyWithin(0, this.#length - keep, this.#length);
      this.#length = keep;
    }

    this.#buffer.set(data, this.#length);
    this.#length += data.byteLength;
  }

  /**
   * Returns the main data for a frame, given its `main_data_begin`.
   *
   * Returns `null` when the reservoir does not yet hold enough history — normal
   * for the first frames of a file, and after a seek. The caller should skip
   * those frames rather than treat it as an error.
   */
  read(mainDataBegin: number, frameData: Uint8Array): Uint8Array | null {
    if (mainDataBegin === 0) {
      // Self-contained frame: no history needed.
      this.push(frameData);
      return frameData;
    }

    if (mainDataBegin > this.#length) return null;

    const out = new Uint8Array(mainDataBegin + frameData.byteLength);
    out.set(this.#buffer.subarray(this.#length - mainDataBegin, this.#length), 0);
    out.set(frameData, mainDataBegin);

    this.push(frameData);
    return out;
  }
}
