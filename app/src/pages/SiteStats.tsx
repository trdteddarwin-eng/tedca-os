import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtAgo } from "../format";

type Day = {
  day: string; views: number; visitors: number;
  calls: number; forms: number; leads: number; estimates: number;
};

type Query = { query: string; impressions: number; clicks: number; position: number; off?: string };

type CallRow = {
  when: string | null; caller: string; name: string; kind: string; transcript: string;
};

type LeadRow = {
  when: string | null; name: string; phone: string;
  town: string; service: string; message: string; source: string;
};

type SearchDay = {
  day: string; impressions: number; clicks: number;
  qualified: number; qualifiedClicks: number; position: number;
};

type Stats = {
  site: { id: string; label: string; domain: string };
  generatedAt: string;
  day: string;
  prevDay: string;
  today: string;
  isToday: boolean;
  yesterday: string;
  traffic: {
    ok: boolean; configured?: boolean; error?: string; days?: Day[];
    selected?: Day; previous?: Day; earliestDay?: string | null; inRange?: boolean;
  };
  leads: {
    ok: boolean; error?: string;
    selected?: number; previous?: number; last7?: number; total?: number; blankRows?: number;
    days?: string[];
    onDay?: LeadRow[];
    recent?: LeadRow[];
  };
  calls: {
    ok: boolean; error?: string;
    selected?: number; previous?: number; total?: number;
    days?: string[]; onDay?: CallRow[]; recent?: CallRow[];
  };
  search: {
    ok: boolean; error?: string; latestDay?: string; day?: string; hasDay?: boolean;
    selected?: SearchDay | null; stale?: boolean;
    days?: SearchDay[];
    topQueries?: Query[];
    offQueries?: Query[];
    offTotals?: { impressions: number; clicks: number };
  };
};

/** A day against the day before it, as a coloured delta. Zero-to-zero stays
 *  neutral so a quiet night does not render as a scary red dash. The comparison
 *  day is named rather than called "yesterday", because the page can be showing
 *  any date in the archive. */
function Delta({ now, prev, prevLabel }: { now: number; prev: number; prevLabel: string }) {
  if (now === prev) return <span className="text-paper/35 font-mono text-[11px]">same as {prevLabel}</span>;
  const up = now > prev;
  const diff = Math.abs(now - prev);
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  return (
    <span className={`font-mono text-[11px] ${up ? "text-emerald-400" : "text-rose-400"}`}>
      {up ? "▲" : "▼"} {diff}{pct !== null ? ` (${pct}%)` : ""} vs {prevLabel}
    </span>
  );
}

/** A YYYY-MM-DD key as "Sat Aug 30". Parsed as a plain calendar date, never as
 *  a timestamp, so it cannot shift a day backwards in a western timezone. */
function fmtDay(key?: string) {
  if (!key) return "";
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" })
    .format(new Date(y, m - 1, d));
}

/** The "?" beside a stat. Every number on this page is one of a dozen that look
 *  alike, and half of them were being read as something they are not — "call
 *  taps" in particular counts clicks on the phone link, NOT calls received.
 *  The explanation lives next to the number rather than in a doc nobody opens. */
function Explain({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={text}
        className="ml-1 grid h-3.5 w-3.5 place-items-center rounded-full border border-edge
                   font-mono text-[9px] leading-none text-paper/40
                   hover:border-paper/40 hover:text-paper
                   focus:outline-none focus-visible:ring-1 focus-visible:ring-signal"
      >?</button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-20 hidden w-60 rounded border border-edge
                   bg-black/95 p-2 text-[11px] leading-snug text-paper/80 normal-case tracking-normal
                   shadow-lg group-hover:block group-focus-within:block"
      >{text}</span>
    </span>
  );
}

