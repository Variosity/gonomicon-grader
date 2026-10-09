// Mock of the site's grader routes. Serves a lab parsed from a gen.mjs response file.
import http from "node:http";
import fs from "node:fs";
const [,, resp, which, port] = process.argv; // which: solution | starter | <path to a custom answer file>
const txt = fs.readFileSync(resp, "utf8");
const parts = {}; const re = /^===(STARTER|VISIBLE_TEST|HIDDEN_TEST|SOLUTION) (\S+)===\n/gm; let m, last = null;
const idx = [];
while ((m = re.exec(txt))) idx.push({ role: m[1], path: m[2], start: re.lastIndex, head: m.index });
const endAt = txt.indexOf("===END===");
idx.forEach((e, i) => { e.body = txt.slice(e.start, (idx[i + 1]?.head ?? endAt)).replace(/\n+$/, "\n"); });
const files = {}, tests = {}, sol = {};
for (const e of idx) (e.role === "STARTER" ? files : e.role === "SOLUTION" ? sol : tests)[e.path] = e.body;
const student = which === "solution" ? sol : which === "starter" ? Object.fromEntries(Object.keys(sol).map((p) => [p, files[p]])) : Object.fromEntries(Object.keys(sol).map((p) => [p, fs.readFileSync(which, "utf8")]));
const SECRET = "s".repeat(32);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401); return res.end("{}"); }
  if (u.pathname === "/api/grader/job") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ lab: "t/1", race: false, files: { ...files, ...student, "go.mod": "module gonomicon/lab\n\ngo 1.22\n" }, tests })); }
  if (u.pathname === "/api/grader/report") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { fs.writeFileSync(process.env.OUT, b); res.setHeader("content-type", "application/json"); res.end("{}"); }); return; }
  res.writeHead(404); res.end("{}");
}).listen(+port, "127.0.0.1");
