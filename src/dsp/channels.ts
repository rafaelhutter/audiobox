/**
 * Channel layout conversion.
 */

import { InvalidArgumentError } from '../errors.ts';

/**
 * Downmixes to a single channel.
 *
 * Averages rather than sums, so a stereo-to-mono conversion cannot clip. The
 * naive `L + R` overflows on anything approaching full scale and is a common
 * source of distortion in "convert to mono" features.
 */
export function toMono(channels: readonly Float32Array[]): Float32Array[] {
  if (channels.length === 0) throw new InvalidArgumentError('No channels to downmix.');
  if (channels.length === 1) return [channels[0]!.slice()];

  const frames = channels[0]!.length;
  const out = new Float32Array(frames);
  const scale = 1 / channels.length;

  for (const channel of channels) {
    for (let i = 0; i < frames; i++) out[i]! += channel[i]! * scale;
  }
  return [out];
}

/** Upmixes or downmixes to exactly two channels. */
export function toStereo(channels: readonly Float32Array[]): Float32Array[] {
  if (channels.length === 0) throw new InvalidArgumentError('No channels to convert.');
  if (channels.length === 2) return [channels[0]!.slice(), channels[1]!.slice()];
  if (channels.length === 1) return [channels[0]!.slice(), channels[0]!.slice()];

  // More than two: fold everything down, then duplicate. A proper surround
  // downmix would need the channel layout, which raw sample data does not carry.
  const mono = toMono(channels)[0]!;
  return [mono, mono.slice()];
}

/**
 * Remaps channels by index.
 *
 * `mapChannels(audio, [0, 0])` duplicates the left channel to both sides;
 * `[1, 0]` swaps them.
 */
export function mapChannels(
  channels: readonly Float32Array[],
  mapping: readonly number[],
): Float32Array[] {
  return mapping.map((source) => {
    const channel = channels[source];
    if (!channel) {
      throw new InvalidArgumentError(
        `Channel ${source} does not exist; the source has ${channels.length}.`,
      );
    }
    return channel.slice();
  });
}

/**
 * Converts to `count` channels, choosing a sensible strategy.
 */
export function toChannelCount(
  channels: readonly Float32Array[],
  count: number,
): Float32Array[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidArgumentError(`Channel count must be a positive integer, got ${count}.`);
  }
  if (count === channels.length) return channels.map((c) => c.slice());
  if (count === 1) return toMono(channels);
  if (count === 2) return toStereo(channels);

  const frames = channels[0]?.length ?? 0;
  const out: Float32Array[] = [];
  for (let c = 0; c < count; c++) {
    // Cycle the available channels; silent padding would be a worse default
    // because it produces channels that appear broken.
    out.push(channels[c % channels.length]?.slice() ?? new Float32Array(frames));
  }
  return out;
}

/**
 * Applies constant-power stereo panning. `position` runs -1 (left) to 1 (right).
 */
export function pan(channels: readonly Float32Array[], position: number): Float32Array[] {
  const p = Math.max(-1, Math.min(1, position));
  const stereo = toStereo(channels);

  // Constant power: the angle sweeps 0..π/2 so left² + right² stays at 1 and
  // the centre does not sound quieter than the sides.
  const angle = ((p + 1) / 2) * (Math.PI / 2);
  const leftGain = Math.cos(angle);
  const rightGain = Math.sin(angle);

  const [l, r] = stereo as [Float32Array, Float32Array];
  for (let i = 0; i < l.length; i++) {
    l[i]! *= leftGain;
    r[i]! *= rightGain;
  }
  return stereo;
}

/** Splits into one single-channel buffer per channel. */
export function splitChannels(channels: readonly Float32Array[]): Float32Array[][] {
  return channels.map((c) => [c.slice()]);
}

/** Merges single-channel buffers into one multi-channel buffer. */
export function mergeChannels(buffers: ReadonlyArray<readonly Float32Array[]>): Float32Array[] {
  const frames = Math.max(...buffers.map((b) => b[0]?.length ?? 0), 0);
  const out: Float32Array[] = [];
  for (const buffer of buffers) {
    for (const channel of buffer) {
      if (channel.length === frames) {
        out.push(channel.slice());
      } else {
        const padded = new Float32Array(frames);
        padded.set(channel);
        out.push(padded);
      }
    }
  }
  return out;
}
