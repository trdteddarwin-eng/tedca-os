// Upcoming: every Curiosity Hook video that WILL post, in posting order. Read-only.
//
// Three sources, merged into one timeline:
//   1. SCHEDULED: GET /uploadposts/schedule on Upload-Post. One job per platform, so
//      the YouTube + Facebook jobs of the same video are folded into one card.
//      Upload-Post gives no playable URL for a pending job (preview_url is null and
//      the OpenAPI spec has no preview endpoint), so the video is served from disk:
//      backlog files live in ../social-queue, daily-pipeline files in the
//      wait-that-happened repo (matched by meta.schedule.at).
//   2. RESERVED: dates booked in wait-that-happened/slots.json that have NO
//      Upload-Post job. The pipeline's scheduler skips these dates, so if nothing
//      is actually queued for them they become silent gaps. Shown as a warning.
//   3. WAITING FOR APPROVAL: wait-that-happened day folders with meta.status
//      "sent" and out/READY. Not scheduled yet; Ted approves on Telegram, then
//      tools/upload_post.py books the next free 07:00 New York slot. We replay that
//      slot logic here to show where each one would land.
//
// Other agents edit the wait-that-happened working tree, so this module NEVER
// touches it: it runs `git fetch` (throttled) and reads origin/main via
// `git show` / `git ls-tree` / `git cat-file`. Video blobs are copied once into
// DATA_DIR/upcoming-cache/<blob sha> so the browser gets Range requests (scrubbing).
//
// CLOUD MODE (Railway, no checkout, no `gh` login): when WTH_GITHUB_TOKEN is set
// (a fine-grained token for that one repo: Contents read/write, Actions read), or
// there is no local checkout, the same reads and the request commit go through
// the GitHub REST API instead (refs, recursive tree, blobs). Same data, same cache.
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getKey } from "./keys.js";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, "..", "..", "..");
const SOCIAL_QUEUE = path.join(WORKSPACE, "social-queue");
const SQ_DIRS = ["youtube", "fb_stamped", "fb"];
const REPO = path.join(WORKSPACE, "wait-that-happened");
const REF = "origin/main";
const WTH_REPO = process.env.WTH_REPO || "trdteddarwin-eng/wait-that-happened";
const wthToken = () => (process.env.WTH_GITHUB_TOKEN || "").trim();
const useApi = () => !!wthToken() || !fs.existsSync(path.join(REPO, ".git"));
const TZ = "America/New_York";
const UP_API = "https://api.upload-post.com/api";

const UP_EVERY_MS = 2 * 60_000; // schedule list: cheap, but no need to hit it on every 60s poll
const FETCH_EVERY_MS = 4 * 60_000; // git fetch: at most every few minutes
const FORCE_MIN_MS = 20_000; // even "refresh now" waits this long between real fetches
const ACTIVE_MS = 25_000; // while a request sent from the OS is in flight, re-check this often
let activeRequests = false;

const cacheDir = () => path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "upcoming-cache");

// ── small helpers ────────────────────────────────────────────────────────────
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", REPO, ...args], { timeout: 30_000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 200)));
      resolve(stdout);
    });
  });
}
// JSON file at origin/main (git) or at the cached head's tree (API)
const blobJsonCache = new Map(); // blob sha -> parsed (content-addressed, never stale)
const gitJson = async (p) => {
  try {
    if (!useApi()) return JSON.parse(await git(["show", `${REF}:${p}`]));
    const sha = repoCache.tree?.get(p);
    if (!sha) return null;
    if (blobJsonCache.has(sha)) return blobJsonCache.get(sha);
    const b = await ghApi("GET", `repos/${WTH_REPO}/git/blobs/${sha}`);
    const v = JSON.parse(Buffer.from(String(b.content || ""), b.encoding === "base64" ? "base64" : "utf8").toString("utf8"));
    if (blobJsonCache.size > 500) blobJsonCache.clear();
    blobJsonCache.set(sha, v);
    return v;
  } catch {
    return null;
  }
};

