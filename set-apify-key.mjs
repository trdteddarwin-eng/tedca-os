#!/usr/bin/env node
// Update the Apify API key WITHOUT it ever passing through the chat.
//
// Usage:
//   1. Copy your new Apify key to the clipboard (Cmd-C).
//   2. Run:  node "/Users/yoljean/Downloads/Ted Workspace/tedca-os/set-apify-key.mjs"
//   3. Restart the stack:  bash "/Users/yoljean/Downloads/Ted Workspace/tedca-os/dev.sh"
//
// The key goes clipboard -> tedca-os/.env. It is NEVER printed (only last 4 chars),
// so it does not appear in this terminal session or the assistant's view.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const dir = import.meta.dirname; // tedca-os/
const envPath = path.join(dir, ".env"); // loaded LAST by dev.sh, so it overrides the workspace .env

// 1. read the clipboard (macOS pbpaste). The value stays in this process only.
let key = "";
try {
  key = execSync("pbpaste", { encoding: "utf8" }).trim();
} catch {
  console.error("Could not read the clipboard. Copy the key first, then re-run.");
  process.exit(1);
}

// 2. validate it looks like an Apify token
if (!/^apify_api_[A-Za-z0-9]+$/.test(key)) {
  console.error(
    `That clipboard value doesn't look like an Apify key (expected "apify_api_…", got ${key.length} chars).`
  );
  console.error("Copy the new key and try again. Nothing was changed.");
  process.exit(1);
}

// 3. surgically set APIFY_API_TOKEN in tedca-os/.env, preserving every other line
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const line = `APIFY_API_TOKEN=${key}`;
if (/^APIFY_API_TOKEN=.*$/m.test(env)) {
  env = env.replace(/^APIFY_API_TOKEN=.*$/m, line);
} else {
  if (env.length && !env.endsWith("\n")) env += "\n";
  env += line + "\n";
}
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log(`✅ wrote APIFY_API_TOKEN to tedca-os/.env  (key ends …${key.slice(-4)}, ${key.length} chars)`);

// 4. live test: a 1-result scrape proves the new key actually has scraping allowance
process.env.APIFY_API_TOKEN = key;
try {
  const { scrapeGoogleMaps } = await import(path.join(dir, "server/src/scrape.js"));
  const items = await scrapeGoogleMaps("med spa in Paramus NJ", 1);
  if (items.length) {
    console.log(`✅ test scrape OK — pulled "${items[0].title || items[0].name}". The key works.`);
  } else {
    console.log("⚠️  key accepted but the test returned 0 results — check the geo settings.");
  }
} catch (e) {
  console.log(`⚠️  key saved, but the test scrape failed: ${String(e.message).slice(0, 160)}`);
  console.log("   (If it's a 402, this account also has no scraping allowance.)");
}

console.log('\nNow restart so the server loads it:\n  bash "' + path.join(dir, "dev.sh") + '"');
