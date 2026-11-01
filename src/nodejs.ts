import {
  defineSteps,
  StepError,
  type ExecResult,
  type StepCtx,
} from "@perfscale/library-sdk";

/**
 * `nodejs` — trusted local Node.js steps for perfscale (RFC 009 `process`
 * capability). Three steps over the bounded host import (`ctx.exec`):
 *
 * - `install`       — download an official nodejs.org release tarball,
 *                     verify its SHA-256 against the official SHASUMS256.txt,
 *                     and extract it into a local toolcache (idempotent).
 * - `exec`          — run an inline script (`node -e`) or a script file with
 *                     a chosen node binary, exit code preserved.
 * - `install-exec`  — compose both: install (or reuse the cache), then exec
 *                     with the installed node.
 *
 * Linux-first: `install` supports linux x86_64 (`x64`) and aarch64 (`arm64`)
 * only and downloads exclusively from `https://nodejs.org` over HTTPS via
 * direct argv to `/usr/bin/curl` — no shell anywhere, a replacement
 * environment on every spawn. The component only loads when the run grants
 * the capability twice over: `capabilities: [process]` on the library entry
 * AND `allow_process_actions: true` + `allow_library_capabilities: true` in
 * the config.
 *
 * Settings (RFC 009): every step knob may also come from the run —
 * `extensions[nodejs]` > `variables[nodejs]` > the library entry's `with:`
 * > built-in defaults; a step's explicit `with:` param beats them all, and
 * `env` maps merge in that order. The component claims the `nodejs` config
 * extension key via its config schema (unknown keys fail the run).
 *
 * Build: node ../sdk-step-authoring/ts/bin/perfscale-library-build.mjs \
 *          --kind steps --process src/nodejs.ts -o nodejs.wasm
 */

/** Minimal explicit PATH: the host environment is never inherited. */
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const DEFAULT_INSTALL_DIR = "/tmp/perfscale-toolcache/nodejs";
const DEFAULT_NODE_PATH = "/usr/bin/node";
const DIST_BASE = "https://nodejs.org/dist";

/** Host-call budgets (still host-capped on top of these). */
const TARBALL_TIMEOUT_MS = 600_000;
const SMALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Settings (RFC 009): library `with:` defaults + run settings
// ---------------------------------------------------------------------------
//
// Every knob a step accepts may also be set once for the whole run.
// Precedence (highest first):
//
//   1. the step's explicit `with:` params
//   2. the run's `extensions[nodejs]` block (claimed via configSchema)
//   3. the run's `variables[nodejs]` map
//   4. the library entry's `with:` block (delivered to `init`)
//   5. the built-in defaults below
//
// `env` maps merge in that same order (a step's `env` wins over the same
// key set anywhere else); scalar keys take the highest-precedence value.
// Invalid settings are hard errors at resolution time — never silently
// ignored.

/** The accepted keys of any settings block (step `with:` adds more). */
const SETTINGS_KEYS = [
  "node-version", "version", "install-dir", "node-path", "executable",
  "working-directory", "cwd", "timeout_ms", "timeoutMs", "env",
];

/** Normalized per-run defaults collected from the settings sources. */
interface NodejsSettings {
  nodeVersion?: string | undefined;
  installDir?: string | undefined;
  nodePath?: string | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: Record<string, string> | undefined;
}

/** JSON Schema for the claimed `nodejs` config extension key. */
const NODEJS_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    "node-version": { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    "install-dir": { type: "string", minLength: 1 },
    "node-path": { type: "string", minLength: 1 },
    executable: { type: "string", minLength: 1 },
    "working-directory": { type: "string", minLength: 1 },
    cwd: { type: "string", minLength: 1 },
    timeout_ms: { type: ["number", "string"] },
    timeoutMs: { type: ["number", "string"] },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} as const;

