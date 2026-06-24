import { useEffect, useState } from "react";
import { api } from "../api";

type Lead = {
  id: number;
  business_name: string;
  domain: string | null;
  category: string | null;
  ceo_name: string | null;
  contact_title: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  status: string;
  stage: string | null;
  deal_value: number | null;
  tags: string | null;
  notes: string | null;
  inbox_used: string | null;
  followup_due_at: string | null;
  last_touch_at: string | null;
  source: string | null;
  rating: number | null;
  review_count: number | null;
};

type Email = {
  id: number;
  inbox: string;
  direction: "out" | "in";
  subject: string | null;
  body: string | null;
  kind: string | null;
  sent_at: string | null;
};

const STATUS_STYLE: Record<string, string> = {
  scraped: "bg-paper/10 text-paper/70",
  emailed: "bg-sky-400/15 text-sky-300",
  followup_sent: "bg-amber-400/15 text-amber-300",
  replied: "bg-emerald-400/15 text-emerald-400",
  do_not_contact: "bg-signal/15 text-signal",
};

export default function Crm() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  function refresh() {
    api("/api/leads").then(setLeads).catch(console.error);
  }
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <h2 className="font-display text-4xl">Clients / CRM</h2>
      <p className="text-paper/50 text-sm mt-2">
        Auto-populated by the cold-email engine. {leads.length} lead{leads.length === 1 ? "" : "s"}. Click a row for the full record.
      </p>

      <div className="mt-6 bg-panel border border-edge rounded-lg overflow-x-auto">
        {leads.length === 0 ? (
          <p className="text-paper/50 text-sm p-5">No leads yet — they appear here after the first scrape run.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50 text-left">
                <th className="p-3">Business</th>
                <th className="p-3">Contact</th>
                <th className="p-3">Status</th>
                <th className="p-3">Follow-up</th>
                <th className="p-3">Via inbox</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setOpenId(l.id)}
                  className="border-t border-edge/50 cursor-pointer hover:bg-paper/5"
                >
                  <td className="p-3">
                    <div>{l.business_name}</div>
                    <div className="font-mono text-[11px] text-paper/40">{l.domain || "—"}</div>
                  </td>
                  <td className="p-3">
                    <div>{l.ceo_name || "—"}</div>
                    <div className="font-mono text-[11px] text-paper/40">{l.email || "—"}</div>
                  </td>
                  <td className="p-3">
                    <span className={`font-mono text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[l.status] || "bg-paper/10"}`}>
                      {l.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs text-paper/60">
                    {l.followup_due_at ? l.followup_due_at.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                  <td className="p-3 font-mono text-xs text-paper/60">{l.inbox_used || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId != null && (
        <LeadDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onSaved={() => {
            refresh();
          }}
        />
      )}
    </div>
  );
}

function LeadDetail({ id, onClose, onSaved }: { id: number; onClose: () => void; onSaved: () => void }) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [draft, setDraft] = useState<Partial<Lead>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api(`/api/leads/${id}`)
      .then((d) => {
        setLead(d.lead);
        setEmails(d.emails);
        setDraft({});
      })
      .catch(console.error);
  }, [id]);

  function field<K extends keyof Lead>(k: K): any {
    return (draft as any)[k] ?? (lead as any)?.[k] ?? "";
  }
  function set<K extends keyof Lead>(k: K, v: any) {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  }

  async function save() {
    if (!lead) return;
    const r = await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(draft) });
    setLead(r.lead);
    setDraft({});
    setSaved(true);
    onSaved();
    setTimeout(() => setSaved(false), 1800);
  }

  const ro = (label: string, value: any) => (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">{label}</div>
      <div className="text-sm mt-0.5">{value || "—"}</div>
    </div>
  );
  const input = (label: string, k: keyof Lead, ph = "") => (
    <label className="block">
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">{label}</div>
      <input
        value={field(k)}
        placeholder={ph}
        onChange={(e) => set(k, e.target.value)}
        className="w-full mt-1 bg-ink border border-edge rounded px-2.5 py-1.5 text-sm text-paper"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-xl h-full bg-panel border-l border-edge overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {!lead ? (
          <p className="text-paper/50">Loading…</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl">{lead.business_name}</h3>
                <p className="font-mono text-xs text-paper/50">
                  {lead.domain || "no domain"} · {lead.category || "—"}
                  {lead.rating != null ? ` · ${lead.rating}★ (${lead.review_count ?? 0})` : ""}
                </p>
              </div>
              <button onClick={onClose} className="text-paper/50 hover:text-paper font-mono text-sm">✕ close</button>
            </div>

            <div className="mt-3">
              <span className={`font-mono text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[lead.status] || "bg-paper/10"}`}>
                {lead.status}
              </span>
            </div>

            {/* read-only engine facts */}
            <div className="mt-5 grid grid-cols-2 gap-4">
              {ro("Sent via inbox", lead.inbox_used)}
              {ro("Follow-up due", lead.followup_due_at ? lead.followup_due_at.replace("T", " ") : "none")}
              {ro("Last touch", lead.last_touch_at ? lead.last_touch_at.replace("T", " ") : "—")}
              {ro("Email verify", lead.email_status)}
              {ro("Email", lead.email)}
              {ro("Source", lead.source)}
            </div>

            {/* editable CRM fields */}
            <div className="mt-6 border-t border-edge pt-5">
              <div className="font-mono text-[11px] uppercase tracking-widest text-paper/50 mb-3">Lead record · editable</div>
              <div className="grid grid-cols-2 gap-3">
                {input("Contact name", "ceo_name")}
                {input("Title / role", "contact_title", "Owner")}
                {input("LinkedIn URL", "linkedin_url", "https://linkedin.com/in/…")}
                {input("Phone", "phone")}
                {input("City", "city")}
                {input("State", "state")}
                <label className="block">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Stage</div>
                  <select
                    value={field("stage")}
                    onChange={(e) => set("stage", e.target.value)}
                    className="w-full mt-1 bg-ink border border-edge rounded px-2.5 py-1.5 text-sm text-paper"
                  >
                    <option value="">—</option>
                    {["lead", "contacted", "replied", "booked", "won", "lost"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {input("Deal value ($)", "deal_value")}
              </div>
              <label className="block mt-3">
                <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Tags (comma-separated)</div>
                <input
                  value={field("tags")}
                  onChange={(e) => set("tags", e.target.value)}
                  className="w-full mt-1 bg-ink border border-edge rounded px-2.5 py-1.5 text-sm text-paper"
                />
              </label>
              <label className="block mt-3">
                <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Notes</div>
                <textarea
                  rows={3}
                  value={field("notes")}
                  onChange={(e) => set("notes", e.target.value)}
                  className="w-full mt-1 bg-ink border border-edge rounded px-2.5 py-1.5 text-sm text-paper leading-relaxed"
                />
              </label>
              <button
                onClick={save}
                disabled={Object.keys(draft).length === 0}
                className="mt-4 bg-signal text-paper rounded px-4 py-2 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
              >
                {saved ? "Saved ✓" : "Save record"}
              </button>
            </div>

            {/* full message timeline */}
            <div className="mt-7 border-t border-edge pt-5">
              <div className="font-mono text-[11px] uppercase tracking-widest text-paper/50 mb-3">
                Timeline · {emails.length} message{emails.length === 1 ? "" : "s"}
              </div>
              {emails.length === 0 ? (
                <p className="text-paper/40 text-sm">No messages yet.</p>
              ) : (
                <div className="space-y-2">
                  {emails.map((e) => (
                    <div key={e.id} className="bg-ink border border-edge rounded-lg p-3">
                      <div className="flex items-center justify-between font-mono text-[11px] text-paper/50">
                        <span className={e.direction === "in" ? "text-emerald-400" : "text-sky-300"}>
                          {e.direction === "in" ? "← reply" : `→ ${e.kind}`}
                        </span>
                        <span>{(e.sent_at || "").replace("T", " ")}</span>
                      </div>
                      <div className="text-sm mt-1 font-medium">{e.subject || "(no subject)"}</div>
                      <div className="text-paper/60 text-xs mt-1 whitespace-pre-wrap line-clamp-4">{e.body}</div>
                      <div className="font-mono text-[10px] text-paper/30 mt-1.5">via {e.inbox}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
