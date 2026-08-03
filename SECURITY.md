# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/jmsansan/audiobox/security/advisories/new)
rather than opening a public issue.

Expect an acknowledgement within 72 hours and an assessment within seven days. Fixes for
confirmed issues are released as soon as they are ready, and reporters are credited in the
advisory unless they ask otherwise.

## Supported versions

| Version | Supported |
| --- | :---: |
| 1.x | ✅ |

## Threat model

audiobox parses audio files, which in most deployments means **untrusted user uploads**. The
security properties it aims to provide are:

1. **No out-of-bounds access.** All parsing goes through a bounds-checked reader; a malformed
   file produces a typed `DecodeError`, not a runtime `RangeError` or undefined behaviour.
2. **No attacker-controlled allocation.** Sizes declared in a file are validated against the
   bytes actually present, and every decode is subject to configurable limits (512 MiB, 6
   hours, 64 channels by default). A small file cannot cause a large allocation.
3. **Termination.** No decoder loops indefinitely on malformed input. Resync and
   variable-length decode paths are bounded.
4. **No code execution.** No `eval`, no `new Function`. Enforced by a CI check.
5. **No ambient authority.** Core imports nothing from `node:*` and touches no DOM API, so a
   decode cannot reach the filesystem or network. Verified by `npm run portability`.

These are tested continuously by a fuzz suite that runs tens of thousands of malformed,
mutated and truncated inputs against every decoder on each CI run.

### Out of scope

- Resource exhaustion when limits are deliberately raised beyond the defaults.
- Correctness of audio output for malformed-but-decodable files; audiobox aims to fail safely,
  not to reproduce another decoder's error recovery.

## Supply chain

- **Zero runtime dependencies**, so there is no transitive tree to compromise.
- Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  via OIDC trusted publishing — no long-lived npm token exists in CI.
- Releases are built and published only from tagged commits on the default branch.
