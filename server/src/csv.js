// Tiny dependency-free CSV/TSV parser for lead files. RFC4180-ish: quoted fields,
// doubled quotes, commas/newlines inside quotes. Lifted from scripts/ingest-zapmail.mjs
// (proven on real vendor exports) and extended with delimiter sniffing + UTF-16 BOMs,
// which Excel "Save As" produces and which would otherwise parse as one garbage column.

export function decodeText(buf) {
  if (!buf) return "";
  if (typeof buf === "string") return buf.replace(/^﻿/, "");
  // UTF-16 LE/BE BOM (Excel "Unicode Text")
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^﻿/, "");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) { swapped[i - 2] = buf[i + 1]; swapped[i - 1] = buf[i]; }
    return swapped.toString("utf16le").replace(/^﻿/, "");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

// Pick the delimiter that splits the header line into the most columns.
export function sniffDelimiter(text) {
  const head = String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = { "\t": (head.match(/\t/g) || []).length, ";": (head.match(/;/g) || []).length, ",": (head.match(/,/g) || []).length, "|": (head.match(/\|/g) || []).length };
  let best = ",", n = -1;
  for (const [d, c] of Object.entries(counts)) if (c > n) { best = d; n = c; }
  return n > 0 ? best : ",";
}

export function parseDelimited(text, delim = ",") {
  text = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => String(c).trim())).filter((r) => r.some((c) => c !== ""));
}

export function parseCsv(textOrBuf) {
  const text = decodeText(textOrBuf);
  return parseDelimited(text, sniffDelimiter(text));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

// Pasted text: a real delimited table, OR a bare one-per-line list of emails / URLs.
// Returns { rows, headers } where headers is synthesized for bare lists.
export function parsePaste(text) {
  const clean = decodeText(text);
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], headers: [] };
  const looksTabular = lines[0].includes("\t") || lines[0].includes(",") || lines[0].includes(";");
  if (!looksTabular) {
    if (lines.every((l) => EMAIL_RE.test(l))) return { headers: ["email"], rows: lines.map((l) => [l]) };
    if (lines.every((l) => URL_RE.test(l))) return { headers: ["website"], rows: lines.map((l) => [l]) };
    return { headers: ["business_name"], rows: lines.map((l) => [l]) }; // names, one per line
  }
  const rows = parseDelimited(clean, sniffDelimiter(clean));
  return { headers: rows[0] || [], rows: rows.slice(1) };
}

export function isEmailLike(s) { return EMAIL_RE.test(String(s || "").trim()); }
export function isUrlLike(s) { return URL_RE.test(String(s || "").trim()); }