async function upGet(p, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${UP_API}${p}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Apikey ${getKey("upload_post")}` },
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(String(j.message || j.error || `HTTP ${res.status}`).slice(0, 200));
  return j;
}

// New York wall-clock parts for an instant: { date: "YYYY-MM-DD", minutes: h*60+m }
function nyParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const addDays = (ymd, n) => {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// UTC instant of a New York wall-clock time (handles EDT/EST by probing the offset)
function nyToUtc(ymd, hhmm) {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const p = nyParts(guess);
  const wall = new Date(`${p.date}T${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}:00Z`);
  return new Date(guess.getTime() + (guess.getTime() - wall.getTime())).toISOString();
}
const normTitle = (t) => String(t || "").replace(/#shorts/gi, "").trim().toLowerCase();

// ── file registry: the ONLY files the /file route will serve ─────────────────
// id → { kind: "sq", abs } | { kind: "git", sha, ext }
let fileIndex = new Map();

function sqFile(name) {
  const base = path.basename(String(name || ""));
  if (!base) return null;
  for (const d of SQ_DIRS) {
    const abs = path.join(SOCIAL_QUEUE, d, base);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}
function regSq(abs, index) {
  if (!abs) return null;
  const id = `sq-${path.relative(SOCIAL_QUEUE, abs).replace(/[\\/]/g, "~")}`;
  index.set(id, { kind: "sq", abs });
  return id;
}
function regGit(entry, index) {
  if (!entry) return null;
  const ext = path.extname(entry.path).toLowerCase();
  const id = `git-${entry.sha}${ext}`;
  index.set(id, { kind: "git", sha: entry.sha, ext });
  return id;
}

export function resolveUpcomingFile(id) {
  const f = fileIndex.get(String(id || ""));
  if (!f) return null;
  if (f.kind === "sq") return fs.existsSync(f.abs) ? f.abs : null;
  return f; // git blob: caller materializes it
}

// Copy a git blob into the cache dir once (content-addressed, so never stale).
const inflightBlobs = new Map();
export function materializeBlob(f) {
  const dest = path.join(cacheDir(), `${f.sha}${f.ext}`);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (inflightBlobs.has(dest)) return inflightBlobs.get(dest);
  const p = new Promise((resolve, reject) => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    if (useApi()) {
      fetch(`https://api.github.com/repos/${WTH_REPO}/git/blobs/${f.sha}`, {
        headers: { ...ghHeaders(), Accept: "application/vnd.github.raw+json" },
        signal: AbortSignal.timeout(180_000),
      })
        .then((res) => {
          if (!res.ok || !res.body) throw new Error(`GitHub blob HTTP ${res.status}`);
          return pipeline(Readable.fromWeb(res.body), out);
        })
        .then(() => { fs.renameSync(tmp, dest); resolve(dest); })
        .catch((e) => { out.destroy(); fs.rmSync(tmp, { force: true }); reject(e); });
      return;
    }
    const child = spawn("git", ["-C", REPO, "cat-file", "blob", f.sha], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.pipe(out, { end: false });
    child.on("error", reject);
    child.on("close", (code) => {
      out.on("close", () => {
        if (code !== 0) {
          fs.rmSync(tmp, { force: true });
          return reject(new Error(`git cat-file exited ${code}`));
        }
        fs.renameSync(tmp, dest);
        resolve(dest);
      });
      out.end();
    });
  }).finally(() => inflightBlobs.delete(dest));
  inflightBlobs.set(dest, p);
  return p;
}

// ── source 1: Upload-Post schedule ───────────────────────────────────────────
let upCache = { at: 0, jobs: null, error: null };
async function scheduledJobs(force) {
  if (!getKey("upload_post")) return { jobs: [], error: "no Upload-Post key (keystore service upload_post)" };
  const age = Date.now() - upCache.at;
  if (upCache.jobs && (age < (force ? FORCE_MIN_MS : activeRequests ? ACTIVE_MS : UP_EVERY_MS))) return upCache;
  try {
    const jobs = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const j = await upGet("/uploadposts/schedule", { limit: 100, offset });
      const page = Array.isArray(j.scheduled_posts) ? j.scheduled_posts : [];
      jobs.push(...page);
      if (page.length < 100 || jobs.length >= (typeof j.total === "number" ? j.total : 0)) break;
    }
    upCache = { at: Date.now(), jobs, error: null };
  } catch (e) {
    // keep the last good list on screen, flagged as stale
    upCache = { at: Date.now(), jobs: upCache.jobs || [], error: String(e.message || e).slice(0, 200) };
  }
  return upCache;
}

