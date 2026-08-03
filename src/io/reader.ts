/**
 * A bounds-checked byte cursor.
 *
 * Every format parser in this library reads through this class and never touches
 * a raw `DataView` offset. That is deliberate: an unchecked read past the end of
 * a buffer is the single most common vulnerability class in media parsers, and
 * the only reliable way to avoid it is to make the unchecked path unavailable.
 *
 * `DataView` does throw `RangeError` on overrun by itself, but the message tells
 * a caller nothing about which file failed or where. Routing through `ensure()`
 * turns every overrun into a {@link DecodeError} carrying a byte offset.
 */

import { DecodeError } from '../errors.ts';

export class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private pos = 0;

  constructor(source: Uint8Array | ArrayBuffer) {
    this.bytes =
      source instanceof Uint8Array ? source : new Uint8Array(source);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }

  /** Total bytes available. */
  get length(): number {
    return this.bytes.byteLength;
  }

  /** Current read position. */
  get offset(): number {
    return this.pos;
  }

  /** Bytes between the cursor and the end. */
  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  /** True when at least `n` bytes remain. Never throws — use to branch, not to guard. */
  has(n: number): boolean {
    return n >= 0 && this.remaining >= n;
  }

  /**
   * Asserts `n` readable bytes remain. Every read in this class calls it first.
   *
   * @throws {DecodeError} when the buffer would be overrun.
   */
  ensure(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.byteLength) {
      throw new DecodeError(
        `Unexpected end of data: needed ${n} byte(s) at offset ${this.pos}, ` +
          `but only ${this.remaining} remain.`,
        { offset: this.pos },
      );
    }
  }

  /** Moves the cursor to an absolute position. */
  seek(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.bytes.byteLength) {
      throw new DecodeError(
        `Seek target ${offset} is outside the buffer (length ${this.bytes.byteLength}).`,
        { offset: this.pos },
      );
    }
    this.pos = offset;
  }

  /** Advances the cursor by `n` bytes. */
  skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  /**
   * Returns the next `n` bytes as a zero-copy view into the same memory.
   *
   * Zero-copy is what keeps large-file handling cheap, but it means the result
   * aliases the caller's buffer. Use {@link copy} when the bytes must outlive or
   * be mutated independently of the source.
   */
  bytesView(n: number): Uint8Array {
    this.ensure(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Returns the next `n` bytes as a fresh, independent copy. */
  copy(n: number): Uint8Array {
    return this.bytesView(n).slice();
  }

  /** Reads `n` bytes as Latin-1 text. Used for chunk tags and format identifiers. */
  ascii(n: number): string {
    this.ensure(n);
    let s = '';
    const end = this.pos + n;
    for (let i = this.pos; i < end; i++) {
      s += String.fromCharCode(this.bytes[i]!);
    }
    this.pos = end;
    return s;
  }

  /**
   * Reads a 4-byte chunk identifier without moving the cursor past it in a way
   * that hides mismatches — the cursor advances by exactly 4.
   */
  fourCC(): string {
    return this.ascii(4);
  }

  /** Peeks a 4-byte identifier without moving the cursor. */
  peekFourCC(): string {
    this.ensure(4);
    const p = this.pos;
    const s =
      String.fromCharCode(this.bytes[p]!) +
      String.fromCharCode(this.bytes[p + 1]!) +
      String.fromCharCode(this.bytes[p + 2]!) +
      String.fromCharCode(this.bytes[p + 3]!);
    return s;
  }

  /** Peeks a single byte at `delta` from the cursor without moving it. */
  peekU8(delta = 0): number {
    this.ensure(delta + 1);
    return this.bytes[this.pos + delta]!;
  }

  u8(): number {
    this.ensure(1);
    return this.bytes[this.pos++]!;
  }

  i8(): number {
    this.ensure(1);
    return this.view.getInt8(this.pos++);
  }

  u16(littleEndian: boolean): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, littleEndian);
    this.pos += 2;
    return v;
  }

  i16(littleEndian: boolean): number {
    this.ensure(2);
    const v = this.view.getInt16(this.pos, littleEndian);
    this.pos += 2;
    return v;
  }

  /** Reads a 24-bit unsigned integer. Common in WAV; absent from `DataView`. */
  u24(littleEndian: boolean): number {
    this.ensure(3);
    const p = this.pos;
    const a = this.bytes[p]!;
    const b = this.bytes[p + 1]!;
    const c = this.bytes[p + 2]!;
    this.pos += 3;
    return littleEndian ? a | (b << 8) | (c << 16) : (a << 16) | (b << 8) | c;
  }

  /** Reads a 24-bit signed integer, sign-extended to a JS number. */
  i24(littleEndian: boolean): number {
    const v = this.u24(littleEndian);
    return v & 0x800000 ? v - 0x1000000 : v;
  }

  u32(littleEndian: boolean): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, littleEndian);
    this.pos += 4;
    return v;
  }

  i32(littleEndian: boolean): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, littleEndian);
    this.pos += 4;
    return v;
  }

  /**
   * Reads a 64-bit unsigned integer as a JS number.
   *
   * Values above `Number.MAX_SAFE_INTEGER` are rejected rather than silently
   * rounded. RF64 and W64 use 64-bit sizes, and a quietly-truncated size is a
   * bounds check that passes when it should not.
   */
  u64(littleEndian: boolean): number {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, littleEndian);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DecodeError(
        `64-bit value ${v} at offset ${this.pos - 8} exceeds the safe integer range.`,
        { offset: this.pos - 8 },
      );
    }
    return Number(v);
  }

  f32(littleEndian: boolean): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.pos, littleEndian);
    this.pos += 4;
    return v;
  }

  f64(littleEndian: boolean): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.pos, littleEndian);
    this.pos += 8;
    return v;
  }

  /**
   * Reads an 80-bit IEEE 754 extended-precision float.
   *
   * AIFF stores its sample rate this way and nothing else in modern computing
   * does, so this exists solely for that field.
   */
  f80(): number {
    this.ensure(10);
    const p = this.pos;
    const b = this.bytes;
    const sign = b[p]! & 0x80 ? -1 : 1;
    const exponent = ((b[p]! & 0x7f) << 8) | b[p + 1]!;

    let mantissa = 0;
    for (let i = 0; i < 8; i++) {
      mantissa = mantissa * 256 + b[p + 2 + i]!;
    }
    this.pos += 10;

    if (exponent === 0 && mantissa === 0) return 0;
    if (exponent === 0x7fff) {
      return mantissa === 0 ? sign * Infinity : NaN;
    }
    // The 80-bit format stores an explicit integer bit, so the mantissa is
    // scaled by 2^63 rather than the 2^52 an implicit-bit format would use.
    return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
  }

  /**
   * Aligns the cursor to an even offset, as RIFF and IFF chunk padding requires.
   * Tolerates a missing final pad byte, which real-world files often omit.
   */
  align2(): void {
    if (this.pos & 1 && this.remaining > 0) {
      this.pos++;
    }
  }

  /** Returns a reader scoped to the next `n` bytes and advances past them. */
  subReader(n: number): Reader {
    return new Reader(this.bytesView(n));
  }
}
