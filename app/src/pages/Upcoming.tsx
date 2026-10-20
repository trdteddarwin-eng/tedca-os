import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, getToken } from "../api";
import { fmtET } from "../format";

type Caption = { platform: string; title: string | null; caption: string | null };
type Media = { label: string; id: string | null };
type Item = {
  kind: "scheduled" | "reserved" | "pending";
  date: string | null; // New York calendar day (null while a new version is being made)
  time: string;
  at: string | null; // UTC ISO
  title: string;
  videos: Media[];
  cover: string | null;
  // scheduled
  platforms?: ({ platform: string; job_id: string } & Caption)[] | string[];
  thumbnail_url?: string | null;
  source?: string | null;
  // reserved
  what?: string;
  captions?: Caption[];
  // pending
  day?: string;
  version?: number | null;
  duration_s?: number | null;
  status?: string | null;
  request?: ReqState | null;
  can?: { approve: boolean; skip: boolean; feedback: boolean };
};
type ReqState = {
  phase: "queued" | "working" | "scheduled" | "skipped" | "failed" | "arrived" | "missing";
  action: string;
  message: string;
  error?: string | null;
  feedback?: string | null;
  sent_at?: string;
  source: "tedca-os" | "telegram";
};
type Data = {
  ok: boolean;
  refreshed_at: string;
  today: string;
  post_time: string;
  scheduled: Item[];
  reserved: Item[];
  pending: Item[];
  drafts: number;
  summary: {
    next: { title: string; at: string; date: string } | null;
    covered_days: number;
    last_scheduled_date: string | null;
    gaps: string[];
    duplicates: { date: string; titles: string[] }[];
  };
  sources: {
    upload_post: { ok: boolean; error: string | null; jobs: number; checked_at: string | null };
    repo: { ok: boolean; error: string | null; commit: string | null; fetched_at: string | null };
  };
};

