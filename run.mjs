// GoNomicon grader. Runs on a throwaway GitHub Actions VM (free and unmetered for public repos).
// 1. Fetch the job (learner files + tests) from the site, using the shared secret.
// 2. Detect which language family the submission is (purely from file extensions —
//    no DB schema change needed; see detectFamily()).
// 3. Grade it with that family's runner, all inside the same sandbox: an unprivileged
//    user, no network, resource limits, a wall-clock timeout, output capped.
// 4. Report passed / failed / error back to the site.
//
// Go submissions (including shell labs, which are Go tests shelling out to the
// student's script) keep the exact original two-phase flow: compile first (no
// learner code runs), then run only the compiled binary inside the sandbox, gated
// by a cryptographic proof-of-completion written by TestMain itself.
//
// JS/TS/React/Node-API/SQL/Mongo (Vitest), Python/FastAPI/Django (pytest), and
// PHP (Pest) are interpreted: the moment the test command starts, the learner's
// code is already executing (import/require time), so there is no safe
// "compile first" split for them the way Go's test binary allows. Instead the
// *entire* interpreter invocation runs inside the sandbox. This is a materially
// different, and slightly weaker, anti-cheat posture than Go's proof-of-completion
// gate — see the comment on KNOWN LIMITATION near reportFamilyResult() — but the
// sandbox itself (no network, unprivileged uid, resource limits, timeout, output
// cap) applies identically to all five languages.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SITE = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.GRADER_SECRET ?? "";
const ID = process.env.JOB_ID ?? "";
const ALLOW_UNSANDBOXED = process.env.GRADER_ALLOW_UNSANDBOXED === "1"; // local testing only
const SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*(\/[A-Za-z0-9_][A-Za-z0-9_.\-]*){0,3}$/;
const isRoot = process.getuid?.() === 0;
const sudo = isRoot ? [] : ["sudo", "-n"];

// Runtime dependency caches, built once per CI run by grade.yml (npm ci / pip
// install / composer install), each keyed off a committed manifest in this repo
// so GitHub Actions' cache action can skip the install when the lockfile hasn't
// changed. See runtime/js, runtime/py, runtime/php and RUNTIME_SETUP.md.
const RUNTIME_JS = path.join(process.cwd(), "runtime", "js");
const RUNTIME_PY = path.join(process.cwd(), "runtime", "py"); // a venv; python at RUNTIME_PY/bin/python
const RUNTIME_PHP = path.join(process.cwd(), "runtime", "php");

async function api(p, init = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SITE + p, { ...init, headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" } });
      if (r.status < 500) return { status: r.status, body: await r.json().catch(() => ({})) };
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}

const report = (status, output) => api("/api/grader/report", { method: "POST", body: JSON.stringify({ id: ID, status, output: String(output).slice(0, 3000) }) });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 4_000_000, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

// Runs a command with an output cap and a wall-clock limit. Resolves with { code, out, truncated }.
function runCapped(cmd, args, opts, capBytes = 200_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", truncated = false;
    const take = (d) => { if (out.length < capBytes) out += d.toString("utf8"); else if (!truncated) { truncated = true; p.kill("SIGKILL"); } };
    p.stdout.on("data", take); p.stderr.on("data", take);
    p.on("error", () => resolve({ code: 127, out, truncated }));
    p.on("close", (code) => resolve({ code: code ?? 1, out, truncated }));
  });
}

