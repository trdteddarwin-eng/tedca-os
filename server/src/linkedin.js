// LinkedIn outreach prep: for every lead that has a LinkedIn profile, generate a
// short, personalized connection message and store it on the lead so it's ready
// to copy from the CRM. Generation is cheap (Haiku) and runs in a background loop
// so it never blocks the email pipeline.
//
// IMPORTANT: sending stays MANUAL. LinkedIn's ToS bans automation and will ban
// the account — we only PREPARE the message; you open the profile and send it.
import { db } from "./db.js";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
let logEvent = () => {};
export function bindLinkedInLogger(fn) {
  logEvent = fn;
}

// Returns a <300-char personalized LinkedIn connection note (no links, no dashes).
export async function generateLinkedInMessage(lead) {
  const key = process.env.OPENROUTER_API_KEY || "";
  if (!key) throw new Error("OPENROUTER_API_KEY missing");
  const titleRe = /^(dr|mr|mrs|ms|miss|mx|prof|professor|md|dds|do)\.?$/i;
  const nameParts = String(lead.ceo_name || "").trim().split(/\s+/).filter(Boolean);
  let first = nameParts[0] || "";
  if (titleRe.test(first)) first = nameParts[1] && !titleRe.test(nameParts[1]) ? nameParts[1] : "";
  first = first.replace(/[.,]+$/, "");
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 160,
      messages: [
        {
          role: "user",
          content: `Write a LinkedIn connection-request note to ${first || "the owner"} of "${lead.business_name}", a med spa${lead.city ? ` in ${lead.city}` : ""}. Context: I run database-reactivation campaigns that bring a med spa's past clients back without ad spend (we recently brought back 5 past clients for a med spa in Union NJ in 30 days). RULES: under 280 characters, casual and human, lowercase is fine, NO links, NO em dashes, not salesy or spammy (LinkedIn flags that), mention their business naturally, open a conversation, end with a soft question. Output ONLY the message text, nothing else.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`linkedin gen failed: ${res.status}`);
  const data = await res.json();
  let msg = (data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
  msg = msg.replace(/[—–]/g, "-"); // belt-and-suspenders: no em/en dashes
  if (msg.length > 300) msg = msg.slice(0, 297).trim() + "...";
  return msg;
}

// Background loop: fill in linkedin_message for any verified lead that has a
// profile but no message yet. Small batches so we never burst the LLM API.
export function startLinkedInLoop() {
  setInterval(async () => {
    try {
      // Contacted leads only. (Before the lead queue existed this keyed off
      // email_status='valid', which was fine when leads were verified the same
      // morning they were emailed. Verify-ahead now fills that pool DAYS early,
      // so the old query would draft for hundreds of leads that never get a send.)
      const due = db
        .prepare(
          "SELECT * FROM leads WHERE linkedin_url IS NOT NULL AND linkedin_url!='' AND (linkedin_message IS NULL OR linkedin_message='') AND status IN ('emailed','followup_sent','replied') ORDER BY last_touch_at DESC LIMIT 4"
        )
        .all();
      for (const lead of due) {
        try {
          const msg = await generateLinkedInMessage(lead);
          db.prepare("UPDATE leads SET linkedin_message=? WHERE id=?").run(msg, lead.id);
          logEvent({ actor: "linkedin", message: `LinkedIn message ready for ${lead.business_name} — copy it from the CRM.`, level: "success" });
        } catch (e) {
          logEvent({ actor: "linkedin", message: `Could not draft a LinkedIn message for ${lead.business_name}: ${e.message}`, level: "warn" });
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch {
      /* loop never throws */
    }
  }, 60_000);
}