const fileUrl = (id: string) => `/api/upcoming/file?id=${encodeURIComponent(id)}&token=${getToken()}`;
// "2026-10-17" → "Sat, Oct 17" (noon UTC keeps the calendar day stable in any zone)
const fmtDay = (ymd: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const fmtWhen = (iso: string | null) => (iso ? fmtET(iso, { weekday: "short" }) + " ET" : "");
function fmtIn(iso: string | null) {
  if (!iso) return "";
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return "posting now";
  const h = Math.floor(s / 3600);
  if (h < 1) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (h < 24) return `in ${h}h ${Math.floor((s % 3600) / 60)}m`;
  return h % 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : `in ${h / 24}d`;
}
// consecutive dates collapse into ranges: ["10-18","10-19","10-21"] → "Oct 18 to Oct 19, Oct 21"
function dateRanges(dates: string[]) {
  const out: string[] = [];
  const sorted = [...dates].sort();
  const next = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10);
  const short = (d: string) => fmtDay(d).split(", ")[1];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === next(sorted[j])) j++;
    out.push(i === j ? short(sorted[i]) : `${short(sorted[i])} to ${short(sorted[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}

function NetBadge({ p }: { p: string }) {
  const yt = p === "youtube";
  return (
    <span className={`font-mono text-[10px] font-bold px-2 py-0.5 rounded ${yt ? "bg-red-400/15 text-red-300" : "bg-sky-400/15 text-sky-300"}`}>
      {yt ? "YT" : p === "facebook" ? "FB" : p === "tiktok" ? "TT" : p.toUpperCase()}
    </span>
  );
}

// Vertical player: shows the cover until clicked, then mounts a real <video>.
// Lazy on purpose: a page of preloading 17 MB shorts would choke the browser.
function Player({ item }: { item: Item }) {
  const playable = item.videos.filter((v) => v.id);
  const [pick, setPick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [thumbIdx, setThumbIdx] = useState(0);
  const thumbs = [item.cover ? fileUrl(item.cover) : null, item.thumbnail_url || null].filter(Boolean) as string[];
  const cur = playable[pick];

  return (
    <div className="w-44 sm:w-48 shrink-0 flex flex-col gap-1.5">
      <div className="relative aspect-[9/16] bg-ink rounded-md overflow-hidden border border-edge">
        {playing && cur?.id ? (
          <video key={cur.id} src={fileUrl(cur.id)} controls autoPlay playsInline className="w-full h-full object-contain bg-black" />
        ) : (
          <button onClick={() => cur && setPlaying(true)} className="group w-full h-full relative" title={cur ? "Play" : "No local video file found"}>
            {thumbs[thumbIdx] ? (
              <img src={thumbs[thumbIdx]} alt="" onError={() => setThumbIdx((i) => i + 1)} className="w-full h-full object-cover opacity-85 group-hover:opacity-100" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-panel to-ink" />
            )}
            {cur ? (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="w-12 h-12 rounded-full bg-ink/70 border border-paper/30 flex items-center justify-center group-hover:bg-signal/80 transition-colors">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-paper ml-0.5"><path d="M8 5.5v13l11-6.5z" /></svg>
                </span>
              </span>
            ) : (
              <span className="absolute bottom-2 inset-x-2 font-mono text-[10px] text-paper/70 bg-ink/80 rounded px-1.5 py-1">no local video file</span>
            )}
          </button>
        )}
      </div>
      {playable.length > 1 && (
        <div className="flex gap-1">
          {playable.map((v, i) => (
            <button
              key={v.label}
              onClick={() => { setPick(i); setPlaying(true); }}
              className={`flex-1 font-mono text-[10px] rounded px-1.5 py-1 border ${i === pick ? "border-signal/60 bg-signal/15 text-signal" : "border-edge text-paper/50 hover:text-paper"}`}
            >
              {v.label.replace(" cut", "")}
            </button>
          ))}
        </div>
      )}
      {playable.length === 1 && <div className="font-mono text-[10px] text-paper/35 text-center">{playable[0].label}</div>}
    </div>
  );
}

function CaptionBlock({ c }: { c: Caption }) {
  if (!c.caption && !c.title) return null;
  return (
    <details className="group bg-ink/60 border border-edge rounded px-2.5 py-1.5">
      <summary className="cursor-pointer list-none flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-paper/45">
        <NetBadge p={c.platform} />
        {c.platform === "youtube" ? "title + description" : "caption"}
        <span className="ml-auto text-paper/30 group-open:rotate-90 transition-transform">›</span>
      </summary>
      <div className="mt-2 text-xs text-paper/70 leading-relaxed whitespace-pre-line break-words">
        {c.title && <div className="text-paper font-semibold mb-1">{c.title}</div>}
        {c.caption}
      </div>
    </details>
  );
}

// What happened to the last Approve / Skip / change request for this day.
function RequestBanner({ r }: { r: ReqState }) {
  const tone =
    r.phase === "scheduled" || r.phase === "arrived" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : r.phase === "failed" || r.phase === "missing" ? "border-red-400/30 bg-red-400/10 text-red-300"
    : r.phase === "skipped" ? "border-edge bg-paper/5 text-paper/60"
    : "border-sky-400/30 bg-sky-400/10 text-sky-300";
  const busy = r.phase === "queued" || r.phase === "working";
  const who = r.source === "telegram" ? "from Telegram" : "from Tedca OS";
  return (
    <div className={`text-xs border rounded p-2.5 ${tone}`}>
      <div className="flex items-start gap-2">
        {busy && <span className="mt-1 w-2 h-2 rounded-full bg-current animate-pulse shrink-0" />}
        <span className="font-semibold leading-snug">{r.message}</span>
      </div>
      {r.feedback && <div className="mt-1.5 text-paper/60 italic break-words">"{r.feedback}"</div>}
      {r.error && <div className="mt-1.5 font-mono text-[11px] text-red-200/90 break-words">{r.error}</div>}
      <div className="mt-1 font-mono text-[10px] opacity-60">
        {r.action === "feedback" ? "change request" : r.action} {who}{r.sent_at ? `, ${fmtET(r.sent_at)}` : ""}
      </div>
    </div>
  );
}

// Approve / Skip / Request changes. Each one makes the same request the Telegram
// buttons and replies make (server: POST /api/upcoming/:day/request).
function Actions({ item, onDone }: { item: Item; onDone: () => void }) {
  const [confirm, setConfirm] = useState<"approve" | "skip" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const can = item.can || { approve: false, skip: false, feedback: false };
  if (!can.approve && !can.skip && !can.feedback) return null;

  const send = async (action: "approve" | "skip" | "feedback") => {
    setBusy(action);
    setError("");
    try {
      await api(`/api/upcoming/${encodeURIComponent(item.day || "")}/request`, {
        method: "POST",
        body: JSON.stringify(action === "feedback" ? { action, feedback: text.trim() } : { action }),
      });
      setConfirm(null);
      setText("");
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  };
  const btn = "font-mono text-[11px] uppercase tracking-widest rounded px-3 py-1.5 disabled:opacity-40";

  return (
    <div className="flex flex-col gap-2 border-t border-edge pt-2.5">
      {confirm ? (
        <div className={`rounded border p-2.5 ${confirm === "approve" ? "border-emerald-400/40 bg-emerald-400/10" : "border-paper/20 bg-paper/5"}`}>
          <div className="text-sm text-paper font-semibold">
            {confirm === "approve"
              ? item.at ? `Schedule for ${fmtWhen(item.at)}?` : "Schedule at the next free 7:00 AM slot?"
              : "Skip this video? It will not post."}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => send(confirm)}
              disabled={!!busy}
              className={`${btn} ${confirm === "approve" ? "bg-emerald-400/20 text-emerald-300 hover:bg-emerald-400/30" : "bg-paper/15 text-paper hover:bg-paper/25"}`}
            >
              {busy ? "sending…" : confirm === "approve" ? "Yes, schedule it" : "Yes, skip it"}
            </button>
            <button onClick={() => setConfirm(null)} disabled={!!busy} className={`${btn} text-paper/55 hover:text-paper`}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {can.approve && (
            <button onClick={() => setConfirm("approve")} disabled={!!busy} className={`${btn} bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25`}>
              Approve
            </button>
          )}
          {can.skip && (
            <button onClick={() => setConfirm("skip")} disabled={!!busy} className={`${btn} bg-paper/10 text-paper/70 hover:bg-paper/20 hover:text-paper`}>
              Skip
            </button>
          )}
        </div>
      )}
      {can.feedback && !confirm && (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Request changes, in plain words (like a Telegram reply)"
            className="w-full bg-ink border border-edge rounded px-2.5 py-2 text-xs text-paper placeholder:text-paper/30 focus:outline-none focus:border-signal/50 resize-y"
          />
          <div className="flex items-center gap-2">
            <button onClick={() => send("feedback")} disabled={!!busy || !text.trim()} className={`${btn} shrink-0 whitespace-nowrap bg-signal/15 text-signal hover:bg-signal/25`}>
              {busy === "feedback" ? "sending…" : "Send changes"}
            </button>
            <span className="text-[10px] text-paper/35 leading-tight">makes v{(item.version || 1) + 1}, then it comes back here and on Telegram</span>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2 break-words">⚠ {error}</p>}
    </div>
  );
}

function Card({ item, dupe, onChanged }: { item: Item; dupe?: boolean; onChanged?: () => void }) {
  const caps: Caption[] =
    item.kind === "scheduled"
      ? ((item.platforms || []) as ({ platform: string } & Caption)[]).map((p) => ({ platform: p.platform, title: p.title, caption: p.caption }))
      : item.captions || [];
  const nets: string[] =
    item.kind === "scheduled" ? caps.map((c) => c.platform) : item.kind === "pending" ? ((item.platforms || []) as string[]) : caps.map((c) => c.platform);
  const firstLine = (s: string | null) => (s || "").split("\n").find((l) => l.trim()) || "";
  const hook = firstLine(caps.find((c) => c.platform === "youtube")?.caption || caps[0]?.caption || null);

  const ph = item.request?.phase;
  const tone =
    item.kind === "scheduled" || ph === "scheduled" ? "text-emerald-400 bg-emerald-400/15"
    : item.kind === "reserved" ? "text-amber-300 bg-amber-400/15"
    : ph === "failed" || ph === "missing" ? "text-red-300 bg-red-400/15"
    : ph === "skipped" ? "text-paper/60 bg-paper/10"
    : ph === "queued" || ph === "working" ? "text-sky-300 bg-sky-400/15"
    : "text-signal bg-signal/15";
  const label =
    item.kind === "scheduled" ? "scheduled"
    : item.kind === "reserved" ? "reserved, not scheduled"
    : ph === "scheduled" ? "scheduled"
    : ph === "skipped" ? "skipped"
    : ph === "queued" ? `${item.request?.action === "feedback" ? "changes" : item.request?.action} sent`
    : ph === "working" ? "making a new version"
    : ph === "failed" ? "approve failed"
    : "if approved";

  const reserved = item.kind === "reserved";
  const header = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`font-mono text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${tone}`}>{label}</span>
        {nets.map((n) => <NetBadge key={n} p={n} />)}
        {item.kind === "pending" && item.version != null && (
          <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-paper/10 text-paper/60">v{item.version}</span>
        )}
      </div>
      {item.at ? (
        <div>
          <div className={`font-display text-xl leading-tight ${reserved || ph === "skipped" ? "text-paper/50" : "text-paper"}`}>{fmtWhen(item.at)}</div>
          <div className={`font-mono text-[11px] mt-0.5 ${reserved ? "text-amber-300/80" : "text-paper/45"}`}>
            {reserved ? "slot held, no Upload-Post job yet" : fmtIn(item.at)}
          </div>
        </div>
      ) : (
        <div className="font-display text-xl leading-tight text-paper/50">{ph === "skipped" ? "Will not post" : "No slot until the new version is approved"}</div>
      )}
    </>
  );

  return (
    <div className={`bg-panel border rounded-lg p-3 flex flex-col sm:flex-row gap-3 ${dupe ? "border-red-400/60" : "border-edge"}`}>
      <div className="sm:hidden flex flex-col gap-2">{header}</div>
      <div className="flex justify-center sm:block">
        <Player item={item} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="hidden sm:flex flex-col gap-2">{header}</div>
        <h4 className="text-[15px] font-semibold text-paper leading-snug">{item.title}</h4>
        {hook && <p className="text-xs text-paper/55 leading-relaxed">{hook}</p>}
        <div className="flex flex-col gap-1.5">
          {caps.map((c) => <CaptionBlock key={c.platform} c={c} />)}
        </div>
        {item.request && <RequestBanner r={item.request} />}
        {item.kind === "pending" && onChanged && <Actions item={item} onDone={onChanged} />}
        <div className="mt-auto pt-1 font-mono text-[10px] text-paper/35 break-all">
          {item.kind === "pending" && <>day folder {item.day}{item.duration_s ? ` · ${Math.round(item.duration_s)}s` : ""}</>}
          {item.kind === "scheduled" && item.source && <>file from {item.source}</>}
          {item.kind === "reserved" && <>slots.json: {item.what}</>}
        </div>
      </div>
    </div>
  );
}

// Real platform marks (small, monochrome-on-color) for the calendar chips.
function NetIcon({ p, size = 14 }: { p: string; size?: number }) {
  if (p === "youtube")
    return (
      <span title="YouTube" className="inline-flex items-center justify-center rounded-[4px] bg-[#ff0033] shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" style={{ width: size * 0.62, height: size * 0.62 }} className="fill-white"><path d="M8 5.5v13l11-6.5z" /></svg>
      </span>
    );
  if (p === "facebook")
    return (
      <span title="Facebook" className="inline-flex items-center justify-center rounded-full bg-[#1877f2] shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" style={{ width: size * 0.7, height: size * 0.7 }} className="fill-white"><path d="M14.2 8.4V6.6c0-.8.2-1.3 1.4-1.3h1.6V2.2c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.3H8.4v3.4H11V22h3.2v-10.2h2.6l.4-3.4z" /></svg>
      </span>
    );
  if (p === "tiktok")
    return (
      <span title="TikTok" className="inline-flex items-center justify-center rounded-[4px] bg-black ring-1 ring-white/20 shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" style={{ width: size * 0.66, height: size * 0.66 }} className="fill-white"><path d="M16.6 2h-3.3v13.2a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9a6.3 6.3 0 1 0 5.3 6.2V8.6a7.9 7.9 0 0 0 4.4 1.3V6.6a4.5 4.5 0 0 1-4.4-4.6z" /></svg>
      </span>
    );
  return <NetBadge p={p} />;
}

type PostedRow = {
  id: string;
  network: string;
  account: string | null;
  permalink: string | null;
  caption: string | null;
  thumbnail_url: string | null;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
};
type CalStatus = "posted" | "scheduled" | "reserved" | "if approved";
type CalEvent = {
  key: string;
  date: string;
  status: CalStatus;
  title: string;
  time: string; // "HH:MM" New York
  thumb: string | null;
  nets: string[];
  item?: Item; // upcoming: opens the full card
  posted?: PostedRow[]; // already out: one row per network
};

// New York calendar day + "HH:MM" for a UTC timestamp
function nyParts(iso: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

function thumbOf(item: Item) {
  return item.cover ? fileUrl(item.cover) : item.thumbnail_url || null;
}

function netsOf(item: Item): string[] {
  const p = item.platforms || item.captions || [];
  return (p as any[]).map((x) => (typeof x === "string" ? x : x.platform));
}

// Every dated thing: videos already posted (Content Posted data, YT + FB of one
// video merged), Upload-Post jobs, slots.json holds, and approval-waiting videos
// at the slot they would get. Pending rows that are already scheduled are the
// same video as a scheduled job, so they are dropped.
function calendarEvents(data: Data, posted: PostedRow[]): CalEvent[] {
  const out: CalEvent[] = [];
  const groups = new Map<string, PostedRow[]>();
  for (const r of posted) {
    if (r.account !== "curiosity_hook" || !r.posted_at) continue;
    const title = firstLineOf(r.caption) || "Posted video";
    const k = `${nyParts(r.posted_at).date}|${title}`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  for (const [k, rows] of groups) {
    rows.sort((x, y) => (x.network === "youtube" ? -1 : 1) - (y.network === "youtube" ? -1 : 1));
    const firstAt = rows.map((r) => r.posted_at as string).sort()[0];
    out.push({
      key: `posted-${k}`,
      date: k.split("|")[0],
      status: "posted",
      title: k.split("|")[1],
      time: nyParts(firstAt).time,
      thumb: rows.find((r) => r.thumbnail_url)?.thumbnail_url || null,
      nets: rows.map((r) => r.network),
      posted: rows,
    });
  }
  const add = (it: Item, status: CalStatus, key: string) =>
    it.date && out.push({ key, date: it.date, status, title: it.title, time: it.time, thumb: thumbOf(it), nets: netsOf(it), item: it });
  for (const it of data.scheduled) add(it, "scheduled", `s-${it.date}-${it.title}`);
  for (const it of data.reserved) add(it, "reserved", `r-${it.date}-${it.what}`);
  for (const it of data.pending) {
    const ph = it.request?.phase;
    if (!it.date || ph === "scheduled" || ph === "skipped") continue;
    if (out.some((e) => e.date === it.date && e.title === it.title)) continue;
    add(it, "if approved", `p-${it.day}`);
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

const firstLineOf = (s: string | null) => (s || "").split("\n").find((l) => l.trim())?.trim() || "";
const fmtNum = (n: number | null) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

const STATUS_STYLE: Record<CalStatus, string> = {
  posted: "border-edge bg-paper/[0.04] hover:bg-paper/10",
  scheduled: "border-emerald-400/40 bg-emerald-400/[0.07] hover:bg-emerald-400/15",
  reserved: "border-amber-400/40 bg-amber-400/[0.07] hover:bg-amber-400/15",
  "if approved": "border-dashed border-signal/60 bg-signal/[0.06] hover:bg-signal/15",
};
const STATUS_DOT: Record<CalStatus, string> = { posted: "bg-paper/50", scheduled: "bg-emerald-400", reserved: "bg-amber-300", "if approved": "bg-signal" };

// One post inside a day cell: cover thumbnail, time, platform icons, title.
function EventChip({ ev, big, onOpen }: { ev: CalEvent; big?: boolean; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const src = ev.thumb;
  return (
    <button
      onClick={onOpen}
      title={`${ev.title} (${ev.status})`}
      className={`w-full text-left rounded-md border transition-colors overflow-hidden flex ${big ? "flex-col" : "items-stretch gap-1.5"} ${STATUS_STYLE[ev.status]}`}
    >
      <div className={`${big ? "w-full aspect-[9/16]" : "w-7 sm:w-9 aspect-[9/16]"} shrink-0 bg-ink relative`}>
        {src && !broken ? (
          <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-panel to-ink" />
        )}
      </div>
      <div className={`min-w-0 flex-1 ${big ? "p-2" : "py-1 pr-1.5"} hidden sm:flex flex-col gap-1`}>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[ev.status]}`} />
          <span className="font-mono text-[10px] text-paper/70">{fmtTime(ev.time)}</span>
          <span className="ml-auto flex gap-0.5">{ev.nets.map((n) => <NetIcon key={n} p={n} size={big ? 16 : 13} />)}</span>
        </div>
        <div className={`text-paper leading-tight ${big ? "text-xs line-clamp-4" : "text-[11px] line-clamp-3"}`}>{ev.title}</div>
        {ev.posted && (
          <div className="font-mono text-[10px] text-paper/50">{fmtNum(ev.posted.reduce((n, r) => n + (r.views || 0), 0))} views</div>
        )}
      </div>
    </button>
  );
}

