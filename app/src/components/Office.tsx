import { useEffect, useState } from "react";
import { api, openFeed } from "../api";
import { deriveStates, nextUp, lastEventsFor, type Event, type AgentState } from "../office";
import OfficeRoom from "./OfficeRoom";

function AgentDossier({ state, events }: { state: AgentState; events: Event[] }) {
  const recent = lastEventsFor(events, state.def.key, 3);
  return (
    <div className="bg-panel border border-edge rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-5">
      <div>
        <p className="font-display text-2xl">
          {state.def.name} <span className="italic text-signal text-base">{state.def.role}</span>
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mt-1">
          {state.statusLabel}
        </p>
        <p className="text-paper/70 text-sm mt-3 leading-relaxed">{state.def.about}</p>
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
          What it did
        </p>
        {recent.length === 0 ? (
          <p className="text-paper/40 text-sm mt-3 italic">
            Nothing yet — hasn't had its first shift.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {recent.map((e) => (
              <li key={e.id} className="text-sm text-paper/80 leading-snug">
                <span className="font-mono text-[10px] text-paper/40 block">{e.ts}</span>
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
          Next step
        </p>
        <p className="text-sm mt-3 leading-relaxed">
          <span className="text-signal mr-1">▸</span>
          {state.def.nextStep}
        </p>
      </div>
    </div>
  );
}

// Code-drawn avatar per agent — simple geometric "office worker" marks, no emoji.
function Avatar({ agentKey, active }: { agentKey: string; active: boolean }) {
  const stroke = active ? "#E63B2E" : "#6b6b66";
  const common = { fill: "none", stroke, strokeWidth: 2, strokeLinecap: "round" as const };
  return (
    <svg viewBox="0 0 48 48" className="w-12 h-12">
      {/* head + shoulders, shared base */}
      <circle cx="24" cy="16" r="7" {...common} />
      <path d="M10 40c2-9 8-12 14-12s12 3 14 12" {...common} />
      {agentKey === "research" && <path d="M31 9l6-6M33 3h4v4" {...common} />}
      {agentKey === "scrape" && <path d="M6 22h8M6 26h6M6 30h8" {...common} />}
      {agentKey === "verify" && <path d="M34 22l3 3 6-7" {...common} />}
      {agentKey === "send" && <path d="M34 24l9-4-3 9-3-2-3-3z" {...common} />}
      {agentKey === "reply" && <path d="M35 20h8v6h-5l-3 3z" {...common} />}
      {agentKey === "worker" && <rect x="33" y="20" width="11" height="8" rx="1.5" {...common} />}
      {agentKey === "system" && <circle cx="39" cy="24" r="4" {...common} />}
    </svg>
  );
}

function StatusDot({ status }: { status: AgentState["status"] }) {
  const color =
    status === "working"
      ? "bg-emerald-400"
      : status === "online"
      ? "bg-sky-400"
      : status === "error"
      ? "bg-signal"
      : "bg-paper/30";
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {(status === "working" || status === "error") && (
        <span className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-60 animate-ping`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
    </span>
  );
}

function AgentCard({ state, isNext }: { state: AgentState; isNext: boolean }) {
  const active = state.status === "working";
  return (
    <div
      className={`relative bg-panel border rounded-xl p-4 transition-all duration-500 ${
        active
          ? "border-signal shadow-[0_0_30px_-8px_rgba(230,59,46,0.5)]"
          : isNext
          ? "border-paper/30"
          : "border-edge"
      }`}
    >
      {isNext && !active && (
        <span className="absolute -top-2.5 right-3 bg-ink border border-paper/30 text-paper/80 font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 rounded">
          Up next
        </span>
      )}
      <div className="flex items-start gap-3">
        <div className={`rounded-lg p-1 ${active ? "bg-signal/10" : "bg-ink"}`}>
          <Avatar agentKey={state.def.key} active={active} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-display text-xl leading-none">{state.def.name}</p>
            <StatusDot status={state.status} />
          </div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mt-1">
            {state.def.role} · {state.statusLabel}
          </p>
        </div>
      </div>
      <p className="text-paper/60 text-xs mt-3 leading-relaxed">{state.def.desk}</p>
      <div className="mt-3 border-t border-edge/60 pt-2 min-h-[34px]">
        {state.lastMessage ? (
          <p className={`text-xs leading-snug ${active ? "text-paper" : "text-paper/50"}`}>
            {active && <span className="text-signal mr-1">▸</span>}
            {state.lastMessage}
          </p>
        ) : (
          <p className="text-paper/30 text-xs italic">Hasn't worked yet.</p>
        )}
      </div>
    </div>
  );
}

export default function Office() {
  const [events, setEvents] = useState<Event[]>([]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    api("/api/activity?limit=300").then(setEvents).catch(console.error);
    const feed = openFeed((e) => setEvents((prev) => [...prev.slice(-500), e]));
    // statuses age out over time even without new events
    const t = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => {
      feed.close();
      clearInterval(t);
    };
  }, []);

  const states = deriveStates(events);
  const next = nextUp(states);
  const working = states.filter((s) => s.status === "working");
  // dossier shows: hovered agent, else whoever is working, else who's up next
  const focus =
    states.find((s) => s.def.key === hoveredKey) || working[0] || next || states[0];

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="font-display text-2xl">
          The <span className="italic text-signal">office</span>
        </h3>
        <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
          {working.length > 0
            ? `${working.map((w) => w.def.name).join(" + ")} working`
            : "Everyone at their desk — quiet for now"}
          {next && ` · next up: ${next.def.name}`}
        </p>
      </div>
      <div className="mt-4">
        <OfficeRoom
          states={states}
          nextKey={next?.def.key ?? null}
          hoveredKey={hoveredKey}
          onHover={setHoveredKey}
        />
      </div>
      <div className="mt-4">
        <AgentDossier state={focus} events={events} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 mt-4">
        {states
          .sort((a, b) => a.def.order - b.def.order)
          .map((s) => (
            <AgentCard key={s.def.key} state={s} isNext={next?.def.key === s.def.key} />
          ))}
      </div>
    </section>
  );
}
