/**
 * FLAC codec — `audiobox/flac`.
 *
 * Kept out of the core bundle so its predictor and Rice-coding machinery only
 * loads for callers that actually handle FLAC.
 */
export { decodeFlac } from './decoder.ts';
export { encodeFlac } from './encoder.ts';
export type { FlacEncodeOptions } from './encoder.ts';
