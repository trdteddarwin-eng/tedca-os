import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, apiBlobUrl } from "../api";

type Slide = { name: string; url: string; path: string };

const btn =
  "rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90";

export default function PostEditor() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state || {}) as { jobId?: number; folder?: string };
  const jobId = state.jobId;

  const [folder, setFolder] = useState(state.folder || "");
  const [slides, setSlides] = useState<Slide[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [overall, setOverall] = useState("");
  const [slideNotes, setSlideNotes] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<{ n: number; text: string }[] | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [renderStatus, setRenderStatus] = useState("");

  async function loadSlides() {
    if (!jobId) return;
    const d = await api(`/api/jobs/${jobId}/media`);
    if (d.folder) setFolder(d.folder);
    const vids: Slide[] = (d.files || []).filter((f: any) => f.kind === "video");
    setSlides(vids);
    const map: Record<string, string> = {};
    for (const f of vids) {
      try { map[f.url] = await apiBlobUrl(f.url); } catch { /* skip */ }
    }
    setUrls(map);
  }
  useEffect(() => {
    loadSlides().catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const hasNotes = Boolean(overall.trim() || Object.values(slideNotes).some((v) => v && v.trim()));
  const notesObj = () => ({
    overall,
    slides: Object.fromEntries(Object.entries(slideNotes).filter(([, v]) => v && v.trim())),
  });

  async function doPreview() {
    setErr(""); setBusy("preview"); setPreview(null);
    try {
      const d = await api("/api/posts/preview", { method: "POST", body: JSON.stringify({ folder, notes: notesObj() }) });
      setPreview(d.slides || []);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  }

  async function doRender() {
    setErr(""); setBusy("render");
    try {
      const d = await api("/api/posts/revise", { method: "POST", body: JSON.stringify({ folder, notes: notesObj() }) });
      setRenderStatus("queued");
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const j = await api(`/api/skills/job/${d.job_id}`);
          setRenderStatus(j.status);
          if (j.status === "done") { await loadSlides(); setPreview(null); setSlideNotes({}); setOverall(""); break; }
          if (j.status === "failed") { setErr("render failed: " + (j.result || "")); break; }
        } catch { /* keep polling */ }
      }
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  }

  if (!jobId) {
    return (
      <div className="p-6 text-paper/60">
        No post loaded — open a post from <button className="text-signal" onClick={() => navigate("/jobs")}>Jobs / History</button> and click Edit.
      </div>
    );
  }

  return (
    <div className="bg-ink min-h-screen -m-6 p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-3xl">tedca os <span className="text-paper/40">· post editor</span></h2>
        <button onClick={() => navigate("/jobs")} className="font-mono text-[10px] uppercase tracking-widest text-paper/40 hover:text-paper/70">← back to jobs</button>
      </div>

      <p className="text-paper/50 text-sm mb-5">
        All {slides.length} slides below. Type what to change on any slide, <b className="text-paper/80">Preview</b> the new copy, then <b className="text-paper/80">Render</b>.
      </p>

      {/* slides grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {slides.map((s, i) => {
          const n = i + 1;
          const prop = preview?.find((p) => p.n === n);
          return (
            <div key={s.url} className="bg-panel border border-edge rounded-xl p-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-2">Slide {n}</div>
              {urls[s.url] ? (
                <video controls src={urls[s.url]} className="w-full rounded-lg bg-black" />
              ) : (
                <div className="aspect-[4/5] grid place-items-center text-paper/30 text-xs font-mono rounded-lg bg-black">loading…</div>
              )}
              <input
                value={slideNotes[n] || ""}
                onChange={(e) => setSlideNotes((p) => ({ ...p, [n]: e.target.value }))}
                placeholder={`change slide ${n}…`}
                className="w-full mt-2 bg-ink border border-edge rounded px-2.5 py-1.5 text-xs text-paper placeholder:text-paper/30"
              />
              {prop && (
                <div className="mt-2 bg-ink border border-emerald-400/30 rounded p-2">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-emerald-400/80">proposed</div>
                  <div className="text-paper/80 text-xs mt-1 whitespace-pre-wrap">{prop.text}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* controls */}
      <div className="mt-6 bg-panel border border-edge rounded-xl p-5 max-w-2xl">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Overall note (optional)</p>
        <textarea
          rows={2}
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
          placeholder='e.g. "make all headlines punchier", "use a calmer tone"'
          className="w-full mt-1 bg-ink border border-edge rounded px-3 py-2 text-xs text-paper placeholder:text-paper/30 resize-none"
        />
        <div className="flex flex-wrap gap-3 mt-4 items-center">
          <button onClick={doPreview} disabled={!hasNotes || busy !== ""} className={`${btn} border border-edge text-paper/80`}>
            {busy === "preview" ? "previewing…" : "Preview changes"}
          </button>
          <button onClick={doRender} disabled={!hasNotes || busy !== ""} className={`${btn} bg-signal text-paper`}>
            {busy === "render" ? "rendering…" : "Render new version →"}
          </button>
          {renderStatus && (
            <span className={`font-mono text-[11px] ${renderStatus === "done" ? "text-emerald-400" : renderStatus === "failed" ? "text-signal" : "text-amber-400"}`}>
              {renderStatus === "done" ? "✓ re-rendered — slides updated above" : `render: ${renderStatus}…`}
            </span>
          )}
        </div>
        <p className="text-paper/35 text-[11px] mt-3 leading-relaxed">
          Preview rewrites the copy (instant, no render). Render runs the editor agent on your Mac — a few minutes, Telegram pings you, then the slides above refresh.
        </p>
        {err && <p className="text-signal font-mono text-xs mt-2 break-all">{err}</p>}
      </div>
    </div>
  );
}