function parseSettingsBlock(source: string, raw: unknown): NodejsSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StepError(`nodejs settings (${source}): must be an object`);
  }
  const block = raw as Record<string, unknown>;
  for (const k of Object.keys(block)) {
    if (!SETTINGS_KEYS.includes(k)) {
      throw new StepError(`nodejs settings (${source}): unknown key '${k}'`);
    }
  }
  const s: NodejsSettings = {};
  const str = (key: string): string | undefined => {
    const v = block[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") {
      throw new StepError(`nodejs settings (${source}): '${key}' must be a non-empty string`);
    }
    return v;
  };
  const version = str("node-version") ?? str("version");
  if (version !== undefined) {
    if (!EXACT_VERSION.test(version) && !MAJOR_VERSION.test(version)) {
      throw new StepError(
        `nodejs settings (${source}): 'node-version' must be an exact semver (e.g. 24.16.0) or a major / major.x (e.g. 24 or 24.x)`,
      );
    }
    s.nodeVersion = version;
  }
  s.installDir = str("install-dir");
  s.nodePath = str("node-path") ?? str("executable");
  if (s.nodePath !== undefined && !s.nodePath.startsWith("/")) {
    throw new StepError(`nodejs settings (${source}): 'node-path' must be an absolute path`);
  }
  const wd = str("working-directory");
  const cwd = str("cwd");
  if (wd !== undefined && cwd !== undefined && wd !== cwd) {
    throw new StepError(`nodejs settings (${source}): 'working-directory' and 'cwd' disagree`);
  }
  s.cwd = wd ?? cwd;
  const t = block["timeout_ms"] ?? block["timeoutMs"];
  if (t !== undefined) {
    const n = typeof t === "number" ? t : typeof t === "string" ? Number(t) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw new StepError(`nodejs settings (${source}): timeout must be a positive number of milliseconds`);
    }
    s.timeoutMs = n;
  }
  const env = block["env"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new StepError(`nodejs settings (${source}): 'env' must be a map of string to string`);
    }
    s.env = {};
    for (const [k, val] of Object.entries(env as Record<string, unknown>)) {
      if (typeof val !== "string") {
        throw new StepError(`nodejs settings (${source}): env['${k}'] must be a string`);
      }
      s.env[k] = val;
    }
  }
  return s;
}

/** Library-level `with:` defaults, captured by `init` at instantiation. */
let libraryDefaults: NodejsSettings = {};

/**
 * Resolve the effective settings for one step invocation:
 * run extension > run variables > library `with:` (the step's own `with:`
 * params are applied by the caller on top). Invalid blocks fail the step.
 */
function resolveSettings(ctx: StepCtx): NodejsSettings {
  const ext = parseSettingsBlock(
    "extensions[nodejs]",
    ctx.settings.extensions?.["nodejs"],
  );
  const vars = parseSettingsBlock(
    "variables[nodejs]",
    ctx.settings.variables?.["nodejs"],
  );
  const lib = libraryDefaults;
  return {
    nodeVersion: ext.nodeVersion ?? vars.nodeVersion ?? lib.nodeVersion,
    installDir: ext.installDir ?? vars.installDir ?? lib.installDir,
    nodePath: ext.nodePath ?? vars.nodePath ?? lib.nodePath,
    cwd: ext.cwd ?? vars.cwd ?? lib.cwd,
    timeoutMs: ext.timeoutMs ?? vars.timeoutMs ?? lib.timeoutMs,
    env: { ...lib.env, ...vars.env, ...ext.env },
  };
}

type Log = { tag: "out" | "err" | "sys"; line: string };
type Out = Record<string, unknown>;

interface StepOutcome {
  success: boolean;
  output: Out;
  logs: Log[];
}

/** A `with:` block may only carry these keys; anything else is an error. */
function strictKeys(step: string, params: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      throw new StepError(`nodejs/${step}: unknown param '${k}'`);
    }
  }
}

function optString(step: string, params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") {
    throw new StepError(`nodejs/${step}: '${key}' must be a non-empty string`);
  }
  return v;
}

/** `working-directory` with `cwd` as an accepted alias; both must agree. */
function optCwd(step: string, params: Record<string, unknown>): string | undefined {
  const wd = params["working-directory"];
  const cwd = params["cwd"];
  for (const [k, v] of [["working-directory", wd], ["cwd", cwd]] as const) {
    if (v !== undefined && (typeof v !== "string" || v === "")) {
      throw new StepError(`nodejs/${step}: '${k}' must be a non-empty string`);
    }
  }
  if (wd !== undefined && cwd !== undefined && wd !== cwd) {
    throw new StepError(`nodejs/${step}: 'working-directory' and 'cwd' disagree`);
  }
  return (wd ?? cwd) as string | undefined;
}

/** User env merges over the minimal PATH and any settings-level env. */
function optEnv(
  step: string,
  params: Record<string, unknown>,
  base: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = { PATH: DEFAULT_PATH, ...base };
  const v = params["env"];
  if (v === undefined) return env;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new StepError(`nodejs/${step}: 'env' must be a map of string to string`);
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new StepError(`nodejs/${step}: env['${k}'] must be a string`);
    }
    env[k] = val;
  }
  return env;
}

