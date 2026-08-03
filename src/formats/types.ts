/** Internal contract every container decoder returns. */

import type { DecodeInfo, AudioMetadata, SampleFormat } from '../types.ts';
import type { DitherOptions } from '../pcm/convert.ts';

/** What a container decoder produces before it is wrapped in an `Audio`. */
export interface DecodedContainer {
  /** One `Float32Array` per channel, all the same length. */
  channelData: Float32Array[];
  sampleRate: number;
  info: DecodeInfo;
}

/** Options shared by the lossless container encoders. */
export interface ContainerEncodeOptions {
  /**
   * Sample storage format. Defaults to `s16` — the safest thing to hand to
   * another program, and what almost every consumer of a `.wav` expects.
   */
  sampleFormat?: SampleFormat;
  /**
   * Convenience alias for common depths: 8, 16, 24, or 32. Ignored when
   * `sampleFormat` is given explicitly. 32 selects float, matching the
   * convention of every audio editor.
   */
  bitDepth?: 8 | 16 | 24 | 32;
  /** Dither settings, applied only when quantizing to an integer format. */
  dither?: DitherOptions;
  /** Tags to embed. */
  metadata?: AudioMetadata;
}

/** Resolves the `bitDepth` shorthand into an explicit sample format. */
export function resolveSampleFormat(options?: ContainerEncodeOptions): SampleFormat {
  if (options?.sampleFormat) return options.sampleFormat;
  switch (options?.bitDepth) {
    case 8:
      return 'u8';
    case 24:
      return 's24';
    case 32:
      return 'f32';
    case 16:
    default:
      return 's16';
  }
}
