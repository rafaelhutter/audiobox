/**
 * Writing the MP3 bitstream: frame headers, side information, scalefactors, and
 * the bit reservoir.
 *
 * ## The bit reservoir, from the writing side
 *
 * A frame is a fixed number of bytes, set by the bitrate. The audio in it is
 * not: a quiet passage needs fewer bits than a dense one. Layer III resolves
 * that by letting a frame's main data start *before* its own header — in space
 * left unused by earlier frames — and `main_data_begin` says how far back.
 *
 * So the encoder cannot emit a frame as a self-contained unit. It generates main
 * data into one continuous stream, and separately fills fixed-size slots from
 * that stream, tracking how far the two have diverged. That divergence is
 * `main_data_begin`, and the format caps it at 511 bytes — a limit the rate
 * control has to respect, since exceeding it produces frames no decoder can
 * reassemble.
 *
 * This mirrors `BitReservoir` in `sideinfo.ts`, which does the same bookkeeping
 * in reverse.
 */

import { BitWriter } from '../io/bits.ts';
import { Writer } from '../io/writer.ts';
import { EncodeError, InvalidArgumentError } from '../errors.ts';
import { bitrateIndex, sampleRateIndex, mpeg1FrameLength, mpeg1SideInfoSize } from './frame.ts';
import { SLEN1, SLEN2 } from './tables.ts';
import type { ChannelMode } from './frame.ts';
import type { GranuleInfo, SideInfo } from './sideinfo.ts';
import type { Scalefactors } from './huffman.ts';

/** The largest look-back the 9-bit `main_data_begin` field can express. */
export const MAX_MAIN_DATA_BEGIN = 511;

export interface FrameParameters {
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  mode: ChannelMode;
  /** Intensity/MS flags. Only meaningful in joint stereo. */
  modeExtension: number;
  padding: boolean;
}

/**
 * Writes a 4-byte MPEG-1 Layer III frame header.
 *
 * The CRC bit is written as "no CRC". A frame CRC protects only the header and
 * side information, every decoder tolerates its absence, and omitting it leaves
 * two more bytes per frame for audio.
 */
export function writeFrameHeader(writer: BitWriter, params: FrameParameters): void {
  const bitrate = bitrateIndex(params.bitrateKbps);
  if (bitrate < 1) {
    throw new InvalidArgumentError(
      `${params.bitrateKbps} kbps is not an MPEG-1 Layer III bitrate. ` +
        'Valid: 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320.',
    );
  }

  const rate = sampleRateIndex(params.sampleRate);
  if (rate < 0) {
    throw new InvalidArgumentError(
      `${params.sampleRate} Hz is not an MPEG-1 sample rate. Valid: 32000, 44100, 48000.`,
    );
  }

  writer.bits(0x7ff, 11); // sync
  writer.bits(0b11, 2); // MPEG-1
  writer.bits(0b01, 2); // Layer III
  writer.bit(1); // no CRC
  writer.bits(bitrate, 4);
  writer.bits(rate, 2);
  writer.bit(params.padding ? 1 : 0);
  writer.bit(0); // private
  writer.bits(modeBits(params.mode), 2);
  writer.bits(params.modeExtension & 0x03, 2);
  writer.bit(0); // copyright
  writer.bit(0); // original
  writer.bits(0, 2); // emphasis: none
}

function modeBits(mode: ChannelMode): number {
  switch (mode) {
    case 'stereo':
      return 0;
    case 'joint':
      return 1;
    case 'dual':
      return 2;
    case 'mono':
      return 3;
  }
}

/**
 * Writes the side information block.
 *
 * Field order and widths mirror `parseSideInfo` exactly; the two are read
 * together whenever either changes.
 */
