import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtET } from "../format";

// Shown once right after login: a quick "here's what happened since you were gone".
export default function Digest() {
  const [d, setD] = useState<any>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    api("/api/digest")
      .then((data) => {
        setD(data);
        setShow(true);
      })
      .catch(() => {});
  }, []);

  if (!show || !d) return null;
  const stat = (n: number, label: string, tone = "text-paper") => (
    <div>
      <div className={`font-display text-2xl ${tone}`}>{n}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/45">{label}</div>
    </div>
  );

  return (
    <div className="mb-6 rounded-xl border border-signal/30 bg-signal/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-signal">Welcome back</div>
          <div className="text-sm text-paper/60 mt-0.5">
            Here's what happened since {d.since ? fmtET(d.since) : "your last visit"}.
          </div>
        </div>
        <button onClick={() => setShow(false)} className="font-mono text-xs text-paper/40 hover:text-paper">
          ✕ dismiss
        </button>
      </div>
      <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-4">
        {stat(d.sentSince ?? 0, "sent since")}
        {stat(d.sentToday ?? 0, "sent today")}
        {stat(d.repliesSince ?? 0, "new replies", (d.repliesSince ?? 0) > 0 ? "text-signal" : "text-paper")}
        {stat(d.interested ?? 0, "interested", (d.interested ?? 0) > 0 ? "text-emerald-300" : "text-paper")}
        {stat(d.bouncesSince ?? 0, "bounces", (d.bouncesSince ?? 0) > 0 ? "text-amber-300" : "text-paper")}
        {stat(d.bankedReady ?? 0, "leads ready")}
      </div>
      {d.lastRun && (
        <div className="mt-3 font-mono text-[11px] text-paper/40">
          last run: {d.lastRun.summary || "—"} · {d.lastRun.status} {d.lastRun.finished_at ? `· ${fmtET(d.lastRun.finished_at)}` : ""}
        </div>
      )}
    </div>
  );
}
