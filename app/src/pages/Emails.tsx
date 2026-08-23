import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtET } from "../format";

type Email = {
  id: number;
  lead_id: number | null;
  inbox: string | null;
  direction: "out" | "in";
  subject: string | null;
  body: string | null;
  kind: string | null;
  sent_at: string | null;
  business_name: string | null;
  lead_email: string | null;
};

type DayRow = { day: string; new_leads: number; followups: number; replies: number };
type InboxRow = { inbox: string; new_leads: number; followups: number; total: number };
type Stats = {
  byDay: DayRow[];
  byInboxToday: InboxRow[];
  totals: { new_leads: number; followups: number };
};

const KIND_STYLE: Record<string, string> = {
  initial: "bg-sky-400/15 text-sky-300",
  followup: "bg-amber-400/15 text-amber-300",
  reply: "bg-emerald-400/15 text-emerald-400",
  test: "bg-paper/10 text-paper/60",
};

export default function Emails() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [inboxFilter, setInboxFilter] = useState<string>("all");

  useEffect(() => {
    const load = () => {
      api("/api/emails").then(setEmails).catch(() => {});
      api("/api/email-stats").then(setStats).catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  // every distinct sending inbox, for the "see all mail from one account" filter
  const inboxes = Array.from(new Set(emails.map((e) => e.inbox).filter(Boolean) as string[])).sort();

  const shown = emails.filter((e) => {
    if (inboxFilter !== "all" && e.inbox !== inboxFilter) return false;
    if (filter === "all") return true;
    if (filter === "in") return e.direction === "in";
    if (filter === "out") return e.direction === "out";
    return e.kind === filter;
  });

  const maxDay = Math.max(1, ...(stats?.byDay || []).map((d) => d.new_leads + d.followups));
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  return (
    <div>
      <h2 className="font-display text-4xl">
        Emails <span className="italic text-signal">{emails.length}</span>
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        Every email the machine has sent or received — click one to read the full copy.
      </p>

      {/* ── NEW LEADS EMAILED — the "how many are we sending" view ── */}
      {stats && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* headline totals */}
          <div className="bg-panel border border-edge rounded-lg p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">New leads emailed (all time)</p>
            <p className="font-display text-5xl text-signal mt-1">{stats.totals.new_leads || 0}</p>
            <p className="font-mono text-[11px] text-paper/50 mt-2">
              first-time cold emails to new businesses
            </p>
            <div className="mt-4 pt-4 border-t border-edge/60">
              <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Follow-ups sent (all time)</p>
              <p className="font-display text-3xl text-amber-300 mt-1">{stats.totals.followups || 0}</p>
              <p className="font-mono text-[11px] text-paper/50 mt-1">second-touch emails</p>
            </div>
          </div>

          {/* daily bars — new leads vs follow-ups per day */}
          <div className="bg-panel border border-edge rounded-lg p-5 lg:col-span-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">
              Emails per day &nbsp;·&nbsp; <span className="text-sky-300">new leads</span> &nbsp;<span className="text-amber-300">follow-ups</span>
            </p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {stats.byDay.length === 0 && <p className="text-paper/40 text-sm">No sends yet.</p>}
              {stats.byDay.map((d) => (
                <div key={d.day} className="flex items-center gap-2">
                  <span className={`font-mono text-[11px] w-24 shrink-0 ${d.day === todayET ? "text-signal font-semibold" : "text-paper/50"}`}>
                    {d.day === todayET ? "today" : d.day.slice(5)}
                  </span>
                  <div className="flex-1 flex items-center gap-px h-5">
                    <div className="bg-sky-400/80 rounded-l h-full" style={{ width: `${(d.new_leads / maxDay) * 100}%` }} />
                    <div className="bg-amber-400/70 rounded-r h-full" style={{ width: `${(d.followups / maxDay) * 100}%` }} />
                    <span className="font-mono text-[11px] text-paper/60 ml-2 shrink-0">
                      {d.new_leads} new{d.followups ? ` + ${d.followups} f/u` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── PER-INBOX TODAY — what each of your 12 accounts sent ── */}
      {stats && stats.byInboxToday.length > 0 && (
        <div className="mt-4 bg-panel border border-edge rounded-lg p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">
            Sent today by inbox &nbsp;·&nbsp; {stats.byInboxToday.reduce((a, r) => a + r.total, 0)} total across {stats.byInboxToday.length} accounts
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
            {stats.byInboxToday.map((r) => (
              <button
                key={r.inbox}
                onClick={() => { setInboxFilter(r.inbox); setFilter("out"); }}
                className="text-left bg-ink/50 hover:bg-ink border border-edge/60 rounded px-3 py-2"
              >
                <p className="font-mono text-[11px] text-paper/80 truncate">{r.inbox}</p>
                <p className="font-mono text-[11px] mt-1">
                  <span className="text-sky-300">{r.new_leads} new</span>
                  <span className="text-paper/30"> · </span>
                  <span className="text-amber-300">{r.followups} f/u</span>
                </p>
              </button>
            ))}
          </div>
          <p className="font-mono text-[10px] text-paper/40 mt-3">click an inbox to see everything it has sent</p>
        </div>
      )}

      {/* per-inbox filter for the full log below */}
      {inboxes.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-6 items-center">
          <span className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Inbox:</span>
          <button
            onClick={() => setInboxFilter("all")}
            className={`font-mono text-[11px] px-2.5 py-1 rounded ${inboxFilter === "all" ? "bg-signal/15 text-signal" : "text-paper/50 hover:text-paper bg-panel"}`}
          >
            all accounts
          </button>
          {inboxes.map((ib) => (
            <button
              key={ib}
              onClick={() => setInboxFilter(ib)}
              className={`font-mono text-[11px] px-2.5 py-1 rounded ${inboxFilter === ib ? "bg-signal/15 text-signal" : "text-paper/50 hover:text-paper bg-panel"}`}
            >
              {ib}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-4">
        {["all", "out", "in", "initial", "followup", "reply", "test"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`font-mono text-[11px] uppercase tracking-widest px-3 py-1.5 rounded ${
              filter === f ? "bg-signal/15 text-signal" : "text-paper/50 hover:text-paper bg-panel"
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="mt-4 bg-panel border border-edge rounded-lg divide-y divide-edge/50">
        {shown.length === 0 && (
          <p className="text-paper/50 text-sm p-5">Nothing here yet.</p>
        )}
        {shown.map((e) => (
          <div key={e.id} className="p-4 cursor-pointer hover:bg-ink/40" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 rounded ${KIND_STYLE[e.kind || ""] || "bg-paper/10"}`}>
                {e.direction === "in" ? "← " : "→ "}{e.kind || e.direction}
              </span>
              <span className="text-sm font-medium">{e.business_name || e.lead_email || "—"}</span>
              <span className="font-mono text-xs text-paper/40 ml-auto">{fmtET(e.sent_at)}</span>
            </div>
            <p className="text-paper/70 text-sm mt-1">{e.subject}</p>
            <p className="font-mono text-[11px] text-paper/40 mt-0.5">
              {e.direction === "out" ? `from ${e.inbox} → ${e.lead_email || "?"}` : `from ${e.lead_email || "?"} → ${e.inbox}`}
            </p>
            {open === e.id && (
              <pre className="mt-3 text-xs text-paper/80 whitespace-pre-wrap bg-ink rounded p-4 leading-relaxed">{e.body}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
