/**
 * UTF-8 encoding and decoding.
 *
 * `TextEncoder`/`TextDecoder` exist in every runtime this library targets, but
 * using them would mean either compiling core against the DOM type library —
 * which would let browser-only APIs slip in unnoticed — or shipping ambient
 * global declarations that clash with a consumer's own lib settings. Metadata
 * strings are the only place text conversion is needed, and the amount of code
 * required is small enough that owning it is cheaper than either workaround.
 *
 * Decoding is deliberately lenient: malformed sequences become U+FFFD rather
 * than throwing. Tags come from arbitrary files, and a bad byte in a comment
 * field must never stop the audio from decoding.
 */

/** Encodes a string as UTF-8. */
export function encodeUtf8(text: string): Uint8Array {
  // Worst case is 3 bytes per UTF-16 code unit; surrogate pairs produce 4 bytes
  // from 2 units, so this bound always holds.
  const out = new Uint8Array(text.length * 3);
  let length = 0;

  for (let i = 0; i < text.length; i++) {
    let codePoint = text.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }

    if (codePoint < 0x80) {
      out[length++] = codePoint;
    } else if (codePoint < 0x800) {
      out[length++] = 0xc0 | (codePoint >> 6);
      out[length++] = 0x80 | (codePoint & 0x3f);
    } else if (codePoint < 0x10000) {
      out[length++] = 0xe0 | (codePoint >> 12);
      out[length++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[length++] = 0x80 | (codePoint & 0x3f);
    } else {
      out[length++] = 0xf0 | (codePoint >> 18);
      out[length++] = 0x80 | ((codePoint >> 12) & 0x3f);
      out[length++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[length++] = 0x80 | (codePoint & 0x3f);
    }
  }

  return out.subarray(0, length);
}

/** Decodes UTF-8, substituting U+FFFD for malformed sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.byteLength;

  while (i < n) {
    const b0 = bytes[i]!;

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    }

    let codePoint: number;
    let needed: number;

    if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f;
      needed = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f;
      needed = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07;
      needed = 3;
    } else {
      out += '\ufffd';
      i++;
      continue;
    }

    // The continuation bytes must all be present.
    if (i + needed >= n) {
      out += '\ufffd';
      i++;
      continue;
    }

    let valid = true;
    for (let k = 1; k <= needed; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (b & 0x3f);
    }

    if (!valid || codePoint > 0x10ffff) {
      out += '\ufffd';
      i++;
      continue;
    }

    if (codePoint >= 0x10000) {
      codePoint -= 0x10000;
      out += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    } else {
      out += String.fromCharCode(codePoint);
    }
    i += needed + 1;
  }

  return out;
}

/** Decodes Latin-1, which is what RIFF INFO and ID3v1 fields actually contain. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}