// ---------- shared scratch-dir / sandbox plumbing (used by every family) ----------
function newBase() {
  const base = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "gnm-"));
  fs.chmodSync(base, 0o755);
  const dirs = Object.fromEntries(["src", "bin", "run", "tmp", "gocache", "gopath"].map((d) => [d, path.join(base, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { base, dirs };
}
function put(root, rel, content) {
  if (!SAFE.test(rel)) throw new Error(`Unsafe path: ${rel}`);
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
// Shells out to `cp -r` rather than fs.cpSync: Node's cpSync silently
// resolves a relative symlink (e.g. node_modules/.bin/vitest -> ../vitest/vitest.mjs)
// into an absolute one pointing back at the SOURCE tree, which then has to stay
// reachable (and traversable by the sandboxed "nobody" user) for the copy to work
// at all. `cp -r` preserves the symlink's original relative text, so the copy is
// actually self-contained.
const copyRuntime = (from, to) => { if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); run("cp", ["-r", from, to]); } };
const clean = (dirs, base) => (s) => s.split(dirs.src).join(".").split(base).join("").trim();

// Runs `cmd args` fully inside the sandbox: unprivileged user, no network,
// resource-limited, wall-clock-timed-out, output capped. Used for every
// interpreted family (js/py/php) because their test runner starts executing
// the learner's submitted code from the moment the process starts (module
// import / require / class autoload), so — unlike Go — there is no safe
// "compile only" phase to run outside the sandbox first.
async function runSandboxed(cwd, cmd, args, { sandboxed, dirs }, timeoutSec = 40) {
  if (sandboxed) run(sudo[0] ?? "chown", sudo.length ? [...sudo.slice(1), "chown", "-R", "65534:65534", cwd, dirs.tmp] : ["-R", "65534:65534", cwd, dirs.tmp]);
  else fs.chmodSync(dirs.tmp, 0o777);
  run("chmod", ["-R", "a+rX", cwd]);
  const inner = ["timeout", "-k", "2", String(timeoutSec), "env", "-i", `PATH=${process.env.PATH}`, `HOME=${dirs.tmp}`, `TMPDIR=${dirs.tmp}`, "LC_ALL=C", cmd, ...args];
  const limits = ["prlimit", "--nproc=512", "--nofile=1024", "--fsize=50000000", "--"];
  const full = sandboxed
    ? [...sudo, "unshare", "-n", "--", "setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", "--", ...limits, ...inner]
    : inner;
  return runCapped(full[0], full.slice(1), { cwd }, 300_000);
}

// ---------- family detection: purely from file names, no DB/schema change needed ----------
// gen-fullstack.mjs's per-language file-naming convention (see outputFormatBlock
// in curriculum/gen-fullstack.mjs) makes every family's test files unambiguous.
function detectFamily(files, tests) {
  const names = [...Object.keys(files ?? {}), ...Object.keys(tests ?? {})];
  if (names.some((n) => n.endsWith("_test.go"))) return "go"; // Go track + shell labs (shell tests ARE Go tests)
  if (names.some((n) => /\.(c|h)$/.test(n))) return "c";
  if (names.some((n) => /Test\.php$/.test(n))) return "php";
  if (names.some((n) => /^test_.*\.py$/.test(n) || /_test\.py$/.test(n))) return "py";
  return "js"; // .test.ts/.test.tsx/.test.js/.hidden.test.* and file-kind labs (config parsed by a Vitest test)
}

// ---------- lightweight JUnit XML parsing (shared by pytest and Pest) ----------
// Avoids pulling in an XML library for a well-known, simple, framework-emitted
// format. Returns [{ name, status: "pass"|"fail", message }].
function parseJUnit(xml) {
  const cases = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = caseRe.exec(xml))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/) ?? [, "?"])[1];
    const classname = (attrs.match(/\bclassname="([^"]*)"/) ?? [, ""])[1];
    const body = m[3] ?? "";
    const failed = /<failure\b|<error\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    const msg = (body.match(/<(?:failure|error)[^>]*(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/(?:failure|error)>/) ?? [, "", ""]);
    const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    cases.push({ name: classname ? `${classname}::${name}` : name, status: skipped ? "skip" : failed ? "fail" : "pass", message: unescape(msg[1] || msg[2] || "").slice(0, 600) });
  }
  return cases;
}

// A hidden test's identity is "defined in a file whose name marks it hidden" —
// same convention run.mjs already used for Go (filenames containing "hidden",
// case-insensitive), kept identical here for every family.
const isHiddenFile = (p) => /hidden/i.test(p);

