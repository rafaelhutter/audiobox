/**
 * Checksums required by the FLAC bitstream.
 *
 * FLAC is unusually thorough about integrity: every frame header carries a
 * CRC-8, every frame a CRC-16, and STREAMINFO holds an MD5 of the *unencoded*
 * samples. That last one is why `flac -t` can prove a file decodes back to
 * exactly what went in — a guarantee worth preserving, so audiobox computes it
 * rather than writing the all-zero "not computed" placeholder the spec permits.
 */

/** CRC-8 with polynomial x^8 + x^2 + x + 1 (0x07), used for frame headers. */
const CRC8_TABLE = new Uint8Array(256);
/** CRC-16 with polynomial x^16 + x^15 + x^2 + 1 (0x8005), used for frames. */
const CRC16_TABLE = new Uint16Array(256);

(function buildTables(): void {
  for (let i = 0; i < 256; i++) {
    let crc8 = i;
    for (let bit = 0; bit < 8; bit++) {
      crc8 = crc8 & 0x80 ? ((crc8 << 1) ^ 0x07) & 0xff : (crc8 << 1) & 0xff;
    }
    CRC8_TABLE[i] = crc8;

    let crc16 = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc16 = crc16 & 0x8000 ? ((crc16 << 1) ^ 0x8005) & 0xffff : (crc16 << 1) & 0xffff;
    }
    CRC16_TABLE[i] = crc16;
  }
})();

export function crc8(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8_TABLE[crc ^ data[i]!]!;
  return crc;
}

export function crc16(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]!) & 0xff]!) & 0xffff;
  }
  return crc;
}

// --- MD5 --------------------------------------------------------------------
//
// Implemented here rather than reached for from a runtime API because neither
// `node:crypto` nor WebCrypto is available in every target this library
// supports, and WebCrypto's digest is async — which would make an otherwise
// synchronous encoder async purely for a checksum.
//
// This is a data-integrity checksum inside a file format, not a security
// primitive. MD5's collision weaknesses are irrelevant to that use, and the
// FLAC specification mandates exactly this algorithm.

const MD5_S = new Int32Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

/** Streaming MD5, so the encoder can hash samples as it writes frames. */
export class Md5 {
  #a = 0x67452301;
  #b = 0xefcdab89;
  #c = 0x98badcfe;
  #d = 0x10325476;
  #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #totalLength = 0;

  update(data: Uint8Array): void {
    this.#totalLength += data.byteLength;
    let offset = 0;

    if (this.#bufferLength > 0) {
      const need = 64 - this.#bufferLength;
      const take = Math.min(need, data.byteLength);
      this.#buffer.set(data.subarray(0, take), this.#bufferLength);
      this.#bufferLength += take;
      offset = take;
      if (this.#bufferLength === 64) {
        this.#process(this.#buffer, 0);
        this.#bufferLength = 0;
      }
    }

    while (offset + 64 <= data.byteLength) {
      this.#process(data, offset);
      offset += 64;
    }

    if (offset < data.byteLength) {
      this.#buffer.set(data.subarray(offset), 0);
      this.#bufferLength = data.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.#totalLength * 8;
    const padLength = this.#bufferLength < 56 ? 56 - this.#bufferLength : 120 - this.#bufferLength;
    const tail = new Uint8Array(padLength + 8);
    tail[0] = 0x80;

    // Length is little-endian, 64-bit. Split to stay inside 32-bit ops.
    const view = new DataView(tail.buffer);
    view.setUint32(padLength, bitLength >>> 0, true);
    view.setUint32(padLength + 4, Math.floor(bitLength / 4294967296), true);
    this.update(tail);

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, this.#a >>> 0, true);
    outView.setUint32(4, this.#b >>> 0, true);
    outView.setUint32(8, this.#c >>> 0, true);
    outView.setUint32(12, this.#d >>> 0, true);
    return out;
  }

  #process(block: Uint8Array, offset: number): void {
    const m = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      m[i] = block[p]! | (block[p + 1]! << 8) | (block[p + 2]! << 16) | (block[p + 3]! << 24);
    }

    let a = this.#a;
    let b = this.#b;
    let c = this.#c;
    let d = this.#d;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i]! + m[g]!) | 0;
      const shift = MD5_S[i]!;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = temp;
    }

    this.#a = (this.#a + a) | 0;
    this.#b = (this.#b + b) | 0;
    this.#c = (this.#c + c) | 0;
    this.#d = (this.#d + d) | 0;
  }
}
