// One-shot: copy required env vars from local .env files to the Railway service.
// Values are passed straight to the CLI, never printed.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RW = "/Users/yoljean/.npm-global/bin/railway";

function parseEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* missing file */
  }
  return out;
}

const local = parseEnv(path.join(here, ".env"));
const workspace = parseEnv(path.join(here, "..", ".env"));

const WANTED = {
  OS_PASSWORD: local.OS_PASSWORD,
  WORKER_TOKEN: local.WORKER_TOKEN,
  GMAIL_OAUTH_CLIENT_ID: local.GMAIL_OAUTH_CLIENT_ID,
  GMAIL_OAUTH_CLIENT_SECRET: local.GMAIL_OAUTH_CLIENT_SECRET,
  INBOXES: local.INBOXES,
  TEST_RECIPIENT: local.TEST_RECIPIENT,
  OPENROUTER_API_KEY: workspace.OPENROUTER_API_KEY,
  ANYMAILFINDER_API_KEY: workspace.ANYMAILFINDER_API_KEY,
  TELEGRAM_BOT_TOKEN: workspace.TELEGRAM_BOT_TOKEN,
  ELEVENLABS_API_KEY: workspace.ELEVENLABS_API_KEY,
  TELEGRAM_CHAT_ID: workspace.TELEGRAM_CHAT_ID,
  PATIENT_ENGINE_URL: workspace.PATIENT_ENGINE_URL || "https://tedca-patient-engine.vercel.app",
};

const args = ["variables", "--service", "tedca-os", "--skip-deploys"];
const missing = [];
for (const [k, v] of Object.entries(WANTED)) {
  if (!v) {
    missing.push(k);
    continue;
  }
  args.push("--set", `${k}=${v}`);
}

execFileSync(RW, args, { cwd: here, stdio: ["ignore", "ignore", "inherit"] });
console.log("set:", Object.keys(WANTED).filter((k) => WANTED[k]).join(", "));
if (missing.length) console.log("MISSING (not set):", missing.join(", "));