// Builds the common pass/fail message, Go-style: visible failures shown in
// full, hidden failures collapsed to a count with a nudge toward edge cases,
// never leaking hidden test source or exact hidden assertions to the learner.
function summarize(cases, hiddenPaths, rawOut, { truncated, timedOut, crashed } = {}) {
  if (!cases.length) {
    const lines = [];
    if (timedOut) lines.push("Your program ran for too long and was stopped. Look for a loop that never ends or waits forever.");
    else if (crashed) lines.push("Your submission crashed before any test could run:", ...rawOut.split("\n").slice(0, 12));
    else lines.push("No test results were produced. Your submission likely has a syntax error or failed to import:", ...rawOut.split("\n").slice(-20));
    if (truncated) lines.push("Your program printed far too much output and was stopped.");
    return { allPass: false, message: lines.join("\n") };
  }
  const isHidden = (name) => hiddenPaths.some((p) => name.includes(p) || name.includes(p.replace(/\.(py|php|ts|tsx|js|jsx)$/, "")));
  const pass = cases.filter((c) => c.status === "pass");
  const failed = cases.filter((c) => c.status === "fail");
  const missing = cases.filter((c) => c.status === "skip");
  const allPass = !failed.length && !missing.length && pass.length > 0;
  if (allPass) return { allPass: true, message: `All ${cases.length} checks passed.` };
  const lines = [];
  const visFail = failed.filter((c) => !isHidden(c.name));
  for (const c of visFail) lines.push(`FAIL ${c.name}`, c.message || "(no details)");
  const hidFail = [...failed, ...missing].filter((c) => isHidden(c.name));
  if (hidFail.length) lines.push(`${hidFail.length} hidden check${hidFail.length > 1 ? "s" : ""} failed. These run your code on different inputs than the visible test, so look for edge cases: empty input, one item, repeated values, odd spacing.`);
  if (truncated) lines.push("Your program printed far too much output and was stopped.");
  if (!lines.length) lines.push("Your solution did not pass. Run the visible test locally for details.");
  lines.push(`\nPassed ${pass.length} of ${cases.length} checks.`);
  return { allPass: false, message: lines.join("\n") };
}

// ============================== Go (unchanged) ==============================
const testNames = (src) => [...src.matchAll(/^func (Test[A-Za-z0-9_]*)\(\s*\w+\s+\*testing\.T\s*\)/gm)].map((m) => m[1]);

// Parses `go test -v` output into { name: { status, log } } for top-level tests.
function parseVerbose(out) {
  const res = {}; let cur = null;
  for (const line of out.split("\n")) {
    let m;
    if ((m = line.match(/^=== (?:RUN|CONT|PAUSE)\s+(\S+)$/))) { cur = m[1].includes("/") ? m[1].split("/")[0] : m[1]; res[cur] ??= { status: "run", log: [] }; continue; }
    if ((m = line.match(/^--- (PASS|FAIL|SKIP): (\S+)/))) { const n = m[2].split("/")[0]; if (!m[2].includes("/")) { res[n] ??= { status: "run", log: [] }; res[n].status = m[1].toLowerCase(); } continue; }
    if (cur && /^\s+\S/.test(line)) res[cur].log.push(line);
  }
  return res;
}