export function writeSideInfo(writer: BitWriter, sideInfo: SideInfo, channels: number): void {
  if (sideInfo.granules.length !== 2) {
    throw new EncodeError('MPEG-1 Layer III requires exactly two granules per frame.');
  }

  writer.bits(sideInfo.mainDataBegin, 9);
  writer.bits(0, channels === 1 ? 5 : 3); // private bits

  for (let ch = 0; ch < channels; ch++) {
    const scfsi = sideInfo.scfsi[ch] ?? [0, 0, 0, 0];
    for (let band = 0; band < 4; band++) writer.bit(scfsi[band] ?? 0);
  }

  for (let gr = 0; gr < 2; gr++) {
    for (let ch = 0; ch < channels; ch++) {
      writeGranuleInfo(writer, sideInfo.granules[gr]![ch]!);
    }
  }
}

function writeGranuleInfo(writer: BitWriter, granule: GranuleInfo): void {
  if (granule.part2_3_length > 4095) {
    throw new EncodeError(
      `part2_3_length ${granule.part2_3_length} exceeds the 12-bit field; ` +
        'the rate control allocated more bits than a granule can hold.',
    );
  }
  if (granule.bigValues > 288) {
    throw new EncodeError(`big_values ${granule.bigValues} exceeds the 288-pair limit.`);
  }

  writer.bits(granule.part2_3_length, 12);
  writer.bits(granule.bigValues, 9);
  writer.bits(granule.globalGain, 8);
  writer.bits(granule.scalefacCompress, 4);
  writer.bit(granule.windowSwitching ? 1 : 0);

  if (granule.windowSwitching) {
    writer.bits(granule.blockType, 2);
    writer.bit(granule.mixedBlock ? 1 : 0);
    writer.bits(granule.tableSelect[0], 5);
    writer.bits(granule.tableSelect[1], 5);
    writer.bits(granule.subblockGain[0], 3);
    writer.bits(granule.subblockGain[1], 3);
    writer.bits(granule.subblockGain[2], 3);
    // region0_count and region1_count are implied when window switching is on,
    // so they are not transmitted.
  } else {
    writer.bits(granule.tableSelect[0], 5);
    writer.bits(granule.tableSelect[1], 5);
    writer.bits(granule.tableSelect[2], 5);
    writer.bits(granule.region0Count, 4);
    writer.bits(granule.region1Count, 3);
  }

  writer.bit(granule.preflag ? 1 : 0);
  // Stored as the multiplier (0.5 or 1.0) rather than the raw bit, because that
  // is what requantisation actually uses.
  writer.bit(granule.scalefacScale === 1 ? 1 : 0);
  writer.bit(granule.count1TableSelect);
}

/** Scalefactor band groups for MPEG-1 long blocks, and which `slen` each uses. */
const LONG_GROUPS: ReadonlyArray<readonly [number, number, 1 | 2]> = [
  [0, 6, 1],
  [6, 11, 1],
  [11, 16, 2],
  [16, 21, 2],
];

/**
 * Writes one granule's scalefactors, honouring `scfsi`.
 *
 * `scfsi` lets granule 1 inherit a band group from granule 0 rather than
 * retransmitting it. The caller decides when that is safe; this only writes what
 * it is told to.
 *
 * @returns Bits written, which the caller folds into `part2_3_length`.
 */
export function writeScalefactors(
  writer: BitWriter,
  granule: GranuleInfo,
  scalefactors: Scalefactors,
  scfsi: readonly number[],
  granuleIndex: number,
): number {
  const before = writer.bitLength;
  const slen1 = SLEN1[granule.scalefacCompress]!;
  const slen2 = SLEN2[granule.scalefacCompress]!;

  if (granule.windowSwitching && granule.blockType === 2) {
    if (granule.mixedBlock) {
      for (let band = 0; band < 8; band++) writer.bits(scalefactors.long[band]!, slen1);
      for (let band = 3; band < 6; band++) {
        for (let w = 0; w < 3; w++) writer.bits(scalefactors.short[w]![band]!, slen1);
      }
      for (let band = 6; band < 12; band++) {
        for (let w = 0; w < 3; w++) writer.bits(scalefactors.short[w]![band]!, slen2);
      }
    } else {
      for (let band = 0; band < 6; band++) {
        for (let w = 0; w < 3; w++) writer.bits(scalefactors.short[w]![band]!, slen1);
      }
      for (let band = 6; band < 12; band++) {
        for (let w = 0; w < 3; w++) writer.bits(scalefactors.short[w]![band]!, slen2);
      }
    }
  } else {
    for (let group = 0; group < 4; group++) {
      const [start, end, which] = LONG_GROUPS[group]!;
      // Granule 1 may inherit this group from granule 0.
      if (granuleIndex === 1 && scfsi[group] === 1) continue;
      const bits = which === 1 ? slen1 : slen2;
      if (bits === 0) continue;
      for (let band = start; band < end; band++) writer.bits(scalefactors.long[band]!, bits);
    }
  }

  return writer.bitLength - before;
}

