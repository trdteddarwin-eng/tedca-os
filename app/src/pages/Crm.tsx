import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtET } from "../format";

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
  linkedin_message: string | null;
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
  first_sent_at: string | null;
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

// Friendly label + colour for each stored message, so the timeline reads
// "first email / follow-up / their reply" instead of raw kinds.
function msgMeta(e: Email): { text: string; cls: string } {
  const isTest = (e.subject || "").includes("[TEST") || e.kind === "test";
  if (e.direction === "in") return { text: "← their reply", cls: "text-emerald-400" };
  if (e.kind === "reply") return { text: "→ auto-reply (Concierge)", cls: "text-sky-300" };
  if (e.kind === "followup") return { text: "→ follow-up", cls: "text-amber-300" };
  if (isTest) return { text: "→ test send", cls: "text-paper/40" };
  return { text: "→ first email", cls: "text-sky-300" };
}

const STATUS_STYLE: Record<string, string> = {
  scraped: "bg-paper/10 text-paper/70",
  emailed: "bg-sky-400/15 text-sky-300",
  followup_sent: "bg-amber-400/15 text-amber-300",
  replied: "bg-emerald-400/15 text-emerald-400",
  do_not_contact: "bg-signal/15 text-signal",
};

export default function Crm() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  // server-side filter + counts → the table and chips reflect ALL leads, not a
  // truncated page (the old client-side count hid older emailed leads).
  function refresh() {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("status", filter);
    if (q.trim()) params.set("q", q.trim());
    const qs = params.toString();
    api(`/api/leads${qs ? `?${qs}` : ""}`).then(setLeads).catch(console.error);
    api("/api/leads/counts").then(setCounts).catch(console.error);
  }
  // refetch when filter/search change (debounced), and live-refresh every 20s
  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [filter, q]);
  useEffect(() => {
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [filter, q]);

  const statuses = ["all", ...Object.keys(counts).filter((k) => k !== "all").sort()];
  const shown = leads; // already filtered server-side

  // Businesses we have ACTUALLY emailed, across every after-first-email stage. The raw
  // "emailed" status chip alone reads like a total but only means "awaiting follow-up" —
  // that misread has confused the operator twice, so the true total gets top billing.
  const contacted =
    (counts.emailed || 0) + (counts.followup_sent || 0) + (counts.replied || 0) +
    (counts.bounced || 0) + (counts.do_not_contact || 0) + (counts.opted_out || 0);
  // stage names that say what the bucket MEANS, not the internal status string
  const CHIP_LABEL: Record<string, string> = {
    emailed: "awaiting follow-up",
    followup_sent: "followed up",
    scraped: "not contacted yet",
    do_not_contact: "do not contact",
  };

  return (
    <div>
      <h2 className="font-display text-4xl">Clients / CRM</h2>
      <p className="text-paper/50 text-sm mt-2">
        Auto-populated by the cold-email engine. <span className="text-paper font-semibold">{contacted} businesses contacted so far.</span>{" "}
        {shown.length} of {counts.all || 0} lead{(counts.all || 0) === 1 ? "" : "s"} shown. Click a row for the full record.
      </p>

      {/* filters */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`font-mono text-[11px] px-3 py-1.5 rounded border transition-colors ${
              filter === s ? "bg-paper/15 border-paper/30 text-paper" : "border-edge text-paper/50 hover:text-paper/80"
            }`}
          >
            {s === "all" ? `all · ${counts.all || 0}` : `${CHIP_LABEL[s] || s} · ${counts[s] || 0}`}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search name, email, city…"
          className="ml-auto bg-ink border border-edge rounded px-3 py-1.5 text-sm text-paper w-56"
        />
      </div>

      <div className="mt-4 bg-panel border border-edge rounded-lg overflow-x-auto">
        {shown.length === 0 ? (
          <p className="text-paper/50 text-sm p-5">No leads match this filter.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50 text-left">
                <th className="p-3">Business</th>
                <th className="p-3">Contact</th>
                <th className="p-3">LinkedIn</th>
                <th className="p-3">Status</th>
                <th className="p-3">Sent</th>
                <th className="p-3">Follow-up</th>
                <th className="p-3">Via inbox</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
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
                    {l.linkedin_url ? (
                      <a
                        href={l.linkedin_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-[11px] text-sky-300 hover:underline"
                      >
                        in/{l.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/(in|company)\//i, "").replace(/\/$/, "").slice(0, 16) || "profile"}
                      </a>
                    ) : (
                      <span className="text-paper/30">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`font-mono text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[l.status] || "bg-paper/10"}`}>
                      {l.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs text-paper/60">
                    {l.first_sent_at ? fmtET(l.first_sent_at) : "—"}
                  </td>
                  <td className="p-3 font-mono text-xs text-paper/60">
                    {l.followup_due_at ? fmtET(l.followup_due_at) : "—"}
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
  const [liGen, setLiGen] = useState(false);
  const [liCopied, setLiCopied] = useState(false);
  const [followup, setFollowup] = useState<any>(null);
  const [openMsgs, setOpenMsgs] = useState<Set<number>>(new Set());
  const [copiedMsg, setCopiedMsg] = useState<number | null>(null);
  const toggleMsg = (mid: number) =>
    setOpenMsgs((s) => {
      const n = new Set(s);
      n.has(mid) ? n.delete(mid) : n.add(mid);
      return n;
    });
  const copyMsg = (e: Email) => {
    navigator.clipboard.writeText(`${e.subject || ""}\n\n${e.body || ""}`.trim());
    setCopiedMsg(e.id);
    setTimeout(() => setCopiedMsg(null), 1500);
  };

  async function genLinkedIn() {
    if (!lead) return;
    setLiGen(true);
    try {
      const r = await api(`/api/leads/${id}/linkedin-message`, { method: "POST" });
      setLead((l) => (l ? { ...l, linkedin_message: r.message } : l));
    } catch (e) {
      console.error(e);
    }
    setLiGen(false);
  }
  function copyLinkedIn() {
    if (lead?.linkedin_message) {
      navigator.clipboard.writeText(lead.linkedin_message);
      setLiCopied(true);
      setTimeout(() => setLiCopied(false), 1500);
    }
  }

  useEffect(() => {
    api(`/api/leads/${id}`)
      .then((d) => {
        setLead(d.lead);
        setEmails(d.emails);
        setDraft({});
      })
      .catch(console.error);
    api(`/api/leads/${id}/followup-preview`).then(setFollowup).catch(() => setFollowup(null));
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
              {ro("First emailed", lead.first_sent_at ? fmtET(lead.first_sent_at) : "—")}
              {ro("Follow-up due", lead.followup_due_at ? fmtET(lead.followup_due_at) : "none")}
              {ro("Last touch", lead.last_touch_at ? fmtET(lead.last_touch_at) : "—")}
              {ro("Email verify", lead.email_status)}
              {ro("Email", lead.email)}
              {ro("Source", lead.source)}
            </div>

            {/* sent-email copies — every message we sent this lead, full text */}
            <div className="mt-6 border-t border-edge pt-5">
              <div className="font-mono text-[11px] uppercase tracking-widest text-paper/50 mb-3">
                Emails sent · {emails.length} message{emails.length === 1 ? "" : "s"}
              </div>
              {emails.length === 0 ? (
                <p className="text-paper/40 text-sm">No emails sent to this lead yet.</p>
              ) : (
                <div className="space-y-2">
                  {emails.map((e) => {
                    const m = msgMeta(e);
                    const open = openMsgs.has(e.id);
                    return (
                      <div key={e.id} className="bg-ink border border-edge rounded-lg overflow-hidden">
                        <button
                          onClick={() => toggleMsg(e.id)}
                          className="w-full text-left p-3 hover:bg-paper/5 transition-colors"
                        >
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className={m.cls}>{m.text}</span>
                            <span className="text-paper/40">{fmtET(e.sent_at)}</span>
                          </div>
                          <div className="text-sm mt-1 font-medium text-paper/90">{e.subject || "(no subject)"}</div>
                          {!open && (
                            <div className="text-paper/50 text-xs mt-1 whitespace-pre-wrap line-clamp-2">{e.body}</div>
                          )}
                          <div className="font-mono text-[10px] text-paper/30 mt-1.5">
                            via {e.inbox} · {open ? "click to collapse ▲" : "click to read full email ▼"}
                          </div>
                        </button>
                        {open && (
                          <div className="px-3 pb-3">
                            <div className="bg-panel border border-edge rounded p-3 text-sm text-paper/90 whitespace-pre-wrap leading-relaxed">
                              {e.body}
                            </div>
                            <button
                              onClick={() => copyMsg(e)}
                              className="mt-2 font-mono text-[10px] px-2.5 py-1 rounded bg-paper/10 text-paper/70 hover:bg-paper/20"
                            >
                              {copiedMsg === e.id ? "copied ✓" : "copy email"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* LinkedIn outreach — message ready to copy + send manually */}
            {lead.linkedin_url && (
              <div className="mt-6 border-t border-edge pt-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-mono text-[11px] uppercase tracking-widest text-paper/50">LinkedIn outreach</div>
                  <a href={lead.linkedin_url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-sky-300 hover:underline">
                    open profile ↗
                  </a>
                </div>
                {lead.linkedin_message ? (
                  <>
                    <div className="bg-ink border border-edge rounded p-3 text-sm text-paper/90 whitespace-pre-wrap">{lead.linkedin_message}</div>
                    <div className="flex gap-2 mt-2">
                      <button onClick={copyLinkedIn} className="font-mono text-[11px] px-3 py-1.5 rounded bg-sky-500/20 text-sky-200 hover:bg-sky-500/30">
                        {liCopied ? "copied ✓" : "copy message"}
                      </button>
                      <button onClick={genLinkedIn} disabled={liGen} className="font-mono text-[11px] px-3 py-1.5 rounded bg-paper/10 text-paper/70 hover:bg-paper/20">
                        {liGen ? "writing…" : "regenerate"}
                      </button>
                    </div>
                    <div className="font-mono text-[10px] text-paper/30 mt-2">send it yourself from their profile — LinkedIn bans automation</div>
                  </>
                ) : (
                  <button onClick={genLinkedIn} disabled={liGen} className="font-mono text-[11px] px-3 py-1.5 rounded bg-sky-500/20 text-sky-200 hover:bg-sky-500/30">
                    {liGen ? "writing…" : "+ generate LinkedIn message"}
                  </button>
                )}
              </div>
            )}

            {/* follow-up email — what's queued to send next */}
            {followup?.available && (
              <div className="mt-6 border-t border-edge pt-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-mono text-[11px] uppercase tracking-widest text-paper/50">Follow-up email</div>
                  <span className={`font-mono text-[10px] px-2 py-0.5 rounded ${followup.scheduled ? "bg-amber-400/15 text-amber-300" : "bg-paper/10 text-paper/40"}`}>
                    {followup.scheduled ? `scheduled · ${fmtET(followup.due_at)}` : "sends after the first email"}
                  </span>
                </div>
                <div className="bg-ink border border-edge rounded p-3">
                  <div className="text-sm font-semibold text-paper/90">{followup.subject}</div>
                  <div className="text-sm text-paper/70 mt-2 whitespace-pre-wrap">{followup.body}</div>
                </div>
                <div className="font-mono text-[10px] text-paper/30 mt-2">
                  goes out from {followup.inbox || "the same inbox"} · the reply Concierge cancels it automatically if they reply first
                </div>
              </div>
            )}

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

          </>
        )}
      </div>
    </div>
  );
}
