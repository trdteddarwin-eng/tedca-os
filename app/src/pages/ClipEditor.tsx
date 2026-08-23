import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, getToken } from "../api";

// Clip Editor with history: every upload is a PROJECT; every edit is a VERSION row in the DB
// (refresh-safe). Revising any finished version branches a new version from it — the same
// v1/v2/v3-with-notes loop as the manual edit rounds, productized.

type Version = {
  id: number;
  project_id: number;
  version_n: number;
  parent_version_id: number | null;
  status: "rendering" | "done" | "failed" | "seeded";
  notes?: string | null;
  output_path?: string | null;
  build_log_path?: string | null;
  created_at: string;
  fail_reason?: string;
};

type Project = {
  id: number;
  name: string;
  source_path: string;
  style_id: string;
  created_at: string;
  version_count?: number;
  latest_status?: string;
  versions?: Version[];
};

function fileUrl(p: string) {
  return `/api/skills/file?path=${encodeURIComponent(p)}&token=${getToken()}`;
}

const btnCls =
  "bg-signal text-paper rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90";

const chipCls = (s: Version["status"] | string | undefined) =>
  s === "done" || s === "seeded"
    ? "text-emerald-400 border-emerald-400/40"
    : s === "failed"
    ? "text-signal border-signal/40"
    : "text-amber-400 border-amber-400/40";

