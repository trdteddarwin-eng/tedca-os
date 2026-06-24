// Obsidian bridge: write a markdown client card to brain/clients/ for a hot lead,
// matching brain/templates/client.md. The structured CRM stays in SQLite; this
// mirrors only replied/hot leads into the second brain for human note-taking.
//
// NOTE: writeClientCard() is NOT auto-wired yet — per the workspace rule, we don't
// write into brain/ silently. It's enabled only after the format is approved.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src → ../../../brain/clients  (workspace root)
const CLIENTS_DIR = path.join(__dirname, "..", "..", "..", "brain", "clients");

function slugify(s) {
  return String(s || "lead")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const box = (on) => `- [${on ? "x" : " "}]`;

// Render a lead + its email timeline as a brain/clients card (client.md shape).
export function leadToCard(lead, emails = []) {
  const name = lead.ceo_name || lead.business_name || "Unknown";
  const location = [lead.city, lead.state].filter(Boolean).join(", ");
  const contacted = lead.status !== "scraped";
  const inConvo = ["replied", "booked", "won"].includes(lead.status) || ["replied", "booked", "won"].includes(lead.stage);
  const working = ["booked", "won"].includes(lead.stage);
  const done = lead.stage === "won";

  const log = emails.length
    ? emails
        .map((e) => {
          const day = (e.sent_at || "").slice(0, 10);
          const who = e.direction === "out" ? "→ us" : "← them";
          return `- **${day}:** ${who} (${e.kind}) ${e.subject || ""}`.trimEnd();
        })
        .join("\n")
    : "- (none yet)";

  return `# ${name}

## Contact
- **Email:** ${lead.email || ""}
- **Phone:** ${lead.phone || ""}
- **Company:** ${lead.business_name || ""}
- **Location:** ${location}
- **LinkedIn:** ${lead.linkedin_url || ""}
- **How we connected:** cold email (${lead.source || "tedca-os"})

## Conversation Log
${log}

## Status
${box(contacted)} Initial contact
${box(inConvo)} In conversation
${box(working)} Working together
${box(done)} Completed

## Notes
${lead.notes || ""}

---
*auto-synced from Tedca OS · lead #${lead.id} · ${new Date().toISOString().slice(0, 10)}*
`;
}

// Write the card into brain/clients/. Returns the file path written.
export function writeClientCard(lead, emails = []) {
  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
  const file = path.join(CLIENTS_DIR, `${slugify(lead.business_name || name(lead))}.md`);
  fs.writeFileSync(file, leadToCard(lead, emails));
  return file;
}
function name(l) {
  return l.ceo_name || `lead-${l.id}`;
}