/**
 * Assembles frames, managing the bit reservoir.
 *
 * Fed one frame's worth of main data at a time, in order. State is explicit so
 * the same object can drive a streaming encoder later without restructuring.
 */
export class FrameAssembler {
  readonly #params: Omit<FrameParameters, 'padding'>;

  /**
   * Header and side-information bytes per frame, with the slot size that
   * follows.
   *
   * Slot contents cannot be written when a frame is added: a frame that uses
   * less than its slot leaves the remainder to be filled by the *next* frame's
   * data, which has not been generated yet. Writing stuffing there instead would
   * overwrite the bytes a later frame's `main_data_begin` points at — which is
   * precisely the reservoir's purpose. So frames are buffered and interleaved in
   * {@link finish}.
   */
  readonly #frames: Array<{ header: Uint8Array; slot: number }> = [];

  /** Every main-data byte generated so far, in order. */
  #mainData = new Uint8Array(1 << 16);
  #mainDataLength = 0;

  /** How much slot space has been committed so far. */
  #slotOffset = 0;
  /** Running total of generated main-data bytes. */
  #dataOffset = 0;

  /** Fractional-byte accumulator driving the padding bit. */
  #paddingAccumulator = 0;
  #frameCount = 0;

  constructor(params: Omit<FrameParameters, 'padding'>) {
    this.#params = params;
  }

  get frameCount(): number {
    return this.#frameCount;
  }

