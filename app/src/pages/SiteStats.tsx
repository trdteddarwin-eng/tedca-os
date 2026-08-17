import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtAgo } from "../format";

type Day = {
  day: string; views: number; visitors: number;
  calls: number; forms: number; leads: number; estimates: number;
};

type Stats = {
  site: { id: string; label: string; domain: string };
  generatedAt: string;
  today: string;
  yesterday: string;
  traffic: { ok: boolean; configured?: boolean; error?: string; today?: Day; yesterday?: Day; days?: Day[] };
  leads: {
    ok: boolean; error?: string;
    today?: number; yesterday?: number; last7?: number; total?: number; blankRows?: number;
    recent?: { when: string | null; name: string; phone: string; town: string; service: string; message: string; source: string }[];
  };
  search: {
    ok: boolean; error?: string; latestDay?: string; stale?: boolean;
    days?: { day: string; impressions: number; clicks: number; position: number }[];
    topQueries?: { query: string; impressions: number; clicks: number; position: number }[];
  };
};

/** Today against yesterday, as a coloured delta. Zero-to-zero stays neutral so
 *  a quiet night does not render as a scary red dash. */
function Delta({ now, prev }: { now: number; prev: number }) {
  if (now === prev) return <span className="text-paper/35 font-mono text-[11px]">same as yesterday</span>;
  const up = now > prev;
  const diff = Math.abs(now - prev);
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  return (
    <span className={`font-mono text-[11px] ${up ? "text-emerald-400" : "text-rose-400"}`}>
      {up ? "▲" : "▼"} {diff}{pct !== null ? ` (${pct}%)` : ""} vs yesterday
    </span>
  );
}

function Card({ label, value, prev, hint }: { label: string; value: number; prev?: number; hint?: string }) {
  return (
    <div className="rounded border border-edge bg-panel p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-paper/45">{label}</div>
      <div className="font-display text-4xl mt-1 tabular-nums">{value}</div>
      <div className="mt-1">
        {prev === undefined
          ? <span className="text-paper/35 font-mono text-[11px]">{hint || ""}</span>
          : <Delta now={value} prev={prev} />}
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

export default function SiteStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setStats(await api("/api/site-stats"));
      setError("");
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Cheap enough to keep warm while the tab is open, slow enough not to
    // hammer PostHog's query API.
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const t = stats?.traffic;
  const l = stats?.leads;
  const s = stats?.search;

  return (
    <div>
      <h2 className="font-display text-4xl">
        Site Stats {stats && <span className="italic text-signal">{stats.site.domain}</span>}
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        {loading && !stats ? "Loading…" : null}
        {stats && (
          <>
            Today is {stats.today}. Updated {fmtAgo(stats.generatedAt)}.{" "}
            <button onClick={load} className="underline underline-offset-2 hover:text-paper">refresh</button>
          </>
        )}
      </p>
      {error && <p className="text-rose-400 text-sm mt-2 font-mono">{error}</p>}

      {/* ---- TRAFFIC ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Traffic · live
      </h3>
      {t?.ok && t.today && t.yesterday ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card label="Visitors today" value={t.today.visitors} prev={t.yesterday.visitors} />
          <Card label="Pageviews today" value={t.today.views} prev={t.yesterday.views} />
          <Card label="Call taps today" value={t.today.calls} prev={t.yesterday.calls} />
          <Card label="Quotes started" value={t.today.estimates} prev={t.yesterday.estimates} />
        </div>
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

      {/* ---- LEADS ---- */}
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-paper/45 mt-7 mb-2">
        Leads · from the sheet
      </h3>
      {l?.ok ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="Leads today" value={l.today ?? 0} prev={l.yesterday ?? 0} />
            <Card label="Last 7 days" value={l.last7 ?? 0} hint="rolling week" />
            <Card label="All time" value={l.total ?? 0} hint="in the sheet" />
            <Card
              label="Blank rows"
              value={l.blankRows ?? 0}
              hint={l.blankRows ? "payloads that failed to parse" : "none, forms parsing fine"}
            />
          </div>
          {!!l.blankRows && (
            <p className="text-amber-400/90 text-xs mt-2 font-mono">
              {l.blankRows} blank row{l.blankRows > 1 ? "s" : ""} in the sheet. That is the signature of a
              lead arriving in a shape the Apps Script could not read.
            </p>
          )}

          {!!l.recent?.length && (
            <div className="mt-3 rounded border border-edge bg-panel divide-y divide-edge">
              {l.recent.map((r, i) => (
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
          {s.stale && (
            <p className="text-amber-400/90 text-xs mb-2 font-mono">
              Stale. Run tracking/gsc_report.py to pull fresh data.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(s.days || []).slice(0, 4).map((d) => (
              <div key={d.day} className="rounded border border-edge bg-panel p-4">
                <div className="font-mono text-[10px] uppercase tracking-wider text-paper/45">{d.day}</div>
                <div className="font-display text-3xl mt-1 tabular-nums">{d.impressions}</div>
                <div className="font-mono text-[11px] text-paper/45 mt-1">
                  {d.clicks} click{d.clicks === 1 ? "" : "s"} · avg pos {d.position}
                </div>
              </div>
            ))}
          </div>

          {!!s.topQueries?.length && (
            <div className="mt-3 rounded border border-edge bg-panel">
              <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper/45 border-b border-edge">
                Top queries on {s.latestDay}
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
        </>
      ) : (
        <Unavailable title="Google Search" error={s?.error} />
      )}
    </div>
  );
}
