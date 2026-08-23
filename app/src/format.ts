// Server timestamps are stored as UTC ("YYYY-MM-DD HH:MM:SS", no zone). Render
// them in Eastern time so the dashboard reads in Ted's timezone, not raw UTC.
export function fmtET(ts?: string | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!ts) return "—";
  const raw = String(ts);
  const iso = (raw.includes("T") ? raw : raw.replace(" ", "T")).replace(/Z?$/, "Z");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...opts,
  }).format(d);
}

// "3m ago" / "2h ago" relative time, falling back to fmtET for older items.
export function fmtAgo(ts?: string | null): string {
  if (!ts) return "—";
  const raw = String(ts);
  const iso = (raw.includes("T") ? raw : raw.replace(" ", "T")).replace(/Z?$/, "Z");
  const t = new Date(iso).getTime();
  if (isNaN(t)) return raw;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtET(ts);
}
