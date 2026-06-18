import { useState, useEffect, useRef } from "react";
import { api } from "../api";

// ---- shared styles (mirror Skills.tsx) ---------------------------------------
const inputCls =
  "w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30 outline-none focus:border-signal";
const btnCls =
  "bg-signal text-paper rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90 transition-opacity";

// Fetches the error message out of non-2xx responses too.
async function apiPost(path: string, body: object) {
  const token = sessionStorage.getItem("tedca_token");
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${path} → ${res.status}`);
  return data;
}

// Poll /api/skills/job/:id until done/failed or timeout (uses the same job table).
async function pollJob(
  jobId: number,
  onStatus: (msg: string) => void,
  timeoutMs = 22 * 60 * 1000
): Promise<{ ok: boolean; result: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await api(`/api/skills/job/${jobId}`);
    if (j.status === "done") return { ok: true, result: JSON.parse(j.result || "{}") };
    if (j.status === "failed") return { ok: false, result: j.result };
    const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
    onStatus(`running… (${elapsed}s)`);
  }
  return { ok: false, result: "timed out waiting for worker" };
}

// ---- skill type --------------------------------------------------------------
type Skill = {
  keyword: string;
  name: string;
  desc: string;
  price: string;
  stripe?: string;
  tags?: string[];
  page_link?: string;
  card_live?: boolean;
  sheet_row?: boolean;
};

// ---- SkillCard ---------------------------------------------------------------
function SkillCard({
  skill,
  postBusy,
  postStatus,
  onPost,
}: {
  skill: Skill;
  postBusy: boolean;
  postStatus: string;
  onPost: () => void;
}) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-5 flex flex-col gap-3">
      {/* header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-xl leading-tight">{skill.name}</h3>
          <span className="inline-block mt-1 font-mono text-[10px] bg-ink border border-edge rounded-full px-2 py-0.5 text-paper/50 uppercase tracking-widest">
            {skill.keyword}
          </span>
        </div>
        <span className="font-display text-2xl text-signal shrink-0">{skill.price}</span>
      </div>

      {/* desc */}
      <p className="text-paper/60 text-xs leading-relaxed">{skill.desc}</p>

      {/* tags */}
      {skill.tags && skill.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skill.tags.map((t) => (
            <span
              key={t}
              className="font-mono text-[10px] bg-ink border border-edge rounded-full px-2 py-0.5 text-paper/40"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* status badges */}
      <div className="flex gap-2 flex-wrap">
        {skill.card_live && (
          <span className="font-mono text-[10px] text-emerald-400 border border-emerald-400/30 rounded-full px-2 py-0.5">
            card live
          </span>
        )}
        {skill.sheet_row && (
          <span className="font-mono text-[10px] text-emerald-400 border border-emerald-400/30 rounded-full px-2 py-0.5">
            bot active
          </span>
        )}
      </div>

      {/* action row */}
      <div className="mt-auto pt-1 flex items-center gap-3">
        <button
          onClick={onPost}
          disabled={postBusy}
          className={`${btnCls} shrink-0`}
        >
          {postBusy ? "posting…" : "Make IG post"}
        </button>
        {postStatus && (
          <p
            className={`font-mono text-[10px] leading-tight break-all ${
              postStatus.startsWith("done")
                ? "text-emerald-400"
                : postStatus.startsWith("failed") || postStatus.startsWith("error")
                ? "text-signal"
                : "text-amber-400"
            }`}
          >
            {postStatus}
          </p>
        )}
      </div>
    </div>
  );
}

// ---- NewSkillForm -----------------------------------------------------------
function NewSkillCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    keyword: "",
    price: "",
    desc: "",
    tags: "",
    stripe_link: "",
    inactive: true, // default: stage inactive
  });
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => nameRef.current?.focus(), 50);
  }, [open]);

  function field(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const r = await apiPost("/api/agentos/skill", {
        ...form,
        keyword: form.keyword.toLowerCase().replace(/[^a-z0-9]/g, ""),
      });
      setStatus("queued — watching for worker…");
      const { ok, result } = await pollJob(r.job_id, setStatus, 5 * 60 * 1000);
      if (ok) {
        setStatus(`done — skill "${form.name}" registered`);
        setForm({ name: "", keyword: "", price: "", desc: "", tags: "", stripe_link: "", inactive: true });
        setOpen(false);
        onCreated();
      } else {
        setError(typeof result === "string" ? result : JSON.stringify(result));
        setStatus("");
      }
    } catch (e: any) {
      setError(e.message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-panel border border-dashed border-edge rounded-xl p-5 flex items-center justify-center gap-2 text-paper/40 hover:text-paper hover:border-signal transition-colors w-full h-full min-h-[200px]"
      >
        <span className="text-2xl leading-none">+</span>
        <span className="font-mono text-xs uppercase tracking-widest">New skill</span>
      </button>
    );
  }

  return (
    <div className="bg-panel border border-signal/40 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">agentos · registry</p>
          <h3 className="font-display text-xl mt-0.5">New Skill</h3>
        </div>
        <button onClick={() => setOpen(false)} className="text-paper/40 hover:text-paper font-mono text-xs">
          cancel
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <input ref={nameRef} value={form.name} onChange={field("name")} placeholder="Skill name, e.g. Cold Email Engine" className={inputCls} required />
        <div className="flex gap-2">
          <div className="flex-1">
            <input
              value={form.keyword}
              onChange={field("keyword")}
              placeholder="keyword (a-z0-9)"
              className={inputCls}
              required
              pattern="[a-z0-9]+"
              title="lowercase letters and numbers only"
            />
            <p className="font-mono text-[10px] text-paper/30 mt-1 pl-1">IG comment trigger · tedca.org/?skill=keyword</p>
          </div>
          <input value={form.price} onChange={field("price")} placeholder="$250" className={`${inputCls} w-24`} required />
        </div>
        <textarea
          value={form.desc}
          onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))}
          placeholder="One-sentence description shown on the card"
          rows={3}
          className="w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30 outline-none focus:border-signal resize-none leading-relaxed"
          required
        />
        <input value={form.tags} onChange={field("tags")} placeholder="Tags (comma-separated): Lead Scraping, Gmail Sending" className={inputCls} />
        <input value={form.stripe_link} onChange={field("stripe_link")} placeholder="https://buy.stripe.com/..." className={inputCls} required />

        {/* inactive checkbox */}
        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={form.inactive}
            onChange={(e) => setForm((f) => ({ ...f, inactive: e.target.checked }))}
            className="mt-0.5 accent-signal"
          />
          <div>
            <p className="font-mono text-xs text-paper/80 group-hover:text-paper">
              Stage keyword inactive
            </p>
            <p className="font-mono text-[10px] text-paper/30 mt-0.5 leading-relaxed">
              Sheet row is written but stays inactive — bot won't fire the DM until you flip it live (after the site card is published)
            </p>
          </div>
        </label>

        <button type="submit" disabled={busy} className={`${btnCls} w-full mt-1`}>
          {busy ? "…" : "Register skill"}
        </button>
      </form>
      {status && <p className="font-mono text-xs text-amber-400 mt-3">{status}</p>}
      {error && <p className="font-mono text-xs text-signal mt-3 break-all">{error}</p>}
    </div>
  );
}

// ---- Wire a Post ------------------------------------------------------------
type KwRow = {
  keyword: string;
  link: string;
  message: string;
  active: string;
  post_url: string;
  match_type: string;
};

function LiveKeywords({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<KwRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const data = await api("/api/agentos/keywords");
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [refresh]);

  return (
    <div className="bg-panel border border-edge rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Live Sheet · Current Keywords</p>
        <button onClick={load} className="font-mono text-[10px] text-paper/40 hover:text-paper transition-colors">
          ↻ refresh
        </button>
      </div>
      {loading && <p className="font-mono text-xs text-paper/40">Loading…</p>}
      {err && <p className="font-mono text-xs text-signal break-all">{err}</p>}
      {!loading && !err && rows.length === 0 && (
        <p className="font-mono text-xs text-paper/30">No keywords in the sheet yet.</p>
      )}
      {!loading &&
        rows.map((r) => (
          <div
            key={r.keyword}
            className="flex items-start justify-between gap-3 py-2.5 border-b border-edge last:border-0"
          >
            <div className="min-w-0">
              <span className="font-mono text-xs text-signal uppercase tracking-wider">{r.keyword}</span>
              <p className="font-mono text-[10px] text-paper/50 mt-0.5 break-all leading-relaxed">{r.link}</p>
              {r.post_url && (
                <p className="font-mono text-[10px] text-paper/30 mt-0.5">locked to specific post</p>
              )}
            </div>
            <span
              className={`font-mono text-[10px] shrink-0 px-2 py-0.5 rounded-full border ${
                r.active === "TRUE"
                  ? "text-emerald-400 border-emerald-400/30"
                  : "text-paper/30 border-edge"
              }`}
            >
              {r.active === "TRUE" ? "live" : "off"}
            </span>
          </div>
        ))}
    </div>
  );
}

function WirePostCard({ onWired }: { onWired: () => void }) {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [form, setForm] = useState({ keyword: "", link: "", message: "", post_url: "" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(""); // uploading | wiring | polling
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const kw = form.keyword; // already sanitized on input
  const linkValid = form.link.startsWith("http");
  const canSubmit = kw.length > 0 && linkValid && !busy;

  function handleKeywordChange(e: React.ChangeEvent<HTMLInputElement>) {
    const sanitized = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "");
    setForm((f) => ({ ...f, keyword: sanitized }));
  }

  function resetForm() {
    setForm({ keyword: "", link: "", message: "", post_url: "" });
    setVideoFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    setSuccess("");
    setStatus("");

    try {
      let video_path = "";

      // Step 1: Upload video if provided
      if (videoFile) {
        setStage("uploading");
        setStatus("Uploading video…");
        const token = sessionStorage.getItem("tedca_token");
        const fd = new FormData();
        fd.append("video", videoFile);
        const up = await fetch(`/api/agentos/upload-video?keyword=${encodeURIComponent(kw)}`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        const upData = await up.json();
        if (!up.ok) throw new Error(upData.error || `Upload failed: ${up.status}`);
        video_path = upData.path;
      }

      // Step 2: Enqueue wire job
      setStage("wiring");
      setStatus("Wiring keyword → link…");
      const r = await apiPost("/api/agentos/wire", {
        keyword: kw,
        link: form.link,
        ...(form.message ? { message: form.message } : {}),
        ...(video_path ? { video_path } : {}),
        ...(form.post_url ? { post_url: form.post_url } : {}),
      });

      // Step 3: Poll for completion
      setStage("polling");
      const { ok, result } = await pollJob(r.job_id, setStatus, 3 * 60 * 1000);
      if (ok) {
        setSuccess(
          `Wired — comment '${kw}' on IG or FB now sends people to ${form.link}.` +
            (videoFile ? " Video sent to your Telegram." : "")
        );
        resetForm();
        onWired();
      } else {
        setError(typeof result === "string" ? result : JSON.stringify(result));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStage("");
      setStatus("");
    }
  }

  return (
    <div className="bg-panel border border-edge rounded-xl p-5">
      <div className="mb-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">agentos · campaigns</p>
        <h3 className="font-display text-xl mt-0.5">Wire a Post</h3>
        <p className="text-paper/50 text-xs mt-1 leading-relaxed">
          Pick a video, set a keyword and link — the Sheet row goes live and both bots fire within ~30s.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        {/* Video file */}
        <label
          className={`block w-full border border-dashed rounded px-3 py-4 text-center cursor-pointer transition-colors ${
            videoFile ? "border-signal/60 bg-signal/5" : "border-edge hover:border-signal/40"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            className="hidden"
            onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
          />
          <span className="font-mono text-xs text-paper/60">
            {videoFile
              ? `${videoFile.name} (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)`
              : "Click or drag a video file  (MP4 / MOV · max 200 MB · optional)"}
          </span>
          {videoFile && (
            <span
              role="button"
              onClick={(e) => {
                e.preventDefault();
                setVideoFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="ml-3 font-mono text-[10px] text-paper/40 hover:text-signal"
            >
              ✕ remove
            </span>
          )}
        </label>

        {/* Keyword */}
        <div>
          <input
            value={form.keyword}
            onChange={handleKeywordChange}
            placeholder="keyword  (a–z 0–9, no spaces)"
            className={inputCls}
            required
          />
          <p className="font-mono text-[10px] text-paper/30 mt-1 pl-1">
            IG / FB comment trigger — auto-sanitized as you type
            {form.keyword ? (
              <span className="text-signal ml-1">→ {form.keyword}</span>
            ) : null}
          </p>
        </div>

        {/* Destination link */}
        <input
          value={form.link}
          onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
          placeholder="https://tedca.org/guide"
          className={inputCls}
          required
        />

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="font-mono text-[10px] text-paper/40 hover:text-paper transition-colors"
        >
          {showAdvanced ? "▲ hide advanced" : "▾ advanced options"}
        </button>

        {showAdvanced && (
          <div className="space-y-3 pt-1">
            <textarea
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
              placeholder={`Custom DM text (optional). Use {link} as placeholder — blank uses "Here you go 👉 <link>"`}
              rows={3}
              className="w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30 outline-none focus:border-signal resize-none leading-relaxed"
            />
            <div>
              <input
                value={form.post_url}
                onChange={(e) => setForm((f) => ({ ...f, post_url: e.target.value }))}
                placeholder="https://www.instagram.com/reel/… (lock to a specific post — optional)"
                className={inputCls}
              />
              <p className="font-mono text-[10px] text-paper/30 mt-1 pl-1">
                Blank = fires on all IG posts AND Facebook. Filled = IG only, locked to that reel.
              </p>
            </div>
          </div>
        )}

        <button type="submit" disabled={!canSubmit} className={`${btnCls} w-full mt-1`}>
          {busy
            ? stage === "uploading"
              ? "Uploading video…"
              : stage === "wiring"
              ? "Wiring to Sheet…"
              : "Worker running…"
            : "Wire this post"}
        </button>
      </form>

      {status && !error && !success && (
        <p className="font-mono text-xs text-amber-400 mt-3">{status}</p>
      )}
      {error && <p className="font-mono text-xs text-signal mt-3 break-all">{error}</p>}
      {success && (
        <p className="font-mono text-xs text-emerald-400 mt-3 leading-relaxed">{success}</p>
      )}
    </div>
  );
}

// ---- page -------------------------------------------------------------------
export default function AgentOS() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // per-keyword post job state: keyword → { jobId, status }
  const [postJobs, setPostJobs] = useState<Record<string, { busy: boolean; status: string }>>({});
  // increment to trigger LiveKeywords refresh after a successful wire
  const [kwRefresh, setKwRefresh] = useState(0);

  async function loadSkills() {
    setLoading(true);
    setError("");
    try {
      const data = await api("/api/agentos/skills");
      setSkills(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSkills();
    // Re-attach poll loops for any in-flight jobs that survived a page refresh
    // or server restart (BUG 1 fix: job_id is no longer lost on reload).
    api("/api/agentos/jobs/active")
      .then((activeJobs: { id: number; type: string; status: string; keyword: string | null }[]) => {
        for (const job of activeJobs) {
          if (!job.keyword) continue;
          const kw = job.keyword;
          setPostJobs((j) => ({
            ...j,
            [kw]: { busy: true, status: `running… (job #${job.id} ${job.status})` },
          }));
          pollJob(
            job.id,
            (msg) => setPostJobs((j) => ({ ...j, [kw]: { busy: true, status: msg } })),
            22 * 60 * 1000
          ).then(({ ok, result }) => {
            const finalStatus = ok
              ? `done — ${(result as any)?.outdir || "check Telegram"}`
              : `failed: ${typeof result === "string" ? result : JSON.stringify(result)}`;
            setPostJobs((j) => ({ ...j, [kw]: { busy: false, status: finalStatus } }));
          });
        }
      })
      .catch(() => {/* silently ignore — active-jobs endpoint is best-effort */});
  }, []);

  async function handlePost(keyword: string) {
    setPostJobs((j) => ({ ...j, [keyword]: { busy: true, status: "queuing…" } }));
    try {
      const r = await apiPost("/api/agentos/post", { keyword });
      setPostJobs((j) => ({ ...j, [keyword]: { busy: true, status: "queued — worker starting…" } }));
      const { ok, result } = await pollJob(
        r.job_id,
        (msg) => setPostJobs((j) => ({ ...j, [keyword]: { busy: true, status: msg } })),
        22 * 60 * 1000
      );
      const finalStatus = ok
        ? `done — ${result?.outdir || "check Telegram"}`
        : `failed: ${typeof result === "string" ? result : JSON.stringify(result)}`;
      setPostJobs((j) => ({ ...j, [keyword]: { busy: false, status: finalStatus } }));
    } catch (e: any) {
      setPostJobs((j) => ({ ...j, [keyword]: { busy: false, status: `error: ${e.message}` } }));
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-1">
        <div>
          <h2 className="font-display text-4xl">
            Agent<span className="italic text-signal">OS</span>
          </h2>
          <p className="text-paper/50 text-sm mt-2">
            Your sellable Claude Code skills. Each card maps to an IG comment keyword → DM → Stripe buy button. "Make IG post" queues an animated carousel on your Mac and sends it to Telegram.
          </p>
        </div>
      </div>

      {loading && <p className="font-mono text-xs text-paper/40 mt-6">Loading registry…</p>}
      {error && <p className="font-mono text-xs text-signal mt-6">{error}</p>}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6 items-start">
          {skills.map((s) => (
            <SkillCard
              key={s.keyword}
              skill={s}
              postBusy={postJobs[s.keyword]?.busy ?? false}
              postStatus={postJobs[s.keyword]?.status ?? ""}
              onPost={() => handlePost(s.keyword)}
            />
          ))}
          <NewSkillCard onCreated={loadSkills} />
        </div>
      )}

      {/* ---- Wire a Post -------------------------------------------------- */}
      <div className="mt-12 pt-8 border-t border-edge">
        <div className="mb-5">
          <h3 className="font-display text-2xl">
            Wire a <span className="italic text-signal">Post</span>
          </h3>
          <p className="text-paper/50 text-sm mt-1">
            Attach a video + keyword + link. No registry card needed — the Sheet row goes live and both Instagram and
            Facebook bots fire within ~30s.
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <WirePostCard onWired={() => setKwRefresh((n) => n + 1)} />
          <LiveKeywords refresh={kwRefresh} />
        </div>
      </div>
    </div>
  );
}