/** Extra arguments, passed verbatim to node (no shell splitting). */
function optArgs(step: string, params: Record<string, unknown>): string[] {
  const v = params["args"];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
    throw new StepError(`nodejs/${step}: 'args' must be an array of strings`);
  }
  return v as string[];
}

/** Accepts a number or a numeric string (like other perfscale params). */
function optTimeoutMs(step: string, params: Record<string, unknown>): number | undefined {
  for (const key of ["timeout_ms", "timeoutMs"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw new StepError(`nodejs/${step}: '${key}' must be a positive number of milliseconds`);
    }
    return n;
  }
  return undefined;
}

function runHost(
  ctx: StepCtx,
  req: {
    executable: string;
    argv: string[];
    cwd?: string;
    timeoutMs?: number;
  },
): ExecResult {
  return ctx.exec({
    executable: req.executable,
    argv: req.argv,
    env: { PATH: DEFAULT_PATH, PERFSCALE_STEP: ctx.stepName },
    ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  });
}

function failOut(logs: Log[], res: ExecResult, note: string): StepOutcome {
  logs.push({ tag: "sys", line: note });
  if (res.stdout !== "") logs.push({ tag: "out", line: res.stdout.trimEnd() });
  if (res.stderr !== "") logs.push({ tag: "err", line: res.stderr.trimEnd() });
  return {
    success: false,
    output: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr },
    logs,
  };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const MAJOR_VERSION = /^(\d+)(?:\.x)?$/;

interface InstallParsed {
  version: string;
  installDir: string;
}

function parseInstallParams(
  step: string,
  params: Record<string, unknown>,
  settings: NodejsSettings,
): InstallParsed {
  const explicit = optString(step, params, "node-version");
  const nodeVersion = explicit ?? settings.nodeVersion;
  if (nodeVersion === undefined) {
    throw new StepError(`nodejs/${step}: 'node-version' is required and must be a non-empty string`);
  }
  if (!EXACT_VERSION.test(nodeVersion) && !MAJOR_VERSION.test(nodeVersion)) {
    throw new StepError(
      `nodejs/${step}: 'node-version' must be an exact semver (e.g. 24.16.0) or a major / major.x (e.g. 24 or 24.x)`,
    );
  }
  const installDir =
    optString(step, params, "install-dir") ?? settings.installDir ?? DEFAULT_INSTALL_DIR;
  return { version: nodeVersion, installDir };
}