async function gradeGo(job, sandboxProbeCode) {
  const { files, tests, race } = job;
  const sandboxed = sandboxProbeCode === 0;
  if (!sandboxed && !ALLOW_UNSANDBOXED) return report("error", "Grader sandbox unavailable. Please submit again later.");

  const { base, dirs } = newBase();
  for (const [p, c] of Object.entries(files)) put(dirs.src, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.src, p, c);

  const hiddenFiles = Object.keys(tests).filter(isHiddenFile);
  const hiddenSet = new Set(hiddenFiles.flatMap((p) => testNames(tests[p])));
  const expected = [...new Set(Object.values(tests).flatMap(testNames))];
  if (!expected.length) return report("error", "This lab has no tests yet. Please report it.");

  const nonce = randomBytes(16).toString("hex");
  const proofPath = path.join(dirs.tmp, "proof");
  const hasMain = Object.values(tests).some((c) => /func TestMain\(/.test(c));
  if (!hasMain) {
    const pkg = Object.values(tests)[0].match(/^package\s+(\w+)/m)?.[1] ?? "lab";
    put(dirs.src, "zz_gate_test.go", `package ${pkg}

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	code := m.Run()
	if code == 0 {
		sum := sha256.Sum256([]byte(${JSON.stringify(nonce + ":ok")}))
		_ = os.WriteFile(${JSON.stringify(proofPath)}, []byte(hex.EncodeToString(sum[:])), 0o644)
	}
	os.Exit(code)
}
`);
  }
  const wantProof = createHash("sha256").update(nonce + ":ok").digest("hex");

  const buildEnv = { PATH: process.env.PATH, HOME: base, GOCACHE: dirs.gocache, GOPATH: dirs.gopath, GOFLAGS: "-mod=readonly", GOPROXY: "off", GOTOOLCHAIN: "local", GOSUMDB: "off", CGO_ENABLED: race ? "1" : "0", TMPDIR: dirs.tmp };
  const cl = clean(dirs, base);
  const vet = run("go", ["vet", "-tests=false", "./..."], { cwd: dirs.src, env: buildEnv, timeout: 120_000 });
  if (vet.code !== 0) return report("failed", `Your code has a problem (go vet):\n${cl(vet.out)}`);
  const bin = path.join(dirs.bin, "lab.test");
  const build = run("go", ["test", "-c", ...(race ? ["-race"] : []), "-o", bin, "."], { cwd: dirs.src, env: buildEnv, timeout: 180_000 });
  if (build.code !== 0) return report("failed", `Your code did not compile:\n${cl(build.out)}`);

  const copy = (from, to) => { for (const e of fs.readdirSync(from, { withFileTypes: true })) { const f = path.join(from, e.name), t = path.join(to, e.name); if (e.isDirectory()) { fs.mkdirSync(t, { recursive: true }); copy(f, t); } else if (!e.name.endsWith("_test.go")) fs.copyFileSync(f, t); } };
  copy(dirs.src, dirs.run);
  fs.copyFileSync(bin, path.join(dirs.run, "lab.test"));
  fs.chmodSync(path.join(dirs.run, "lab.test"), 0o755);
  if (sandboxed) run(sudo[0] ?? "chown", sudo.length ? [...sudo.slice(1), "chown", "-R", "65534:65534", dirs.run, dirs.tmp] : ["-R", "65534:65534", dirs.run, dirs.tmp]);
  else fs.chmodSync(dirs.tmp, 0o777);
  run("chmod", ["-R", "a+rX", dirs.run]);

  const inner = ["timeout", "-k", "2", "25", "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", `HOME=${dirs.tmp}`, `TMPDIR=${dirs.tmp}`, "LC_ALL=C", "./lab.test", "-test.v", "-test.timeout=20s"];
  const limits = ["prlimit", "--nproc=256", "--nofile=512", "--fsize=20000000", "--"];
  const cmd = sandboxed
    ? [...sudo, "unshare", "-n", "--", "setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", "--", ...limits, ...inner]
    : inner;
  const ran = await runCapped(cmd[0], cmd.slice(1), { cwd: dirs.run }, 200_000);

  const proofOk = fs.existsSync(proofPath) && fs.readFileSync(proofPath, "utf8").trim() === wantProof;
  const results = parseVerbose(ran.out);
  const pass = expected.filter((n) => results[n]?.status === "pass");
  const failed = expected.filter((n) => results[n]?.status === "fail");
  const missing = expected.filter((n) => !results[n] || results[n].status === "run" || results[n].status === "skip");
  const allPass = ran.code === 0 && pass.length === expected.length && !failed.length && (hasMain || proofOk);

  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);
  if (allPass) return report("passed", `All ${expected.length} checks passed.`);

  const lines = [];
  if (ran.code === 124 || ran.code === 137 || /test timed out/.test(ran.out)) lines.push("Your program ran for too long and was stopped. Look for a loop that never ends or waits forever.");
  else if (/^panic:/m.test(ran.out) || /^fatal error:/m.test(ran.out)) lines.push("Your program crashed:", ...ran.out.split("\n").filter((l) => /^(panic|fatal error):|^[\w.\/-]+\.go:\d+/.test(l.trim()) && !/_test\.go|\/usr\/local\/go|\/go[0-9.]+\/src\//.test(l)).slice(0, 8).map(cl));
  if (ran.truncated) lines.push("Your program printed far too much output and was stopped.");
  const vis = failed.filter((n) => !hiddenSet.has(n));
  for (const n of vis) lines.push(`FAIL ${n}`, ...results[n].log.slice(0, 14).map(cl));
  const hid = [...failed, ...missing].filter((n) => hiddenSet.has(n));
  if (hid.length) lines.push(`${hid.length} hidden check${hid.length > 1 ? "s" : ""} failed. These run your code on different inputs than the visible test, so look for edge cases: empty input, one item, repeated values, odd spacing.`);
  if (missing.some((n) => !hiddenSet.has(n)) || (!lines.length && missing.length)) lines.push("Some tests did not finish. Make sure your code returns and does not exit early.");
  if (!lines.length) lines.push("Your solution did not pass. Run the visible test locally for details.");
  lines.push(`\nPassed ${pass.length} of ${expected.length} checks.`);
  return report("failed", lines.join("\n"));
}

// ======================= JS/TS/React/Node-API/SQL/Mongo (Vitest) =======================
async function gradeJs(job, sandboxed) {
  const { files, tests } = job;
  if (!fs.existsSync(RUNTIME_JS)) return report("error", "Grader is missing its JS runtime. This is a site configuration problem, not yours — please report it.");
  const { base, dirs } = newBase();
  copyRuntime(path.join(RUNTIME_JS, "node_modules"), path.join(dirs.run, "node_modules"));
  const pkgPath = path.join(RUNTIME_JS, "package.json");
  put(dirs.run, "package.json", fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : JSON.stringify({ type: "module" }));
  const usesDom = Object.keys({ ...files, ...tests }).some((p) => p.endsWith(".tsx"));
  put(dirs.run, "vitest.config.ts", `export default { test: { environment: ${JSON.stringify(usesDom ? "jsdom" : "node")} } };\n`);
  put(dirs.run, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", target: "ES2022", module: "ESNext", moduleResolution: "Bundler", esModuleInterop: true, skipLibCheck: true } }, null, 2));
  for (const [p, c] of Object.entries(files)) put(dirs.run, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.run, p, c);

  const hiddenPaths = Object.keys(tests).filter(isHiddenFile);
  const reportFile = path.join(dirs.tmp, "vitest-report.json");
  const ran = await runSandboxed(dirs.run, "npx", ["vitest", "run", "--reporter=json", `--outputFile=${reportFile}`, "--root", dirs.run], { sandboxed, dirs }, 45);

  let cases = [];
  try {
    const j = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    for (const tf of j.testResults ?? []) for (const a of tf.assertionResults ?? []) {
      // Drop Vitest's own internal stack frames (node_modules/vitest/..., the
      // run-dir's temp path) — the learner only needs their own assertion
      // failure and, where present, the one frame pointing at their file.
      const msg = (a.failureMessages || []).join("\n").split("\n").filter((l) => !/node_modules[/\\]vitest|runWithCancel|at new Promise/.test(l)).join("\n");
      cases.push({ name: `${path.basename(tf.name)}::${a.fullName || a.title}`, status: a.status === "passed" ? "pass" : a.status === "pending" || a.status === "skipped" ? "skip" : "fail", message: msg.slice(0, 500) });
    }
  } catch { /* no report file: crash before Vitest could write one — handled by summarize()'s empty-cases branch */ }

  const timedOut = ran.code === 124 || ran.code === 137;
  const { allPass, message } = summarize(cases, hiddenPaths, ran.out, { truncated: ran.truncated, timedOut, crashed: !cases.length && !timedOut });
  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);
  return report(allPass ? "passed" : "failed", message);
}

// ============================= Python (FastAPI/Django, pytest) =============================
async function gradePy(job, sandboxed) {
  const { files, tests } = job;
  const PY = path.join(RUNTIME_PY, "bin", "python");
  if (!fs.existsSync(PY)) return report("error", "Grader is missing its Python runtime. This is a site configuration problem, not yours — please report it.");
  const { base, dirs } = newBase();
  for (const [p, c] of Object.entries(files)) put(dirs.run, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.run, p, c);

  const hiddenPaths = Object.keys(tests).filter(isHiddenFile);
  const junit = path.join(dirs.tmp, "junit.xml");
  const ran = await runSandboxed(dirs.run, PY, ["-m", "pytest", "-q", `--junitxml=${junit}`], { sandboxed, dirs }, 45);

  let cases = [];
  try { cases = parseJUnit(fs.readFileSync(junit, "utf8")); } catch { /* handled below */ }

  const timedOut = ran.code === 124 || ran.code === 137;
  const { allPass, message } = summarize(cases, hiddenPaths, ran.out, { truncated: ran.truncated, timedOut, crashed: !cases.length && !timedOut });
  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);
  return report(allPass ? "passed" : "failed", message);
}

// ===================================== PHP (Pest) =====================================
async function gradePhp(job, sandboxed) {
  const { files, tests } = job;
  const PEST = path.join(RUNTIME_PHP, "vendor", "bin", "pest");
  if (!fs.existsSync(PEST)) return report("error", "Grader is missing its PHP runtime. This is a site configuration problem, not yours — please report it.");
  const { base, dirs } = newBase();
  copyRuntime(path.join(RUNTIME_PHP, "vendor"), path.join(dirs.run, "vendor"));
  const composerJsonPath = path.join(RUNTIME_PHP, "composer.json");
  if (fs.existsSync(composerJsonPath)) put(dirs.run, "composer.json", fs.readFileSync(composerJsonPath, "utf8"));
  for (const [p, c] of Object.entries(files)) put(dirs.run, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.run, p, c);

  const hiddenPaths = Object.keys(tests).filter(isHiddenFile);
  const junit = path.join(dirs.tmp, "junit.xml");
  const ran = await runSandboxed(dirs.run, "php", [path.join(dirs.run, "vendor", "bin", "pest"), `--log-junit=${junit}`], { sandboxed, dirs }, 45);

  let cases = [];
  try { cases = parseJUnit(fs.readFileSync(junit, "utf8")); } catch { /* handled below */ }

  const timedOut = ran.code === 124 || ran.code === 137;
  const { allPass, message } = summarize(cases, hiddenPaths, ran.out, { truncated: ran.truncated, timedOut, crashed: !cases.length && !timedOut });
  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);
  return report(allPass ? "passed" : "failed", message);
}

