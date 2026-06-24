// Set the CAN-SPAM compliance footer (opt-out line + physical address).
// Usage: node server/scripts/set-footer.mjs "Brand" "123 St, City, ST 00000"
import { db } from "../src/db.js";

const brand = process.argv[2] || "Tedca";
const address = process.argv[3] || "";
const footer = `${brand} · ${address}\nNot interested? Reply "unsubscribe" and you're off the list.`;

db.prepare(
  "INSERT INTO settings (key, value) VALUES ('compliance_footer', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
).run(footer);

console.log("compliance_footer set:\n---\n" + footer + "\n---");