export default function ClipEditor() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const pid = params.get("p") ? Number(params.get("p")) : null;

  const entry = (location.state || {}) as {
    sourcePath?: string;
    styleId?: string;
    existing?: boolean;
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [learn, setLearn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enteredRef = useRef(false);

  const versions = project?.versions || [];
  const selected = versions.find((v) => v.id === selectedId) || null;

  const openProject = useCallback(
    (id: number) => {
      setSelectedId(null);
      setParams({ p: String(id) });
    },
    [setParams]
  );

  // ── entry from Skills (new upload) or Jobs (existing video): create a persistent project ──
  useEffect(() => {
    if (!entry.sourcePath || pid || enteredRef.current) return;
    enteredRef.current = true;
    (async () => {
      try {
        let projectId: number;
        if (entry.existing) {
          // a finished video enters as a project seeded with itself as v1 (no render queued)
          const p = await api("/api/edit-projects", {
            method: "POST",
            body: JSON.stringify({ source_path: entry.sourcePath, style: entry.styleId || "locked", skip_initial: true }),
          });
          await api(`/api/edit-projects/${p.project_id}/seed`, {
            method: "POST",
            body: JSON.stringify({ output_path: entry.sourcePath, notes: "imported — the video as it was when this project was opened" }),
          });
          projectId = p.project_id;
        } else {
          const p = await api("/api/edit-projects", {
            method: "POST",
            body: JSON.stringify({ source_path: entry.sourcePath, style: entry.styleId || "locked" }),
          });
          projectId = p.project_id;
        }
        // one navigation: sets ?p AND clears the entry state so a refresh doesn't re-create
        navigate(`${location.pathname}?p=${projectId}`, { replace: true, state: null });
      } catch (e: any) {
        setError(`Error creating project: ${e.message}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.sourcePath]);

  // ── project list (no project open) ────────────────────────────────────────
  useEffect(() => {
    if (pid) return;
    let dead = false;
    (async () => {
      try {
        const rows = await api("/api/edit-projects");
        if (!dead) setProjects(rows);
      } catch (e: any) {
        if (!dead) setError(e.message);
      }
    })();
    return () => {
      dead = true;
    };
  }, [pid]);

  // ── project detail + polling of rendering versions ───────────────────────
  const loadProject = useCallback(async () => {
    if (!pid) return;
    const p: Project = await api(`/api/edit-projects/${pid}`);
    setProject(p);
    setSelectedId((cur) => {
      if (cur && p.versions?.some((v) => v.id === cur)) return cur;
      const playable = [...(p.versions || [])].reverse().find((v) => v.output_path);
      return playable?.id ?? p.versions?.[p.versions.length - 1]?.id ?? null;
    });
  }, [pid]);

  useEffect(() => {
    if (!pid) return;
    let dead = false;
    loadProject().catch((e) => !dead && setError(e.message));
    const iv = setInterval(async () => {
      try {
        const p: Project = await api(`/api/edit-projects/${pid}`);
        if (dead) return;
        setProject(p);
      } catch {
        /* transient poll error — keep the last state */
      }
    }, 4000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [pid, loadProject]);

  // ── revise from the selected version ──────────────────────────────────────
  async function revise() {
    const trimmed = notes.trim();
    if (!trimmed || !pid || !selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/edit-projects/${pid}/revise`, {
        method: "POST",
        body: JSON.stringify({ from_version_id: selected.id, notes: trimmed, learn }),
      });
      setNotes("");
      await loadProject();
    } catch (e: any) {
      setError(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ════════════════ PROJECT LIST VIEW ════════════════
  if (!pid) {
    return (
      <div className="bg-ink min-h-screen -m-6 p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-3xl">
            tedca os <span className="text-paper/40">· clip editor</span>
          </h2>
          <Link to="/skills" className={btnCls}>
            + new project (upload a video)
          </Link>
        </div>
        {error && <p className="text-signal font-mono text-xs mb-4 break-all">{error}</p>}
        {projects.length === 0 ? (
          <div className="bg-panel border border-edge rounded-xl p-10 text-center">
            <p className="text-paper/60 text-sm leading-relaxed max-w-md mx-auto">
              No edit projects yet. Upload a video in One-Click Run → Avatar Video and hit{" "}
              <span className="text-paper">Upload &amp; edit my video</span> — it becomes a project
              here, with every version you ever make kept in its history.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => openProject(p.id)}
                className="text-left bg-panel border border-edge rounded-xl p-5 hover:border-signal/60 transition"
              >
                <div className="flex items-center justify-between">
                  <span className="text-paper font-medium truncate">{p.name}</span>
                  <span
                    className={`font-mono text-[9px] uppercase tracking-widest border rounded px-1.5 py-0.5 ${chipCls(
                      p.latest_status
                    )}`}
                  >
                    {p.latest_status || "empty"}
                  </span>
                </div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mt-2">
                  {p.version_count || 0} version{(p.version_count || 0) === 1 ? "" : "s"} ·{" "}
                  {p.created_at?.slice(0, 16)}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ════════════════ PROJECT DETAIL VIEW ════════════════
  return (
    <div className="bg-ink min-h-screen -m-6 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-3xl">
            tedca os <span className="text-paper/40">· {project?.name || "clip editor"}</span>
          </h2>
          <button
            onClick={() => setParams({})}
            className="font-mono text-[10px] uppercase tracking-widest text-paper/40 hover:text-paper/70"
          >
            ← all projects
          </button>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-signal border border-signal/40 bg-signal/10 rounded px-2.5 py-1.5">
          {project?.style_id === "locked" ? "Tedca Locked style" : project?.style_id || ""}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5 items-start">
        {/* ── LEFT: revise + history ─────────────────────────────── */}
        <div className="space-y-4">
          <div className="bg-panel border border-edge rounded-xl p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              Tell it what to change
            </p>
            <p className="text-paper/50 text-xs mt-1 mb-3 leading-relaxed">
              {selected
                ? `Revising from v${selected.version_n} — a new version will branch from it.`
                : "Select a finished version to revise from."}
            </p>
            <textarea
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  revise();
                }
              }}
              placeholder={'e.g. "the opener text is too big", "remove the sound at 0:09" — then press Enter'}
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
            <button
              onClick={revise}
              disabled={busy || !notes.trim() || !selected || !["done", "seeded"].includes(selected.status)}
              className={`${btnCls} mt-3 w-full`}
            >
              {busy ? "queuing…" : `Revise from v${selected?.version_n ?? "?"} →`}
            </button>
            {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
          </div>

          <div className="bg-panel border border-edge rounded-xl p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">
              History
            </p>
            {versions.length === 0 && <p className="text-paper/40 text-xs">No versions yet…</p>}
            <div className="space-y-2">
              {versions.map((v) => {
                const parent = versions.find((x) => x.id === v.parent_version_id);
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedId(v.id)}
                    className={`block w-full text-left rounded p-3 border transition ${
                      selectedId === v.id
                        ? "bg-ink border-signal"
                        : "bg-ink border-edge hover:border-paper/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-paper">
                        v{v.version_n}
                        {parent && (
                          <span className="text-paper/40"> · from v{parent.version_n}</span>
                        )}
                      </span>
                      <span
                        className={`font-mono text-[9px] uppercase tracking-widest border rounded px-1.5 py-0.5 ${chipCls(
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
                );
              })}
            </div>
          </div>
        </div>

        {/* ── CENTER: player ─────────────────────────────────────── */}
        <div className="bg-panel border border-edge rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              Preview {selected ? `· v${selected.version_n}` : ""}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
              {selected?.status === "rendering"
                ? "rendering…"
                : selected
                ? selected.status
                : ""}
            </p>
          </div>

          <div className="mx-auto w-full max-w-[420px] aspect-[9/16] rounded-2xl overflow-hidden bg-black border border-edge flex items-center justify-center shadow-2xl">
            {selected?.output_path ? (
              <video
                key={selected.output_path}
                src={fileUrl(selected.output_path)}
                controls
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : selected?.status === "rendering" ? (
              <div className="text-center px-6">
                <div className="font-mono text-xs text-amber-400">rendering…</div>
                <p className="text-paper/40 text-xs mt-2 leading-relaxed">
                  the editor agent is working — a few minutes (Telegram pings you too)
                </p>
              </div>
            ) : selected?.status === "failed" ? (
              <div className="text-center px-6">
                <div className="font-mono text-xs text-signal">render failed</div>
                <p className="text-paper/40 text-xs mt-2 leading-relaxed break-words">
                  {selected.fail_reason || "see the activity feed"}
                </p>
              </div>
            ) : (
              <p className="text-paper/40 text-xs px-6 leading-relaxed">select a version…</p>
            )}
          </div>

          <p className="text-paper/40 text-xs mt-4 text-center leading-relaxed">
            Every version is kept forever (outputs are write-protected). Select any old version and
            revise from it to branch a new take — just like a real edit history.
          </p>
        </div>
      </div>
    </div>
  );
}
