import { useEffect, useState } from "react";
import { api } from "../api";
import Office from "../components/Office";

type Stats = {
  leads: number;
  emails_sent: number;
  replies: number;
  cost_month: number;
  running: { id: number; agent: string; status: string; started_at: string }[];
};

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-panel border border-edge rounded-lg p-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">{label}</p>
      <p className="font-display text-4xl mt-2">{value}</p>
    </div>
  );
}

const NICHES = [
  "med spas",
  "dentists",
  "roofing companies",
  "solar installers",
  "real estate agencies",
  "chiropractors",
  "law firms",
  "hvac companies",
];

function RunPanel() {
  const [status, setStatus] = useState<any>(null);
  const [target, setTarget] = useState(10);
  const [niche, setNiche] = useState("");
  const [locations, setLocations] = useState("");
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  function refresh() {
    api("/api/run/status").then(setStatus).catch(console.error);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // niche + each location compose into "niche in location" searches — one Apify run
  const chosenNiche = niche || status?.niche || "";
  const locationList = locations
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const query =
    locationList.length > 0
      ? locationList.map((loc) => `${chosenNiche} in ${loc}`).join(" | ")
      : null;

  async function start() {
    setError("");
    try {
      await api("/api/run/morning", {
        method: "POST",
        body: JSON.stringify({ target, query }),
      });
      setStarted(true);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const running = Boolean(status?.running_run_id);
  return (
    <div className="mt-8 bg-panel border border-signal/40 rounded-lg p-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50 mb-3">
        Morning run · pick who to go after
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="font-mono text-xs text-paper/60">
          <span className="block mb-1">1 · niche</span>
          <select
            value={chosenNiche}
            onChange={(e) => setNiche(e.target.value)}
            className="bg-ink border border-edge rounded px-3 py-2.5 text-paper text-sm min-w-[180px]"
          >
            {!NICHES.includes(chosenNiche) && chosenNiche && (
              <option value={chosenNiche}>{chosenNiche}</option>
            )}
            {NICHES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="font-mono text-xs text-paper/60 flex-1 min-w-[260px]">
          <span className="block mb-1">2 · locations (comma-separated = one scrape, many cities)</span>
          <input
            value={locations}
            onChange={(e) => setLocations(e.target.value)}
            placeholder="Union NJ, Elizabeth NJ, Westfield NJ"
            className="w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper"
          />
        </label>
        <label className="font-mono text-xs text-paper/60">
          <span className="block mb-1">3 · leads</span>
          <input
            type="number"
            min={1}
            max={500}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="w-20 bg-ink border border-edge rounded px-2 py-2.5 text-paper"
          />
        </label>
        <button
          onClick={start}
          disabled={running || (!query && locationList.length === 0 && !status)}
          className="bg-signal text-paper rounded px-5 py-3 font-mono text-sm uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
        >
          {running ? "Run in progress…" : "Run"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <p className="text-paper/50 text-xs font-mono">
          will search: {query || `${chosenNiche} in ${status?.city ?? "…"} (default)`}
        </p>
        {status?.test_mode && (
          <span className="font-mono text-[11px] uppercase tracking-widest bg-amber-400/15 text-amber-300 px-2 py-1 rounded">
            test mode — emails go to you
          </span>
        )}
      </div>
      {started && running && (
        <p className="text-paper/60 text-xs mt-3">
          Running — watch the office above and Live Activity for every step.
        </p>
      )}
      {error && <p className="text-signal font-mono text-xs mt-3">{error}</p>}
    </div>
  );
}

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api("/api/stats").then(setStats).catch(console.error);
  }, []);

  async function sendTestEvent() {
    await api("/api/activity/test", { method: "POST" });
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  }

  return (
    <div>
      <h2 className="font-display text-4xl">
        Morning, <span className="italic text-signal">Ted</span>.
      </h2>
      <div className="mt-8">
        <Office />
      </div>

      <RunPanel />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <Kpi label="Leads" value={stats?.leads ?? "—"} />
        <Kpi label="Emails sent" value={stats?.emails_sent ?? "—"} />
        <Kpi label="Replies" value={stats?.replies ?? "—"} />
        <Kpi label="Cost this month" value={stats ? `$${stats.cost_month.toFixed(2)}` : "—"} />
      </div>

      <div className="mt-8 bg-panel border border-edge rounded-lg p-5">
        <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
          Running now
        </p>
        {stats && stats.running.length === 0 && (
          <p className="text-paper/60 mt-2 text-sm">Nothing running.</p>
        )}
        {stats?.running.map((r) => (
          <p key={r.id} className="font-mono text-sm mt-2">
            <span className="text-signal">●</span> {r.agent} — {r.status} since {r.started_at}
          </p>
        ))}
      </div>

      <button
        onClick={sendTestEvent}
        className="mt-6 bg-signal text-paper rounded px-4 py-2 font-mono text-xs uppercase tracking-widest hover:opacity-90"
      >
        {sent ? "Sent ✓" : "Emit test event → Live Activity"}
      </button>
      <p className="text-paper/40 text-xs mt-2">
        Proves the WebSocket feed end-to-end. The “Run morning cold email” button arrives with the
        engine milestones.
      </p>
    </div>
  );
}