function Card({ label, value, prev, prevLabel, hint, explain }:
  { label: string; value: number; prev?: number; prevLabel?: string; hint?: string; explain?: string }) {
  return (
    <div className="rounded border border-edge bg-panel p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-paper/45">
        {label}{explain && <Explain text={explain} />}
      </div>
      <div className="font-display text-4xl mt-1 tabular-nums">{value}</div>
      <div className="mt-1">
        {prev === undefined
          ? <span className="text-paper/35 font-mono text-[11px]">{hint || ""}</span>
          : <Delta now={value} prev={prev} prevLabel={prevLabel || "the day before"} />}
      </div>
    </div>
  );
}

/** A source that could not report. Shown rather than hidden: a blank panel
 *  reads as "zero traffic", which is a very different thing from "not wired". */
function Unavailable({ title, error }: { title: string; error?: string }) {
  return (
    <div className="rounded border border-edge bg-panel/50 p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-paper/45">{title}</div>
      <p className="text-paper/50 text-sm mt-2">{error || "No data"}</p>
    </div>
  );
}

/** The last 30 days as clickable chips. Days that produced a lead carry a dot,
 *  so the month can be scanned for the ones worth opening instead of stepped
 *  through one at a time. */
function DayStrip({ today, day, leadDays, onPick }:
  { today: string; day: string; leadDays: string[]; onPick: (d: string) => void }) {
  const days: string[] = [];
  const [y, m, d] = today.split("-").map(Number);
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(y, m - 1, d - i);
    days.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`);
  }
  return (
    <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
      {days.map((k) => {
        const on = k === day;
        const lead = leadDays.includes(k);
        return (
          <button
            key={k}
            onClick={() => onPick(k)}
            title={fmtDay(k) + (lead ? " · lead" : "")}
            className={`shrink-0 w-9 rounded border px-1 py-1 font-mono text-[11px] tabular-nums transition-colors
              ${on ? "border-signal text-signal bg-signal/10" : "border-edge text-paper/45 hover:text-paper hover:border-paper/30"}`}
          >
            {k.slice(-2)}
            <span className={`mx-auto mt-1 block h-1 w-1 rounded-full ${lead ? "bg-signal" : "bg-transparent"}`} />
          </button>
        );
      })}
    </div>
  );
}

export default function SiteStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // "" means today. Kept as the requested day rather than the resolved one, so
  // re-fetching after midnight still means "today" instead of freezing on a date.
  const [day, setDay] = useState("");
  // Four sources on one page is more than fits on a screen, so they get tabs.
  // "all" stays the default: the point of the page is seeing them together.
  const [tab, setTab] = useState<"all" | "traffic" | "calls" | "leads" | "search">("all");

  async function load(d = day) {
    setLoading(true);
    try {
      setStats(await api(`/api/site-stats${d ? `?day=${d}` : ""}`));
      setError("");
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(day);
    // Only the live view needs refreshing. Polling a finished day would burn
    // PostHog queries to redraw numbers that cannot change.
    if (day) return;
    const t = setInterval(() => load(""), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [day]);

  const t = stats?.traffic;
  const l = stats?.leads;
  const c = stats?.calls;
  const s = stats?.search;
  const viewing = stats?.day || "";
  const prevLabel = fmtDay(stats?.prevDay);
  const isToday = stats?.isToday ?? true;
  const show = (k: string) => tab === "all" || tab === k;
  const step = (n: number) => {
    if (!stats) return;
    const [yy, mm, dd] = stats.day.split("-").map(Number);
    const dt = new Date(yy, mm - 1, dd + n);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    setDay(k >= stats.today ? "" : k);
  };

  return (
    <div>
      <h2 className="font-display text-4xl">
        Site Stats {stats && <span className="italic text-signal">{stats.site.domain}</span>}
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        {loading && !stats ? "Loading…" : null}
        {stats && (
          <>
            {isToday ? "Showing today" : `Showing ${fmtDay(viewing)}`}, against {prevLabel}.
            Updated {fmtAgo(stats.generatedAt)}.{" "}
            <button onClick={() => load()} className="underline underline-offset-2 hover:text-paper">refresh</button>
          </>
        )}
      </p>
      {error && <p className="text-rose-400 text-sm mt-2 font-mono">{error}</p>}

      {stats && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => step(-1)}
              className="rounded border border-edge px-2 py-1 font-mono text-[11px] text-paper/60 hover:text-paper hover:border-paper/30"
            >‹ earlier</button>
            <input
              type="date"
              value={viewing}
              max={stats.today}
              onChange={(e) => setDay(e.target.value >= stats.today ? "" : e.target.value)}
              className="rounded border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-paper"
            />
            <button
              onClick={() => step(1)}
              disabled={isToday}
              className="rounded border border-edge px-2 py-1 font-mono text-[11px] text-paper/60 hover:text-paper hover:border-paper/30 disabled:opacity-30 disabled:hover:text-paper/60"
            >later ›</button>
            <button
              onClick={() => setDay("")}
              disabled={isToday}
              className="rounded border border-edge px-2 py-1 font-mono text-[11px] text-paper/60 hover:text-paper hover:border-paper/30 disabled:opacity-30"
            >today</button>
            {!isToday && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-signal">viewing an archived day</span>
            )}
          </div>
          <DayStrip
            today={stats.today}
            day={viewing}
            leadDays={[...(l?.days || []), ...(c?.days || [])]}
            onPick={(k) => setDay(k >= stats.today ? "" : k)}
          />

          <div className="mt-4 flex flex-wrap gap-1 border-b border-edge">
            {([
              ["all", "Everything", null],
              ["traffic", "Traffic", null],
              ["calls", "Calls", c?.ok ? c.selected ?? 0 : null],
              ["leads", "Leads", l?.ok ? l.selected ?? 0 : null],
              ["search", "Search", null],
            ] as [typeof tab, string, number | null][]).map(([k, label, count]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`-mb-px border-b-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors
                  ${tab === k
                    ? "border-signal text-signal"
                    : "border-transparent text-paper/45 hover:text-paper"}`}
              >
                {label}
                {!!count && <span className="ml-1.5 tabular-nums text-signal">{count}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {show("traffic") && (
        <>
      {/* ---- TRAFFIC ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Traffic · {isToday ? "live" : fmtDay(viewing)}
      </h3>
      {t?.ok && t.selected && t.previous ? (
        <>
          {t.inRange === false && (
            <p className="text-amber-400/90 text-xs mb-2 font-mono">
              Older than PostHog's {t.earliestDay ? `window (back to ${t.earliestDay})` : "window"}. These
              zeros mean "not retained", not "nobody came".
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="Visitors" value={t.selected.visitors} prev={t.previous.visitors} prevLabel={prevLabel}
              explain="Distinct people who loaded a page that day, counted by PostHog. One person browsing five pages is one visitor." />
            <Card label="Pageviews" value={t.selected.views} prev={t.previous.views} prevLabel={prevLabel}
              explain="Total pages loaded. Divided by visitors it tells you how deeply people read: 13 views from 2 visitors is someone going through the whole site." />
            <Card label="Call taps" value={t.selected.calls} prev={t.previous.calls} prevLabel={prevLabel}
              explain="Clicks on the phone number ON the site. It is NOT the number of calls you received. Desktop visitors cannot tap to dial, so they read the number and call from their phone, and that never shows here. Use the Calls panel for actual calls." />
            <Card label="Quotes started" value={t.selected.estimates} prev={t.previous.estimates} prevLabel={prevLabel}
              explain="Visitors who started the /quote estimate calculator. The step before a lead: they wanted a price but may not have left contact details." />
          </div>
        </>
      ) : (
        <Unavailable
          title="Traffic"
          error={
            t?.configured === false
              ? "PostHog personal API key not set. Add it on the API Keys page as \"PostHog (site stats)\" and this fills in."
              : t?.error
          }
        />
      )}
        </>
      )}

      {show("calls") && (
        <>
      {/* ---- CALLS ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Calls · from Google Voice
      </h3>
      {c?.ok ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card
              label={`Calls ${isToday ? "today" : "on " + fmtDay(viewing)}`}
              value={c.selected ?? 0}
              prev={c.previous ?? 0}
              prevLabel={prevLabel}
              explain="Voicemails and missed calls on this line that day, read out of Google Voice notification email. Every one of these is someone who wanted to talk and got no answer."
            />
            <Card label="All time" value={c.total ?? 0} hint="voicemails and missed calls"
              explain="Every call in the Calls tab. Google's own welcome voicemail is filtered out, so this counts real callers only." />
          </div>
          {!c.total && (
            <p className="text-amber-400/90 text-xs mt-2 font-mono">
              The Calls tab is empty. In the Apps Script editor run backfillVoicemails to load the
              voicemails already in Gmail, then installVoicemailTrigger to keep it current.
            </p>
          )}
          {!!(c.onDay?.length ? c.onDay : c.recent)?.length && (
            <>
              <div className="mt-4 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                {c.onDay?.length ? `On ${fmtDay(viewing)}` : "Most recent"}
              </div>
              <div className="mt-2 rounded border border-edge bg-panel divide-y divide-edge">
                {(c.onDay?.length ? c.onDay : c.recent)!.map((r, i) => (
                  <div key={i} className="p-3">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono text-sm text-signal">{r.caller}</span>
                      {r.name && <span className="text-sm">{r.name}</span>}
                      <span className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
                        {r.kind === "missed" ? "missed call" : "voicemail"}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-paper/35">{fmtAgo(r.when)}</span>
                    </div>
                    {r.transcript && (
                      <p className="text-paper/60 text-sm mt-1 break-words">{r.transcript}</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <Unavailable title="Calls" error={c?.error} />
      )}
        </>
      )}

      {show("leads") && (
        <>
      {/* ---- LEADS ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Leads · from the sheet
      </h3>
      {l?.ok ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label={`Leads ${isToday ? "today" : "on " + fmtDay(viewing)}`} value={l.selected ?? 0} prev={l.previous ?? 0} prevLabel={prevLabel}
              explain="Form submissions that day, with our own test rows and spam removed. A single person can produce several as they move through the form." />
            <Card label="Last 7 days" value={l.last7 ?? 0} hint="rolling week, to today"
              explain="Real leads in the last seven days counting back from today. It does not follow the day picker, so it stays a fixed reference." />
            <Card label="All time" value={l.total ?? 0} hint="in the sheet"
              explain="Every real lead the sheet has ever held. Test submissions and bot spam are excluded from this count." />
            <Card
              label="Blank rows"
              value={l.blankRows ?? 0}
              hint={l.blankRows ? "payloads that failed to parse" : "none, forms parsing fine"}
              explain="Rows that arrived with no name, phone or email. It means a submission reached the sheet in a shape the script could not read. Any increase here means leads are being lost."
            />
          </div>
          {!!l.blankRows && (
            <p className="text-amber-400/90 text-xs mt-2 font-mono">
              {l.blankRows} blank row{l.blankRows > 1 ? "s" : ""} in the sheet. That is the signature of a
              lead arriving in a shape the Apps Script could not read.
            </p>
          )}

          <div className="mt-4 font-mono text-[10px] uppercase tracking-wider text-paper/45">
            {isToday ? "Latest leads" : `On ${fmtDay(viewing)}`}
          </div>
          {!isToday && !l.onDay?.length && (
            <p className="text-paper/40 text-sm mt-2">
              No leads on this day. The most recent ones are below.
            </p>
          )}
          {!!(isToday ? l.recent : l.onDay?.length ? l.onDay : l.recent)?.length && (
            <div className="mt-2 rounded border border-edge bg-panel divide-y divide-edge">
              {(isToday ? l.recent : l.onDay?.length ? l.onDay : l.recent)!.map((r, i) => (
                <div key={i} className="p-3">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium">{r.name || "No name given"}</span>
                    <span className="font-mono text-[11px] text-signal">{r.phone}</span>
                    {r.town && <span className="font-mono text-[10px] text-paper/40">{r.town}</span>}
                    <span className="ml-auto font-mono text-[10px] text-paper/35">{fmtAgo(r.when)}</span>
                  </div>
                  {r.message && (
                    <p className="font-mono text-[11px] text-paper/50 mt-1 break-words">{r.message}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <Unavailable title="Leads" error={l?.error} />
      )}
        </>
      )}

      {show("search") && (
        <>
      {/* ---- SEARCH ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Google Search {s?.latestDay ? `· data through ${s.latestDay}` : ""}
      </h3>
      {s?.ok ? (
        <>
          <p className="text-paper/40 text-xs mb-2">
            Search Console runs two to three days behind, so this is never "today". It is the number that
            tells you whether the SEO is working.
          </p>
          <p className="text-paper/40 text-xs mb-2">
            The big number is <strong>qualified</strong> impressions: searches for something we sell, in
            an area we serve. Google shows the site for plenty that is neither, and counting those made
            the totals look better than the pipeline actually was.
          </p>
          {s.stale && (
            <p className="text-amber-400/90 text-xs mb-2 font-mono">
              Stale. Run tracking/gsc_report.py to pull fresh data.
            </p>
          )}
          {!isToday && s.hasDay === false && (
            <p className="text-amber-400/90 text-xs mb-2 font-mono">
              No Search Console data for {fmtDay(viewing)} yet. Showing {fmtDay(s.day)}, the newest day it has.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              // Anchor the strip on the day being viewed, then the three before it,
              // so the picker moves this panel too instead of always showing newest.
              const all = s.days || [];
              const at = Math.max(0, all.findIndex((d) => d.day === s.day));
              return all.slice(at, at + 4);
            })().map((d) => (
              <div key={d.day} className={`rounded border p-4 ${d.day === s.day ? "border-signal/60 bg-signal/5" : "border-edge bg-panel"}`}>
                <div className="font-mono text-[10px] uppercase tracking-wider text-paper/45">{d.day}</div>
                <div className="font-display text-3xl mt-1 tabular-nums">{d.qualified}</div>
                <div className="font-mono text-[11px] text-paper/45 mt-1">
                  {d.clicks} click{d.clicks === 1 ? "" : "s"} · avg pos {d.position}
                </div>
                {d.impressions !== d.qualified && (
                  <div className="font-mono text-[10px] text-paper/30 mt-0.5">
                    {d.impressions} raw, {d.impressions - d.qualified} off-intent
                  </div>
                )}
              </div>
            ))}
          </div>

          {!!s.topQueries?.length && (
            <div className="mt-3 rounded border border-edge bg-panel">
              <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper/45 border-b border-edge">
                Top queries on {fmtDay(s.day)}
              </div>
              <div className="divide-y divide-edge">
                {s.topQueries.map((q) => (
                  <div key={q.query} className="px-3 py-2 flex items-center gap-3">
                    <span className="text-sm truncate flex-1">{q.query}</span>
                    <span className="font-mono text-[11px] text-paper/50 shrink-0 tabular-nums">
                      {q.impressions} imp · {q.clicks} clk · pos {q.position}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!s.offQueries?.length && (
            <div className="mt-3 rounded border border-edge bg-panel/50">
              <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper/35 border-b border-edge">
                Off-intent, excluded ({s.offTotals?.impressions || 0} imp)
              </div>
              <div className="divide-y divide-edge">
                {s.offQueries.map((q) => (
                  <div key={q.query} className="px-3 py-2 flex items-center gap-3">
                    <span className="text-sm truncate flex-1 text-paper/45">{q.query}</span>
                    <span className="font-mono text-[11px] text-paper/30 shrink-0 tabular-nums">
                      {q.off} · {q.impressions} imp · pos {q.position}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <Unavailable title="Google Search" error={s?.error} />
      )}
        </>
      )}

    </div>
  );
}
