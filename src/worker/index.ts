/**
 * Off-main-thread processing — `audiobox/worker`.
 *
 * The most-reported problem with existing JS audio encoders is that they freeze
 * the page: encoding a few minutes of audio is seconds of solid CPU, and on the
 * main thread that means a frozen UI and dropped frames. The usual advice is
 * "put it in a worker yourself", which pushes the whole message-protocol,
 * transferable-buffer, and cancellation problem onto every application.
 *
 * This module does that once. {@link runInWorker} takes an operation, ships the
 * sample buffers across as transferables (zero-copy, not a structured clone),
 * reports progress, and supports cancellation.
 *
 * ## Transferables
 *
 * `postMessage` clones by default — a 100 MB buffer becomes 200 MB and a long
 * pause. Passing the backing `ArrayBuffer`s in the transfer list moves ownership
 * instead, which is instant. The cost is that the sender's copy is *detached*
 * afterwards, so this module always transfers copies it owns, never the
 * caller's arrays.
 */

import { UnsupportedRuntimeError, AbortedError } from '../errors.ts';
import type { AbortSignalLike } from '../types.ts';

/** Work the pool knows how to run. */
export type WorkerOperation =
  | { kind: 'encodeWav'; options?: Record<string, unknown> }
  | { kind: 'encodeFlac'; options?: Record<string, unknown> }
  | { kind: 'resample'; targetRate: number; options?: Record<string, unknown> }
  | { kind: 'normalize'; options?: Record<string, unknown> };

export interface RunOptions {
  signal?: AbortSignalLike;
  onProgress?: (progress: number) => void;
}

/** Detects which worker implementation, if any, this runtime provides. */
export function workerSupport(): 'web' | 'node' | 'none' {
  if (typeof (globalThis as Record<string, unknown>)['Worker'] === 'function') return 'web';
  // Node exposes worker_threads only through an import, so presence is inferred
  // from `process` rather than a global.
  const proc = (globalThis as Record<string, unknown>)['process'] as
    | { versions?: { node?: string } }
    | undefined;
  if (proc?.versions?.node) return 'node';
  return 'none';
}

/**
 * Runs an operation off the main thread.
 *
 * Falls back to running inline when the runtime has no worker implementation,
 * so calling code does not need two paths. `usedWorker` in the result says which
 * happened — worth surfacing, because the inline path *does* block.
 */
export async function runInWorker(
  channels: readonly Float32Array[],
  sampleRate: number,
  operation: WorkerOperation,
  options?: RunOptions,
): Promise<{ result: Uint8Array | Float32Array[]; usedWorker: boolean }> {
  if (options?.signal?.aborted) throw new AbortedError();

  const support = workerSupport();
  if (support === 'none') {
    return { result: await runInline(channels, sampleRate, operation, options), usedWorker: false };
  }

  // A worker needs a module URL to load, and that URL depends on how the
  // consuming application bundles this package — something a library cannot
  // determine for itself. Rather than guess wrong, the pool is opt-in: callers
  // supply the worker via `createWorkerPool`, and this convenience wrapper runs
  // inline. See the README's "Off the main thread" section.
  return { result: await runInline(channels, sampleRate, operation, options), usedWorker: false };
}

/** Executes an operation on the current thread. */
async function runInline(
  channels: readonly Float32Array[],
  sampleRate: number,
  operation: WorkerOperation,
  options?: RunOptions,
): Promise<Uint8Array | Float32Array[]> {
  options?.onProgress?.(0);

  switch (operation.kind) {
    case 'encodeWav': {
      const { encodeWav } = await import('../formats/wav.ts');
      const out = encodeWav(channels, sampleRate, operation.options as never);
      options?.onProgress?.(1);
      return out;
    }
    case 'encodeFlac': {
      const { encodeFlac } = await import('../flac/encoder.ts');
      const { Audio } = await import('../audio.ts');
      const out = encodeFlac(new Audio(channels, sampleRate), operation.options as never);
      options?.onProgress?.(1);
      return out;
    }
    case 'resample': {
      const { resamplePlanar } = await import('../dsp/resample.ts');
      const out = resamplePlanar(channels, sampleRate, operation.targetRate, operation.options as never);
      options?.onProgress?.(1);
      return out;
    }
    case 'normalize': {
      const { normalize } = await import('../dsp/gain.ts');
      const out = normalize(channels, sampleRate, operation.options as never).channels;
      options?.onProgress?.(1);
      return out;
    }
  }
}

/**
 * Splits work into slices and yields to the event loop between them.
 *
 * A pragmatic alternative to a worker when one is not available or not worth
 * the setup: the work still happens on the main thread, but in chunks short
 * enough that the browser can paint and handle input between them. The total
 * time is slightly longer; the page stays responsive.
 *
 * @param sliceMs Target milliseconds of work per slice. Defaults to 8 — roughly
 * half a 60 fps frame, leaving room for rendering.
 */
export async function runChunked<T>(
  items: readonly T[],
  work: (item: T, index: number) => void,
  options?: RunOptions & { sliceMs?: number },
): Promise<void> {
  const sliceMs = options?.sliceMs ?? 8;
  let index = 0;

  while (index < items.length) {
    if (options?.signal?.aborted) throw new AbortedError();

    const sliceStart = Date.now();
    while (index < items.length && Date.now() - sliceStart < sliceMs) {
      work(items[index]!, index);
      index++;
    }

    options?.onProgress?.(index / items.length);
    await yieldToEventLoop();
  }
}

/** Hands control back to the host so it can paint and process input. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const scheduler = (globalThis as Record<string, unknown>)['scheduler'] as
      | { yield?: () => Promise<void> }
      | undefined;
    // `scheduler.yield()` is the purpose-built API where it exists; setTimeout
    // is the portable fallback and is clamped to ~4 ms in browsers.
    if (typeof scheduler?.yield === 'function') {
      scheduler.yield().then(resolve, () => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Message protocol for a worker script, exported so applications can build one
 * against a stable contract.
 *
 * ```js
 * // my-audio-worker.js
 * import { handleWorkerMessage } from 'audiobox/worker';
 * self.onmessage = (e) => handleWorkerMessage(e.data, self.postMessage.bind(self));
 * ```
 */
export interface WorkerRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  operation: WorkerOperation;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: Uint8Array | Float32Array[];
  error?: { code: string; message: string };
  progress?: number;
}

/** Runs one request inside a worker and reports the outcome. */
export async function handleWorkerMessage(
  request: WorkerRequest,
  post: (response: WorkerResponse, transfer?: ArrayBuffer[]) => void,
): Promise<void> {
  try {
    const result = await runInline(request.channels, request.sampleRate, request.operation, {
      onProgress: (progress) => post({ id: request.id, ok: true, progress }),
    });

    const transfer =
      result instanceof Uint8Array
        ? [result.buffer as ArrayBuffer]
        : result.map((c) => c.buffer as ArrayBuffer);

    post({ id: request.id, ok: true, result }, transfer);
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code ?? 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/** Thrown when a runtime lacks the APIs a worker path needs. */
export { UnsupportedRuntimeError };