// ======================================= C (gcc/clang + sanitizers) =======================================
// The one family with a real compile phase, so it follows Go's pattern: compile
// outside the sandbox (no learner code runs during compilation), then run the
// compiled, sanitizer-instrumented binary inside the sandbox. The sanitizers ARE
// the correctness check here, not an extra — see curriculum/gen-fullstack.mjs's
// validateC() for the authoring-time equivalent of this same logic.
async function gradeC(job, sandboxed) {
  const { files, tests } = job;
  const cc = !run("gcc", ["--version"]).error ? "gcc" : !run("clang", ["--version"]).error ? "clang" : null;
  if (!cc) return report("error", "Grader has no C compiler on PATH. This is a site configuration problem, not yours — please report it.");
  const CFLAGS = ["-std=c17", "-Wall", "-Wextra", "-fsanitize=address,undefined", "-g"];

  const { base, dirs } = newBase();
  for (const [p, c] of Object.entries(files)) put(dirs.run, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.run, p, c);

  const implFiles = Object.keys(files).filter((p) => p.endsWith(".c"));
  const visFiles = Object.keys(tests).filter((p) => !isHiddenFile(p) && p.endsWith(".c"));
  const hidFiles = Object.keys(tests).filter((p) => isHiddenFile(p) && p.endsWith(".c"));
  if (!visFiles.length) return report("error", "This lab has no visible test yet. Please report it.");

  const compileAndRun = async (testFiles, binName) => {
    const bin = path.join(dirs.bin, binName);
    const c = run(cc, [...CFLAGS, ...testFiles, ...implFiles, "-o", bin, "-lpthread"], { cwd: dirs.run, timeout: 60_000 });
    if (c.code !== 0) return { compiled: false, out: c.out };
    fs.chmodSync(bin, 0o755);
    fs.copyFileSync(bin, path.join(dirs.run, binName));
    const ran = await runSandboxed(dirs.run, path.join(dirs.run, binName), [], { sandboxed, dirs }, 30);
    const sanitizerTripped = /ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer|LeakSanitizer)/.test(ran.out);
    return { compiled: true, code: ran.code, sanitizerTripped, out: ran.out, truncated: ran.truncated };
  };

  const vis = await compileAndRun(visFiles, "vis_bin");
  if (!vis.compiled) { run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]); return report("failed", `Your code did not compile:\n${vis.out}`); }
  const visOk = vis.code === 0 && !vis.sanitizerTripped;

  let hid = { compiled: true, code: 0, sanitizerTripped: false, out: "" };
  if (hidFiles.length) hid = await compileAndRun(hidFiles, "hid_bin");
  const hidOk = hid.compiled && hid.code === 0 && !hid.sanitizerTripped;

  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);

  if (visOk && hidOk) return report("passed", "All checks passed.");
  const lines = [];
  if (!visOk) lines.push(vis.sanitizerTripped ? "A sanitizer caught a memory bug:" : "The visible test failed:", vis.out.slice(0, 1200));
  if (hidFiles.length && !hidOk) lines.push(hid.compiled ? (hid.sanitizerTripped ? "A hidden check caught a memory bug. These run your code on different, often larger, inputs than the visible test — look for edge cases and buffer sizes." : "A hidden check failed. These run your code on different inputs than the visible test, so look for edge cases.") : `Your code did not compile against the hidden test:\n${hid.out}`);
  return report("failed", lines.join("\n"));
}

