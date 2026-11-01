# @perfscale/library-nodejs

Trusted local **Node.js steps** for [perfscale](https://github.com/Perfscale) —
a WASM step component (RFC 009) exposing three steps over the bounded
`process` host capability:

| Step | Purpose |
| --- | --- |
| `lib/nodejs/install` | Download an official nodejs.org release, SHA-256-verify it, extract into a local toolcache (idempotent) |
| `lib/nodejs/exec` | Run an inline script (`node -e`) or a script file with a chosen node binary |
| `lib/nodejs/install-exec` | Compose both: install (or reuse the cache), then exec with the installed node |

**Linux-first**: `install` supports Linux x86_64 (`x64`) and aarch64
(`arm64`) only — any other OS/arch fails with an explicit unsupported error.
It assumes `/usr/bin/uname`, `/usr/bin/mkdir`, `/usr/bin/curl`,
`/usr/bin/sha256sum`, and `/usr/bin/tar` exist. Downloads come exclusively
from `https://nodejs.org` over HTTPS, and every downloaded archive is
verified against the official `SHASUMS256.txt` **before** extraction.

## Security model — read this first

**This library is trusted arbitrary code execution.** The `process`
capability is an intentional escape hatch, not a sandbox: whatever the
scripts can do on the host, they do with the perfscale process's privileges.

- No shell anywhere — every spawn is a direct argv to the tool or node
  binary with a **replacement** environment (host variables are never
  inherited; the component supplies a minimal explicit
  `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` which `env` may extend
  or override, string values only).
- `install` never uses sudo and never mutates global state: everything
  lands under `install-dir` (default `/tmp/perfscale-toolcache/nodejs`).
  It is idempotent — if `<install-dir>/node-v<VERSION>-linux-<ARCH>/bin/node`
  exists (`test -x`; the host import hard-errors on spawn-ENOENT) and
  answers `--version`, nothing is re-downloaded or re-installed, ever. On a
  checksum mismatch only the downloaded archive is deleted; install trees
  are never `rm`'d.
- `exec` path/`node-path` values are passed verbatim — this is a trusted
  process capability, not a confinement boundary.
- Timeouts are optional per step (`timeout_ms`, number or numeric string,
  positive) and always host-capped; on timeout the host kills the process
  tree.

## Installing and granting the capability

Pin the built artifact with the perfscale lockfile:

```console
$ perfscale install github:Perfscale/library-nodejs@<tag>   # writes perfscale.lock
```

Then grant the capability **twice** (fail-closed, like `net`):

```yaml
# perfscale.config.yaml
allow_library_capabilities: true
allow_process_actions: true
libraries:
  - use: ./nodejs.wasm          # or the lockfile-managed artifact
    capabilities: [process]
```

Missing either gate, the engine refuses to even load the component.

## Steps

### `lib/nodejs/install`

`with:` keys (unknown keys are rejected):

- `node-version` (string, **required**) — exact semver (`24.16.0`) or a
  major / `major.x` (`24`, `24.x`), resolved through the official
  `https://nodejs.org/dist/latest-v<major>.x/SHASUMS256.txt` index.
- `install-dir` (string, optional, default `/tmp/perfscale-toolcache/nodejs`).

Output (`outputs: setup` below) is snake_case per the engine's ActionOutput:

```json
{ "path": "/…/node-v24.16.0-linux-x64", "node-path": "/…/bin/node",
  "version": "24.16.0", "stdout": "v24.16.0\n", "stderr": "", "exit_code": 0 }
```

`success` is true only after the installed `node --version` confirms the
install (or the cache). Any download/checksum/extract failure reports
`success: false` with the failing command's `exit_code`/`stdout`/`stderr`.

### `lib/nodejs/exec`

Runs an inline script (`node -e <script>`) or a script file
(`node <file>`) — exactly one of `script` / `file` is required.

```yaml
steps:
  - name: smoke
    use: lib/nodejs/exec
    with:
      node-path: "${{ config.setup.node-path }}"   # from a before: install
      script: console.log(`node ${process.version}`)
      args: ["--extra"]            # appended after the script/file
      working-directory: ./fixtures # alias: cwd
      env: { NODE_ENV: test }
      timeout_ms: 10000            # number or numeric string
    outputs: run
    check:
      message_contains: node v24
```

`with:` keys (unknown keys are rejected):

- `script` / `file` (string, **exactly one required**)
- `node-path` (absolute path, optional, default `/usr/bin/node`)
- `args` (array of strings, optional)
- `working-directory` / `cwd` (string, optional alias pair)
- `env` (map of string→string, optional; merges over the default PATH)
- `timeout_ms` / `timeoutMs` (positive number or numeric string, optional)

Output: `{ "exit_code": 0, "stdout": "...", "stderr": "..." }`. `success` is
`exit_code == 0`; **non-zero exits keep stdout/stderr**.

### `lib/nodejs/install-exec`

Install (or reuse the cached toolchain), then exec with the installed node —
no `node-path` needed (it is taken from the install result). `with:` is the
strict union of the `install` and `exec` keys above (minus `node-path`).
If installation fails, exec is skipped.

```yaml
steps:
  - name: one-shot
    use: lib/nodejs/install-exec
    with:
      node-version: 24.16.0
      install-dir: /tmp/perfscale-toolcache/nodejs   # absolute — exec requires an absolute node-path
      script: console.log("ok")
    outputs: combo
```

Output merges install and exec results: `{ "path", "node-path", "version",
"exit_code", "stdout", "stderr" }`.

## Run settings (RFC 009)

Every step knob may be set once for the whole run instead of repeated per
step. Precedence (highest first):

1. the step's explicit `with:` params
2. the `nodejs:` config extension block (claimed via the component's config
   schema — unknown keys fail the run)
3. the `variables.nodejs` map
4. the library entry's `with:` block
5. the built-in defaults

`env` maps merge in that same order (a step's `env` wins per key). Accepted
settings keys: `node-version` (alias `version`), `install-dir`, `node-path`
(alias `executable`), `working-directory` / `cwd`, `timeout_ms` /
`timeoutMs`, `env`. Invalid blocks (unknown key, wrong type, relative
`node-path`, bad version) are hard errors — at instantiation for the
library `with:`, at step resolution for the rest.

```yaml
# perfscale.config.yaml
nodejs:                      # config extension, validated against the schema
  node-version: "24"
  install-dir: /tmp/perfscale-toolcache/nodejs   # absolute — exec requires an absolute node-path
variables:
  nodejs: { timeout_ms: 30000 }
libraries:
  - use: ./nodejs.wasm
    capabilities: [process]
    with: { env: { NODE_ENV: test } }   # lowest-precedence defaults
steps:
  - name: smoke
    use: lib/nodejs/install-exec
    with:
      script: console.log(process.version)   # version/dir come from settings
```

## Orchestration, not hot path

Each step invocation is **real host process spawns** (and `install` may
download ~30 MB on a cold cache). Use these steps for setup, fixtures, and
one-off environment checks — the one-shot `before:` / `after:` blocks are
the natural home:

```yaml
before:
  - name: node
    use: lib/nodejs/install
    with:
      node-version: 24.16.0
      install-dir: /tmp/perfscale-toolcache/nodejs   # absolute — exec requires an absolute node-path
    outputs: setup        # → ${{ config.setup.node-path }} in test steps
```

Do not put `exec` in the per-iteration VU loop of a high-RPS test; the spawn
cost will dominate the measurement.

## Local e2e

```console
$ npm install
$ npm run build        # → nodejs.wasm (needs the SDK bin, see below)
$ perfscale run -f examples/node.test.yaml -c examples/node.config.yaml
```

The first run downloads Node.js 24.16.0 from nodejs.org into the default
toolcache (`/tmp/perfscale-toolcache/nodejs`); later runs reuse the cache.
`install-dir` may be relative, but then the installed `node-path` is
relative too and `exec` (which requires an absolute path) will refuse it —
prefer absolute install dirs.

## Development

```console
$ npm install          # file: dependency on the SDK checkout
$ npm test             # unit tests (node:test, fake host exec)
$ npm run typecheck
$ npm run build        # node ../sdk-step-authoring/ts/bin/perfscale-library-build.mjs \
                       #   --kind steps --process src/nodejs.ts -o nodejs.wasm
```

Built with [`@perfscale/library-sdk`](../sdk-step-authoring/ts) against
`perfscale:step@0.1.0` (`wit/step/step.wit`).

## License

Dual-licensed under [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at
your option.
