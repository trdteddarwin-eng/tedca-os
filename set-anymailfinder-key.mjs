#!/usr/bin/env node
// Rotate the AnyMailFinder API key WITHOUT it ever passing through the chat.
//
// Usage:
//   1. Copy the new AnyMailFinder key to the clipboard (Cmd-C).
//   2. Run:  node "/Users/yoljean/Downloads/Ted Workspace/tedca-os/set-anymailfinder-key.mjs"
//   3. Restart the stack:  bash "/Users/yoljean/Downloads/Ted Workspace/tedca-os/dev.sh"
//
// The key goes clipboard -> tedca-os/.env AND -> the keystore (server/data/api_keys.json).
// Both are written because keys.js prefers the STORE once a key has been rotated in-OS,
// but re-seeds from env when it never has. Writing both means it takes effect either way.
// The key is NEVER printed (only the last 4 chars).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const dir = import.meta.dirname; // tedca-os/
const envPath = path.join(dir, ".env");

// 1. read the clipboard (macOS pbpaste). The value stays in this process only.
let key = "";
try {
  key = execSync("pbpaste", { encoding: "utf8" }).trim();
} catch {
  console.error("Could not read the clipboard. Copy the key first, then re-run.");
  process.exit(1);
}

// 2. sanity-check shape. AnyMailFinder keys have no fixed prefix, so we only reject
//    things that obviously are not a key rather than guessing a format.
if (!key || key.length < 20 || /\s/.test(key)) {
  console.error(
    `That clipboard value doesn't look like an API key (${key.length} chars${/\s/.test(key) ? ", contains whitespace" : ""}).`
  );
  console.error("Copy the new key and try again. Nothing was changed.");
  process.exit(1);
}

// 3. LIVE test BEFORE writing anything — a dead key should never replace a live one.
console.log("Testing the key against the AnyMailFinder account endpoint…");
let credits = null;
try {
  const res = await fetch("https://api.anymailfinder.com/v5.1/account", {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.error(`❌ AnyMailFinder rejected the key (HTTP ${res.status}). Nothing was changed.`);
    if (res.status === 401) console.error("   401 = bad/expired key. Check you copied the whole thing.");
    if (res.status === 402) console.error("   402 = key is valid but the account has no credits.");
    process.exit(1);
  }
  const j = await res.json();
  credits = j?.credits_left ?? j?.data?.credits_left ?? null;
  console.log(`✅ key accepted${credits != null ? ` — ${credits} credits left` : ""}.`);
} catch (e) {
  console.error(`❌ could not reach AnyMailFinder: ${String(e.message).slice(0, 160)}`);
  console.error("   Nothing was changed. Check your connection and re-run.");
  process.exit(1);
}

// 4. write tedca-os/.env, preserving every other line
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const line = `ANYMAILFINDER_API_KEY=${key}`;
if (/^ANYMAILFINDER_API_KEY=.*$/m.test(env)) {
  env = env.replace(/^ANYMAILFINDER_API_KEY=.*$/m, line);
} else {
  if (env.length && !env.endsWith("\n")) env += "\n";
  env += line + "\n";
}
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log(`✅ wrote ANYMAILFINDER_API_KEY to tedca-os/.env  (ends …${key.slice(-4)}, ${key.length} chars)`);

// 5. write the keystore too, so a previously-rotated store cannot shadow the new key
try {
  const { setKeys } = await import(path.join(dir, "server/src/keys.js"));
  const info = setKeys("anymailfinder", { primary: key });
  console.log(`✅ keystore updated — active=${info.active}, primary=${info.masked_primary}`);
} catch (e) {
  console.log(`⚠️  .env written, but the keystore update failed: ${String(e.message).slice(0, 160)}`);
  console.log("   The env value will still be picked up if this key was never rotated in-OS.");
}

console.log('\nNow restart so the server loads it:\n  bash "' + path.join(dir, "dev.sh") + '"');
