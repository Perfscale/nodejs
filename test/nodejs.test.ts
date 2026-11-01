import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StepCtx,
  StepError,
  testStep,
  type ExecRequest,
  type ExecResult,
  type HostExec,
} from "@perfscale/library-sdk";
import def from "../src/nodejs.ts";

/**
 * Record every host spawn and answer from a script. The harness fake is a
 * WIT-boundary `HostExec` (env as entry pairs); tests see the ergonomic
 * ExecRequest shape (env as a Record) the component itself uses.
 */
function fakeExec(handler: (req: ExecRequest, call: number) => ExecResult) {
  const calls: ExecRequest[] = [];
  const exec: HostExec = (wreq) => {
    const req: ExecRequest = {
      executable: wreq.executable,
      env: Object.fromEntries(wreq.env ?? []),
    };
    if (wreq.argv !== undefined) req.argv = wreq.argv;
    if (wreq.cwd !== undefined) req.cwd = wreq.cwd;
    if (wreq.timeoutMs !== undefined) req.timeoutMs = wreq.timeoutMs;
    calls.push(req);
    return handler(req, calls.length - 1);
  };
  return { calls, exec };
}

function ctx(exec?: HostExec): StepCtx {
  const c = new StepCtx(exec);
  c.stepName = "t";
  return c;
}

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const SHA = "a".repeat(64);
const shasums = (version: string, arch: string, sha = SHA): string =>
  `${sha}  node-v${version}-linux-${arch}.tar.xz\n` +
  `${"b".repeat(64)}  node-v${version}-linux-${arch === "x64" ? "arm64" : "x64"}.tar.xz\n`;

/**
 * A full Linux host for install flows. `node --version` fails on the first
 * invocation (cache miss) and succeeds afterwards (post-install verify),
 * unless `cached` — then it succeeds immediately and nothing is downloaded.
 */
function installHost(opts: {
  arch?: string;
  os?: string;
  version?: string;
  cached?: boolean;
  badSum?: boolean;
  downloadFails?: boolean;
} = {}) {
  const arch = opts.arch ?? "x86_64";
  const version = opts.version ?? "24.16.0";
  const nodeArch = arch === "x86_64" ? "x64" : "arm64";
  let nodeCalls = 0;
  return fakeExec((req) => {
    const argv = req.argv ?? [];
    if (req.executable === "/usr/bin/uname") {
      return ok(argv[0] === "-s" ? `${opts.os ?? "Linux"}\n` : `${arch}\n`);
    }
    if (req.executable.endsWith("/bin/node")) {
      nodeCalls += 1;
      if (opts.cached || nodeCalls > 1) return ok(`v${version}\n`);
      return { exitCode: 1, stdout: "", stderr: "no such file" };
    }
    if (req.executable === "/usr/bin/curl") {
      if (argv.includes("-o")) {
        if (opts.downloadFails) return { exitCode: 7, stdout: "", stderr: "connection refused" };
        return ok();
      }
      const url = argv[argv.length - 1]!;
      if (url === `https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt`) {
        return ok(shasums(version, nodeArch));
      }
      if (url === `https://nodejs.org/dist/v${version}/SHASUMS256.txt`) {
        return ok(shasums(version, nodeArch, opts.badSum ? "c".repeat(64) : SHA));
      }
      return { exitCode: 22, stdout: "", stderr: "unexpected url" };
    }
    if (req.executable === "/usr/bin/sha256sum") return ok(`${SHA}  ${argv[0]}\n`);
    if (req.executable === "/usr/bin/mkdir") return ok();
    if (req.executable === "/usr/bin/tar") return ok();
    if (req.executable === "/usr/bin/rm") return ok();
    return { exitCode: 99, stdout: "", stderr: `unhandled: ${req.executable}` };
  });
}

