// GoNomicon grader. Runs on a throwaway GitHub Actions VM (free and unmetered for public repos).
// 1. Fetch the job (learner files + tests) from the site, using the shared secret.
// 2. Compile everything with the secret-free toolchain. Learner code does not run yet.
// 3. Run the compiled test binary with no network, as an unprivileged user, with an empty environment.
// 4. Report passed / failed / error back to the site.
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

async function main() {
  const unset = [!SITE && "SITE_URL", SECRET.length < 24 && "GRADER_SECRET (missing or under 24 chars)", !/^[0-9a-f-]{36}$/i.test(ID) && "JOB_ID"].filter(Boolean);
  if (unset.length) { console.error("::error::Grader not configured. Check these GitHub secrets: " + unset.join(", ")); process.exit(1); }
  const job = await api(`/api/grader/job?id=${ID}`);
  if (job.status !== 200) { console.log("job:", job.status, job.body?.error); return; } // already graded or unknown: nothing to report
  const { files, tests, race } = job.body;

  // Sandbox must exist, or we refuse to run learner code at all.
  const probe = run(sudo[0] ?? "unshare", sudo.length ? [...sudo.slice(1), "unshare", "-n", "true"] : ["-n", "true"]);
  const sandboxed = probe.code === 0;
  if (!sandboxed && !ALLOW_UNSANDBOXED) return report("error", "Grader sandbox unavailable. Please submit again later.");

  const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "gnm-"));
  fs.chmodSync(base, 0o755);
  const dirs = Object.fromEntries(["src", "bin", "run", "tmp", "gocache", "gopath"].map((d) => [d, path.join(base, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const put = (root, rel, content) => {
    if (!SAFE.test(rel)) throw new Error(`Unsafe path: ${rel}`);
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  for (const [p, c] of Object.entries(files)) put(dirs.src, p, c);
  for (const [p, c] of Object.entries(tests)) put(dirs.src, p, c);

  // Which tests are hidden? Those defined in hidden test files. We only know them by exclusion from visible ones.
  // The site sends both under `tests`; hidden file names end in _hidden_test.go by convention, but we do not rely on it:
  const hiddenFiles = Object.keys(tests).filter((p) => /hidden/i.test(p));
  const hiddenSet = new Set(hiddenFiles.flatMap((p) => testNames(tests[p])));
  const expected = [...new Set(Object.values(tests).flatMap(testNames))];
  if (!expected.length) return report("error", "This lab has no tests yet. Please report it.");

  // Gate: the compiled binary proves it ran every test to completion.
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

  // ---- build (no learner code runs here) ----
  const buildEnv = { PATH: process.env.PATH, HOME: base, GOCACHE: dirs.gocache, GOPATH: dirs.gopath, GOFLAGS: "-mod=readonly", GOPROXY: "off", GOTOOLCHAIN: "local", GOSUMDB: "off", CGO_ENABLED: race ? "1" : "0", TMPDIR: dirs.tmp };
  const clean = (s) => s.split(dirs.src).join(".").split(base).join("").trim();
  const vet = run("go", ["vet", "-tests=false", "./..."], { cwd: dirs.src, env: buildEnv, timeout: 120_000 });
  if (vet.code !== 0) return report("failed", `Your code has a problem (go vet):\n${clean(vet.out)}`);
  const bin = path.join(dirs.bin, "lab.test");
  const build = run("go", ["test", "-c", ...(race ? ["-race"] : []), "-o", bin, "."], { cwd: dirs.src, env: buildEnv, timeout: 180_000 });
  if (build.code !== 0) return report("failed", `Your code did not compile:\n${clean(build.out)}`);

  // ---- run: learner code executes only here ----
  // The run folder holds the learner's files and fixtures but no test sources (hidden tests live only in the binary).
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

  // Files in run/ belong to the sandbox user, so removing them needs sudo. Best effort: the VM is thrown away anyway.
  run(sudo[0] ?? "rm", sudo.length ? [...sudo.slice(1), "rm", "-rf", base] : ["-rf", base]);
  if (allPass) return report("passed", `All ${expected.length} checks passed.`);

  const lines = [];
  if (ran.code === 124 || ran.code === 137 || /test timed out/.test(ran.out)) lines.push("Your program ran for too long and was stopped. Look for a loop that never ends or waits forever.");
  else if (/^panic:/m.test(ran.out) || /^fatal error:/m.test(ran.out)) lines.push("Your program crashed:", ...ran.out.split("\n").filter((l) => /^(panic|fatal error):|^[\w.\/-]+\.go:\d+/.test(l.trim()) && !/_test\.go|\/usr\/local\/go|\/go[0-9.]+\/src\//.test(l)).slice(0, 8).map(clean));
  if (ran.truncated) lines.push("Your program printed far too much output and was stopped.");
  const vis = failed.filter((n) => !hiddenSet.has(n));
  for (const n of vis) lines.push(`FAIL ${n}`, ...results[n].log.slice(0, 14).map(clean));
  const hid = [...failed, ...missing].filter((n) => hiddenSet.has(n));
  if (hid.length) lines.push(`${hid.length} hidden check${hid.length > 1 ? "s" : ""} failed. These run your code on different inputs than the visible test, so look for edge cases: empty input, one item, repeated values, odd spacing.`);
  if (missing.some((n) => !hiddenSet.has(n)) || (!lines.length && missing.length)) lines.push("Some tests did not finish. Make sure your code returns and does not exit early.");
  if (!lines.length) lines.push("Your solution did not pass. Run the visible test locally for details.");
  lines.push(`\nPassed ${pass.length} of ${expected.length} checks.`);
  return report("failed", lines.join("\n"));
}

main().catch(async (e) => {
  console.error(e);
  try { await report("error", "Grader hit an internal error. Please submit again."); } catch { /* the site's cleanup marks stuck jobs as errors */ }
  process.exit(0);
});
