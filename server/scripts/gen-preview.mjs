// Generate an HTML preview of the cold email applying Nick Sarav's structure:
// research-y icebreaker → identification + social proof → offer → risk-reversal → soft CTA.
import fs from "node:fs";

const C = "https://tedca-os-production.up.railway.app";
const { token } = await (await fetch(C + "/api/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.OS_PASSWORD }),
})).json();
const h = { Authorization: `Bearer ${token}` };
const leads = (await (await fetch(C + "/api/leads", { headers: h })).json()).slice(0, 3);

// short, lowercase, personalized via business name (always renders clean even when
// the owner name is unknown), no fake Re:, no emojis/jargon, rotates per send
const subject = "{past clients at {business_name}|quick question for {business_name}|reactivating {business_name} clients}";

// Final: tight version + REAL case study (Union NJ med spa, 5 clients, $20k LTV)
const body = `hey {first_name},

{saw|came across|was just looking at} {business_name}, {rating} stars across {review_count} reviews {is no joke|tells me your clients love you}.

i build database reactivation systems for med spas to bring back past clients without spending a dollar on ads. {we just did this for|we recently ran this for} a med spa in Union, NJ and brought back 5 of their past clients in 30 days, {now worth over $20k in lifetime value|who are now worth over $20k in lifetime value to them}.

best part is, {if it doesn't put revenue in your pocket, you don't pay|you don't pay unless it actually makes you money}.

{open to|want me to send you} a short walkthrough of how it'd work for {business_name}?

{sender_name}
tedca.org`;

function fill(tpl, l, sender) {
  const tidy = (n) => String(n || "").split(/\s+[-–—|/]\s+/)[0].split(/,\s*/)[0].trim();
  let o = tpl
    .replaceAll("{business_name}", tidy(l.business_name) || "your business")
    .replaceAll("{first_name}", (l.ceo_name || "").split(" ")[0] || "there")
    .replaceAll("{city}", l.city || "your area")
    .replaceAll("{category}", l.category || "business")
    .replaceAll("{rating}", l.rating != null ? String(l.rating) : "great")
    .replaceAll("{review_count}", l.review_count != null ? String(l.review_count) : "plenty of")
    .replaceAll("{sender_name}", sender);
  return o.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
    const c = opts.split("|");
    return c[Math.floor(Math.random() * c.length)];
  });
}

const inboxes = [["April", "april@outreachopszone.co"], ["Brandon", "brandon@tryforgestack.co"], ["Joanna", "joanna@mymyaigen.co"]];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cards = leads.map((l, i) => {
  const [nm, em] = inboxes[i];
  const sub = fill(subject, l, nm), bd = fill(body, l, nm);
  return `<div class="mail"><div class="bar"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div></div>
<div class="hd"><div><span class="lbl">From</span> <b>${nm}</b> &lt;${em}&gt;</div><div><span class="lbl">To</span> ${esc(l.business_name)}</div><div class="subj">${esc(sub)}</div></div>
<div class="body">${esc(bd).replace(/\n/g, "<br>")}</div>
<div class="meta">real data → ${esc(l.business_name)} · ${l.rating}★ / ${l.review_count} reviews${l.city ? ` · ${esc(l.city)}` : ""} · owner: ${l.ceo_name ? esc(l.ceo_name) : "<i>fills in on verify</i>"}</div></div>`;
}).join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cold Email Preview</title><style>
body{margin:0;background:#14110d;color:#ece7de;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:44px 22px 70px}
.kick{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#ff5a00}
h1{font-size:30px;margin:12px 0 6px;letter-spacing:-.01em}
.sub{color:#9a9081;font-size:15px;margin-bottom:8px}
.note{background:#15211a;border:1px solid #2c4233;border-radius:12px;padding:14px 18px;margin:18px 0 26px;font-size:14px;color:#bfe0cd}
.note b{color:#39d98a}
.mail{background:#f7f4ee;color:#1a1714;border-radius:14px;overflow:hidden;margin-bottom:22px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.bar{display:flex;gap:7px;padding:11px 14px;background:#e9e4da;border-bottom:1px solid #d8d2c6}
.dot{width:11px;height:11px;border-radius:50%}.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
.hd{padding:14px 20px;border-bottom:1px solid #e2ddd2;font-size:14px;color:#3a352e}
.lbl{font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#9a8f7e;display:inline-block;width:38px}
.subj{margin-top:8px;font-size:17px;font-weight:700;color:#1a1714}
.body{padding:20px;font-size:15px;line-height:1.65;color:#26221d}
.meta{padding:10px 20px;background:#efe9dd;border-top:1px solid #e2ddd2;font-family:ui-monospace,monospace;font-size:11px;color:#8a8070}
footer{color:#9a9081;font-size:13px;margin-top:30px;border-top:1px solid #352c20;padding-top:16px}
</style></head><body><div class="wrap">
<div class="kick">Tedca OS · Cold Email · FINAL</div>
<h1>Database reactivation + real case study</h1>
<div class="sub">3 real leads from your CRM · refresh to see the wording rotate (spintax)</div>
<div class="note"><b>This is the locked copy.</b> Real, honest case study (med spa in Union NJ, 5 reactivated clients, $20k+ <b>lifetime value</b>), the <b>"you don't pay unless it makes you money"</b> guarantee, research opener, soft CTA. Every send rotates so Gmail can't cluster them.</div>
${cards}
<footer>The case study is worded as <b>lifetime value</b> (true to what happened), holds up if a prospect asks. Owner first name fills in on verify.</footer>
</div></body></html>`;

fs.writeFileSync("/Users/yoljean/Downloads/Ted Workspace/tedca-os/email-preview.html", html);
console.log("wrote preview for:", leads.map((l) => l.business_name).join(", "));
