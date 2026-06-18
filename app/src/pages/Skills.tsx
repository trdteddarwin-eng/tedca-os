import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, getToken } from "../api";

function useJobWatch() {
  const [jobState, setJobState] = useState<string | null>(null);
  async function watch(jobId: number): Promise<string | null> {
    setJobState("generating voice…");
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const j = await api(`/api/skills/job/${jobId}`);
      if (j.status === "done") {
        const result = JSON.parse(j.result || "{}");
        setJobState(`done: ${result.path}`);
        return result.path;
      }
      if (j.status === "failed") {
        setJobState(`failed: ${j.result}`);
        return null;
      }
    }
    setJobState("timed out");
    return null;
  }
  return { jobState, watch };
}

function Card({ title, tag, children }: { title: string; tag: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">{tag}</p>
      <h3 className="font-display text-2xl mt-1">{title}</h3>
      <div className="mt-4">{children}</div>
    </div>
  );
}

const inputCls =
  "w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30";
const btnCls =
  "bg-signal text-paper rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90";

function AvatarVideo() {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [script, setScript] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const { jobState, watch } = useJobWatch();

  // Step 4 — upload a recorded take and let an AI editor cut it to a style.
  const [styles, setStyles] = useState<{ id: string; name: string; description: string }[]>([]);
  const [styleId, setStyleId] = useState("");
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [editStatus, setEditStatus] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api("/api/skills/edit-styles")
      .then((s) => {
        setStyles(s);
        if (s[0]) setStyleId(s[0].id);
      })
      .catch(() => {});
  }, []);

  async function uploadAndEdit() {
    if (!editFile) return;
    setEditing(true);
    setEditStatus("uploading your video…");
    try {
      const fd = new FormData();
      fd.append("video", editFile);
      const tok = getToken();
      const up = await fetch("/api/skills/video-edit/upload", {
        method: "POST",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        body: fd,
      });
      if (!up.ok) throw new Error(`upload failed (${up.status})`);
      const { path: vpath } = await up.json();
      const styleName = styles.find((s) => s.id === styleId)?.name || "Tedca Signature";
      // hand off to the Clip Editor page — it queues the first cut, plays it,
      // and runs the review/revise/self-learning loop.
      navigate("/editor", { state: { sourcePath: vpath, styleId, styleName } });
    } catch (e: any) {
      setEditStatus(`Error: ${e.message}`);
    } finally {
      setEditing(false);
    }
  }

  async function writeScript(revise = false) {
    setBusy(true);
    setStatus("");
    try {
      const r = await api("/api/skills/avatar-video/script", {
        method: "POST",
        body: JSON.stringify(revise ? { topic, previous: script, notes } : { topic }),
      });
      setScript(r.script);
      setNotes("");
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setStatus("");
    try {
      const r = await api("/api/skills/avatar-video/voice", {
        method: "POST",
        body: JSON.stringify({ script, topic }),
      });
      if (r.delivered === "telegram") setStatus("✓ Voice generated in the cloud — check your Telegram.");
      else if (r.job_id) {
        setStatus("Queued on your Mac…");
        await watch(r.job_id);
      } else setStatus(`Saved: ${r.file}`);
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Avatar Video" tag="tedca · script first, voice on your OK">
      <p className="text-paper/60 text-xs mb-3 leading-relaxed">
        1: topic → script. 2: edit it directly or give notes and revise. 3: approve → the
        locked avatar voice is generated and sent to your Telegram. No audio until you approve.
      </p>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic, e.g. why missed calls cost med spas $3k/month" className={inputCls} />
      <button onClick={() => writeScript(false)} disabled={busy || !topic} className={`${btnCls} mt-3`}>
        {busy && !script ? "Writing…" : script ? "Start over with this topic" : "1 · Write the script"}
      </button>
      {script && (
        <>
          <textarea
            rows={9}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            className="w-full mt-3 bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper leading-relaxed"
          />
          <div className="flex gap-2 mt-2">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='notes, e.g. "punchier hook, mention dentists too"'
              className={inputCls}
            />
            <button onClick={() => writeScript(true)} disabled={busy || !notes} className="border border-edge text-paper/70 hover:text-paper rounded px-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40 whitespace-nowrap">
              2 · Revise
            </button>
          </div>
          <button onClick={approve} disabled={busy} className={`${btnCls} mt-3 w-full`}>
            {busy ? "…" : "3 · I like it — generate the voice"}
          </button>
        </>
      )}
      {status && <p className="font-mono text-xs text-emerald-400 mt-2">{status}</p>}
      {jobState && <p className="font-mono text-xs text-emerald-400 mt-2 break-all">{jobState}</p>}

      <div className="mt-5 pt-4 border-t border-edge">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">step 4 · edit</p>
        <p className="text-paper/60 text-xs mt-1 mb-3 leading-relaxed">
          Recorded your avatar take? Upload it and an AI editor reads the style playbook and cuts it
          for you. It's a real edit — runs a few minutes and the finished MP4 lands on your Telegram.
        </p>
        {styles.length > 0 && (
          <select value={styleId} onChange={(e) => setStyleId(e.target.value)} className={`${inputCls} mb-2`}>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setEditFile(e.target.files?.[0] || null)}
          className="block w-full text-xs text-paper/70 file:mr-3 file:rounded file:border file:border-edge file:bg-ink file:px-3 file:py-2 file:font-mono file:text-[10px] file:uppercase file:text-paper/80"
        />
        <button onClick={uploadAndEdit} disabled={editing || !editFile} className={`${btnCls} mt-3 w-full`}>
          {editing ? "Editing…" : "Upload & edit my video"}
        </button>
        {editStatus && <p className="font-mono text-xs text-emerald-400 mt-2 break-all">{editStatus}</p>}
      </div>
    </Card>
  );
}

function MotionGraphic() {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const r = await api("/api/skills/motion-graphic", { method: "POST", body: JSON.stringify({ topic }) });
      setStatus("queued — an editor agent is building the full motion graphic on your Mac (script → narration → SFX → render). I'll Telegram the MP4 when it's done.");
      for (let i = 0; i < 800; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const j = await api(`/api/skills/job/${r.job_id}`);
        if (j.status === "done") {
          const result = JSON.parse(j.result || "{}");
          setStatus(`✓ done — sent to your Telegram. ${result.path || ""}`);
          return;
        }
        if (j.status === "failed") {
          setError(j.result || "build failed");
          setStatus("");
          return;
        }
        if (i % 20 === 19) setStatus(`still building… (${Math.round(((i + 1) * 3) / 60)} min)`);
      }
      setStatus("still running — it'll arrive on Telegram when done");
    } catch (e: any) {
      setError(e.message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Motion Graphic" tag="tedca · pure motion graphic, no avatar">
      <p className="text-paper/60 text-xs mb-3 leading-relaxed">
        One topic in, one finished motion-graphic video out — no avatar, nothing to upload. An AI
        editor writes the script, narrates it, adds SFX and renders the MP4 on your Mac, then sends it
        to your Telegram.
      </p>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic, e.g. how AI receptionists never miss a call" className={inputCls} />
      <button onClick={run} disabled={busy || !topic} className={`${btnCls} mt-3 w-full`}>
        {busy ? "Building…" : "Generate the motion graphic"}
      </button>
      {status && <p className="font-mono text-xs text-emerald-400 mt-2 break-all">{status}</p>}
      {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
    </Card>
  );
}

function LivePhoto() {
  const [topics, setTopics] = useState<{ topic: string; hook: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ live_photo: string; captions: string[]; slides?: string[] } | null>(null);

  async function suggest() {
    setBusy(true);
    setTopics([]);
    setError("");
    try {
      const r = await api("/api/skills/livephoto/topics", { method: "POST" });
      setTopics(r.topics);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function pick(topic: string) {
    setBusy(true);
    setResult(null);
    setError("");
    setStatus("queued — your Mac is writing copy, rendering the 3s slide loops and minting Live Photos…");
    try {
      const r = await api("/api/skills/livephoto/run", {
        method: "POST",
        body: JSON.stringify({ topic }),
      });
      // the full build (copy + 5 slide renders at 2160x2700 + Photos import) takes minutes
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const j = await api(`/api/skills/job/${r.job_id}`);
        if (j.status === "done") {
          setResult(JSON.parse(j.result || "{}"));
          setStatus("");
          return;
        }
        if (j.status === "failed") {
          setError(`build failed: ${j.result}`);
          setStatus("");
          return;
        }
        if (i % 10 === 9) setStatus(`still rendering… (${Math.round(((i + 1) * 3) / 60)} min)`);
      }
      setError("timed out waiting for the build");
      setStatus("");
    } catch (e: any) {
      setError(e.message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="TikTok Live Photo" tag="personal brand · animated poster set">
      <p className="text-paper/60 text-xs mb-3 leading-relaxed">
        Finds Claude Code topics you haven't covered, you pick one, and your Mac builds the whole
        thing: 6 animated 4:5 poster slides (hook → tips → comment-CTA closer, 3s loops) minted as
        real Apple Live Photos and imported into Photos. Telegram pings you when the build starts
        and when it's done, and Photos opens by itself — you just AirDrop and post.
      </p>
      <button onClick={suggest} disabled={busy} className={btnCls}>
        {busy && !topics.length ? "Hunting…" : "Suggest 5 topics"}
      </button>
      {topics.length > 0 && (
        <div className="mt-3 space-y-2">
          {topics.map((t) => (
            <button
              key={t.topic}
              onClick={() => pick(t.topic)}
              disabled={busy}
              className="block w-full text-left bg-ink border border-edge hover:border-signal rounded p-3 disabled:opacity-40"
            >
              <p className="text-sm">{t.topic}</p>
              <p className="text-paper/50 text-xs mt-1">{t.hook}</p>
            </button>
          ))}
        </div>
      )}
      {status && <p className="font-mono text-xs text-amber-400 mt-3">{status}</p>}
      {result && (
        <div className="mt-3 space-y-2">
          <p className="font-mono text-xs text-emerald-400 break-all">
            ✓ {result.live_photo} — Photos is open on your Mac: select all 6, Share → AirDrop →
            iPhone, then post from TikTok's Photos tab.
          </p>
          {result.captions?.map((c, i) => (
            <div key={i} className="bg-ink rounded p-3">
              <p className="font-mono text-[10px] text-paper/40 uppercase">caption {i + 1}</p>
              <p className="text-sm mt-1 whitespace-pre-wrap">{c}</p>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
    </Card>
  );
}

function Carousel() {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ slides: string[]; caption: string } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setResult(null);
    setError("");
    setStatus("");
    try {
      const r = await api("/api/skills/carousel", { method: "POST", body: JSON.stringify({ topic }) });
      setStatus("rendering on your Mac… (copy → animated slide 1 → slides 2-6)");
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const j = await api(`/api/skills/job/${r.job_id}`);
        if (j.status === "done") {
          setResult(JSON.parse(j.result || "{}"));
          setStatus("done — Finder opened on the folder");
          return;
        }
        if (j.status === "failed") {
          setError(j.result || "render failed");
          setStatus("");
          return;
        }
      }
      setStatus("timed out");
    } catch (e: any) {
      setError(e.message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Instagram Carousel" tag="tedca · animated cover + 5 slides + caption">
      <p className="text-paper/60 text-xs mb-3 leading-relaxed">
        Renders the real carousel on your Mac: slide 1 as an animated looping MP4 cover, slides 2-6
        as static editorial PNGs, plus caption.txt — Finder opens on the folder when it's done.
      </p>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic, e.g. AI receptionists for local businesses" className={inputCls} />
      <button onClick={run} disabled={busy || !topic} className={`${btnCls} mt-3`}>
        {busy ? "Rendering…" : "Render the carousel"}
      </button>
      {status && <p className="font-mono text-xs text-emerald-400 mt-2">{status}</p>}
      {result && (
        <div className="mt-3 space-y-2 max-h-64 overflow-y-auto">
          {result.slides?.map((s, i) => (
            <div key={i} className="bg-ink rounded p-3">
              <p className="font-mono text-[10px] text-paper/40 uppercase">slide {i + 1}</p>
              <p className="font-mono text-xs mt-1 break-all">{s}</p>
            </div>
          ))}
          <div className="bg-ink rounded p-3">
            <p className="font-mono text-[10px] text-paper/40 uppercase">caption</p>
            <p className="font-mono text-xs mt-1 break-all">{result.caption}</p>
          </div>
        </div>
      )}
      {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
    </Card>
  );
}

function EduPost() {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<{ topic: string; slides: any[] } | null>(null);
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function writeCopy(revise = false) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const body = revise && data ? { previous: data, notes } : topic ? { topic } : {};
      const r = await api("/api/skills/edu-post/copy", { method: "POST", body: JSON.stringify(body) });
      setData(r);
      setNotes("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function setField(i: number, key: string, val: string) {
    if (!data) return;
    setData({ ...data, slides: data.slides.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)) });
  }

  async function generate() {
    if (!data) return;
    setBusy(true);
    setError("");
    setStatus("queued — your Mac is rendering the animated slides → Live Photos…");
    try {
      const r = await api("/api/skills/edu-post/generate", {
        method: "POST",
        body: JSON.stringify({ topic: data.topic, slides: data.slides }),
      });
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const j = await api(`/api/skills/job/${r.job_id}`);
        if (j.status === "done") {
          const res = JSON.parse(j.result || "{}");
          setStatus(`✓ done — ${(res.live_photos?.length) || 0} Live Photos in Photos.app. Preview opened on your Mac.`);
          return;
        }
        if (j.status === "failed") {
          setError(j.result || "render failed");
          setStatus("");
          return;
        }
        if (i % 10 === 9) setStatus(`still rendering… (${Math.round(((i + 1) * 3) / 60)} min)`);
      }
      setStatus("still running — it'll land in Photos when done");
    } catch (e: any) {
      setError(e.message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  const FIELDS = ["kicker", "line1", "line2", "accent", "sub"];
  return (
    <Card title="Educational Post" tag="tedca · pixel carousel · topic → copy → generate">
      <p className="text-paper/60 text-xs mb-3 leading-relaxed">
        Leave the topic blank to let it find a fresh Claude Code topic, or type your own. It writes the
        5-slide copy first — edit any line, then Generate to render the animated Live Photos.
      </p>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic (optional) — e.g. claude code subagents" className={inputCls} />
      <button onClick={() => writeCopy(false)} disabled={busy} className={`${btnCls} mt-3 w-full`}>
        {busy && !data ? "Writing…" : topic ? "Write the copy" : "Find a topic + write copy"}
      </button>

      {data && (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">topic</p>
          <p className="text-sm mb-2">{data.topic}</p>
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {data.slides.map((s, i) => (
              <div key={i} className="bg-ink border border-edge rounded p-2.5">
                <p className="font-mono text-[10px] text-paper/40 uppercase">
                  slide {i + 1} · {s.kind} · <span className="text-signal">{s.scene}</span>
                </p>
                {FIELDS.filter((f) => s[f] !== undefined).map((f) => (
                  <input
                    key={f}
                    value={s[f]}
                    onChange={(e) => setField(i, f, e.target.value)}
                    placeholder={f}
                    className="w-full mt-1.5 bg-panel border border-edge rounded px-2 py-1.5 font-mono text-[11px] text-paper"
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='revise, e.g. "make trick 3 about MCP"' className={inputCls} />
            <button onClick={() => writeCopy(true)} disabled={busy || !notes} className="border border-edge text-paper/70 hover:text-paper rounded px-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40 whitespace-nowrap">
              Revise
            </button>
          </div>
          <button onClick={generate} disabled={busy} className={`${btnCls} mt-3 w-full`}>
            {busy ? "…" : "Generate the post →"}
          </button>
        </div>
      )}
      {status && <p className="font-mono text-xs text-emerald-400 mt-2 break-all">{status}</p>}
      {error && <p className="text-signal font-mono text-xs mt-2 break-all">{error}</p>}
    </Card>
  );
}

export default function Skills() {
  return (
    <div>
      <h2 className="font-display text-4xl">
        One-Click <span className="italic text-signal">Run</span>
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        Your daily content skills, each one button. Voices generate on your Mac (ElevenLabs) and
        land in <span className="font-mono">tedca-os/output/</span> — Finder opens on the file.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6 items-start">
        <EduPost />
        <AvatarVideo />
        <MotionGraphic />
        <LivePhoto />
        <Carousel />
      </div>
    </div>
  );
}
