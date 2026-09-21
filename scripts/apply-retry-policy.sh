#!/usr/bin/env bash
# apply-retry-policy.sh — make the harness retry EVERY provider failure forever.
#
# Writes `retryPolicy: { mode: always }` into every provider under
# `llm-pi-ai.providers` in ~/.dsh/settings.yaml (idempotent, backs up first).
# mode: always retries all failures (429 RATE_LIMIT, 5xx SERVER, TIMEOUT,
# TRANSPORT, empty responses) with exponential backoff and no retry cap.
# 401/403 auth failures are also retried — pointless for bad keys, so fix the
# key or use `mode: normal` + maxRetries instead.
#
# usage:  bash <(curl -sL https://raw.githubusercontent.com/<user>/dsh-tool-browser/main/scripts/apply-retry-policy.sh)
# env:    DSH_HOME (default ~/.dsh)   DSH_SETTINGS (default $DSH_HOME/settings.yaml)
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "error: node is required (harness machines have it)"; exit 1; }
node - "$@" <<'NODE'
const fs = require("fs");
const path = require("path");
const os = require("os");
const home = process.env.DSH_HOME || os.homedir();
const settings = process.env.DSH_SETTINGS || path.join(home, ".dsh", "settings.yaml");
if (!fs.existsSync(settings)) {
  console.error("settings.yaml not found: " + settings);
  process.exit(1);
}
const lines = fs.readFileSync(settings, "utf8").split("\n");
let secStart = -1;
for (let i = 0; i < lines.length; i++) if (/^llm-pi-ai:\s*$/.test(lines[i])) { secStart = i; break; }
if (secStart === -1) {
  console.error('no "llm-pi-ai:" section in ' + settings + " — cannot locate providers");
  process.exit(1);
}
let secEnd = lines.length;
for (let i = secStart + 1; i < lines.length; i++) if (/^\S/.test(lines[i]) && lines[i].trim() !== "") { secEnd = i; break; }
let provIdx = -1;
for (let i = secStart + 1; i < secEnd; i++) if (/^  providers:\s*$/.test(lines[i])) { provIdx = i; break; }
if (provIdx === -1) {
  console.error('no "providers:" under llm-pi-ai — nothing to patch');
  process.exit(1);
}
const blocks = [];
let cur = null;
for (let i = provIdx + 1; i < secEnd; i++) {
  const m = lines[i].match(/^    ([A-Za-z0-9_.-]+):\s*$/);
  if (m) { if (cur) cur.end = i; cur = { id: m[1], start: i }; blocks.push(cur); }
  else if (cur && /^    /.test(lines[i])) { /* inside block */ }
  else if (cur && lines[i].trim() !== "") { cur.end = i; cur = null; }
}
if (cur) cur.end = secEnd;
if (blocks.length === 0) { console.error("no providers found under llm-pi-ai.providers"); process.exit(1); }
let changed = 0;
const out = [];
let bi = 0;
for (let i = 0; i < lines.length; i++) {
  const b = bi < blocks.length && i === blocks[bi].start ? blocks[bi] : null;
  if (b) {
    out.push(lines[i]);
    const body = lines.slice(b.start + 1, b.end);
    if (body.some((l) => /^      retryPolicy:/.test(l))) {
      console.log("- " + b.id + ": retryPolicy already set, skip");
    } else {
      out.push("      retryPolicy:");
      out.push("        mode: always");
      console.log("+ " + b.id + ": retryPolicy -> { mode: always }");
      changed++;
    }
    i = b.end - 1;
    bi++;
  } else {
    out.push(lines[i]);
  }
}
if (changed === 0) { console.log("nothing to change"); process.exit(0); }
const stamp = String(Date.now());
fs.copyFileSync(settings, settings + ".bak-" + stamp);
fs.writeFileSync(settings, out.join("\n"));
console.log("backup: " + settings + ".bak-" + stamp);
console.log("updated " + changed + " provider(s). Restart dsh (or its web service) to apply.");
NODE