// ── source 2+3: wait-that-happened origin/main ───────────────────────────────
let repoCache = { fetchedAt: 0, head: null, data: null, error: null };
async function repoState(force) {
  let error = null;
  const age = Date.now() - repoCache.fetchedAt;
  if (age > (force ? FORCE_MIN_MS : activeRequests ? ACTIVE_MS : FETCH_EVERY_MS)) {
    repoCache.fetchedAt = Date.now();
    try {
      if (useApi()) {
        if (!wthToken()) throw new Error("no local checkout and no WTH_GITHUB_TOKEN");
        const ref = await ghApi("GET", `repos/${WTH_REPO}/git/ref/heads/main`);
        repoCache.apiHead = ref?.object?.sha || repoCache.apiHead;
      } else {
        await git(["fetch", "-q", "origin", "main"]);
      }
    } catch (e) {
      error = `${useApi() ? "GitHub" : "git fetch"} failed, showing the last fetched origin/main (${String(e.message || e).slice(0, 120)})`;
    }
  }
  let head;
  try {
    head = useApi() ? repoCache.apiHead : (await git(["rev-parse", REF])).trim();
    if (!head) throw new Error(error || "no head yet");
  } catch (e) {
    return { data: null, error: `cannot read ${REF} in wait-that-happened: ${String(e.message || e).slice(0, 120)}` };
  }
  if (repoCache.data && repoCache.head === head) return { data: repoCache.data, head, error: error || repoCache.error };

  // every blob under days/ and requests/ at this head: { sha, size, path }
  const entries = [];
  if (useApi()) {
    const t = await ghApi("GET", `repos/${WTH_REPO}/git/trees/${head}?recursive=1`);
    if (t.truncated) error = error || "GitHub tree listing was truncated";
    for (const e of t.tree || []) if (e.type === "blob" && (/^(days|requests)\//.test(e.path) || e.path === "slots.json" || e.path === "config.json")) entries.push({ sha: e.sha, size: Number(e.size || 0), path: e.path });
  } else {
    for (const line of (await git(["ls-tree", "-r", "-l", REF, "days/", "requests/"])).split("\n")) {
      const m = line.match(/^\d+ blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/);
      if (m) entries.push({ sha: m[1], size: Number(m[2]), path: m[3] });
    }
  }
  repoCache.tree = null; // git mode reads json with `git show`
  if (useApi()) repoCache.tree = new Map(entries.map((e) => [e.path, e.sha]));
  const files = {};
  for (const e of entries) {
    if (!e.path.startsWith("days/")) continue;
    (files[e.path.split("/")[1]] ||= []).push(e);
  }
  const days = [];
  for (const day of Object.keys(files).sort()) {
    const meta = await gitJson(`days/${day}/meta.json`);
    if (!meta) continue;
    const has = (rel) => files[day].find((f) => f.path === `days/${day}/${rel}`) || null;
    const outVideos = files[day]
      .filter((f) => /^days\/[^/]+\/out\/[^/]+_(1080p|720p)\.mp4$/.test(f.path) && !f.path.endsWith("_tg.mp4"))
      .sort((a, b) => Number(b.path.endsWith("_1080p.mp4")) - Number(a.path.endsWith("_1080p.mp4")));
    days.push({ day, meta, ready: !!has("out/READY"), cover: has("out/cover.jpg"), video: outVideos[0] || null, sent_to_telegram: !!has("telegram.json") });
  }
  // request files: top level = not handled yet, requests/done = respond.yml processed it
  const reqOpen = new Set();
  const reqDone = new Set();
  for (const { path: line } of entries) {
    const m = line.match(/^requests\/(done\/)?([^/]+\.json)$/);
    if (m) (m[1] ? reqDone : reqOpen).add(m[2]);
  }
  const data = {
    days,
    slots: (await gitJson("slots.json"))?.booked || [],
    config: (await gitJson("config.json")) || {},
    commit: head.slice(0, 7),
    reqOpen,
    reqDone,
  };
  repoCache = { ...repoCache, head, data, error };
  return { data, head, error };
}

// backlog metadata (titles, covers) keyed by queue key and by video basename
function readQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(SOCIAL_QUEUE, "queue.json"), "utf8"));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

