// Insert a realistic demo lead + timeline so we can preview the CRM detail view
// and the Obsidian card. Prints the lead id. Cleaned up by demo-crm-clean.mjs.
import { db } from "../src/db.js";
import { leadToCard } from "../src/obsidian.js";
import fs from "node:fs";

db.prepare("DELETE FROM emails WHERE lead_id IN (SELECT id FROM leads WHERE email='owner@bergenglow.example')").run();
db.prepare("DELETE FROM leads WHERE email='owner@bergenglow.example'").run();

const info = db.prepare(`INSERT INTO leads
  (business_name, domain, category, rating, review_count, website, ceo_name, contact_title,
   email, email_status, phone, linkedin_url, city, state, source, status, stage, sentiment,
   inbox_used, last_touch_at, followup_due_at, notes, tags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now','+3 days'),?,?)`).run(
  "Bergen Glow Med Spa", "bergenglow.com", "med spa", 4.8, 212, "https://bergenglow.com",
  "Jamie Rivera", "Owner", "owner@bergenglow.example", "valid", "(201) 555-0142",
  "https://linkedin.com/in/jamie-rivera", "Paramus", "NJ", "google_maps", "replied", "replied",
  "interested", "april@outreachopszone.co", "warm lead — wants the 90s video, asked about pricing", "medspa,hot"
);
const id = Number(info.lastInsertRowid);

db.prepare("INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?,?,?,?,?,?,datetime('now','-2 days'))")
  .run(id, "april@outreachopszone.co", "out", "quick question about Bergen Glow Med Spa", "hey Jamie, saw Bergen Glow on google…", "initial");
db.prepare("INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?,?,?,?,?,?,datetime('now','-1 days'))")
  .run(id, "april@outreachopszone.co", "in", "Re: quick question about Bergen Glow Med Spa", "yeah this is interesting, can you send the video and pricing?", "reply");
db.prepare("INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?,?,?,?,?,?,datetime('now','-1 days'))")
  .run(id, "april@outreachopszone.co", "out", "Re: quick question about Bergen Glow Med Spa", "hey! absolutely, here's the video: [link]…", "reply");

// preview the Obsidian card to .tmp (NOT brain/) so the format can be reviewed first
const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
const emails = db.prepare("SELECT * FROM emails WHERE lead_id=? ORDER BY id").all(id);
fs.mkdirSync("/Users/yoljean/Downloads/Ted Workspace/.tmp", { recursive: true });
fs.writeFileSync("/Users/yoljean/Downloads/Ted Workspace/.tmp/sample-client-card.md", leadToCard(lead, emails));

console.log(`demo lead id=${id} inserted with ${emails.length} messages`);
console.log("Obsidian card preview → .tmp/sample-client-card.md");