// A video that already went out: cover, when, and live numbers per network.
function PostedCard({ ev }: { ev: CalEvent }) {
  const rows = ev.posted || [];
  return (
    <div className="bg-panel border border-edge rounded-lg p-3 flex flex-col sm:flex-row gap-3">
      <div className="w-44 sm:w-48 shrink-0 mx-auto sm:mx-0 aspect-[9/16] bg-ink rounded-md overflow-hidden border border-edge">
        {ev.thumb && <img src={ev.thumb} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded bg-paper/10 text-paper/70">posted</span>
          {ev.nets.map((n) => <NetBadge key={n} p={n} />)}
        </div>
        <div className="font-display text-xl leading-tight text-paper">{fmtDay(ev.date)}, {fmtTime(ev.time)} ET</div>
        <h4 className="text-[15px] font-semibold text-paper leading-snug">{ev.title}</h4>
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 bg-ink/60 border border-edge rounded px-2.5 py-2">
              <NetIcon p={r.network} size={18} />
              <div className="flex gap-4 font-mono text-xs text-paper/80">
                <span><span className="text-paper font-semibold">{fmtNum(r.views)}</span> views</span>
                <span>{fmtNum(r.likes)} likes</span>
                <span>{fmtNum(r.comments)} comments</span>
              </div>
              {r.permalink && (
                <a href={r.permalink} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-signal hover:underline shrink-0">open ↗</a>
              )}
            </div>
          ))}
        </div>
        <div className="mt-auto font-mono text-[10px] text-paper/35">numbers from Content Posted</div>
      </div>
    </div>
  );
}