// ── the merged timeline ──────────────────────────────────────────────────────
let lastResult = null;
let inflight = null;
export function getUpcoming(force = false) {
  if (inflight) return inflight;
  inflight = build(force).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function build(force) {
  const index = new Map();
  const now = new Date();
  const latestRequest = new Map();
  for (const r of db.prepare("SELECT * FROM upcoming_requests ORDER BY id ASC").all()) latestRequest.set(r.day, r);
  const today = nyParts(now);
  const [up, repo] = await Promise.all([scheduledJobs(force), repoState(force).catch((e) => ({ data: null, error: String(e.message || e) }))]);
  const queue = readQueue();
  const byBasename = new Map();
  for (const q of queue) {
    for (const side of ["yt", "fb"]) if (q[side]?.file) byBasename.set(path.basename(q[side].file), q);
  }
  const rdays = repo.data?.days || [];
  const postTime = String(repo.data?.config?.post_time || "07:00");

  // 1. scheduled jobs → one card per (NY date, title)
  // A TikTok-only job (upload_post.py add-tiktok) is listed by Upload-Post under its caption, not the video title,
  // so map job ids back to their day first (meta.schedule.job_id / meta.schedule.tiktok.job_id).
  const dayByJob = new Map();
  for (const d of rdays) {
    const s = d.meta?.schedule || {};
    for (const id of [s.job_id, s.response?.job_id, s.tiktok?.job_id]) if (typeof id === "string" && id) dayByJob.set(id, d);
  }
  const groups = new Map();
  for (const job of up.jobs || []) {
    const atUtc = job.scheduled_date ? new Date(/Z|[+-]\d\d:?\d\d$/.test(job.scheduled_date) ? job.scheduled_date : job.scheduled_date + "Z") : null;
    if (!atUtc || isNaN(atUtc.getTime())) continue;
    const ny = job.original_timezone === TZ && job.original_scheduled_str
      ? { date: job.original_scheduled_str.slice(0, 10), time: job.original_scheduled_str.slice(11, 16) }
      : (() => { const p = nyParts(atUtc); return { date: p.date, time: `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}` }; })();
    const platforms = Array.isArray(job.platforms) ? job.platforms : [];
    const pc = job.platform_content || {};
    const jobDay = dayByJob.get(job.job_id);
    const title = jobDay?.meta?.title || String(job.title || "").split("\n")[0];
    const key = `${ny.date}|${normTitle(title)}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind: "scheduled", date: ny.date, time: ny.time, at: atUtc.toISOString(), title: title.replace(/\s*#shorts\s*$/i, ""), platforms: [], thumbnail_url: null, videos: [], cover: null, source: null };
      groups.set(key, g);
    }
    for (const pl of platforms) {
      const c = pc[pl] || {};
      g.platforms.push({ platform: pl, job_id: job.job_id, title: c.title || job.title || null, caption: c.caption || job.description || job.caption || null });
    }
    if (job.thumbnail_url && (!g.thumbnail_url || platforms.includes("youtube"))) g.thumbnail_url = job.thumbnail_url;

    // playable file: daily-pipeline day scheduled for this date, else the backlog file
    const day = (jobDay?.video ? jobDay : null) || rdays.find((d) => d.meta?.schedule?.at && String(d.meta.schedule.at).slice(0, 10) === ny.date && d.video);
    if (day) {
      if (!g.videos.some((v) => v.label === "Video")) g.videos.push({ label: "Video", id: regGit(day.video, index) });
      g.cover = g.cover || regGit(day.cover, index);
      g.source = `wait-that-happened/days/${day.day}`;
    } else {
      const abs = sqFile(job.source_filename);
      const label = platforms.includes("facebook") ? "Facebook cut" : "YouTube cut";
      if (abs && !g.videos.some((v) => v.label === label)) g.videos.push({ label, id: regSq(abs, index) });
      const q = byBasename.get(path.basename(String(job.source_filename || "")));
      if (q) {
        g.source = g.source || `social-queue (${q.key})`;
        const cov = path.join(SOCIAL_QUEUE, "covers", `${q.key}.jpg`);
        if (!g.cover && fs.existsSync(cov)) g.cover = regSq(cov, index);
      }
    }
  }
  const scheduled = [...groups.values()]
    .filter((g) => g.at >= new Date(now.getTime() - 3600_000).toISOString())
    .sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title));
  for (const g of scheduled) {
    g.platforms.sort((a, b) => a.platform.localeCompare(b.platform) * -1); // youtube first
    g.videos.sort((a, b) => a.label.localeCompare(b.label) * -1); // YouTube cut first
  }
  const scheduledDates = new Set(scheduled.map((g) => g.date));

  // 2. reserved in slots.json but nothing scheduled on Upload-Post
  const reserved = [];
  for (const b of repo.data?.slots || []) {
    if (!b?.date || b.date < today.date || scheduledDates.has(b.date)) continue;
    if (b.date === today.date && today.minutes >= Number(postTime.slice(0, 2)) * 60 + Number(postTime.slice(3, 5))) continue;
    const q = queue.find((x) => x.key === b.what);
    const day = rdays.find((d) => d.day === b.what);
    const item = { kind: "reserved", date: b.date, time: postTime, at: nyToUtc(b.date, postTime), what: b.what, title: q?.title || day?.meta?.title || b.what, videos: [], cover: null, captions: [] };
    if (q) {
      const yt = q.yt?.file && sqFile(q.yt.file);
      const fb = q.fb?.file && sqFile(q.fb.file);
      if (yt) item.videos.push({ label: "YouTube cut", id: regSq(yt, index) });
      if (fb) item.videos.push({ label: "Facebook cut", id: regSq(fb, index) });
      const cov = path.join(SOCIAL_QUEUE, "covers", `${q.key}.jpg`);
      if (fs.existsSync(cov)) item.cover = regSq(cov, index);
      if (q.yt) item.captions.push({ platform: "youtube", title: q.yt.title || null, caption: q.yt.description || null });
      if (q.fb) item.captions.push({ platform: "facebook", title: null, caption: q.fb.description || null });
    } else if (day) {
      if (day.video) item.videos.push({ label: "Video", id: regGit(day.video, index) });
      item.cover = regGit(day.cover, index);
    }
    reserved.push(item);
  }
  reserved.sort((a, b) => a.date.localeCompare(b.date));

  // 3. waiting for Ted's approval: status "sent" + out/READY (or a failed approve to retry),
  //    plus days a request is in flight for, so the card can show what happened to it
  const taken = new Set([...(repo.data?.slots || []).map((b) => b.date), ...scheduledDates]);
  const leadMin = 20; // tools/upload_post.py next_slot: the slot must be >= 20 min away
  const [hh, mm] = postTime.split(":").map(Number);
  let cursor = today.minutes + leadMin >= hh * 60 + mm ? addDays(today.date, 1) : today.date;
  const pending = [];
  let anyActive = false;
  for (const d of rdays) {
    const m = d.meta || {};
    const req = latestRequest.get(d.day) || null;
    const recent = req && Date.now() - new Date(req.sent_at).getTime() < 24 * 3600_000;
    const st = await requestState(d, req, repo.data);
    const show =
      (m.status === "sent" && d.ready) || m.status === "approved_unscheduled" || m.status === "revising" || (recent && st);
    if (!show || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    if (st && ["queued", "working"].includes(st.phase)) anyActive = true;

    // where it would land: same next-free-slot walk as tools/upload_post.py
    let date = null;
    let at = null;
    const needsSlot = (m.status === "sent" && d.ready && !(st && ["queued"].includes(st.phase) && st.action === "skip")) || m.status === "approved_unscheduled";
    if (m.status === "scheduled" && m.schedule?.at) {
      date = String(m.schedule.at).slice(0, 10);
      at = nyToUtc(date, String(m.schedule.at).slice(11, 16) || postTime);
    } else if (needsSlot && !(st && st.phase === "working")) {
      while (taken.has(cursor)) cursor = addDays(cursor, 1);
      taken.add(cursor);
      date = cursor;
      at = nyToUtc(cursor, postTime);
    }
    const idle = !st || ["arrived", "failed", "missing"].includes(st.phase);
    const actionable = idle && ((m.status === "sent" && d.ready) || m.status === "approved_unscheduled");
    pending.push({
      kind: "pending",
      day: d.day,
      status: m.status || null,
      title: m.title || d.day,
      version: m.version ?? null,
      duration_s: typeof m.duration_s === "number" ? m.duration_s : null,
      date,
      time: postTime,
      at,
      platforms: Array.isArray(repo.data?.config?.platforms) ? repo.data.config.platforms : ["youtube", "facebook"],
      captions: [
        { platform: "youtube", title: m.title || null, caption: m.youtube?.description || null },
        { platform: "facebook", title: null, caption: m.facebook?.caption || null },
        { platform: "tiktok", title: null, caption: m.tiktok?.caption || m.facebook?.caption || null },
      ],
      cover: regGit(d.cover, index),
      videos: d.video ? [{ label: d.video.path.endsWith("_1080p.mp4") ? "1080p preview" : "720p preview", id: regGit(d.video, index) }] : [],
      request: st,
      can: { approve: actionable, skip: actionable, feedback: actionable },
    });
  }
  activeRequests = anyActive;
  pending.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : a.day.localeCompare(b.day)));
  const shown = new Set(pending.map((p) => p.day));
  const drafts = rdays.filter((d) => d.meta?.status === "draft" && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && !d.day.startsWith("2099") && !shown.has(d.day)).length;

  // summary: next post, coverage, gaps, one-video-per-day check
  // two posts a day is fine now (7 AM + the 6 PM TikTok slot); a duplicate is two videos in the SAME slot
  const perDay = new Map();
  const perSlot = new Map();
  for (const g of scheduled) {
    perDay.set(g.date, [...(perDay.get(g.date) || []), g.title]);
    perSlot.set(`${g.date} ${g.time}`, [...(perSlot.get(`${g.date} ${g.time}`) || []), g.title]);
  }
  const duplicates = [...perSlot.entries()].filter(([, t]) => t.length > 1).map(([slot, titles]) => ({ date: slot.slice(0, 10), time: slot.slice(11), titles }));
  const last = scheduled.length ? scheduled[scheduled.length - 1].date : null;
  const firstOpen = today.minutes >= hh * 60 + mm ? addDays(today.date, 1) : today.date;
  const gaps = [];
  if (last) for (let d = firstOpen; d <= last; d = addDays(d, 1)) if (!perDay.has(d)) gaps.push(d);
  const next = scheduled[0] || null;

  fileIndex = new Map([...fileIndex, ...index]); // keep old ids valid for players already open
  if (fileIndex.size > 400) fileIndex = index;
  pruneCache(index);

  lastResult = {
    ok: !up.error && !repo.error,
    refreshed_at: new Date().toISOString(),
    today: today.date,
    post_time: postTime,
    scheduled,
    reserved,
    pending,
    drafts,
    summary: {
      next: next ? { title: next.title, at: next.at, date: next.date } : null,
      covered_days: perDay.size,
      last_scheduled_date: last,
      gaps,
      duplicates,
    },
    sources: {
      upload_post: { ok: !up.error, error: up.error || null, jobs: (up.jobs || []).length, checked_at: up.at ? new Date(up.at).toISOString() : null },
      repo: { ok: !repo.error, error: repo.error || null, commit: repo.data?.commit || null, fetched_at: repoCache.fetchedAt ? new Date(repoCache.fetchedAt).toISOString() : null },
    },
  };
  return lastResult;
}

// drop cached blobs no current card points at (keeps the cache to a few videos)
function pruneCache(index) {
  try {
    const keep = new Set([...index.values()].filter((f) => f.kind === "git").map((f) => `${f.sha}${f.ext}`));
    for (const name of fs.readdirSync(cacheDir())) {
      if (!keep.has(name) && !name.endsWith(".part")) fs.rmSync(path.join(cacheDir(), name), { force: true });
    }
  } catch {
    /* no cache dir yet */
  }
}

// ══ Approve / Skip / Request changes from the OS ═════════════════════════════
// The Telegram bridge (wait-that-happened/modal/wth_telegram.py) turns a tap or a
// reply into ONE thing: a commit of requests/<UTC ts>-<action>.json with
// {day, action, feedback, at}, message "request: <action> <day>". respond.yml
// runs tools/respond.py on it (approve -> upload_post.py schedule, skip ->
// status skipped, feedback -> pending_feedback.json + the WTH Respond routine)
// and posts the outcome to Telegram itself. The bridge has no entry point other
// than the Telegram webhook, so the OS makes the identical commit through the
// GitHub contents API with the Mac's `gh` login (the token never leaves `gh`), or
// in the cloud with WTH_GITHUB_TOKEN. The browser only ever sees our own route.
db.exec(`CREATE TABLE IF NOT EXISTS upcoming_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  action TEXT NOT NULL,
  feedback TEXT,
  file TEXT NOT NULL,
  version INTEGER,
  commit_sha TEXT,
  sent_at TEXT NOT NULL,
  telegram_note TEXT
)`);

let ghRepo = null;
async function repoSlug() {
  if (ghRepo) return ghRepo;
  if (useApi()) return (ghRepo = WTH_REPO);
  const url = (await git(["remote", "get-url", "origin"])).trim();
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error("wait-that-happened origin is not a GitHub repo");
  ghRepo = m[1];
  return ghRepo;
}

// `gh api` with the keyring login. GITHUB_TOKEN / GH_TOKEN from .env would silently
// override the keyring account, so they are stripped from the child's env.
// Cloud: plain REST with WTH_GITHUB_TOKEN (never logged, never sent to the browser).
const ghHeaders = () => ({ Authorization: `Bearer ${wthToken()}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tedca-os" });
async function ghApi(method, apiPath, body = null, { raw = false } = {}) {
  if (!wthToken()) return ghCli(method, apiPath, body, { raw });
  const res = await fetch(`https://api.github.com/${apiPath}`, {
    method,
    headers: { ...ghHeaders(), Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text).message || msg; } catch { /* not JSON */ }
    throw new Error(String(msg).slice(0, 240));
  }
  if (raw) return text;
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function ghCli(method, apiPath, body = null, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const args = ["api", "-X", method, apiPath];
    if (body) args.push("--input", "-");
    const child = spawn("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`gh not available: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let msg = err.trim() || `gh exited ${code}`;
        try { msg = JSON.parse(out).message || msg; } catch { /* not JSON */ }
        return reject(new Error(String(msg).slice(0, 240)));
      }
      if (raw) return resolve(out);
      try { resolve(out ? JSON.parse(out) : {}); } catch { resolve({}); }
    });
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}

// Telegram note, same bot + chat the bridge answers from (env only, never logged).
async function tgNote(text, replyTo) {
  const token = process.env.CH_TELEGRAM_BOT_TOKEN || "";
  const chat = process.env.CH_TELEGRAM_CHAT_ID || "";
  if (!token || !chat) return "not configured";
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    return j.ok ? "sent" : `failed: ${String(j.description || r.status).slice(0, 80)}`;
  } catch (e) {
    return `failed: ${String(e.message || e).slice(0, 80)}`;
  }
}

