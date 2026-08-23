import { useEffect, useState } from "react";
import { api } from "../api";

type Pipe = {
  scraped: number;
  unchecked: number;
  checked: number;
  valid: number;
  emailed: number;
  followup_sent: number;
  replied: number;
  deadBreakdown: Record<string, number>;
  filteredBreakdown: Record<string, number>;
};

// The lead's journey, in Ted's words.
const FUNNEL: { key: keyof Pipe; label: string; sub: string }[] = [
  { key: "scraped", label: "Scraped", sub: "pulled from Apify (Google Maps)" },
  { key: "checked", label: "Email-checked", sub: "run through AnyMailFinder" },
  { key: "valid", label: "Valid email", sub: "real owner email found" },
  { key: "emailed", label: "Emailed", sub: "actually contacted" },
  { key: "replied", label: "Replied", sub: "wrote back" },
];

const DEAD_LABELS: Record<string, string> = {
  not_found: "No email found",
  platform: "Generic / shared inbox",
  unknown: "Unverifiable",
  risky: "Risky (likely bounce)",
};
const FILTER_LABELS: Record<string, string> = {
  dup_recipient: "Duplicate owner",
  off_geo: "Out of target area",
  duplicate: "Duplicate listing",
  off_niche: "Not a med spa",
  suppressed: "Opted out / bounced",
};

const STATUS_COL = ["scraped", "emailed", "followup_sent", "replied"] as const;
const STATUS_LABEL: Record<string, string> = {
  scraped: "In pipeline",
  emailed: "Emailed",
  followup_sent: "Follow-up sent",
  replied: "Replied",
};

export default function Pipeline() {
  const [p, setP] = useState<Pipe | null>(null);
  const [leads, setLeads] = useState<any[]>([]);
  useEffect(() => {
    api("/api/pipeline").then(setP).catch(console.error);
    api("/api/leads").then(setLeads).catch(console.error);
  }, []);

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const sum = (o?: Record<string, number>) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);
  const deadTotal = sum(p?.deadBreakdown);
  const filteredTotal = sum(p?.filteredBreakdown);

  return (
    <div>
      <h2 className="font-display text-4xl">Pipeline</h2>
      <p className="text-paper/50 mt-1">Every lead, from the Apify scrape through AnyMailFinder to the inbox.</p>

      {/* SOURCING FUNNEL */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
        {FUNNEL.map((s, i) => {
          const val = p ? (p[s.key] as number) : 0;
          const prev = !p || i === 0 ? null : (p[FUNNEL[i - 1].key] as number);
          return (
            <div key={s.key} className="bg-panel border border-edge rounded-lg p-4">
              <div className="font-display text-3xl">{p ? val.toLocaleString() : "—"}</div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-paper/60 mt-1">{s.label}</div>
              <div className="text-[11px] text-paper/40 mt-0.5">{s.sub}</div>
              {prev != null && (
                <div className="text-[11px] text-amber-400/80 mt-2 font-mono">{pct(val, prev)}% of previous</div>
              )}
            </div>
          );
        })}
      </div>

      {/* ANYMAILFINDER RESULTS */}
      <h3 className="font-display text-2xl mt-10">AnyMailFinder results</h3>
      <p className="text-paper/50 text-sm mt-1">
        Of {p ? p.checked.toLocaleString() : "—"} leads checked
        {p && p.unchecked ? ` (${p.unchecked} still waiting)` : ""}, how the email search came back.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <div className="bg-emerald-400/10 border border-emerald-400/30 rounded-lg p-4">
          <div className="font-display text-3xl text-emerald-400">{p ? p.valid.toLocaleString() : "—"}</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-emerald-400/80 mt-1">Valid · emailable</div>
          <div className="text-[11px] text-paper/40 mt-2">these get the cold email</div>
        </div>
        <div className="bg-panel border border-edge rounded-lg p-4">
          <div className="font-display text-3xl text-rose-400">{deadTotal.toLocaleString()}</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-paper/60 mt-1">No usable email</div>
          <div className="mt-3 space-y-1">
            {p &&
              Object.entries(p.deadBreakdown).map(([k, v]) => (
                <div key={k} className="flex justify-between text-[12px] text-paper/60">
                  <span>{DEAD_LABELS[k] || k}</span>
                  <span className="font-mono">{v}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="bg-panel border border-edge rounded-lg p-4">
          <div className="font-display text-3xl text-amber-400">{filteredTotal.toLocaleString()}</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-paper/60 mt-1">Filtered out</div>
          <div className="mt-3 space-y-1">
            {p &&
              Object.entries(p.filteredBreakdown)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between text-[12px] text-paper/60">
                    <span>{FILTER_LABELS[k] || k}</span>
                    <span className="font-mono">{v}</span>
                  </div>
                ))}
            {p && filteredTotal === 0 && <p className="text-paper/40 text-xs">None</p>}
          </div>
        </div>
      </div>

      {/* LEADS BY STAGE */}
      <h3 className="font-display text-2xl mt-10">Leads by stage</h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
        {STATUS_COL.map((stage) => {
          const items = leads.filter((l) => l.status === stage);
          return (
            <div key={stage} className="bg-panel border border-edge rounded-lg p-4">
              <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
                {STATUS_LABEL[stage]} · {items.length}
              </p>
              <div className="mt-3 space-y-2">
                {items.length === 0 && <p className="text-paper/40 text-xs">Empty</p>}
                {items.slice(0, 30).map((l) => (
                  <div key={l.id} className="bg-ink rounded p-2 text-sm">
                    {l.business_name}
                    {l.email && <p className="font-mono text-[11px] text-paper/50">{l.email}</p>}
                  </div>
                ))}
                {items.length > 30 && <p className="text-paper/40 text-[11px]">+{items.length - 30} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
