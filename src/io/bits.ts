/**
 * MSB-first bit-level I/O.
 *
 * MP3 and FLAC are bitstream formats: fields are not byte-aligned and Huffman
 * codes are read one bit at a time. Both read most-significant-bit first, so
 * that is the only order implemented here.
 *
 * {@link BitReader} is on the hot path of MP3 decoding — it is called millions of
 * times for a single track — so it keeps a small integer cache instead of
 * recomputing byte/bit offsets per call, and it reads past-the-end as zero bits
 * rather than throwing. That last choice is deliberate: Layer III's bit
 * reservoir legitimately lets a frame's Huffman data run slightly past the
 * declared part2_3_length, and real encoders emit files that rely on it. Callers
 * detect overrun via {@link BitReader.overran} once a granule is finished, rather
 * than failing mid-symbol on a file every other decoder plays.
 */

export class BitReader {
  private readonly data: Uint8Array;
  private bytePos: number;
  private bitPos = 0;
  private readonly end: number;
  private didOverrun = false;

  constructor(data: Uint8Array, startByte = 0) {
    this.data = data;
    this.bytePos = startByte;
    this.end = data.byteLength;
  }

  /** True if any read has gone past the end of the buffer. */
  get overran(): boolean {
    return this.didOverrun;
  }

  /** Total bits consumed since construction. */
  get bitsRead(): number {
    return this.bytePos * 8 + this.bitPos;
  }

  /** Bits remaining before the end of the buffer. */
  get bitsRemaining(): number {
    return Math.max(0, this.end * 8 - this.bitsRead);
  }

  /** Reads a single bit. Returns 0 past the end. */
  bit(): number {
    if (this.bytePos >= this.end) {
      this.didOverrun = true;
      return 0;
    }
    const v = (this.data[this.bytePos]! >> (7 - this.bitPos)) & 1;
    if (++this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return v;
  }

  /**
   * Reads `n` bits (0–32) as an unsigned integer.
   *
   * `n` above 25 is handled in two steps because a JS bitwise shift operates on
   * 32-bit signed values — accumulating 32 bits in one `<<` chain would flip the
   * sign and silently corrupt the result.
   */
  bits(n: number): number {
    if (n === 0) return 0;
    if (n > 25) {
      const high = this.bits(n - 16);
      const low = this.bits(16);
      return high * 65536 + low;
    }

    let v = 0;
    let need = n;
    while (need > 0) {
      if (this.bytePos >= this.end) {
        this.didOverrun = true;
        return (v << need) >>> 0;
      }
      const avail = 8 - this.bitPos;
      const take = Math.min(avail, need);
      const cur = this.data[this.bytePos]!;
      const shift = avail - take;
      const mask = (1 << take) - 1;
      v = (v << take) | ((cur >> shift) & mask);
      this.bitPos += take;
      need -= take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return v >>> 0;
  }

  /** Reads `n` bits as a two's-complement signed integer. */
  signedBits(n: number): number {
    const v = this.bits(n);
    const signBit = 1 << (n - 1);
    return v & signBit ? v - (1 << n) : v;
  }

  /** Peeks `n` bits without consuming them. */
  peek(n: number): number {
    const byte = this.bytePos;
    const bit = this.bitPos;
    const over = this.didOverrun;
    const v = this.bits(n);
    this.bytePos = byte;
    this.bitPos = bit;
    this.didOverrun = over;
    return v;
  }

  /** Skips `n` bits. */
  skip(n: number): void {
    const total = this.bitsRead + n;
    if (total > this.end * 8) this.didOverrun = true;
    this.bytePos = Math.min(this.end, total >>> 3);
    this.bitPos = this.bytePos === this.end ? 0 : total & 7;
  }

  /** Moves to an absolute bit position. */
  seekBits(bitOffset: number): void {
    this.bytePos = bitOffset >>> 3;
    this.bitPos = bitOffset & 7;
    if (this.bytePos > this.end) {
      this.bytePos = this.end;
      this.bitPos = 0;
      this.didOverrun = true;
    }
  }

  /** Advances to the next byte boundary. */
  align(): void {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }

  /**
   * Reads a unary-coded value: the count of zero bits before the next one bit.
   *
   * FLAC's Rice coding is built on this. `limit` bounds the scan so a corrupt
   * stream of zeros cannot spin forever — returning -1 signals "no terminator
   * found", which the caller must treat as a decode error.
   */
  unary(limit = 1 << 20): number {
    let count = 0;
    while (count < limit) {
      if (this.bytePos >= this.end) {
        this.didOverrun = true;
        return -1;
      }
      if (this.bit() === 1) return count;
      count++;
    }
    return -1;
  }
}

/** MSB-first bit sink. Used by the MP3 and FLAC encoders. */
export class BitWriter {
  private buf: Uint8Array;
  private len = 0;
  private acc = 0;
  private accBits = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity | 0));
  }

  /** Bytes written, including the partial byte currently being assembled. */
  get length(): number {
    return this.len + (this.accBits > 0 ? 1 : 0);
  }

  /** Total bits written. */
  get bitLength(): number {
    return this.len * 8 + this.accBits;
  }

  private grow(needed: number): void {
    if (this.len + needed <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Writes the low `n` bits of `value`, most-significant first. */
  bits(value: number, n: number): void {
    if (n <= 0) return;
    if (n > 24) {
      // Same 32-bit-shift hazard as BitReader.bits — split to stay in range.
      this.bits(Math.floor(value / 65536), n - 16);
      this.bits(value & 0xffff, 16);
      return;
    }

    this.acc = ((this.acc << n) | (value & ((1 << n) - 1))) >>> 0;
    this.accBits += n;
    while (this.accBits >= 8) {
      this.grow(1);
      this.accBits -= 8;
      this.buf[this.len++] = (this.acc >>> this.accBits) & 0xff;
    }
    this.acc &= (1 << this.accBits) - 1;
  }

  bit(value: number): void {
    this.bits(value & 1, 1);
  }

  /** Pads with zero bits to the next byte boundary. */
  align(): void {
    if (this.accBits > 0) {
      this.bits(0, 8 - this.accBits);
    }
  }

  /** Appends whole bytes. Requires byte alignment. */
  writeBytes(data: Uint8Array): void {
    if (this.accBits !== 0) {
      throw new Error('BitWriter.writeBytes requires byte alignment; call align() first.');
    }
    this.grow(data.byteLength);
    this.buf.set(data, this.len);
    this.len += data.byteLength;
  }

  /** Flushes any partial byte and returns an exact-length copy. */
  finish(): Uint8Array {
    this.align();
    return this.buf.slice(0, this.len);
  }

  /**
   * Discards everything written and reuses the buffer.
   *
   * For callers that emit many independent blocks — one per MP3 frame, say — and
   * would otherwise allocate a writer and let it grow again for each one.
   */
  reset(): void {
    this.len = 0;
    this.acc = 0;
    this.accBits = 0;
  }
}
