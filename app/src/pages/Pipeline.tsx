import { useEffect, useState } from "react";
import { api } from "../api";

const STAGES = ["scraped", "emailed", "followup_sent", "replied"] as const;
const LABELS: Record<string, string> = {
  scraped: "Scraped",
  emailed: "Emailed",
  followup_sent: "Follow-up",
  replied: "Replied",
};

export default function Pipeline() {
  const [leads, setLeads] = useState<any[]>([]);
  useEffect(() => {
    api("/api/leads").then(setLeads).catch(console.error);
  }, []);

  return (
    <div>
      <h2 className="font-display text-4xl">Pipeline</h2>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
        {STAGES.map((stage) => {
          const items = leads.filter((l) => l.status === stage);
          return (
            <div key={stage} className="bg-panel border border-edge rounded-lg p-4">
              <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
                {LABELS[stage]} · {items.length}
              </p>
              <div className="mt-3 space-y-2">
                {items.length === 0 && <p className="text-paper/40 text-xs">Empty</p>}
                {items.slice(0, 30).map((l) => (
                  <div key={l.id} className="bg-ink rounded p-2 text-sm">
                    {l.business_name}
                    {l.email && (
                      <p className="font-mono text-[11px] text-paper/50">{l.email}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
