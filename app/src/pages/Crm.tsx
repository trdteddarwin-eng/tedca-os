import { useEffect, useState } from "react";
import { api } from "../api";

type Lead = {
  id: number;
  business_name: string;
  category: string | null;
  email: string | null;
  email_status: string | null;
  status: string;
  last_touch_at: string | null;
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
  useEffect(() => {
    api("/api/leads").then(setLeads).catch(console.error);
  }, []);

  return (
    <div>
      <h2 className="font-display text-4xl">Clients / CRM</h2>
      <p className="text-paper/50 text-sm mt-2">
        Auto-populated by the cold-email engine. {leads.length} lead{leads.length === 1 ? "" : "s"}.
      </p>
      <div className="mt-6 bg-panel border border-edge rounded-lg overflow-x-auto">
        {leads.length === 0 ? (
          <p className="text-paper/50 text-sm p-5">
            No leads yet — they appear here after the first scrape run.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50 text-left">
                <th className="p-3">Business</th>
                <th className="p-3">Category</th>
                <th className="p-3">Email</th>
                <th className="p-3">Verify</th>
                <th className="p-3">Status</th>
                <th className="p-3">Last touch</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-edge/50">
                  <td className="p-3">{l.business_name}</td>
                  <td className="p-3 text-paper/60">{l.category || "—"}</td>
                  <td className="p-3 font-mono text-xs">{l.email || "—"}</td>
                  <td className="p-3 font-mono text-xs">{l.email_status || "—"}</td>
                  <td className="p-3">
                    <span
                      className={`font-mono text-[11px] px-2 py-0.5 rounded ${
                        STATUS_STYLE[l.status] || "bg-paper/10"
                      }`}
                    >
                      {l.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs text-paper/60">{l.last_touch_at || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
