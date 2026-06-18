import { useEffect, useState } from "react";
import { api } from "../api";

type Run = {
  id: number;
  agent: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  cost_usd: number;
  summary: string | null;
};

export default function Automations() {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    api("/api/runs").then(setRuns).catch(console.error);
  }, []);

  return (
    <div>
      <h2 className="font-display text-4xl">Automations</h2>
      <p className="text-paper/50 text-sm mt-2">
        Run history. Agents (scrape · verify · send · replies) come online in the next milestones.
      </p>
      <div className="mt-6 bg-panel border border-edge rounded-lg overflow-x-auto">
        {runs.length === 0 ? (
          <p className="text-paper/50 text-sm p-5">No runs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50 text-left">
                <th className="p-3">#</th>
                <th className="p-3">Agent</th>
                <th className="p-3">Started</th>
                <th className="p-3">Finished</th>
                <th className="p-3">Status</th>
                <th className="p-3">Cost</th>
                <th className="p-3">Summary</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-edge/50 font-mono text-xs">
                  <td className="p-3">{r.id}</td>
                  <td className="p-3">{r.agent}</td>
                  <td className="p-3">{r.started_at}</td>
                  <td className="p-3">{r.finished_at || "—"}</td>
                  <td className="p-3">{r.status}</td>
                  <td className="p-3">${r.cost_usd.toFixed(2)}</td>
                  <td className="p-3 text-paper/60">{r.summary || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