describe("nodejs/install", () => {
  it("installs an exact version: download, checksum, extract, verify", () => {
    const { calls, exec } = installHost();
    const res = testStep(def, ctx(exec), "install", { "node-version": "24.16.0" });
    assert.equal(res.success, true);
    const out = res.output as Record<string, unknown>;
    assert.equal(out["version"], "24.16.0");
    assert.equal(out["path"], "/tmp/perfscale-toolcache/nodejs/node-v24.16.0-linux-x64");
    assert.equal(out["node-path"], "/tmp/perfscale-toolcache/nodejs/node-v24.16.0-linux-x64/bin/node");
    assert.equal(out["exit_code"], 0);

    const dl = calls.find((c) => c.executable === "/usr/bin/curl" && c.argv?.includes("-o"))!;
    assert.deepEqual(dl.argv, [
      "-fsSL",
      "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz",
      "-o",
      "/tmp/perfscale-toolcache/nodejs/.node-v24.16.0-linux-x64.tar.xz",
    ]);
    // exact version: no latest-v24.x resolution fetch, but the per-version
    // SHASUMS256.txt is always fetched for verification.
    assert.ok(!calls.some((c) => c.argv?.some((a) => a.includes("latest-v"))));
    assert.ok(calls.some((c) => c.argv?.includes("https://nodejs.org/dist/v24.16.0/SHASUMS256.txt")));
    const tar = calls.find((c) => c.executable === "/usr/bin/tar")!;
    assert.deepEqual(tar.argv, [
      "-xJf",
      "/tmp/perfscale-toolcache/nodejs/.node-v24.16.0-linux-x64.tar.xz",
      "-C",
      "/tmp/perfscale-toolcache/nodejs",
    ]);
    // every spawn is direct argv with a replacement env
    assert.ok(calls.every((c) => c.env?.PATH === "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
  });

  it("resolves a major.x version through the official SHASUMS index", () => {
    const { calls, exec } = installHost();
    const res = testStep(def, ctx(exec), "install", {
      "node-version": "24.x",
      "install-dir": "/opt/tools",
    });
    assert.equal(res.success, true);
    assert.ok(calls.some((c) =>
      c.argv?.includes("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"),
    ));
    assert.equal((res.output as Record<string, unknown>)["node-path"],
      "/opt/tools/node-v24.16.0-linux-x64/bin/node");
  });

  it("maps aarch64 to the arm64 artifact", () => {
    const { calls, exec } = installHost({ arch: "aarch64" });
    const res = testStep(def, ctx(exec), "install", { "node-version": "24.16.0" });
    assert.equal(res.success, true);
    const dl = calls.find((c) => c.argv?.includes("-o"))!;
    assert.ok(dl.argv!.includes("https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-arm64.tar.xz"));
  });

  it("fails explicitly on unsupported OS and architectures", () => {
    const darwin = installHost({ os: "Darwin" });
    assert.throws(
      () => testStep(def, ctx(darwin.exec), "install", { "node-version": "24.16.0" }),
      /unsupported OS 'Darwin'/,
    );
    const armv7 = installHost({ arch: "armv7l" });
    assert.throws(
      () => testStep(def, ctx(armv7.exec), "install", { "node-version": "24.16.0" }),
      /unsupported architecture 'armv7l'/,
    );
  });

  it("deletes only the archive and never extracts on checksum mismatch", () => {
    const { calls, exec } = installHost({ badSum: true });
    const res = testStep(def, ctx(exec), "install", { "node-version": "24.16.0" });
    assert.equal(res.success, false);
    const rm = calls.find((c) => c.executable === "/usr/bin/rm")!;
    assert.deepEqual(rm.argv, ["-f", "/tmp/perfscale-toolcache/nodejs/.node-v24.16.0-linux-x64.tar.xz"]);
    assert.ok(!calls.some((c) => c.executable === "/usr/bin/tar"));
    assert.ok(res.logs!.some((l) => l.line.includes("checksum mismatch")));
  });

  it("is idempotent: a working cached node is never re-downloaded", () => {
    const { calls, exec } = installHost({ cached: true });
    const res = testStep(def, ctx(exec), "install", { "node-version": "24.16.0" });
    assert.equal(res.success, true);
    assert.equal((res.output as Record<string, unknown>)["stdout"], "v24.16.0\n");
    assert.ok(!calls.some((c) => ["/usr/bin/curl", "/usr/bin/tar"].includes(c.executable)));
  });

  it("reports download failures with the curl exit code", () => {
    const { exec } = installHost({ downloadFails: true });
    const res = testStep(def, ctx(exec), "install", { "node-version": "24.16.0" });
    assert.equal(res.success, false);
    assert.equal((res.output as Record<string, unknown>)["exit_code"], 7);
    assert.ok(res.logs!.some((l) => l.line.includes("download")));
  });

  it("rejects bad versions, unknown keys, and wrong types", () => {
    const { exec } = installHost({ cached: true });
    for (const p of [
      {},
      { "node-version": "" },
      { "node-version": "24.16" },
      { "node-version": "v24.16.0" },
      { "node-version": "24.16.0", sudo: true },
      { "node-version": "24.16.0", "install-dir": 5 },
      { "node-version": "24.16.0", "working-directory": "/tmp" },
    ]) {
      assert.throws(() => testStep(def, ctx(exec), "install", p), StepError, JSON.stringify(p));
    }
  });
});

describe("nodejs/exec", () => {
  const done = { exitCode: 0, stdout: "hi\n", stderr: "" };

  it("runs an inline script with the default node and minimal env", () => {
    const { calls, exec } = fakeExec(() => done);
    const res = testStep(def, ctx(exec), "exec", { script: "console.log('hi')" });
    assert.equal(res.success, true);
    assert.deepEqual(res.output, { exit_code: 0, stdout: "hi\n", stderr: "" });
    const req = calls[0]!;
    assert.equal(req.executable, "/usr/bin/node");
    assert.deepEqual(req.argv, ["-e", "console.log('hi')"]);
    assert.equal(req.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(req.env?.PERFSCALE_STEP, "t");
  });

  it("runs a script file with args, cwd alias, env, and timeout", () => {
    const { calls, exec } = fakeExec(() => done);
    testStep(def, ctx(exec), "exec", {
      file: "scripts/run.js",
      "node-path": "/opt/node/bin/node",
      args: ["--flag", "x"],
      cwd: "/tmp/work",
      env: { FOO: "bar" },
      timeout_ms: "5000",
    });
    const req = calls[0]!;
    assert.equal(req.executable, "/opt/node/bin/node");
    assert.deepEqual(req.argv, ["scripts/run.js", "--flag", "x"]);
    assert.equal(req.cwd, "/tmp/work");
    assert.equal(req.env?.FOO, "bar");
    assert.equal(req.timeoutMs, 5000);
  });

  it("keeps output on non-zero exit and reports success=false", () => {
    const { exec } = fakeExec(() => ({ exitCode: 2, stdout: "partial\n", stderr: "boom\n" }));
    const res = testStep(def, ctx(exec), "exec", { script: "process.exit(2)" });
    assert.equal(res.success, false);
    assert.deepEqual(res.output, { exit_code: 2, stdout: "partial\n", stderr: "boom\n" });
  });

  it("requires exactly one of script/file", () => {
    const { exec } = fakeExec(() => done);
    assert.throws(() => testStep(def, ctx(exec), "exec", {}), /exactly one of 'script' or 'file'/);
    assert.throws(
      () => testStep(def, ctx(exec), "exec", { script: "1", file: "a.js" }),
      /exactly one of 'script' or 'file'/,
    );
  });

  it("rejects relative node-path, unknown keys, and wrong types", () => {
    const { exec } = fakeExec(() => done);
    for (const p of [
      { script: "1", "node-path": "node" },
      { script: "1", shell: true },
      { script: "1", args: "oops" },
      { script: "1", args: [1] },
      { script: "1", env: { A: 1 } },
      { script: "1", timeout_ms: 0 },
      { script: "1", timeoutMs: "abc" },
      { script: "1", cwd: 5 },
    ]) {
      assert.throws(() => testStep(def, ctx(exec), "exec", p), StepError, JSON.stringify(p));
    }
  });

  it("throws when the process capability is not connected", () => {
    assert.throws(() => testStep(def, ctx(), "exec", { script: "1" }), /process capability/);
  });
});

describe("nodejs/install-exec", () => {
  it("installs (cache hit) then executes with the installed node", () => {
    const { calls, exec } = fakeExec((req) => {
      const argv = req.argv ?? [];
      if (req.executable === "/usr/bin/uname") return ok(argv[0] === "-s" ? "Linux\n" : "x86_64\n");
      if (req.executable.endsWith("/bin/node")) {
        return argv[0] === "--version" ? ok("v24.16.0\n") : ok("ran\n");
      }
      return { exitCode: 99, stdout: "", stderr: "unhandled" };
    });
    const res = testStep(def, ctx(exec), "install-exec", {
      "node-version": "24.16.0",
      "install-dir": "/opt/tools",
      script: "console.log('ran')",
    });
    assert.equal(res.success, true);
    const out = res.output as Record<string, unknown>;
    assert.deepEqual(out, {
      path: "/opt/tools/node-v24.16.0-linux-x64",
      "node-path": "/opt/tools/node-v24.16.0-linux-x64/bin/node",
      version: "24.16.0",
      exit_code: 0,
      stdout: "ran\n",
      stderr: "",
    });
    const run = calls.find((c) => c.argv?.[0] === "-e")!;
    assert.equal(run.executable, "/opt/tools/node-v24.16.0-linux-x64/bin/node");
  });

  it("skips exec when installation fails", () => {
    const { calls, exec } = installHost({ downloadFails: true });
    const res = testStep(def, ctx(exec), "install-exec", {
      "node-version": "24.16.0",
      script: "console.log(1)",
    });
    assert.equal(res.success, false);
    assert.ok(!calls.some((c) => c.argv?.[0] === "-e"));
  });

  it("preserves a non-zero exec exit code after a successful install", () => {
    const { exec } = fakeExec((req) => {
      const argv = req.argv ?? [];
      if (req.executable === "/usr/bin/uname") return ok(argv[0] === "-s" ? "Linux\n" : "x86_64\n");
      if (req.executable.endsWith("/bin/node")) {
        return argv[0] === "--version"
          ? ok("v24.16.0\n")
          : { exitCode: 4, stdout: "", stderr: "test failed\n" };
      }
      return { exitCode: 99, stdout: "", stderr: "unhandled" };
    });
    const res = testStep(def, ctx(exec), "install-exec", {
      "node-version": "24.16.0",
      file: "test.js",
    });
    assert.equal(res.success, false);
    assert.equal((res.output as Record<string, unknown>)["exit_code"], 4);
  });

  it("rejects unknown keys (including node-path) and bad install params", () => {
    const { exec } = installHost({ cached: true });
    for (const p of [
      { "node-version": "24.16.0", script: "1", "node-path": "/usr/bin/node" },
      { "node-version": "24.16.0", script: "1", shell: true },
      { "node-version": "nope", script: "1" },
      { "node-version": "24.16.0" },
    ]) {
      assert.throws(() => testStep(def, ctx(exec), "install-exec", p), StepError, JSON.stringify(p));
    }
  });
});

// ---------------------------------------------------------------------------
// Settings (RFC 009): extensions[nodejs] > variables[nodejs] > library with
// > built-in defaults; explicit step `with:` wins over everything.
// ---------------------------------------------------------------------------

function settingsCtx(
  exec: HostExec | undefined,
  settings: { extensions?: Record<string, unknown>; variables?: Record<string, unknown> },
): StepCtx {
  const c = ctx(exec);
  c.settings = {
    vus: null,
    duration_ms: null,
    seed: null,
    stages: null,
    arrival: null,
    variables: settings.variables ?? {},
    extensions: settings.extensions ?? {},
  };
  return c;
}

/** Reset library-level `with:` defaults so module state never leaks between tests. */
function resetLibraryWith() {
  def.init?.(null);
}

describe("nodejs settings", () => {
  it("install takes node-version and install-dir from extensions[nodejs]", () => {
    resetLibraryWith();
    const { calls, exec } = installHost();
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { nodejs: { "node-version": "24.16.0", "install-dir": "/opt/ext" } } }),
      "install",
      {},
    );
    assert.equal(res.success, true);
    assert.equal(
      (res.output as Record<string, unknown>)["node-path"],
      "/opt/ext/node-v24.16.0-linux-x64/bin/node",
    );
    assert.ok(calls.some((c) => c.argv?.includes("/opt/ext/.node-v24.16.0-linux-x64.tar.xz")));
  });

  it("explicit step params beat the run extension", () => {
    resetLibraryWith();
    const { exec } = installHost();
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { nodejs: { "install-dir": "/opt/ext" } } }),
      "install",
      { "node-version": "24.16.0", "install-dir": "/opt/step" },
    );
    assert.equal(res.success, true);
    assert.equal(
      (res.output as Record<string, unknown>)["node-path"],
      "/opt/step/node-v24.16.0-linux-x64/bin/node",
    );
  });

  it("variables[nodejs] apply when no extension, library with applies below variables", () => {
    def.init?.({ "install-dir": "/opt/lib", "node-version": "24.16.0" });
    try {
      const { exec } = installHost();
      const res = testStep(
        def,
        settingsCtx(exec, { variables: { nodejs: { "install-dir": "/opt/vars" } } }),
        "install",
        {},
      );
      assert.equal(res.success, true);
      assert.equal(
        (res.output as Record<string, unknown>)["node-path"],
        "/opt/vars/node-v24.16.0-linux-x64/bin/node",
      );
    } finally {
      resetLibraryWith();
    }
  });

  it("library with defaults apply when run settings are silent", () => {
    def.init?.({ "install-dir": "/opt/lib", "node-version": "24.16.0" });
    try {
      const { exec } = installHost();
      const res = testStep(def, settingsCtx(exec, {}), "install", {});
      assert.equal(res.success, true);
      assert.equal(
        (res.output as Record<string, unknown>)["node-path"],
        "/opt/lib/node-v24.16.0-linux-x64/bin/node",
      );
    } finally {
      resetLibraryWith();
    }
  });

  it("exec merges env in precedence order: step > extension > variables > library with", () => {
    def.init?.({ env: { A: "lib", B: "lib", C: "lib", D: "lib" } });
    try {
      const { calls, exec } = fakeExec(() => ok());
      const res = testStep(
        def,
        settingsCtx(exec, {
          variables: { nodejs: { env: { B: "vars", C: "vars", D: "vars" } } },
          extensions: { nodejs: { env: { C: "ext", D: "ext" }, cwd: "/ext/cwd", timeout_ms: 5000 } },
        }),
        "exec",
        { script: "1", env: { D: "step" } },
      );
      assert.equal(res.success, true);
      const run = calls.find((c) => c.executable.endsWith("/node"))!;
      assert.equal(run.env?.A, "lib");
      assert.equal(run.env?.B, "vars");
      assert.equal(run.env?.C, "ext");
      assert.equal(run.env?.D, "step");
      assert.equal(run.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(run.cwd, "/ext/cwd");
      assert.equal(run.timeoutMs, 5000);
    } finally {
      resetLibraryWith();
    }
  });

  it("exec takes node-path from settings when the step omits it", () => {
    resetLibraryWith();
    const { calls, exec } = fakeExec(() => ok());
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { nodejs: { "node-path": "/opt/node/bin/node" } } }),
      "exec",
      { script: "1" },
    );
    assert.equal(res.success, true);
    assert.equal(calls[0]!.executable, "/opt/node/bin/node");
  });

  it("rejects invalid settings blocks", () => {
    resetLibraryWith();
    const { exec } = fakeExec(() => ok());
    for (const settings of [
      { extensions: { nodejs: { bogus: 1 } } },
      { extensions: { nodejs: { env: { A: 1 } } } },
      { extensions: { nodejs: { "node-path": "relative/node" } } },
      { extensions: { nodejs: { "node-version": "nope" } } },
      { extensions: { nodejs: { timeout_ms: -5 } } },
      { variables: { nodejs: "not-an-object" } },
      { variables: { nodejs: { cwd: "/a", "working-directory": "/b" } } },
    ]) {
      assert.throws(
        () => testStep(def, settingsCtx(exec, settings), "exec", { script: "1" }),
        StepError,
        JSON.stringify(settings),
      );
    }
  });

  it("rejects an invalid library with block at init", () => {
    assert.throws(() => def.init?.({ "install-dir": 42 }), StepError);
    assert.throws(() => def.init?.({ unknown: true }), StepError);
    resetLibraryWith();
  });
});