  /** Bytes the reservoir currently holds for the next frame to borrow. */
  get reservoirBytes(): number {
    return Math.max(0, this.#slotOffset - this.#dataOffset);
  }

  /**
   * Bytes of main data the next frame can carry.
   *
   * The slot itself plus whatever the reservoir has banked, capped by the
   * `main_data_begin` field's reach.
   */
  nextBudgetBytes(bitrateKbps?: number): number {
    const { slot } = this.#nextGeometry(bitrateKbps);
    const banked = Math.min(this.#slotOffset - this.#dataOffset, MAX_MAIN_DATA_BEGIN);
    return slot + Math.max(0, banked);
  }

  /**
   * Frame length and slot size for the frame about to be written.
   *
   * `override` selects a different bitrate for this frame alone, which is what
   * makes variable bitrate possible: the field is per frame in the format, and
   * only the convention of never changing it makes a stream constant-bitrate.
   */
  #nextGeometry(override?: number): { frameBytes: number; slot: number; padding: boolean } {
    const { sampleRate, channels } = this.#params;
    const bitrateKbps = override ?? this.#params.bitrateKbps;

    // 1152 samples rarely occupy a whole number of bytes, so the padding bit
    // distributes the remainder across frames rather than letting it drift.
    const exact = (144 * bitrateKbps * 1000) / sampleRate;
    const base = Math.floor(exact);
    const padding = this.#paddingAccumulator + (exact - base) >= 1;

    const frameBytes = mpeg1FrameLength(bitrateKbps, sampleRate, padding);
    const header = 4 + mpeg1SideInfoSize(channels);
    return { frameBytes, slot: frameBytes - header, padding };
  }

  #growMainData(needed: number): void {
    if (this.#mainDataLength + needed <= this.#mainData.byteLength) return;
    let capacity = this.#mainData.byteLength * 2;
    while (capacity < this.#mainDataLength + needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#mainData.subarray(0, this.#mainDataLength));
    this.#mainData = next;
  }

  /**
   * Appends one frame.
   *
   * @param sideInfo Side information; `mainDataBegin` is filled in here, since
   * only the assembler knows how far the reservoir has diverged.
   * @param mainData This frame's scalefactors and Huffman data, byte-aligned.
   */
  addFrame(sideInfo: SideInfo, mainData: Uint8Array, bitrateOverride?: number): void {
    const { frameBytes, slot, padding } = this.#nextGeometry(bitrateOverride);
    const { channels, sampleRate, mode, modeExtension } = this.#params;
    const bitrateKbps = bitrateOverride ?? this.#params.bitrateKbps;

    // When frames consistently use less than their slot — a silent passage, or
    // simply an easy one — the gap between generated data and committed slots
    // grows past what the 9-bit field can express. Real encoders answer that
    // with stuffing: filler bytes appended to the stream so the look-back stays
    // in range. Decoders skip them, since anything after a granule's Huffman
    // data is ancillary.
    const overflow = this.#slotOffset - this.#dataOffset - MAX_MAIN_DATA_BEGIN;
    if (overflow > 0) {
      this.#growMainData(overflow);
      this.#mainData.fill(0, this.#mainDataLength, this.#mainDataLength + overflow);
      this.#mainDataLength += overflow;
      this.#dataOffset += overflow;
    }

    const mainDataBegin = this.#slotOffset - this.#dataOffset;

    // Validated against the frame being added, not the one before it: the data
    // has to fit in this slot plus whatever the reservoir has banked, or it has
    // nowhere to live and the next frame's look-back would go negative.
    if (mainData.byteLength > slot + mainDataBegin) {
      throw new EncodeError(
        `Bit reservoir underflow: this frame carries ${mainData.byteLength} bytes but only ` +
          `${slot + mainDataBegin} are available. Check nextBudgetBytes() before adding it.`,
      );
    }

    this.#growMainData(mainData.byteLength);
    this.#mainData.set(mainData, this.#mainDataLength);
    this.#mainDataLength += mainData.byteLength;
    this.#dataOffset += mainData.byteLength;

    const header = new BitWriter(64);
    writeFrameHeader(header, {
      bitrateKbps,
      sampleRate,
      channels,
      mode,
      modeExtension,
      padding,
    });
    writeSideInfo(header, { ...sideInfo, mainDataBegin }, channels);
    header.align();

    // Only the header is fixed now; the slot is filled in `finish`, once the
    // data that belongs in it exists.
    this.#frames.push({ header: header.finish(), slot });
    this.#slotOffset += slot;
    this.#frameCount++;

    // Advance the padding accumulator by the fractional byte this frame owed.
    const exact = (144 * bitrateKbps * 1000) / sampleRate;
    this.#paddingAccumulator += exact - Math.floor(exact);
    if (padding) this.#paddingAccumulator -= 1;

    void frameBytes;
  }

  /**
   * Finishes the stream.
   *
   * Any main data still ahead of the slots would be lost, so trailing frames are
   * emitted until the reservoir drains — otherwise the last fraction of a second
   * simply disappears.
   */
  finish(emptyFrames: (count: number) => SideInfo): Uint8Array {
    // Data still ahead of the committed slots would be lost, so add empty frames
    // until the slots catch up — otherwise the final fraction of a second simply
    // disappears.
    let guard = 0;
    while (this.#slotOffset < this.#mainDataLength && guard++ < 64) {
      this.addFrame(emptyFrames(this.#frameCount), new Uint8Array(0));
    }

    const output = new Writer(this.#slotOffset + this.#frames.length * 40);
    let position = 0;

    for (const { header, slot } of this.#frames) {
      output.write(header);

      const available = Math.max(0, this.#mainDataLength - position);
      const take = Math.min(slot, available);
      if (take > 0) output.write(this.#mainData.subarray(position, position + take));
      // Only the tail of the stream is ever stuffed, and by then no later frame
      // can be pointing into it.
      if (take < slot) output.zeros(slot - take);

      position += slot;
    }

    return output.finish();
  }
}
