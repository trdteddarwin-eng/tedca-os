import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { api, getToken } from "../api";

type Version = {
  n: number;
  jobId: number;
  status: "rendering" | "done" | "failed";
  path?: string;
  notes?: string;
};

function fileUrl(p: string) {
  return `/api/skills/file?path=${encodeURIComponent(p)}&token=${getToken()}`;
}

const btnCls =
  "bg-signal text-paper rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90";

export default function ClipEditor() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state || {}) as {
    sourcePath?: string;
    styleId?: string;
    styleName?: string;
    existing?: boolean; // entered from a finished video (Jobs → Edit)
  };
  const sourcePath = state.sourcePath || "";
  const styleId = state.styleId || "signature";
  const styleName = state.styleName || styleId;

  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedN, setSelectedN] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [learn, setLearn] = useState(true);
  const [savedNote, setSavedNote] = useState("");
  const [error, setError] = useState("");

  const mountedRef = useRef(false);

  const selected = versions.find((v) => v.n === selectedN) || null;

  // ── update a single version in place ────────────────────────────
  function patchVersion(n: number, patch: Partial<Version>) {
    setVersions((prev) => prev.map((v) => (v.n === n ? { ...v, ...patch } : v)));
  }

  // ── poll a job → resolve a version to done / failed ─────────────
  async function pollVersion(n: number, jobId: number) {
    for (let i = 0; i < 600; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      try {
        const j = await api(`/api/skills/job/${jobId}`);
        if (j.status === "done") {
          let path = "";
          try {
            const result = JSON.parse(j.result || "{}");
            path = result.path || "";
          } catch {
            /* ignore parse error, keep empty path */
          }
          patchVersion(n, { status: "done", path });
          setSelectedN(n);
          return;
        }
        if (j.status === "failed") {
          patchVersion(n, { status: "failed", notes: j.result || "render failed" });
          return;
        }
      } catch (e: any) {
        // transient fetch error — keep polling, surface it softly
        setError(`poll error (v${n}): ${e.message}`);
      }
    }
    patchVersion(n, { status: "failed", notes: "timed out waiting for the render" });
  }

  // ── ON MOUNT: kick off v1 from the source clip ──────────────────
  useEffect(() => {
    if (!sourcePath) return;
    if (mountedRef.current) return;
    mountedRef.current = true;

    // entered from a finished video (Jobs → Edit): show it as v1, don't re-render
    if (state.existing) {
      setVersions([{ n: 1, jobId: 0, status: "done", path: sourcePath }]);
      setSelectedN(1);
      return;
    }

    (async () => {
      try {
        const r = await api("/api/skills/video-edit", {
          method: "POST",
          body: JSON.stringify({ video_path: sourcePath, style: styleId }),
        });
        const v: Version = { n: 1, jobId: r.job_id, status: "rendering" };
        setVersions([v]);
        setSelectedN(1);
        pollVersion(1, r.job_id);
      } catch (e: any) {
        setError(`Error starting first render: ${e.message}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── submit a correction → new revised version ───────────────────
  async function applyChanges() {
    const trimmed = notes.trim();
    if (!trimmed) return;
    setError("");
    const nextN = (versions.reduce((m, v) => Math.max(m, v.n), 0) || 0) + 1;
    try {
      const r = await api("/api/skills/video-edit/revise", {
        method: "POST",
        body: JSON.stringify({
          source_path: sourcePath,
          style: styleId,
          notes: trimmed,
          prev_path: selected?.path || "",
          learn,
        }),
      });
      const v: Version = { n: nextN, jobId: r.job_id, status: "rendering", notes: trimmed };
      setVersions((prev) => [...prev, v]);
      setNotes("");
      setSavedNote(
        learn
          ? "✓ saved to the editor's memory — it won't repeat this."
          : "applied to this version only — not added to memory."
      );
      pollVersion(nextN, r.job_id);
    } catch (e: any) {
      setError(`Error: ${e.message}`);
    }
  }

  // ── EMPTY STATE ─────────────────────────────────────────────────
  if (!sourcePath) {
    return (
      <div className="bg-ink min-h-[60vh] flex flex-col items-center justify-center text-center px-6">
        <p className="text-paper/70 text-sm max-w-md leading-relaxed">
          No clip loaded — go to One-Click Run → Avatar Video, upload a take and hit{" "}
          <span className="text-paper">Upload &amp; edit my video.</span>
        </p>
        <Link to="/skills" className={`${btnCls} mt-5 inline-block`}>
          Go to One-Click Run
        </Link>
      </div>
    );
  }

  // ── MAIN UI ─────────────────────────────────────────────────────
  const chip = (s: Version["status"]) =>
    s === "done"
      ? "text-emerald-400 border-emerald-400/40"
      : s === "failed"
      ? "text-signal border-signal/40"
      : "text-amber-400 border-amber-400/40";

  return (
    <div className="bg-ink min-h-screen -m-6 p-6">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-3xl">
            tedca os <span className="text-paper/40">· clip editor</span>
          </h2>
          <button
            onClick={() => navigate("/skills")}
            className="font-mono text-[10px] uppercase tracking-widest text-paper/40 hover:text-paper/70"
          >
            ← back
          </button>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-signal border border-signal/40 bg-signal/10 rounded px-2.5 py-1.5">
          ● Live Edit
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 items-start">
        {/* ── LEFT COLUMN ───────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="bg-panel border border-edge rounded-xl p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              Tell it what to change
            </p>
            <p className="text-paper/50 text-xs mt-1 mb-3 leading-relaxed">
              Style: <span className="text-paper/80">{styleName}</span>. Each note also teaches the
              editor — it learns your taste over time.
            </p>
            <textarea
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  applyChanges();
                }
              }}
              placeholder={
                'e.g. "cut the intro to 2s", "the riser is too loud", "make the captions bigger" — then press Enter'
              }
              className="w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30 leading-relaxed resize-none"
            />
            <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={learn}
                onChange={(e) => setLearn(e.target.checked)}
                className="accent-signal w-3.5 h-3.5"
              />
              <span className="font-mono text-[10px] uppercase tracking-widest text-paper/60">
                Remember this — teach the editor
              </span>
            </label>
            <p className="text-paper/35 text-[11px] mt-1 leading-relaxed">
              {learn
                ? "On: this note becomes a permanent rule for all future edits."
                : "Off: applies to this video only — nothing saved to memory."}
            </p>
            <button onClick={applyChanges} disabled={!notes.trim()} className={`${btnCls} mt-3 w-full`}>
              Apply changes →
            </button>
            {savedNote && (
              <p className="font-mono text-xs text-emerald-400 mt-2 leading-relaxed">{savedNote}</p>
            )}
            {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
          </div>

          <div className="bg-panel border border-edge rounded-xl p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">
              Versions
            </p>
            {versions.length === 0 && (
              <p className="text-paper/40 text-xs">No versions yet…</p>
            )}
            <div className="space-y-2">
              {versions.map((v) => (
                <button
                  key={v.n}
                  onClick={() => v.status === "done" && setSelectedN(v.n)}
                  disabled={v.status !== "done"}
                  className={`block w-full text-left rounded p-3 border transition ${
                    selectedN === v.n
                      ? "bg-ink border-signal"
                      : "bg-ink border-edge hover:border-paper/30"
                  } ${v.status !== "done" ? "cursor-default" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-paper">v{v.n}</span>
                    <span
                      className={`font-mono text-[9px] uppercase tracking-widest border rounded px-1.5 py-0.5 ${chip(
                        v.status
                      )}`}
                    >
                      {v.status}
                    </span>
                  </div>
                  {v.notes && (
                    <p className="text-paper/50 text-[11px] mt-1.5 line-clamp-2 break-words">
                      {v.notes}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── CENTER STAGE ──────────────────────────────────────── */}
        <div className="bg-panel border border-edge rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              Preview {selected ? `· v${selected.n}` : ""}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              {selected?.status === "rendering"
                ? "rendering…"
                : selected?.status === "done"
                ? "ready"
                : selected?.status === "failed"
                ? "failed"
                : ""}
            </p>
          </div>

          <div className="mx-auto w-full max-w-[420px] aspect-[4/5] rounded-2xl overflow-hidden bg-black border border-edge flex items-center justify-center shadow-2xl">
            {selected?.status === "done" && selected.path ? (
              <video
                key={selected.path}
                src={fileUrl(selected.path)}
                controls
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : selected?.status === "rendering" ? (
              <div className="text-center px-6">
                <div className="font-mono text-xs text-amber-400">rendering…</div>
                <p className="text-paper/40 text-xs mt-2 leading-relaxed">
                  (a few min — Telegram pings you too)
                </p>
              </div>
            ) : selected?.status === "failed" ? (
              <div className="text-center px-6">
                <div className="font-mono text-xs text-signal">render failed</div>
                <p className="text-paper/40 text-xs mt-2 leading-relaxed break-words">
                  {selected.notes}
                </p>
              </div>
            ) : (
              <div className="text-center px-6">
                <p className="text-paper/40 text-xs leading-relaxed">
                  your first cut is on the way…
                </p>
              </div>
            )}
          </div>

          <p className="text-paper/40 text-xs mt-4 text-center leading-relaxed">
            Play, scrub and replay with the native controls. Type a note on the left to spin a new
            version — the editor keeps every take.
          </p>
        </div>
      </div>
    </div>
  );
}
