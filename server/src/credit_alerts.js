// Telegram alerts when a paid lead-gen key stops working (out of credit / rejected).
// Wired into the two choke points: scrape.js (Apify) and anymailfinder.js (AnyMailFinder).
// Debounced in-memory (6h per service) so a run that hits the wall 100x doesn't send 100
// Telegram messages. Resets on restart — a fresh restart re-alerting once is fine (even useful).
import { sendTelegram } from "./telegram.js";

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // one alert per service per 6h
const lastAlert = new Map(); // service -> ms timestamp

const LABEL = {
  apify: "Apify (Google-Maps lead scraper)",
  anymailfinder: "AnyMailFinder (owner-email finder)",
};

// status 402 = out of credit; 401/403 = key rejected/expired. Both block lead-gen.
export async function alertCreditOut(service, status, detail = "") {
  const now = Date.now();
  if (now - (lastAlert.get(service) || 0) < COOLDOWN_MS) return; // debounced
  lastAlert.set(service, now);
  const label = LABEL[service] || service;
  const reason = status === 402 ? "is OUT OF CREDIT" : `key was rejected (HTTP ${status})`;
  const msg =
    `🛑 ${label} ${reason}.\n\n` +
    `New leads are BLOCKED until it's topped up or a new key is set — the cold-email machine will keep sending follow-ups but can't find new prospects.\n\n` +
    (detail ? `Details: ${detail}\n\n` : "") +
    `Fix: add credit at the provider, then set the new key on the OS API Keys page (or paste it and I'll wire it in).`;
  await sendTelegram(msg);
}
