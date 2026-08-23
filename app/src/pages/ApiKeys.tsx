import { useEffect, useState } from "react";
import { api } from "../api";

type Credits = {
  kind: "usd" | "credits" | "characters" | "none" | "unknown";
  unit?: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  detail?: string;
};
type KeyRow = {
  service: string;
  label: string;
  env: string;
  has_credit_api: boolean;
  masked_primary: string | null;
  masked_fallback: string | null;
  active: "primary" | "fallback";
  rotated_at: string | null;
  credits: Credits;
};

function fmt(n: number, unit?: string): string {
  if (unit === "$") return `$${n.toFixed(2)}`;
  const s = n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
  return unit && unit !== "$" ? `${s}` : s;
}

function rotatedAgo(iso: string | null): string {
  if (!iso) return "seeded from env — never rotated";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "rotated today";
  if (days === 1) return "rotated 1 day ago";
  return `rotated ${days} days ago`;
}

function CreditBlock({ c }: { c: Credits }) {
  if (c.kind === "none") {
    return <p className="font-mono text-sm text-paper/40 mt-1">no credit API — key shown for reference only</p>;
  }
  if (c.kind === "unknown" || (c.remaining == null && c.used == null)) {
    return (
      <p className="font-mono text-sm text-amber-300/80 mt-1">
        credits: unknown{c.detail ? <span className="text-paper/40"> — {c.detail}</span> : null}
      </p>
    );
  }
  // remaining known?
  if (c.remaining != null) {
    const pct = c.limit ? Math.max(0, Math.min(100, (c.remaining / c.limit) * 100)) : null;
    const low = pct != null ? pct < 15 : false;
    return (
      <div className="mt-1">
        <p className={`font-display text-3xl ${low ? "text-red-400" : "text-paper"}`}>
          {fmt(c.remaining, c.unit)}
          <span className="text-sm text-paper/50 font-mono ml-2">
            {c.unit && c.unit !== "$" ? `${c.unit} ` : ""}left{c.limit != null ? ` of ${fmt(c.limit, c.unit)}` : ""}
          </span>
        </p>
        {pct != null && (
          <div className="mt-2 h-1.5 bg-ink rounded overflow-hidden border border-edge/60">
            <div className={`h-full ${low ? "bg-red-400" : "bg-signal"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {c.detail && <p className="font-mono text-[11px] text-paper/40 mt-1.5">{c.detail}</p>}
      </div>
    );
  }
  // usage known but no limit (e.g. OpenRouter key with no cap)
  return (
    <div className="mt-1">
      <p className="font-display text-3xl text-paper">
        {fmt(c.used as number, c.unit)}
        <span className="text-sm text-paper/50 font-mono ml-2">used</span>
      </p>
      {c.detail && <p className="font-mono text-[11px] text-paper/40 mt-1.5">{c.detail}</p>}
    </div>
  );
}

function KeyCard({ row, onSaved }: { row: KeyRow; onSaved: () => Promise<void> }) {
  const [primary, setPrimary] = useState("");
  const [fallback, setFallback] = useState("");
  const [busy, setBusy] = useState<"" | "primary" | "fallback">("");
  const [notice, setNotice] = useState("");

  const save = async (which: "primary" | "fallback") => {
    const value = which === "primary" ? primary.trim() : fallback.trim();
    if (!value) return;
    setBusy(which);
    setNotice("");
    try {
      await api("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ service: row.service, [which]: value }),
      });
      setNotice(which === "primary" ? "Primary replaced — live immediately." : "Fallback saved — fires automatically if the primary is rejected.");
      if (which === "primary") setPrimary("");
      else setFallback("");
      await onSaved();
    } catch (e: any) {
      setNotice(`Save failed: ${e?.message || e}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="bg-panel border border-edge rounded-lg p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl">{row.label}</h3>
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mt-0.5">{row.env}</p>
        </div>
        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-paper/10 text-paper/50 whitespace-nowrap">
          {rotatedAgo(row.rotated_at)}
        </span>
      </div>

      <CreditBlock c={row.credits} />

      {/* current keys, masked */}
      <div className="mt-4 space-y-1.5 font-mono text-[12px]">
        <div className="flex items-center gap-2">
          <span className="text-paper/40 w-16 shrink-0">primary</span>
          <span className="text-paper/80">{row.masked_primary || <span className="text-paper/30">not set</span>}</span>
          {row.active === "primary" && row.masked_primary && (
            <span className="bg-emerald-400/15 text-emerald-400 px-2 py-0.5 rounded text-[10px]">active</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-paper/40 w-16 shrink-0">fallback</span>
          <span className="text-paper/80">{row.masked_fallback || <span className="text-paper/30">not set</span>}</span>
          {row.active === "fallback" && row.masked_fallback && (
            <span className="bg-amber-400/15 text-amber-300 px-2 py-0.5 rounded text-[10px]">active — primary failed</span>
          )}
        </div>
      </div>

      {/* rotate / set fallback */}
      <div className="mt-4 grid grid-cols-1 gap-2">
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            placeholder="new primary key"
            className="flex-1 min-w-0 bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono"
          />
          <button
            onClick={() => save("primary")}
            disabled={busy !== "" || !primary.trim()}
            className="bg-signal/90 hover:bg-signal text-ink font-semibold text-xs rounded px-3 py-2 disabled:opacity-40 whitespace-nowrap"
          >
            {busy === "primary" ? "Saving…" : "Replace primary"}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="fallback key (auto-used on 401/402/403)"
            className="flex-1 min-w-0 bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono"
          />
          <button
            onClick={() => save("fallback")}
            disabled={busy !== "" || !fallback.trim()}
            className="border border-edge hover:bg-ink text-paper/80 font-semibold text-xs rounded px-3 py-2 disabled:opacity-40 whitespace-nowrap"
          >
            {busy === "fallback" ? "Saving…" : "Set fallback"}
          </button>
        </div>
      </div>
      {notice && <p className="mt-2 text-xs text-paper/60">{notice}</p>}
    </div>
  );
}

export default function ApiKeys() {
  const [rows, setRows] = useState<KeyRow[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api("/api/api-keys");
      setRows(d);
      setErr("");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <h2 className="font-display text-4xl">
        API Keys <span className="text-paper/40 text-2xl italic">credits · rotation · fallbacks</span>
      </h2>
      <p className="text-paper/50 text-sm mt-2 max-w-2xl">
        Every paid key the OS runs on: live credit remaining, rotate a key in place, and set a
        fallback that <span className="text-paper/80">fires automatically when the primary is rejected
        (401/402/403)</span>. Keys are stored server-side and always shown masked.
      </p>

      {err && <p className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/30 rounded p-3">{err}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={load}
          disabled={loading}
          className="font-mono text-[11px] uppercase tracking-wider border border-edge rounded px-3 py-1.5 text-paper/60 hover:text-paper hover:bg-panel disabled:opacity-40"
        >
          {loading ? "Checking credits…" : "Refresh credits"}
        </button>
        {rows === null && !err && <span className="text-xs text-paper/40">Loading keys + live credit balances…</span>}
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(rows || []).map((r) => (
          <KeyCard key={r.service} row={r} onSaved={load} />
        ))}
      </div>
    </div>
  );
}