// ============================================= main =============================================
async function main() {
  const unset = [!SITE && "SITE_URL", SECRET.length < 24 && "GRADER_SECRET (missing or under 24 chars)", !/^[0-9a-f-]{36}$/i.test(ID) && "JOB_ID"].filter(Boolean);
  if (unset.length) { console.error("::error::Grader not configured. Check these GitHub secrets: " + unset.join(", ")); process.exit(1); }
  const job = await api(`/api/grader/job?id=${ID}`);
  if (job.status !== 200) { console.log("job:", job.status, job.body?.error); return; } // already graded or unknown: nothing to report
  const { files, tests } = job.body;

  // Sandbox must exist, or we refuse to run learner code at all — for every family.
  const probe = run(sudo[0] ?? "unshare", sudo.length ? [...sudo.slice(1), "unshare", "-n", "true"] : ["-n", "true"]);
  const sandboxed = probe.code === 0;
  if (!sandboxed && !ALLOW_UNSANDBOXED) return report("error", "Grader sandbox unavailable. Please submit again later.");

  const family = detectFamily(files, tests);
  if (family === "go") return gradeGo(job.body, probe.code);
  if (family === "js") return gradeJs(job.body, sandboxed);
  if (family === "py") return gradePy(job.body, sandboxed);
  if (family === "php") return gradePhp(job.body, sandboxed);
  if (family === "c") return gradeC(job.body, sandboxed);
  return report("error", `Grader could not tell what language this lab is (unrecognized file names). Please report it.`);
}

main().catch(async (e) => {
  console.error(e);
  try { await report("error", "Grader hit an internal error. Please submit again."); } catch { /* the site's cleanup marks stuck jobs as errors */ }
  process.exit(0);
});
