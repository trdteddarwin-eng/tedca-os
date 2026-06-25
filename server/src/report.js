// End-of-day report: a PDF of every email sent today (with the full copy),
// delivered to Telegram. Pure-JS PDF (pdfkit) so it works in the cloud container.
import PDFDocument from "pdfkit";
import { db } from "./db.js";
import { sendTelegramFile } from "./telegram.js";

const TZ = "America/New_York";
const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

// today's outbound messages (initial + follow-up + auto-reply) with lead + copy
function todaysSends() {
  return db
    .prepare(
      `SELECT e.sent_at, e.inbox, e.kind, e.subject, e.body, l.business_name, l.email AS lead_email
       FROM emails e LEFT JOIN leads l ON l.id = e.lead_id
       WHERE e.direction='out' AND e.kind IN ('initial','followup','reply')
         AND e.sent_at >= date('now')
       ORDER BY e.sent_at`
    )
    .all();
}

export function buildReportPDF(rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pretty = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "full" }).format(new Date());
    const counts = rows.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {});

    doc.fontSize(20).fillColor("#111").text("Tedca OS — Daily Email Report");
    doc.fontSize(11).fillColor("#666").text(pretty);
    doc.moveDown(0.6);
    doc
      .fontSize(12)
      .fillColor("#000")
      .text(`Total sent: ${rows.length}    initial: ${counts.initial || 0}    follow-ups: ${counts.followup || 0}    replies: ${counts.reply || 0}`);
    doc.moveDown(1);

    if (!rows.length) {
      doc.fontSize(12).fillColor("#888").text("No emails were sent today.");
    }

    for (const r of rows) {
      doc.fontSize(9).fillColor("#999").text(`${r.sent_at || ""}   ·   ${r.kind}   ·   via ${r.inbox || "—"}`);
      doc.fontSize(12).fillColor("#111").text(`${r.business_name || "—"}   <${r.lead_email || ""}>`);
      doc.fontSize(11).fillColor("#333").text(`Subject: ${r.subject || ""}`);
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#444").text(r.body || "", { width: 495 });
      doc.moveDown(0.5);
      doc.strokeColor("#dddddd").lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);
    }
    doc.end();
  });
}

// Build today's report and send it to Telegram. Returns true on success.
export async function sendDailyReport() {
  const rows = todaysSends();
  const buffer = await buildReportPDF(rows);
  const day = etDate();
  const caption = `📊 Daily cold-email report — ${day}\n${rows.length} message${rows.length === 1 ? "" : "s"} sent today.`;
  return sendTelegramFile(buffer, `tedca-report-${day}.pdf`, caption, "document");
}