// Upload-Post style content calendar: month grid (or one week, bigger), a cover
// thumbnail on every day that posts. Clicking a post opens its full card.
function PostCalendar({ data, onChanged }: { data: Data; onChanged: () => void }) {
  const [posted, setPosted] = useState<PostedRow[]>([]);
  useEffect(() => {
    api("/api/content").then((d: { posts: PostedRow[] }) => setPosted(d.posts || [])).catch(() => {});
  }, [data.refreshed_at]);
  const events = calendarEvents(data, posted);
  const today = data.today;
  const [view, setView] = useState<"month" | "week">("month");
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [weekStart, setWeekStart] = useState(() => addDays(today, -weekday(today)));
  const [open, setOpen] = useState<CalEvent | null>(null);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  const byDate = new Map<string, CalEvent[]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) || []), e]);

  // month grid: weeks Sun..Sat covering the whole month
  let days: string[];
  let heading: string;
  if (view === "month") {
    const first = ymd(ym.y, ym.m, 1);
    const last = ymd(ym.y, ym.m, new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate());
    const start = addDays(first, -weekday(first));
    const end = addDays(last, 6 - weekday(last));
    days = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    heading = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${first}T12:00:00Z`));
  } else {
    days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    heading = `${fmtDay(days[0]).split(", ")[1]} to ${fmtDay(days[6]).split(", ")[1]}, ${days[6].slice(0, 4)}`;
  }
  const inMonth = (d: string) => view === "week" || Number(d.slice(5, 7)) - 1 === ym.m;

  const step = (n: number) => {
    if (view === "month") setYm(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));
    else setWeekStart((w) => addDays(w, 7 * n));
  };
  const goToday = () => {
    setYm({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
    setWeekStart(addDays(today, -weekday(today)));
  };
  const visible = days.filter(inMonth);
  const count = visible.reduce((n, d) => n + (byDate.get(d)?.length || 0), 0);
  const empty = visible.filter((d) => d > today && !byDate.has(d) && (!data.summary.last_scheduled_date || d <= data.summary.last_scheduled_date)).length;

  const navBtn = "w-8 h-8 rounded-md border border-edge text-paper/70 hover:text-paper hover:bg-paper/10 flex items-center justify-center";
  const seg = (on: boolean) => `px-3 py-1.5 rounded font-mono text-[11px] uppercase tracking-widest ${on ? "bg-signal/15 text-signal" : "text-paper/50 hover:text-paper"}`;

  return (
    <section className="mt-6 bg-panel border border-edge rounded-xl p-3 sm:p-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => step(-1)} className={navBtn} aria-label="Previous">‹</button>
        <button onClick={() => step(1)} className={navBtn} aria-label="Next">›</button>
        <button onClick={goToday} className="h-8 px-3 rounded-md border border-edge font-mono text-[11px] uppercase tracking-widest text-paper/70 hover:text-paper hover:bg-paper/10">Today</button>
        <h3 className="font-display text-2xl ml-1">{heading}</h3>
        <span className="font-mono text-[11px] text-paper/45">{count} {count === 1 ? "post" : "posts"}</span>
        <div className="ml-auto inline-flex gap-1 bg-ink/60 border border-edge rounded-lg p-1">
          <button onClick={() => setView("month")} className={seg(view === "month")}>Month</button>
          <button onClick={() => setView("week")} className={seg(view === "week")}>Week</button>
        </div>
      </div>

      {/* legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-paper/50">
        <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${STATUS_DOT.posted}`} />posted</span>
        <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${STATUS_DOT.scheduled}`} />scheduled on Upload-Post</span>
        <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${STATUS_DOT["if approved"]}`} />waiting for approval (where it would land)</span>
        <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${STATUS_DOT.reserved}`} />slot held, not scheduled</span>
        {empty > 0 && <span className="text-amber-300/80">{empty} open {empty === 1 ? "day" : "days"} before the last post</span>}
      </div>

      {/* grid */}
      <div className="mt-3 grid grid-cols-7 gap-px bg-edge border border-edge rounded-lg overflow-hidden">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
          <div key={w} className="bg-ink/80 px-1.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-paper/45 text-center sm:text-left">{w}</div>
        ))}
        {days.map((d) => {
          const evs = byDate.get(d) || [];
          const isToday = d === today;
          const past = d < today;
          return (
            <div
              key={d}
              className={`bg-panel ${view === "week" ? "min-h-[16rem]" : "min-h-[5.5rem] sm:min-h-[8.5rem]"} p-1 sm:p-1.5 flex flex-col gap-1 ${!inMonth(d) ? "opacity-35" : past ? "opacity-60" : ""} ${isToday ? "ring-1 ring-inset ring-signal/70" : ""}`}
            >
              <div className="flex items-center justify-center sm:justify-start">
                <span className={`font-mono text-[11px] w-6 h-6 rounded-full flex items-center justify-center ${isToday ? "bg-signal text-ink font-bold" : "text-paper/60"}`}>
                  {Number(d.slice(8, 10))}
                </span>
              </div>
              {evs.map((ev) => <EventChip key={ev.key} ev={ev} big={view === "week"} onOpen={() => setOpen(ev)} />)}
            </div>
          );
        })}
      </div>

      {/* full card for one post */}
      {open && (
        <div className="fixed inset-0 z-50 bg-ink/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 overflow-y-auto" onClick={() => setOpen(null)}>
          <div className="w-full max-w-2xl relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(null)} className="absolute -top-2 -right-2 z-10 w-8 h-8 rounded-full bg-panel border border-edge text-paper/70 hover:text-paper" aria-label="Close">✕</button>
            {open.item ? (
              <Card item={open.item} onChanged={open.item.kind === "pending" ? () => { setOpen(null); onChanged(); } : undefined} />
            ) : (
              <PostedCard ev={open} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Tile({ value, label, sub, tone }: { value: string; label: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-panel border border-edge rounded-lg px-3 py-2.5 min-w-0">
      <div className={`font-display text-2xl truncate ${tone || "text-paper"}`}>{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/45 mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-paper/55 mt-1 truncate">{sub}</div>}
    </div>
  );
}

export function ContentTabs() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded font-mono text-[11px] uppercase tracking-widest ${isActive ? "bg-signal/15 text-signal" : "text-paper/50 hover:text-paper"}`;
  return (
    <div className="mb-4 inline-flex gap-1 bg-panel border border-edge rounded-lg p-1">
      <NavLink to="/content" className={cls}>Posted</NavLink>
      <NavLink to="/upcoming" className={cls}>Upcoming</NavLink>
    </div>
  );
}

