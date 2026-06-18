import { useEffect, useRef, useState } from "react";
import { api, openFeed } from "../api";

type Event = {
  id: number;
  run_id: number | null;
  ts: string;
  actor: string;
  message: string;
  level: string;
  raw: string | null;
};

const LEVEL_COLOR: Record<string, string> = {
  info: "text-paper/80",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-signal",
};

export default function Activity() {
  const [events, setEvents] = useState<Event[]>([]);
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api("/api/activity").then(setEvents).catch(console.error);
    const feed = openFeed(
      (e) => setEvents((prev) => [...prev.slice(-500), e]),
      setLive
    );
    return () => feed.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div>
      <div className="flex items-center gap-3">
        <h2 className="font-display text-4xl">Live Activity</h2>
        <span
          className={`font-mono text-[11px] uppercase tracking-widest px-2 py-1 rounded ${
            live ? "bg-emerald-400/15 text-emerald-400" : "bg-signal/15 text-signal"
          }`}
        >
          {live ? "● live" : "○ disconnected"}
        </span>
      </div>
      <div className="mt-6 bg-panel border border-edge rounded-lg p-4 max-h-[70vh] overflow-y-auto">
        {events.length === 0 && <p className="text-paper/50 text-sm">No activity yet.</p>}
        {events.map((e) => (
          <div
            key={e.id}
            className="py-1.5 border-b border-edge/50 last:border-0 cursor-pointer"
            onClick={() => setExpanded(expanded === e.id ? null : e.id)}
          >
            <p className={`font-mono text-xs ${LEVEL_COLOR[e.level] || "text-paper/80"}`}>
              <span className="text-paper/40">{e.ts}</span>{" "}
              <span className="text-signal/80">[{e.actor}]</span> {e.message}
            </p>
            {expanded === e.id && e.raw && (
              <pre className="mt-1 text-[11px] text-paper/60 bg-ink rounded p-2 overflow-x-auto">
                {e.raw}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