/** Map the host to a nodejs.org artifact arch; anything else is unsupported. */
function hostArch(ctx: StepCtx): string {
  const os = runHost(ctx, {
    executable: "/usr/bin/uname",
    argv: ["-s"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const osName = os.stdout.trim();
  if (os.exitCode !== 0 || osName !== "Linux") {
    throw new StepError(
      `nodejs: unsupported OS '${osName || "?"}' — install supports Linux only (nodejs.org linux tarballs)`,
    );
  }
  const machine = runHost(ctx, {
    executable: "/usr/bin/uname",
    argv: ["-m"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const m = machine.stdout.trim();
  if (machine.exitCode === 0 && m === "x86_64") return "x64";
  if (machine.exitCode === 0 && m === "aarch64") return "arm64";
  throw new StepError(
    `nodejs: unsupported architecture '${m || "?"}' — install supports linux x86_64 (x64) and aarch64 (arm64) only`,
  );
}

/** First line of SHASUMS256.txt content matching `re`, as a regex match. */
function matchShasums(shasums: string, re: RegExp): RegExpExecArray | undefined {
  for (const line of shasums.split("\n")) {
    const m = re.exec(line.trim());
    if (m) return m;
  }
  return undefined;
}

/** Resolve `24` / `24.x` to an exact version via the official index. */
function resolveVersion(
  ctx: StepCtx,
  requested: string,
  arch: string,
  logs: Log[],
): { version: string } | StepOutcome {
  if (EXACT_VERSION.test(requested)) return { version: requested };
  const major = MAJOR_VERSION.exec(requested)![1]!;
  const url = `${DIST_BASE}/latest-v${major}.x/SHASUMS256.txt`;
  logs.push({ tag: "sys", line: `nodejs: resolving latest v${major}.x via ${url}` });
  const res = runHost(ctx, {
    executable: "/usr/bin/curl",
    argv: ["-fsSL", url],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    return failOut(logs, res, `nodejs: failed to fetch ${url}`);
  }
  const artifactRe = new RegExp(`^[0-9a-f]{64}  node-v(\\d+\\.\\d+\\.\\d+)-linux-${arch}\\.tar\\.xz$`);
  const match = matchShasums(res.stdout, artifactRe);
  const version = match?.[1];
  if (version === undefined) {
    logs.push({ tag: "sys", line: `nodejs: no node-v*-linux-${arch}.tar.xz in ${url}` });
    return {
      success: false,
      output: { exit_code: 1, stdout: res.stdout, stderr: res.stderr },
      logs,
    };
  }
  logs.push({ tag: "sys", line: `nodejs: resolved v${major}.x → ${version}` });
  return { version };
}

function runInstall(step: string, params: Record<string, unknown>, ctx: StepCtx): StepOutcome {
  const logs: Log[] = [];
  const { version: requested, installDir } = parseInstallParams(step, params, resolveSettings(ctx));
  const arch = hostArch(ctx);

  const resolved = resolveVersion(ctx, requested, arch, logs);
  if (!("version" in resolved)) return resolved;
  const version = resolved.version;

  const artifact = `node-v${version}-linux-${arch}`;
  const path = `${installDir}/${artifact}`;
  const nodePath = `${path}/bin/node`;

  // Idempotent: a working cached node is reused, never re-downloaded.
  const cached = runHost(ctx, {
    executable: nodePath,
    argv: ["--version"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (cached.exitCode === 0) {
    logs.push({ tag: "sys", line: `nodejs: ${artifact} already installed at ${path} (${cached.stdout.trim()})` });
    return {
      success: true,
      output: {
        path,
        "node-path": nodePath,
        version,
        stdout: cached.stdout,
        stderr: cached.stderr,
        exit_code: 0,
      },
      logs,
    };
  }

  const tarballUrl = `${DIST_BASE}/v${version}/${artifact}.tar.xz`;
  const shasumsUrl = `${DIST_BASE}/v${version}/SHASUMS256.txt`;
  const archive = `${installDir}/.${artifact}.tar.xz`;

  const mk = runHost(ctx, {
    executable: "/usr/bin/mkdir",
    argv: ["-p", installDir],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (mk.exitCode !== 0) return failOut(logs, mk, `nodejs: mkdir -p ${installDir} failed`);

  logs.push({ tag: "sys", line: `nodejs: downloading ${tarballUrl}` });
  const dl = runHost(ctx, {
    executable: "/usr/bin/curl",
    argv: ["-fsSL", tarballUrl, "-o", archive],
    timeoutMs: TARBALL_TIMEOUT_MS,
  });
  if (dl.exitCode !== 0) return failOut(logs, dl, `nodejs: download of ${tarballUrl} failed`);

  const sums = runHost(ctx, {
    executable: "/usr/bin/curl",
    argv: ["-fsSL", shasumsUrl],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (sums.exitCode !== 0) return failOut(logs, sums, `nodejs: failed to fetch ${shasumsUrl}`);
  const wantRe = new RegExp(`^([0-9a-f]{64})  ${artifact}\\.tar\\.xz$`);
  const expected = matchShasums(sums.stdout, wantRe)?.[1];
  if (expected === undefined) {
    runHost(ctx, { executable: "/usr/bin/rm", argv: ["-f", archive], timeoutMs: SMALL_TIMEOUT_MS });
    logs.push({ tag: "sys", line: `nodejs: no checksum for ${artifact}.tar.xz in ${shasumsUrl}` });
    return { success: false, output: { exit_code: 1, stdout: sums.stdout, stderr: sums.stderr }, logs };
  }

  const sum = runHost(ctx, {
    executable: "/usr/bin/sha256sum",
    argv: [archive],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const actual = sum.exitCode === 0 ? (sum.stdout.trim().split(/\s+/)[0] ?? "") : "";
  if (sum.exitCode !== 0 || actual !== expected) {
    // Delete only the bad downloaded archive; never rm install trees.
    runHost(ctx, { executable: "/usr/bin/rm", argv: ["-f", archive], timeoutMs: SMALL_TIMEOUT_MS });
    logs.push({
      tag: "sys",
      line: `nodejs: checksum mismatch for ${artifact}.tar.xz (expected ${expected}, got ${actual || "?"}) — archive deleted`,
    });
    return {
      success: false,
      output: { exit_code: sum.exitCode === 0 ? 1 : sum.exitCode, stdout: sum.stdout, stderr: sum.stderr },
      logs,
    };
  }
  logs.push({ tag: "sys", line: `nodejs: sha256 verified (${expected})` });

  const untar = runHost(ctx, {
    executable: "/usr/bin/tar",
    argv: ["-xJf", archive, "-C", installDir],
    timeoutMs: TARBALL_TIMEOUT_MS,
  });
  if (untar.exitCode !== 0) return failOut(logs, untar, `nodejs: extraction of ${archive} failed`);
  runHost(ctx, { executable: "/usr/bin/rm", argv: ["-f", archive], timeoutMs: SMALL_TIMEOUT_MS });

  const verify = runHost(ctx, {
    executable: nodePath,
    argv: ["--version"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (verify.exitCode !== 0) {
    return failOut(logs, verify, `nodejs: installed node at ${nodePath} failed --version`);
  }
  logs.push({ tag: "sys", line: `nodejs: installed ${artifact} at ${path} (${verify.stdout.trim()})` });
  return {
    success: true,
    output: {
      path,
      "node-path": nodePath,
      version,
      stdout: verify.stdout,
      stderr: verify.stderr,
      exit_code: 0,
    },
    logs,
  };
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

const EXEC_KEYS = [
  "script", "file", "node-path", "args", "working-directory", "cwd", "env",
  "timeout_ms", "timeoutMs",
];

function runExec(
  step: string,
  params: Record<string, unknown>,
  ctx: StepCtx,
  installedNodePath?: string,
): StepOutcome {
  const settings = resolveSettings(ctx);
  const script = optString(step, params, "script");
  const file = optString(step, params, "file");
  if ((script === undefined) === (file === undefined)) {
    throw new StepError(`nodejs/${step}: exactly one of 'script' or 'file' is required`);
  }
  const nodePath =
    installedNodePath ?? optString(step, params, "node-path") ?? settings.nodePath ?? DEFAULT_NODE_PATH;
  if (!nodePath.startsWith("/")) {
    throw new StepError(`nodejs/${step}: 'node-path' must be an absolute path to the node executable`);
  }
  const args = optArgs(step, params);
  const cwd = optCwd(step, params) ?? settings.cwd;
  const env = optEnv(step, params, settings.env);
  const timeoutMs = optTimeoutMs(step, params) ?? settings.timeoutMs;

  const argv = script !== undefined ? ["-e", script, ...args] : [file!, ...args];
  const res = ctx.exec({
    executable: nodePath,
    argv,
    env: { ...env, PERFSCALE_STEP: ctx.stepName },
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const logs: Log[] = [
    { tag: "sys", line: `nodejs/${step}: ${nodePath} exit code ${res.exitCode}` },
  ];
  if (res.stdout !== "") logs.push({ tag: "out", line: res.stdout.trimEnd() });
  if (res.stderr !== "") logs.push({ tag: "err", line: res.stderr.trimEnd() });
  return {
    success: res.exitCode === 0,
    output: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr },
    logs,
  };
}

// ---------------------------------------------------------------------------

export default defineSteps({
  name: "nodejs",
  version: "0.1.0",
  configSchema: { key: "nodejs", schema: NODEJS_CONFIG_SCHEMA },
  init(config) {
    // Library-level `with:` defaults — validated once at instantiation;
    // invalid defaults are fatal to the run, never silently ignored.
    libraryDefaults = parseSettingsBlock("library with", config);
  },
  steps: {
    install: {
      description:
        "Install an official nodejs.org Node.js release (checksum-verified) into a local toolcache; idempotent per version+arch",
      run(params, ctx) {
        strictKeys("install", params, ["node-version", "install-dir"]);
        return runInstall("install", params, ctx);
      },
    },
    exec: {
      description:
        "Run an inline JS script (`node -e`) or a script file with a chosen node binary; exit code preserved",
      run(params, ctx) {
        strictKeys("exec", params, EXEC_KEYS);
        return runExec("exec", params, ctx);
      },
    },
    "install-exec": {
      description:
        "Install (or reuse the cached) Node.js, then run a script with the installed node; installation failure skips exec",
      run(params, ctx) {
        strictKeys("install-exec", params, ["node-version", "install-dir", ...EXEC_KEYS.filter((k) => k !== "node-path")]);
        const inst = runInstall("install-exec", params, ctx);
        if (!inst.success) return inst;
        const nodePath = inst.output["node-path"] as string;
        const ex = runExec("install-exec", params, ctx, nodePath);
        return {
          success: ex.success,
          output: {
            path: inst.output["path"],
            "node-path": nodePath,
            version: inst.output["version"],
            exit_code: ex.output["exit_code"],
            stdout: ex.output["stdout"],
            stderr: ex.output["stderr"],
          },
          logs: [...inst.logs, ...ex.logs],
        };
      },
    },
  },
});