export default function Upcoming() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);

  const load = (force = false) =>
    api(`/api/upcoming${force ? "?force=1" : ""}`)
      .then((d: Data) => { setData(d); setErr(""); })
      .catch((e) => setErr(String(e?.message || e)));

  // while a request is in flight the server re-checks every ~25s, so poll faster too
  const inFlight = (data?.pending || []).some((p) => p.request && ["queued", "working"].includes(p.request.phase));
  useEffect(() => {
    load();
    const poll = setInterval(() => load(), inFlight ? 10000 : 60000); // server caches: Upload-Post 2 min, git fetch 4 min
    const tick = setInterval(() => setTick((t) => t + 1), 30000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [inFlight]);

  const forceRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const s = data?.summary;
  const dupeDates = new Set((s?.duplicates || []).map((d) => d.date));
  const agoS = data?.refreshed_at ? Math.max(0, Math.floor((Date.now() - new Date(data.refreshed_at).getTime()) / 1000)) : null;
  const first = data?.scheduled[0]?.date;
  const reservedDates = (data?.reserved || []).map((r) => r.date || "").filter(Boolean);

  return (
    <div>
      <ContentTabs />
      <h2 className="font-display text-4xl">Upcoming <span className="text-paper/40 text-2xl italic">what Curiosity Hook posts next</span></h2>
      <p className="text-paper/50 text-sm mt-2 max-w-2xl">
        Every video that will go out, in posting order, with the exact New York time. Scheduled jobs come from Upload-Post;
        videos waiting for your approval come from the pipeline repo and post at the next free 7:00 AM slot once you approve
        them, here or on Telegram. Both do exactly the same thing.
      </p>

      {err && <p className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/30 rounded p-3">{err}</p>}

      {/* health strip */}
      <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[11px]">
        {data && (
          <>
            <span className={`px-2.5 py-1 rounded ${data.sources.upload_post.ok ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400"}`} title={data.sources.upload_post.error || ""}>
              Upload-Post: {data.sources.upload_post.ok ? `${data.sources.upload_post.jobs} jobs` : "error"}
            </span>
            <span className={`px-2.5 py-1 rounded ${data.sources.repo.ok ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400"}`} title={data.sources.repo.error || ""}>
              pipeline repo: {data.sources.repo.commit ? `origin/main ${data.sources.repo.commit}` : "error"}
            </span>
          </>
        )}
        <span className="px-2.5 py-1 rounded bg-paper/10 text-paper/60">
          {agoS === null ? "loading…" : agoS < 60 ? `updated ${agoS}s ago` : `updated ${Math.floor(agoS / 60)}m ago`}
        </span>
        <button onClick={forceRefresh} disabled={refreshing} className="px-2.5 py-1 rounded bg-signal/15 text-signal hover:bg-signal/25 disabled:opacity-40">
          {refreshing ? "refreshing…" : "↻ refresh now"}
        </button>
      </div>
      {data?.sources.upload_post.error && (
        <p className="mt-2 text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2.5 font-mono">⚠ Upload-Post: {data.sources.upload_post.error}</p>
      )}
      {data?.sources.repo.error && (
        <p className="mt-2 text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2.5 font-mono">⚠ Pipeline repo: {data.sources.repo.error}</p>
      )}

      {data && s && (
        <>
          {/* summary */}
          <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="col-span-2 bg-panel border border-edge rounded-lg px-3 py-2.5 min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-widest text-paper/45">Next post</div>
              {s.next ? (
                <>
                  <div className="text-paper font-semibold mt-1 leading-snug">{s.next.title}</div>
                  <div className="font-display text-2xl text-signal mt-0.5">{fmtWhen(s.next.at)} <span className="font-mono text-[11px] text-paper/45">{fmtIn(s.next.at)}</span></div>
                </>
              ) : (
                <div className="font-display text-2xl text-red-400 mt-1">Nothing scheduled</div>
              )}
            </div>
            <Tile
              value={String(s.covered_days)}
              label={s.covered_days === 1 ? "day scheduled" : "days scheduled"}
              sub={first && s.last_scheduled_date ? (first === s.last_scheduled_date ? fmtDay(first) : `${fmtDay(first)} to ${fmtDay(s.last_scheduled_date)}`) : "none on Upload-Post"}
              tone={s.covered_days <= 2 ? "text-amber-300" : undefined}
            />
            <Tile
              value={String(data.pending.length)}
              label="waiting for approval"
              sub={data.drafts ? `${data.drafts} more still in draft` : "on Telegram"}
            />
          </div>

          {/* warnings */}
          <div className="mt-3 flex flex-col gap-2">
            {s.last_scheduled_date && (
              <p className="text-xs text-amber-200 bg-amber-400/10 border border-amber-400/30 rounded p-2.5">
                <span className="font-semibold">Nothing scheduled after {fmtDay(s.last_scheduled_date)}.</span> Upload-Post has no job for{" "}
                {fmtDay(new Date(new Date(`${s.last_scheduled_date}T12:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10))} onward.
              </p>
            )}
            {!s.last_scheduled_date && !err && (
              <p className="text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2.5 font-semibold">Nothing is scheduled on Upload-Post. No video will post until one is scheduled.</p>
            )}
            {reservedDates.length > 0 && (
              <p className="text-xs text-amber-200 bg-amber-400/10 border border-amber-400/30 rounded p-2.5">
                <span className="font-semibold">{dateRanges(reservedDates)} {reservedDates.length === 1 ? "is" : "are"} reserved in slots.json but not scheduled.</span>{" "}
                {reservedDates.length === 1 ? "That date is" : "Those dates are"} held for backlog videos that have no Upload-Post job, so nothing posts on{" "}
                {reservedDates.length === 1 ? "it" : "them"} unless {reservedDates.length === 1 ? "it gets" : "they get"} scheduled. Approved videos skip these dates.
              </p>
            )}
            {s.gaps.length > 0 && (
              <p className="text-xs text-amber-200 bg-amber-400/10 border border-amber-400/30 rounded p-2.5">
                <span className="font-semibold">No post on {dateRanges(s.gaps)}</span>, inside the scheduled range.
              </p>
            )}
            {s.duplicates.map((d) => (
              <p key={d.date} className="text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2.5">
                <span className="font-semibold">{d.titles.length} videos post on {fmtDay(d.date)}:</span> {d.titles.join(" and ")}. One video per day is the rule.
              </p>
            ))}
          </div>

          <PostCalendar data={data} onChanged={() => load()} />

          {/* 1. scheduled */}
          <section className="mt-8">
            <h3 className="font-display text-2xl">Scheduled <span className="text-paper/40 text-base italic">will post on their own</span></h3>
            {data.scheduled.length === 0 ? (
              <p className="mt-3 text-paper/50 text-sm">No scheduled jobs on Upload-Post right now.</p>
            ) : (
              <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                {data.scheduled.map((it) => <Card key={`${it.date}-${it.title}`} item={it} dupe={dupeDates.has(it.date || "")} />)}
              </div>
            )}
          </section>

          {/* 2. reserved but not scheduled */}
          {data.reserved.length > 0 && (
            <section className="mt-10">
              <h3 className="font-display text-2xl">Reserved, not scheduled <span className="text-paper/40 text-base italic">booked in slots.json, no Upload-Post job</span></h3>
              <p className="text-paper/45 text-xs mt-1 max-w-2xl">
                These backlog videos hold a 7:00 AM slot in the pipeline, but nothing will publish them until they are scheduled on Upload-Post.
              </p>
              <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                {data.reserved.map((it) => <Card key={`${it.date}-${it.what}`} item={it} />)}
              </div>
            </section>
          )}

          {/* 3. waiting for approval */}
          <section className="mt-10">
            <h3 className="font-display text-2xl">Waiting for your approval <span className="text-paper/40 text-base italic">sent to Telegram, not scheduled yet</span></h3>
            <p className="text-paper/45 text-xs mt-1 max-w-2xl">
              Times show where each would land if you approve them in this order: the next free {data.post_time === "07:00" ? "7:00 AM" : data.post_time} New York
              slot, one video per day, skipping booked dates. Approve, Skip and Request changes send the same request as the
              Telegram buttons and replies; GitHub Actions does the work and posts the result to Telegram too.
            </p>
            {data.pending.length === 0 ? (
              <p className="mt-3 text-paper/50 text-sm">Nothing is waiting on Telegram right now.</p>
            ) : (
              <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                {data.pending.map((it) => <Card key={it.day} item={it} onChanged={() => load()} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
