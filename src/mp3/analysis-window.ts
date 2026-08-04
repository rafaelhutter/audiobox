/**
 * Layer III analysis filterbank window, `C[512]`, in this codebase's tap order.
 *
 * GENERATED — regenerate with scripts/solve-analysis-window.mjs.
 *
 * Derived, not transcribed. `C` and the synthesis window `D` share a prototype
 * filter, so every magnitude here is `|D[(i + 64) mod 512]| / 32` and is rebuilt
 * at load rather than shipped: 512 floats would be 2.8 kB of data already in the
 * bundle, and two copies of the same numbers can drift apart.
 *
 * The signs are the part that is not derivable. `C = D/32` — same signs as the
 * synthesis window — reconstructs at only ~41 dB, and 28 of the 512 taps turn
 * out to need the opposite sign. They are solved by least squares against
 * perfect reconstruction and refined by coordinate descent, so no external
 * reference is involved; 64 bytes of mask carry the result.
 *
 * Those 28 signs are worth 31 dB to an independent decoder. Encoding with the
 * plain derived window and letting ffmpeg decode scores 41.8 dB against the
 * source; with these signs it scores 73.1 dB. Our own round trip barely notices
 * the difference, which is exactly why the sign convention has to be solved and
 * checked against something other than ourselves.
 *
 * Reconstruction through analysis → our own synthesis: 54.2 dB at a delay of
 * 545 samples. That figure is capped by the synthesis window, not this one.
 */

import { SYNTH_WINDOW } from './tables.ts';

/** Which of the 512 taps are negative, one bit each, least-significant first. */
const SIGN_MASK = new Uint32Array([
  0xffffd5fe, 0xfffefffd, 0xffc00000, 0xffffffff, 0xffff0000, 0xffffffff, 0xfffffe00, 0xffffffff,
  0x00000000, 0xff000000, 0x00000000, 0xffff0000, 0x00000000, 0xfffefe00, 0x00000000, 0xc8010000,
]);

/** Analysis window `C[512]`: synthesis magnitudes, solved signs. */
export const ANALYSIS_WINDOW = (() => {
  const window = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const magnitude = Math.abs(SYNTH_WINDOW[(i + 64) % 512]!) / 32;
    const negative = (SIGN_MASK[i >> 5]! >>> (i & 31)) & 1;
    window[i] = negative ? -magnitude : magnitude;
  }
  return window;
})();

/** Combined analysis + synthesis group delay, in samples. */
export const FILTERBANK_DELAY = 545;
