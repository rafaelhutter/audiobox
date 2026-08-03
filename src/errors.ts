/**
 * Every error thrown by audiobox is an instance of {@link AudioboxError}, so a
 * single `catch` can distinguish "this file is bad" from "my code is bad".
 *
 * Each error carries a stable machine-readable {@link AudioboxError.code}. Match on
 * the code, never on the message — messages are free to change in a patch release.
 */

import type { AbortSignalLike } from './types.ts';

/** Stable, machine-readable discriminator for every error this library throws. */
export type ErrorCode =
  /** The bytes are not a format audiobox recognises. */
  | 'UNSUPPORTED_FORMAT'
  /** The container was recognised but is malformed, truncated, or self-contradictory. */
  | 'DECODE_ERROR'
  /** The encoder was asked for something it cannot represent. */
  | 'ENCODE_ERROR'
  /** A caller-supplied argument is out of range or internally inconsistent. */
  | 'INVALID_ARGUMENT'
  /** Input would exceed a configured safety limit. See `limits.ts`. */
  | 'LIMIT_EXCEEDED'
  /** The operation was cancelled through an `AbortSignal`. */
  | 'ABORTED'
  /** The host runtime lacks an API this code path requires. */
  | 'UNSUPPORTED_RUNTIME';

/** Base class for every error thrown by audiobox. */
export class AudioboxError extends Error {
  /** Stable discriminator. Branch on this rather than on `message`. */
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.code = code;
    this.name = new.target.name;
    // Keeps `instanceof` working when the output is down-levelled to ES5 by a
    // consumer's bundler, which is otherwise a classic subclassed-Error trap.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The input does not match any format audiobox can read. */
export class UnsupportedFormatError extends AudioboxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('UNSUPPORTED_FORMAT', message, options);
  }
}

/**
 * The container was identified but could not be read: truncated data, a chunk
 * size that overruns the file, a reserved bit pattern, and so on.
 */
export class DecodeError extends AudioboxError {
  /** Byte offset where the problem was detected, when known. */
  readonly offset: number | undefined;

  constructor(message: string, options?: { cause?: unknown; offset?: number }) {
    super('DECODE_ERROR', message, options);
    this.offset = options?.offset;
  }
}

/** The encoder cannot represent what it was asked to produce. */
export class EncodeError extends AudioboxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ENCODE_ERROR', message, options);
  }
}

/** A caller-supplied argument is invalid. This one means the bug is in calling code. */
export class InvalidArgumentError extends AudioboxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INVALID_ARGUMENT', message, options);
  }
}

/**
 * Input would exceed a configured safety limit.
 *
 * This is the guard that stops a hostile 40-byte header from asking for a 40 GB
 * allocation. Raise the relevant limit deliberately if you trust the source.
 */
export class LimitExceededError extends AudioboxError {
  /** Which limit tripped, e.g. `'maxDecodedBytes'`. */
  readonly limit: string;
  /** The configured ceiling. */
  readonly allowed: number;
  /** What the input asked for. */
  readonly requested: number;

  constructor(limit: string, requested: number, allowed: number) {
    super(
      'LIMIT_EXCEEDED',
      `Input exceeds the ${limit} limit: requested ${requested}, limit is ${allowed}. ` +
        `Raise it via the \`limits\` option if you trust this input.`,
    );
    this.limit = limit;
    this.allowed = allowed;
    this.requested = requested;
  }
}

/** The operation was cancelled via an `AbortSignal`. */
export class AbortedError extends AudioboxError {
  constructor(message = 'Operation was aborted.') {
    super('ABORTED', message);
  }
}

/** The current runtime is missing an API that this code path needs. */
export class UnsupportedRuntimeError extends AudioboxError {
  constructor(message: string) {
    super('UNSUPPORTED_RUNTIME', message);
  }
}

/** Throws {@link AbortedError} if `signal` is already aborted. */
export function throwIfAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted) {
    throw new AbortedError();
  }
}
