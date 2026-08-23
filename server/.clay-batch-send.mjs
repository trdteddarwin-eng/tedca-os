// One-off batch: send the Clay-sourced med spa leads from the 12 Zapmail inboxes.
// DRY RUN unless invoked with --send.
import fs from "node:fs";
import { sendEmailSMTP, smtpFirstName } from "./src/smtp.js";

const SEND = process.argv.includes("--send");
let leads = JSON.parse(fs.readFileSync("/tmp/clay-leads-clean.json", "utf8"));

// Trim: drop the name-mismatched address, then one contact per company
// (list is already sorted hook-first, so the triggered contact wins).
leads = leads.filter((l) => l.email !== "logan@drvitenas.com");
const takenCompany = new Set();
leads = leads.filter((l) => {
  const k = l.company.toLowerCase().trim();
  if (takenCompany.has(k)) return false;
  takenCompany.add(k);
  return true;
});

const INBOXES = [
  "joanna@mymyaigen.co", "beverly@myoutreachart.co", "beth@outreachopszone.co",
  "rex@tryforgestack.co", "andrea@myoutreachart.co", "anna@outreachopszone.co",
  "april@outreachopszone.co", "brandon@tryforgestack.co", "crystal@myoutreachart.co",
  "elaine@mymyaigen.co", "victor@tryforgestack.co", "aileen@mymyaigen.co",
];

const FOOTER = [
  "",
  "Tedca - 157 Harper Ave, Irvington, NJ 07111",
  'Not interested? Reply "unsubscribe" and you\'re off the list.',
].join("\n");

const first = (n) => n.replace(/,.*$/, "").replace(/^Dr\.?\s+/i, "").trim().split(/\s+/)[0];

function build(lead, persona) {
  const fn = first(lead.full_name);
  const co = lead.company;
  const role = (lead.hooks || [])[0];
  if (role) {
    const r = role.replace(/\s*-.*$/, "").trim().toLowerCase();
    return {
      subject: "your front desk opening",
      body: [
        `hey ${fn},`, "",
        `saw you're hiring a ${r}. usually that means the phones and the rebooking have gotten ahead of the team.`, "",
        "before you add another seat, one thing worth a look. i rebook past clients who drifted off, using the list you already have. ran it for a spa in Union NJ and got 5 of their past clients back on the books inside a month.", "",
        "it's fully performance based, so you only pay when someone actually rebooks.", "",
        `want me to send a two minute video showing how it'd work for ${co}?`, "",
        persona, "tedca.org", FOOTER,
      ].join("\n"),
    };
  }
  return {
    subject: `past clients at ${co}`,
    body: [
      `hey ${fn},`, "",
      `looks like ${co} is growing. the thing that usually gets missed in that stretch is the patients who came once and quietly stopped booking.`, "",
      "i reactivate those, using the list you already have. did it for a spa in Union NJ and got 5 of their past clients back on the books inside a month.", "",
      "fully performance based, so you only pay when someone rebooks.", "",
      "worth a two minute video showing how it'd work?", "",
      persona, "tedca.org", FOOTER,
    ].join("\n"),
  };
}

const plan = leads.map((l, i) => {
  const inbox = INBOXES[i % INBOXES.length];
  const persona = smtpFirstName(inbox) || "Ted";
  return { ...l, inbox, persona, ...build(l, persona) };
});

if (!SEND) {
  console.log(`DRY RUN — ${plan.length} emails across ${new Set(plan.map(p => p.inbox)).size} inboxes\n`);
  for (const p of plan) console.log(`${p.inbox.padEnd(26)} -> ${p.email.padEnd(34)} | ${p.subject}`);
  console.log("\n\n===== SAMPLE 1 (front-desk hook) =====\n");
  const a = plan.find(p => p.hooks && p.hooks.length);
  console.log(`From: ${a.inbox}\nTo: ${a.email}\nSubject: ${a.subject}\n\n${a.body}`);
  console.log("\n\n===== SAMPLE 2 (no hook) =====\n");
  const b = plan.find(p => !(p.hooks && p.hooks.length));
  console.log(`From: ${b.inbox}\nTo: ${b.email}\nSubject: ${b.subject}\n\n${b.body}`);
  fs.writeFileSync("/tmp/clay-send-plan.json", JSON.stringify(plan, null, 1));
  process.exit(0);
}

let sent = 0, failed = 0;
for (const p of plan) {
  try {
    await sendEmailSMTP({ from: p.inbox, to: p.email, subject: p.subject, body: p.body });
    console.log(`SENT  ${p.inbox.padEnd(26)} -> ${p.email}`);
    sent++;
  } catch (e) {
    console.log(`FAIL  ${p.inbox.padEnd(26)} -> ${p.email}  ${e.message.split("\n")[0].slice(0, 60)}`);
    failed++;
  }
  await new Promise(r => setTimeout(r, 20000)); // 20s spacing
}
console.log(`\ndone: ${sent} sent, ${failed} failed`);
