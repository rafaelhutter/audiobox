# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-03

First release.

### Added

- **Containers** — WAV (RIFF, RF64/BW64, `WAVE_FORMAT_EXTENSIBLE`), FLAC, AIFF/AIFF-C, CAF,
  and Sun/NeXT AU, all read and write.
- **Sample formats** — unsigned/signed 8-bit, 16-, 24- and 32-bit integer, 32- and 64-bit
  float, G.711 A-law and µ-law, plus IMA ADPCM decoding.
- **`Audio`** — an immutable value type with a fluent transform API.
- **Editing** — cut, remove, concat, pad, reverse, mix, crossfade.
- **Conversion** — windowed-sinc resampling with anti-aliasing, channel-layout conversion,
  bit-depth conversion with optional TPDF dither.
- **Processing** — gain, fades, peak/true-peak/LUFS normalisation, biquad filters, lookahead
  limiter, silence trimming, DC-offset removal, WSOLA time-stretch and pitch-shift.
- **Measurement** — peak, true peak, RMS, ITU-R BS.1770 / EBU R128 loudness, waveform peaks,
  FFT and spectrogram.
- **MP3 decoding** — MPEG-1, MPEG-2 and MPEG-2.5 Layer III at every sample rate from 8 to
  48 kHz, CBR and VBR, mono/stereo/dual-channel/joint stereo (mid-side and intensity), with
  gapless playback from Xing/VBRI/LAME tags. Verified sample-aligned against ffmpeg at
  52-64 dB SNR.
- **MP3 inspection** — frame headers, ID3v2 sizing, Xing/VBRI/LAME tags, and `probeMp3()` for
  duration, bitrate and channel mode without decoding a single sample.
- **Subpath entry points** — `audiobox/flac`, `/mp3`, `/analyze`, `/stream`, `/worker`,
  `/node`, `/webcodecs`, so unused codecs stay out of your bundle.
- **Safety limits** on every decode, enabled by default.
- Dual ESM + CJS build with per-format type declarations; zero runtime dependencies.

### Known limitations

- MP3 *encoding* is not implemented. Decoding is.
- `s32` and `f64` round-trips are accurate to float32 precision (~24 bits), because decoded
  audio is held as `Float32Array`. Depths up to 24 bits are bit-exact.
- Streaming resampling processes each chunk independently, so filter state does not carry
  across chunk boundaries.

[1.0.0]: https://github.com/jmsansan/audiobox/releases/tag/v1.0.0
