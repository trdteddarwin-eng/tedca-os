import { useEffect, useState } from "react";
import { api } from "../api";

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

const KIND_STYLE: Record<string, string> = {
  initial: "bg-sky-400/15 text-sky-300",
  followup: "bg-amber-400/15 text-amber-300",
  reply: "bg-emerald-400/15 text-emerald-400",
  test: "bg-paper/10 text-paper/60",
};

export default function Emails() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    api("/api/emails").then(setEmails).catch(console.error);
    const t = setInterval(() => api("/api/emails").then(setEmails).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, []);

  const shown = emails.filter((e) => {
    if (filter === "all") return true;
    if (filter === "in") return e.direction === "in";
    if (filter === "out") return e.direction === "out";
    return e.kind === filter;
  });

  return (
    <div>
      <h2 className="font-display text-4xl">
        Emails <span className="italic text-signal">{emails.length}</span>
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        Every email the machine has sent or received — click one to read the full copy.
      </p>
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
              <span className="font-mono text-xs text-paper/40 ml-auto">{e.sent_at}</span>
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
