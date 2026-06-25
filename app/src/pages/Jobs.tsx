import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiBlobUrl } from "../api";

type Job = {
  id: number;
  run_id: number | null;
  type: string;
  params: string | null;
  status: string; // queued | claimed | done | failed
  result: string | null;
  created_at: string | null;
  claimed_at: string | null;
  finished_at: string | null;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "● queued", cls: "bg-paper/10 text-paper/60" },
  claimed: { label: "▶ running", cls: "bg-amber-400/15 text-amber-300 animate-pulse" },
  running: { label: "▶ running", cls: "bg-amber-400/15 text-amber-300 animate-pulse" },
  done: { label: "✓ done", cls: "bg-emerald-400/15 text-emerald-400" },
  failed: { label: "✕ failed", cls: "bg-signal/15 text-signal" },
};

const TYPE_LABEL: Record<string, string> = {
  scrape: "Lead scrape",
  "motion-graphic": "Motion Graphic video",
  motion_graphic: "Motion Graphic video",
  livephoto: "Live Photo",
  carousel: "Carousel",
  "video-edit": "Video edit",
  agentos_post: "AgentOS post",
  agentos_new_skill: "AgentOS skill",
  "avatar-video": "Avatar video",
};

// pull the most human-meaningful field out of the params JSON
function summarize(job: Job): string {
  try {
    const p = JSON.parse(job.params || "{}");
    return p.topic || p.search || p.keyword || p.style_name || p.title || p.query || "—";
  } catch {
    return "—";
  }
}

function when(s: string | null): string {
  return s ? s.replace("T", " ").slice(0, 19) : "—";
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  function refresh() {
    api("/api/jobs").then(setJobs).catch(console.error);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000); // live status updates
    return () => clearInterval(t);
  }, []);

  const active = jobs.filter((j) => j.status === "queued" || j.status === "claimed").length;

  return (
    <div>
      <div className="flex items-center gap-3">
        <h2 className="font-display text-4xl">Jobs</h2>
        {active > 0 && (
          <span className="font-mono text-[11px] uppercase tracking-widest px-2 py-1 rounded bg-amber-400/15 text-amber-300 animate-pulse">
            {active} running
          </span>
        )}
      </div>
      <p className="text-paper/50 text-sm mt-2">
        Every video, scrape, and skill run — live status and full history. Auto-refreshes.
      </p>

      <div className="mt-6 space-y-2">
        {jobs.length === 0 && (
          <p className="text-paper/50 text-sm bg-panel border border-edge rounded-lg p-5">
            No jobs yet — they appear here the moment you run something (Motion Graphic, Live Photo, a scrape…).
          </p>
        )}
        {jobs.map((j) => {
          const st = STATUS[j.status] || { label: j.status, cls: "bg-paper/10 text-paper/60" };
          const isOpen = open === j.id;
          return (
            <div key={j.id} className="bg-panel border border-edge rounded-lg">
              <div
                className="p-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-paper/5"
                onClick={() => setOpen(isOpen ? null : j.id)}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{TYPE_LABEL[j.type] || j.type}</span>
                    <span className="font-mono text-[10px] text-paper/30">#{j.id}</span>
                  </div>
                  <div className="text-paper/60 text-sm truncate">{summarize(j)}</div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className="font-mono text-[11px] text-paper/40 hidden sm:block">{when(j.created_at)}</span>
                  <span className={`font-mono text-[11px] px-2 py-1 rounded whitespace-nowrap ${st.cls}`}>{st.label}</span>
                </div>
              </div>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-edge/50 pt-3 space-y-1.5">
                  <div className="grid grid-cols-3 gap-3 font-mono text-[11px] text-paper/50">
                    <div>created<br /><span className="text-paper/80">{when(j.created_at)}</span></div>
                    <div>started<br /><span className="text-paper/80">{when(j.claimed_at)}</span></div>
                    <div>finished<br /><span className="text-paper/80">{when(j.finished_at)}</span></div>
                  </div>
                  <JobMedia id={j.id} type={j.type} status={j.status} result={j.result} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Renders the actual generated output — playable video / image preview — not JSON.
function JobMedia({ id, type, status, result }: { id: number; type: string; status: string; result: string | null }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<{ name: string; kind: string; path: string; url: string }[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string[] = [];
    let alive = true;
    api(`/api/jobs/${id}/media`)
      .then(async (d) => {
        if (!alive) return;
        setFiles(d.files);
        setFolder(d.folder || null);
        const map: Record<string, string> = {};
        for (const f of (d.files || []).slice(0, 8)) {
          try {
            const u = await apiBlobUrl(f.url);
            map[f.url] = u;
            revoke.push(u);
          } catch { /* skip */ }
        }
        if (alive) setUrls(map);
      })
      .catch(() => setFiles([]));
    return () => {
      alive = false;
      revoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [id]);

  if (status === "failed") {
    return (
      <div className="mt-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Error</div>
        <pre className="mt-1 text-xs whitespace-pre-wrap break-words font-mono text-signal">{(result || "failed").slice(0, 800)}</pre>
      </div>
    );
  }
  if (files === null) return <p className="text-paper/40 text-sm mt-3">loading output…</p>;
  if (files.length === 0)
    return (
      <p className="text-paper/50 text-sm mt-3">
        No previewable file here — the output may live on your Mac or in Photos. (Cloud preview needs the worker to upload it.)
      </p>
    );

  const videoCount = files.filter((f) => f.kind === "video").length;
  const isPost = ["agentos_post", "edu_post"].includes(type) || videoCount > 1;

  return (
    <div className="mt-3">
      {isPost && folder && (
        <button
          onClick={() => navigate("/post-editor", { state: { jobId: id, folder } })}
          className="mb-3 font-mono text-[11px] uppercase tracking-widest bg-signal text-paper rounded px-3 py-2 hover:opacity-90"
        >
          ✎ Edit post ({videoCount} slide{videoCount === 1 ? "" : "s"})
        </button>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {files.map((f) => (
          <div key={f.url} className="bg-ink border border-edge rounded-lg p-2">
            {urls[f.url] ? (
              f.kind === "video" ? (
                <video controls src={urls[f.url]} className="w-full rounded" />
              ) : (
                <img src={urls[f.url]} alt={f.name} className="w-full rounded" />
              )
            ) : (
              <div className="aspect-video grid place-items-center text-paper/30 text-xs font-mono">loading…</div>
            )}
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="font-mono text-[10px] text-paper/40 truncate">{f.name}</span>
              {f.kind === "video" && !isPost && (
                <button
                  onClick={() =>
                    navigate("/editor", { state: { sourcePath: f.path, existing: true, styleName: "edit" } })
                  }
                  className="font-mono text-[10px] uppercase tracking-widest bg-signal text-paper rounded px-2.5 py-1 hover:opacity-90 whitespace-nowrap"
                >
                  ✎ Edit
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