// The real reason an approve failed lives in the respond.yml job log (upload_post.py
// output). Find the run that handled "request: approve <day>" and pull the error lines.
const errCache = new Map();
async function respondError(day) {
  const key = `${day}|${repoCache.head}`;
  if (errCache.has(key)) return errCache.get(key);
  let msg = null;
  try {
    const repo = await repoSlug();
    const runs = await ghApi("GET", `repos/${repo}/actions/workflows/respond.yml/runs?per_page=30`);
    const run = (runs.workflow_runs || []).find((r) => String(r.head_commit?.message || "").trim() === `request: approve ${day}`);
    if (run) {
      const jobs = await ghApi("GET", `repos/${repo}/actions/runs/${run.id}/jobs`);
      const job = (jobs.jobs || [])[0];
      if (job) {
        const log = await ghApi("GET", `repos/${repo}/actions/jobs/${job.id}/logs`, null, { raw: true });
        const lines = log.split("\n").map((l) => l.replace(/^\S+Z\s/, "").replace(/\x1b\[[0-9;]*m/g, "").trim());
        const from = lines.findIndex((l) => l.startsWith("== ") && l.includes(`approve ${day}`));
        const section = from >= 0 ? lines.slice(from + 1) : lines;
        const stop = section.findIndex((l) => l.startsWith("== ") || l.startsWith("##[group]Run git config"));
        const body = (stop >= 0 ? section.slice(0, stop) : section)
          .filter((l) => l && !l.startsWith("+ ") && !l.startsWith("##[") && !/^\[?telegram/i.test(l))
          .filter((l) => !/^\d\d:\d\d:\d\d /.test(l) && !/^\^+$/.test(l) && !l.startsWith("File \"") && !/^(raise|return|with|self\.|data =|d =)/.test(l));
        // a Python exception line ("FileNotFoundError: ...") or upload_post.py's own die() message wins
        const exc = body.filter((l) => /^[A-Za-z_.]*(Error|Exception)\b.*:/.test(l));
        const bad = body.filter((l) => /error|fail|denied|limit|quota|credit|exceed|HTTP [45]\d\d|refused|invalid/i.test(l));
        msg = (exc.length ? exc.slice(-1) : bad.length ? bad.slice(-2) : body.slice(-2)).join(" | ").slice(0, 300) || null;
        if (msg) msg += ` (GitHub run ${run.id})`;
      }
    }
  } catch (e) {
    msg = `could not read the respond.yml log: ${String(e.message || e).slice(0, 120)}`;
  }
  errCache.set(key, msg);
  return msg;
}

export const _respondErrorForTest = respondError;

// What happened to the newest OS request for this day (or a Telegram-started revision)
async function requestState(d, req, data) {
  const m = d.meta || {};
  const v = typeof m.version === "number" ? m.version : null;
  if (!req) {
    if (m.status === "revising") return { phase: "working", action: "feedback", message: `Working on v${(v || 1) + 1}...`, source: "telegram" };
    if (m.status === "approved_unscheduled") {
      return { phase: "failed", action: "approve", message: "Approved, but scheduling failed on Upload-Post.", error: await respondError(d.day), source: "telegram" };
    }
    return null;
  }
  // a later Telegram tap can overtake an older OS request: then the day's own status wins
  const ageMs = Date.now() - new Date(req.sent_at).getTime();
  const overtaken =
    (req.action === "approve" && ["skipped", "revising"].includes(m.status)) ||
    (req.action === "skip" && ["scheduled", "approved_unscheduled", "revising"].includes(m.status)) ||
    (req.action === "feedback" && ["scheduled", "skipped", "approved_unscheduled", "posted"].includes(m.status));
  if (overtaken) return requestState(d, null, data);
  const base = { action: req.action, feedback: req.feedback || null, sent_at: req.sent_at, source: "tedca-os" };
  const open = data?.reqOpen?.has(req.file);
  const done = data?.reqDone?.has(req.file);
  if (open) return { ...base, phase: "queued", message: "Request sent. Waiting for GitHub Actions to pick it up." };
  if (!done) {
    const age = Date.now() - new Date(req.sent_at).getTime();
    return age < 5 * 60_000
      ? { ...base, phase: "queued", message: "Request sent. Waiting for the repo to show it." }
      : { ...base, phase: "missing", message: `The request file ${req.file} is not in the repo.` };
  }
  if (req.action === "approve") {
    if (m.status === "scheduled") return { ...base, phase: "scheduled", message: `Scheduled for ${m.schedule?.at || "the next 7:00 slot"} ET on ${(m.schedule?.platforms || ["youtube", "facebook"]).map((p) => ({ youtube: "YouTube", facebook: "Facebook", tiktok: "TikTok" })[p] || p).join(" + ")}${m.schedule?.tiktok ? " (TikTok " + m.schedule.tiktok.at + ")" : ""}.` };
    if (m.status === "approved_unscheduled") return { ...base, phase: "failed", message: "Approved, but scheduling failed on Upload-Post.", error: await respondError(d.day) };
    return { ...base, phase: "failed", message: `GitHub handled the approve, but the day is still "${m.status}".`, error: await respondError(d.day) };
  }
  if (req.action === "skip") {
    return m.status === "skipped"
      ? { ...base, phase: "skipped", message: "Skipped. It will not post." }
      : { ...base, phase: "failed", message: `GitHub handled the skip, but the day is "${m.status}".` };
  }
  // feedback: revising -> routine edits (draft, version+1) -> Modal render -> READY -> deliver -> sent
  if (m.status === "sent" && v !== null && req.version !== null && v > req.version) {
    return { ...base, phase: "arrived", message: `v${v} is here with your changes. It was also sent to Telegram.` };
  }
  if (m.status === "draft" && v !== null && req.version !== null && v > req.version) {
    return { ...base, phase: "working", message: `v${v} is rendering...` };
  }
  const hrs = Math.floor(ageMs / 3600_000);
  return {
    ...base,
    phase: "working",
    message: hrs >= 2 ? `Still working on v${(req.version || 1) + 1} after ${hrs}h. If the pipeline hit an error, Telegram has the alert.` : `Working on v${(req.version || 1) + 1}...`,
  };
}

const ACTIONS = new Set(["approve", "skip", "feedback"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Make the exact commit the Telegram bridge makes. `test` allows the no-op action
// "noop" on a 2099-* test day only (respond.py ignores unknown actions after
// resolving the day): it exercises the whole write path without approving,
// skipping or messaging anything. Not reachable from the HTTP route.
export async function sendDayRequest({ day, action, feedback = "" }, { test = false } = {}) {
  day = String(day || "");
  action = String(action || "");
  feedback = String(feedback || "").trim();
  const isTest = test && action === "noop" && day.startsWith("2099-");
  if (!DAY_RE.test(day)) throw Object.assign(new Error("bad day"), { status: 400 });
  if (!ACTIONS.has(action) && !isTest) throw Object.assign(new Error("action must be approve, skip or feedback"), { status: 400 });
  if (action === "feedback" && !feedback) throw Object.assign(new Error("write what to change first"), { status: 400 });
  if (feedback.length > 2000) throw Object.assign(new Error("keep the change request under 2000 characters"), { status: 400 });

  // validate against the freshest origin/main
  repoCache.fetchedAt = 0;
  const repo = await repoState(true);
  if (!repo.data) throw Object.assign(new Error(repo.error || "pipeline repo unavailable"), { status: 503 });
  const d = repo.data.days.find((x) => x.day === day);
  if (!d) throw Object.assign(new Error(`day ${day} is not in the repo`), { status: 404 });
  const st = d.meta?.status;
  if (!isTest) {
    const ok = (st === "sent" && d.ready) || st === "approved_unscheduled";
    if (!ok) throw Object.assign(new Error(`${day} is "${st}", not waiting for approval`), { status: 409 });
  }
  // one in-flight request per day (a double tap must not schedule twice)
  for (const f of repo.data.reqOpen) {
    const r = await gitJson(`requests/${f}`);
    if (r?.day === day) throw Object.assign(new Error(`a ${r.action} request for ${day} is already waiting for GitHub Actions`), { status: 409 });
  }
  const last = db.prepare("SELECT * FROM upcoming_requests WHERE day = ? ORDER BY id DESC LIMIT 1").get(day);
  if (last && !repo.data.reqDone.has(last.file) && Date.now() - new Date(last.sent_at).getTime() < 5 * 60_000) {
    throw Object.assign(new Error(`a ${last.action} request for ${day} was just sent`), { status: 409 });
  }

  // identical to wth_telegram.py request(): UTC %Y%m%d-%H%M%S, json indent=1, same keys + order
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = `${ts}-${action}.json`;
  const body = JSON.stringify({ day, action, feedback, at: ts }, null, 1);
  const repoName = await repoSlug();
  let res;
  try {
    res = await ghApi("PUT", `repos/${repoName}/contents/requests/${file}`, {
      message: `request: ${action} ${day}`,
      content: Buffer.from(body, "utf8").toString("base64"),
    });
  } catch (e) {
    throw Object.assign(new Error(`GitHub refused the request: ${e.message}`), { status: 502 });
  }
  const commit = res?.commit?.sha || null;

  // the bridge replies in the chat only for typed changes (buttons just get a toast)
  let note = null;
  if (action === "feedback") {
    const tgIds = await gitJson(`days/${day}/telegram.json`);
    note = await tgNote(`Changes requested from Tedca OS for ${day}: "${feedback.slice(0, 300)}"`, tgIds?.approval || null);
  }
  const sentAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO upcoming_requests (day, action, feedback, file, version, commit_sha, sent_at, telegram_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(day, action, feedback || null, file, typeof d.meta?.version === "number" ? d.meta.version : null, commit, sentAt, note);

  // re-check soon: the card follows the request through respond.yml
  activeRequests = true;
  repoCache.fetchedAt = 0;
  upCache.at = 0;
  return { ok: true, day, action, file, commit: commit ? commit.slice(0, 7) : null, telegram: note };
}

// Test helper: remove a request file this module created (requests/ or requests/done/).
export async function deleteRequestFile(relPath, message) {
  if (!/^requests\/(done\/)?\d{8}-\d{6}-noop\.json$/.test(relPath)) throw new Error("only test noop request files can be deleted");
  const repoName = await repoSlug();
  const cur = await ghApi("GET", `repos/${repoName}/contents/${relPath}`);
  await ghApi("DELETE", `repos/${repoName}/contents/${relPath}`, { message, sha: cur.sha });
  db.prepare("DELETE FROM upcoming_requests WHERE file = ?").run(relPath.split("/").pop());
}
