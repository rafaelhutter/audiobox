/**
 * A growable byte sink.
 *
 * Encoders rarely know their exact output size up front — a WAV header is fixed
 * but a VBR MP3 frame is not — so this grows geometrically and hands back a
 * single exact-length `Uint8Array` at the end.
 *
 * Growth doubles rather than incrementing, which keeps the amortised cost of an
 * append at O(1); the naive "allocate exactly what's needed each time" pattern is
 * quadratic and is the reason several JS encoders are slower than they look.
 */

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 8192) {
    const cap = Math.max(16, initialCapacity | 0);
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer);
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.len;
  }

  private grow(needed: number): void {
    if (this.len + needed <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  /**
   * Reserves `n` bytes at the current position and returns their offset.
   *
   * Used for fields that can only be filled in later — a RIFF chunk size is not
   * known until its contents have been written. Pair with {@link patchU32}.
   */
  reserve(n: number): number {
    this.grow(n);
    const at = this.len;
    this.len += n;
    return at;
  }

  /** Overwrites a previously reserved 32-bit slot. */
  patchU32(offset: number, value: number, littleEndian: boolean): void {
    if (offset < 0 || offset + 4 > this.len) {
      throw new RangeError(`patchU32 offset ${offset} is outside the written region.`);
    }
    this.view.setUint32(offset, value >>> 0, littleEndian);
  }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
  }

  i8(v: number): void {
    this.grow(1);
    this.view.setInt8(this.len++, v);
  }

  u16(v: number, littleEndian: boolean): void {
    this.grow(2);
    this.view.setUint16(this.len, v & 0xffff, littleEndian);
    this.len += 2;
  }

  i16(v: number, littleEndian: boolean): void {
    this.grow(2);
    this.view.setInt16(this.len, v, littleEndian);
    this.len += 2;
  }

  u24(v: number, littleEndian: boolean): void {
    this.grow(3);
    const a = v & 0xff;
    const b = (v >>> 8) & 0xff;
    const c = (v >>> 16) & 0xff;
    if (littleEndian) {
      this.buf[this.len++] = a;
      this.buf[this.len++] = b;
      this.buf[this.len++] = c;
    } else {
      this.buf[this.len++] = c;
      this.buf[this.len++] = b;
      this.buf[this.len++] = a;
    }
  }

  u32(v: number, littleEndian: boolean): void {
    this.grow(4);
    this.view.setUint32(this.len, v >>> 0, littleEndian);
    this.len += 4;
  }

  i32(v: number, littleEndian: boolean): void {
    this.grow(4);
    this.view.setInt32(this.len, v, littleEndian);
    this.len += 4;
  }

  u64(v: number, littleEndian: boolean): void {
    this.grow(8);
    this.view.setBigUint64(this.len, BigInt(Math.max(0, Math.trunc(v))), littleEndian);
    this.len += 8;
  }

  f32(v: number, littleEndian: boolean): void {
    this.grow(4);
    this.view.setFloat32(this.len, v, littleEndian);
    this.len += 4;
  }

  f64(v: number, littleEndian: boolean): void {
    this.grow(8);
    this.view.setFloat64(this.len, v, littleEndian);
    this.len += 8;
  }

  /** Writes an 80-bit IEEE 754 extended float. AIFF sample rates only. */
  f80(value: number): void {
    this.grow(10);
    const out = new Uint8Array(10);

    if (value !== 0 && Number.isFinite(value)) {
      const sign = value < 0 ? 0x8000 : 0;
      const abs = Math.abs(value);
      let exponent = Math.floor(Math.log2(abs));
      let mantissa = abs / Math.pow(2, exponent);
      // Guard against log2 landing a hair on the wrong side of a power of two.
      if (mantissa >= 2) {
        mantissa /= 2;
        exponent += 1;
      } else if (mantissa < 1) {
        mantissa *= 2;
        exponent -= 1;
      }
      const biased = exponent + 16383;
      out[0] = (sign | (biased >> 8)) & 0xff;
      out[1] = biased & 0xff;

      // 64 explicit mantissa bits, high word first.
      let frac = mantissa * Math.pow(2, 63);
      for (let i = 9; i >= 2; i--) {
        out[i] = frac % 256 | 0;
        frac = Math.floor(frac / 256);
      }
    }

    this.buf.set(out, this.len);
    this.len += 10;
  }

  /** Writes a string as Latin-1, optionally padded with spaces to a fixed width. */
  ascii(s: string, padTo?: number): void {
    const n = padTo ?? s.length;
    this.grow(n);
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = i < s.length ? s.charCodeAt(i) & 0xff : 0x20;
    }
  }

  /** Appends raw bytes. */
  write(data: Uint8Array): void {
    this.grow(data.byteLength);
    this.buf.set(data, this.len);
    this.len += data.byteLength;
  }

  /** Appends `n` zero bytes. */
  zeros(n: number): void {
    this.grow(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
  }

  /** Writes a single pad byte if the length is odd, as RIFF and IFF require. */
  align2(): void {
    if (this.len & 1) this.u8(0);
  }

  /** Returns an exact-length copy of everything written. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
