# Security Policy

`@perfscale/library-nodejs` is a **trusted-code** component: its whole
purpose is downloading Node.js and executing it on the host via the
perfscale `process` capability (RFC 009). Treat any report of "this library
can run node scripts" as working as intended.

## What is in scope

Genuinely security-relevant findings are cases where the component exceeds
its contract, for example:

- Downloading from anything other than `https://nodejs.org` over HTTPS, or
  skipping the SHA-256 verification against the official `SHASUMS256.txt`
  before extraction.
- Spawning anything other than the documented `/usr/bin/uname`,
  `/usr/bin/test` (cache probe), `/usr/bin/mkdir`, `/usr/bin/curl`,
  `/usr/bin/sha256sum`, `/usr/bin/tar`, `/usr/bin/rm` (the downloaded
  archive only), or the selected node binary.
- Leaking host environment variables into a child (the host import already
  guarantees a replacement environment; a bug that bypasses it matters).
- The cache-idempotency or bad-archive cleanup deleting anything other than
  the downloaded `.tar.xz` archive.
- Validation gaps that let crafted `with:` params or settings blocks
  (extension / variables / library `with:`) alter the spawned argv or
  environment in undocumented ways.

## What is out of scope

- "The step ran the script the YAML told it to run." Capability grants
  (`capabilities: [process]`, `allow_process_actions: true`,
  `allow_library_capabilities: true`) are the operator's explicit,
  double opt-in decision.
- Denial of service via long-running or noisy scripts — timeouts are
  host-capped; tune `timeout_ms`.

## Reporting

Do not open a public issue for a vulnerability. Report privately to the
Perfscale maintainers (see the contact in the main perfscale repository's
SECURITY.md) with a minimal YAML + script reproducer. We aim to acknowledge
within 7 days.

## Supported versions

Only the latest release receives security fixes.
