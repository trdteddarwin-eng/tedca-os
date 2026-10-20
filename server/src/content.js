// Content Posted: read-only performance metrics for everything Ted publishes.
// TWO separate Meta integrations that CANNOT share a token:
//   - Instagram → graph.instagram.com (Instagram Login API, keystore service "ig_graph",
//     IG user id in settings key `ig_user_id`)
//   - Facebook  → graph.facebook.com (never-expiring Page token, keystore service
//     "fb_page", page id in settings key `fb_page_id`)
//
// Facebook coverage is VIDEOS ONLY: /{page}/posts|feed|published_posts all return
// "(#10) requires pages_read_engagement" and /{video}/video_insights returns
// "(#200) read_insights permission missing" until the app passes Meta App Review
// (Advanced Access). The UI states this honestly instead of pretending.
//
// Meta has NO push webhook for like/view counts — polling is the only way to keep
// these numbers live. Every refresh appends a snapshot row to content_metrics, so
// the UI can draw a growth curve per post: "real time" degrades gracefully into
// "here is how this post grew".
import { db } from "./db.js";
import { getKey } from "./keys.js";

// Injected logger (same pattern as engine.js/keys.js) — index.js owns logEvent.
let logEvent = () => {};
export function bindContentLogger(fn) {
  logEvent = fn;
}

const getSetting = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;

// Graph timestamps arrive as "2026-07-09T21:38:13+0000" — normalize to real ISO
// ("…Z") so SQLite's ORDER BY and the dashboard's date formatter both behave.
const toIso = (t) => {
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? String(t) : d.toISOString();
};

// Bare GET against the Graph API. Graph puts errors in a JSON body (often with
// HTTP 400), so check both. Error text is defensively scrubbed of anything
// token-shaped before it can reach a log line or the UI health strip.
async function graphGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const msg = String(j?.error?.message || `HTTP ${res.status}`).replace(/access_token=[^&\s]+/gi, "access_token=***");
    throw new Error(msg);
  }
  return j;
}

// ── Instagram ────────────────────────────────────────────────────────────────
const IG_MEDIA_FIELDS =
  "id,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url,caption";
// Metric names the insights endpoint accepts are constrained ("plays" and
// "engagement" are rejected outright) — these six map onto our snapshot columns.
const IG_INSIGHT_METRICS = ["views", "reach", "likes", "comments", "saved", "shares"];
const IG_METRIC_COL = { views: "views", reach: "reach", likes: "likes", comments: "comments", saved: "saves", shares: "shares" };

// Per-media insights. Which metrics exist varies by media_product_type (FEED
// images reject metrics that REELS accept) and ONE bad name rejects the whole
// batch — so on a batch failure retry one metric at a time and keep whatever the
// API will give us. A missing metric never kills the row.
async function igInsights(base, mediaId, token) {
  const metrics = {};
  const apply = (data) => {
    for (const row of data || []) {
      const col = IG_METRIC_COL[row.name];
      const v = row.values?.[0]?.value;
      if (col && typeof v === "number") metrics[col] = v;
    }
  };
  try {
    const j = await graphGet(`${base}/${mediaId}/insights?metric=${IG_INSIGHT_METRICS.join(",")}&access_token=${encodeURIComponent(token)}`);
    apply(j.data);
    return metrics;
  } catch {
    /* batch rejected — fall through to per-metric salvage */
  }
  for (const m of IG_INSIGHT_METRICS) {
    try {
      const j = await graphGet(`${base}/${mediaId}/insights?metric=${m}&access_token=${encodeURIComponent(token)}`);
      apply(j.data);
    } catch {
      /* this metric doesn't exist for this media type — skip it */
    }
  }
  return metrics;
}

// Insights likes/comments can lag behind the media node's live counters — show
// the freshest (larger) of the two rather than a number Ted can see is stale.
function pickCount(insightVal, nodeVal) {
  const a = typeof insightVal === "number" ? insightVal : null;
  const b = typeof nodeVal === "number" ? nodeVal : null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export async function fetchInstagramPosts() {
  const token = getKey("ig_graph");
  const base = getSetting("ig_graph_base") || "https://graph.instagram.com/v21.0";
  const userId = getSetting("ig_user_id") || "";
  if (!token || !userId) {
    const missing = !token ? "no Instagram token (keystore service ig_graph)" : "ig_user_id not set in settings";
    return { configured: false, ok: false, error: missing, posts: [] };
  }
  try {
    const j = await graphGet(`${base}/${userId}/media?fields=${IG_MEDIA_FIELDS}&limit=25&access_token=${encodeURIComponent(token)}`);
    const posts = [];
    for (const m of j.data || []) {
      const ins = await igInsights(base, m.id, token);
      posts.push({
        network: "instagram",
        external_id: String(m.id),
        permalink: m.permalink || null,
        caption: m.caption || null,
        media_type: m.media_product_type || m.media_type || null,
        thumbnail_url: m.thumbnail_url || m.media_url || null,
        posted_at: toIso(m.timestamp),
        metrics: {
          views: ins.views ?? null,
          reach: ins.reach ?? null,
          likes: pickCount(ins.likes, m.like_count),
          comments: pickCount(ins.comments, m.comments_count),
          saves: ins.saves ?? null,
          shares: ins.shares ?? null,
        },
      });
    }
    return { configured: true, ok: true, error: null, posts };
  } catch (e) {
    return { configured: true, ok: false, error: String(e.message || e).slice(0, 200), posts: [] };
  }
}

// ── Facebook (videos only — see header comment) ──────────────────────────────
const FB_VIDEO_FIELDS = "id,description,created_time,permalink_url,picture,length,views";

// /{page}/videos returns permalink_url as a site-relative path ("/{page}/videos/{id}/")
const absFbUrl = (u) => (u && u.startsWith("/") ? `https://www.facebook.com${u}` : u || null);

export async function fetchFacebookVideos() {
  const token = getKey("fb_page");
  const base = getSetting("fb_graph_base") || "https://graph.facebook.com/v21.0";
  const pageId = getSetting("fb_page_id") || "";
  if (!token || !pageId) {
    const missing = !token ? "no Facebook Page token (keystore service fb_page)" : "fb_page_id not set in settings";
    return { configured: false, ok: false, error: missing, posts: [] };
  }
  try {
    const j = await graphGet(`${base}/${pageId}/videos?fields=${FB_VIDEO_FIELDS}&limit=25&access_token=${encodeURIComponent(token)}`);
    const posts = [];
    for (const v of j.data || []) {
      // Like/comment totals come from the per-video node with summaries. That is
      // ALL we can get: /{video}/video_insights (watch time, 3s views, …) needs
      // the read_insights permission = Meta App Review. Reach/saves/shares stay
      // null on Facebook and the UI omits them rather than showing fake zeros.
      let views = typeof v.views === "number" ? v.views : null;
      let likes = null;
      let comments = null;
      try {
        const d = await graphGet(`${base}/${v.id}?fields=views,likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(token)}`);
        if (typeof d.views === "number") views = d.views;
        const lc = d.likes?.summary?.total_count;
        const cc = d.comments?.summary?.total_count;
        if (typeof lc === "number") likes = lc;
        if (typeof cc === "number") comments = cc;
      } catch {
        /* summaries are a bonus — the row still ships with list-level views */
      }
      posts.push({
        network: "facebook",
        external_id: String(v.id),
        permalink: absFbUrl(v.permalink_url),
        caption: v.description || null,
        media_type: "VIDEO",
        thumbnail_url: v.picture || null,
        posted_at: toIso(v.created_time),
        metrics: { views, reach: null, likes, comments, saves: null, shares: null },
      });
    }
    return { configured: true, ok: true, error: null, posts };
  } catch (e) {
    return { configured: true, ok: false, error: String(e.message || e).slice(0, 200), posts: [] };
  }
}

// ── Curiosity Hook (via Upload-Post) ─────────────────────────────────────────
// The history-shorts channel posts to YouTube + its own FB Page through
// Upload-Post, so no Meta/Google token of ours ever touches those accounts.
// /uploadposts/history lists every post (one row per platform) and
// /uploadposts/post-analytics/{request_id} returns live platform counters. Polled
// every 10 min (not 90s): one call per post, and these numbers move slowly.
const UP_API = "https://api.upload-post.com/api";
const UP_EVERY_MS = 10 * 60_000;
const ytId = (u) => (String(u || "").match(/(?:v=|shorts\/|youtu\.be\/)([\w-]{6,})/) || [])[1] || null;

async function upGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${UP_API}${path}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Apikey ${getKey("upload_post")}` },
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(String(j.message || j.error || `HTTP ${res.status}`).slice(0, 200));
  return j;
}
const num = (v) => (typeof v === "number" ? v : null);

let upCache = { at: 0, result: null };
export async function fetchCuriosityHook(force = false) {
  if (!getKey("upload_post")) {
    return { configured: false, ok: false, error: "no Upload-Post key (keystore service upload_post)", posts: [], channel: null };
  }
  if (!force && upCache.result && Date.now() - upCache.at < UP_EVERY_MS) return upCache.result;
  try {
    const rows = [];
    for (let page = 1; page <= 5; page++) {
      const h = await upGet("/uploadposts/history", { page, limit: 50 });
      rows.push(...(h.history || []));
      if ((h.history || []).length < 50) break;
    }
    const live = rows.filter((r) => r.success && r.post_url && ["youtube", "facebook", "tiktok"].includes(r.platform));
    const posts = [];
    for (const r of live) {
      let m = {};
      try {
        const a = await upGet(`/uploadposts/post-analytics/${encodeURIComponent(r.request_id)}`);
        m = a.platforms?.[r.platform]?.post_metrics || {};
      } catch {
        /* analytics are a bonus: the post still shows with its link */
      }
      const yt = r.platform === "youtube" ? ytId(r.post_url) : null;
      posts.push({
        network: r.platform,
        account: "curiosity_hook",
        external_id: String(r.platform_post_id || r.request_id),
        permalink: r.post_url,
        caption: r.post_title || r.post_caption || null,
        media_type: r.platform === "youtube" ? "SHORT" : r.platform === "tiktok" ? "VIDEO" : "REEL",
        thumbnail_url: yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null,
        posted_at: toIso(r.upload_timestamp),
        metrics: { views: num(m.views), reach: null, likes: num(m.likes), comments: num(m.comments), saves: null, shares: num(m.shares) || null },
      });
    }
    // Upload-Post gives no FB thumbnail: the same video is on YouTube, so borrow its frame
    for (const p of posts) {
      if (!p.thumbnail_url) p.thumbnail_url = posts.find((q) => q.network === "youtube" && q.caption === p.caption)?.thumbnail_url || null;
    }
    // channel totals: YouTube subscribers, FB Page followers + 28-day reach
    const channel = { youtube: null, facebook: null };
    const profile = live[0]?.profile_username || "default";
    const fbPage = live.find((r) => r.facebook_page_id)?.facebook_page_id;
    try {
      const y = await upGet(`/analytics/${encodeURIComponent(profile)}`, { platforms: "youtube" });
      if (y.youtube && y.youtube.success !== false) channel.youtube = { followers: num(y.youtube.followers) };
    } catch { /* channel strip just omits it */ }
    if (fbPage) {
      try {
        const f = await upGet(`/analytics/${encodeURIComponent(profile)}`, { platforms: "facebook", page_id: fbPage });
        if (f.facebook && f.facebook.success !== false) {
          channel.facebook = { followers: num(f.facebook.followers), reach: num(f.facebook.reach), impressions: num(f.facebook.impressions) };
        }
      } catch { /* same */ }
    }
    const result = { configured: true, ok: true, error: null, posts, channel };
    upCache = { at: Date.now(), result };
    return result;
  } catch (e) {
    return { configured: true, ok: false, error: String(e.message || e).slice(0, 200), posts: [], channel: upCache.result?.channel || null };
  }
}

// ── persistence ──────────────────────────────────────────────────────────────
// `account` separates Curiosity Hook's FB Page from the Tedca Page (both "facebook").
try {
  db.exec("ALTER TABLE content_posts ADD COLUMN account TEXT");
} catch {
  /* column already exists */
}
const upsertPost = db.prepare(`
  INSERT INTO content_posts (id, network, external_id, permalink, caption, media_type, thumbnail_url, posted_at, first_seen, last_refreshed, account)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    permalink = excluded.permalink,
    caption = excluded.caption,
    media_type = excluded.media_type,
    thumbnail_url = excluded.thumbnail_url,
    posted_at = excluded.posted_at,
    last_refreshed = excluded.last_refreshed,
    account = excluded.account
`);
const latestSnap = db.prepare(
  "SELECT * FROM content_metrics WHERE post_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1"
);
const insertSnap = db.prepare(
  "INSERT INTO content_metrics (post_id, captured_at, views, reach, likes, comments, saves, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const METRIC_COLS = ["views", "reach", "likes", "comments", "saves", "shares"];

// Append a snapshot when any metric moved; when nothing moved, still lay down an
// hourly heartbeat row so the growth curve keeps an honest time axis without
// writing ~960 identical rows per post per day at the 90s cadence.
function recordSnapshot(postId, metrics, now) {
  const prev = latestSnap.get(postId);
  const changed = !prev || METRIC_COLS.some((c) => (prev[c] ?? null) !== (metrics[c] ?? null));
  const stale = prev && Date.now() - new Date(prev.captured_at).getTime() > 3600_000;
  if (!changed && !stale) return false;
  insertSnap.run(
    postId,
    now,
    metrics.views ?? null,
    metrics.reach ?? null,
    metrics.likes ?? null,
    metrics.comments ?? null,
    metrics.saves ?? null,
    metrics.shares ?? null
  );
  return true;
}

// Health of the last refresh, served with GET /api/content so the dashboard can
// show "updated Ns ago" + per-network status without hitting Meta on every poll.
let lastStatus = {
  refreshed_at: null,
  instagram: { configured: false, ok: false, error: "not refreshed yet" },
  facebook: { configured: false, ok: false, error: "not refreshed yet" },
  curiosity: { configured: false, ok: false, error: "not refreshed yet", channel: null },
};
export function contentStatus() {
  return lastStatus;
}

// Fetch both networks, upsert posts, append metric snapshots. A per-network
// failure lands in that network's {ok, error} — this function never throws for
// API trouble. In-flight guard: the 90s loop and a manual "Refresh now" click
// share one refresh instead of hammering the Graph API twice.
let inflight = null;
export function refreshContent(force = false) {
  if (inflight) return inflight;
  inflight = doRefresh(force).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(force = false) {
  const now = new Date().toISOString();
  const [ig, fb, ch] = await Promise.all([fetchInstagramPosts(), fetchFacebookVideos(), fetchCuriosityHook(force)]);
  let snapshots = 0;
  for (const p of [...ig.posts, ...fb.posts, ...ch.posts]) {
    const id = `${p.network}:${p.external_id}`;
    upsertPost.run(id, p.network, p.external_id, p.permalink, p.caption, p.media_type, p.thumbnail_url, p.posted_at, now, now, p.account || null);
    if (recordSnapshot(id, p.metrics, now)) snapshots++;
  }
  lastStatus = {
    refreshed_at: now,
    instagram: { configured: ig.configured, ok: ig.ok, error: ig.error },
    facebook: { configured: fb.configured, ok: fb.ok, error: fb.error },
    curiosity: { configured: ch.configured, ok: ch.ok, error: ch.error, channel: ch.channel },
  };
  return { ...lastStatus, posts_seen: ig.posts.length + fb.posts.length + ch.posts.length, snapshots_written: snapshots };
}

// ── background poll ──────────────────────────────────────────────────────────
// Meta offers NO webhook for like/view/reach counts, so polling every 90s is the
// only way to track a post's growth in near-real-time. Jitter (0–15s) keeps
// restarts from thundering against the API in lockstep; failures back the
// cadence off toward ~15 min and log ONCE per streak (not every 90s). A failed
// poll can never crash the process — the tick body is fully caught.
const POLL_MS = 90_000;
let loopStarted = false;
let failStreak = 0;
export function startContentLoop() {
  if (loopStarted) return;
  loopStarted = true;
  const tick = async () => {
    try {
      const s = await refreshContent();
      const igBad = s.instagram.configured && !s.instagram.ok;
      const fbBad = s.facebook.configured && !s.facebook.ok;
      const chBad = s.curiosity.configured && !s.curiosity.ok;
      if (igBad || fbBad || chBad) {
        failStreak++;
        if (failStreak === 1) {
          const parts = [];
          if (igBad) parts.push(`Instagram: ${s.instagram.error}`);
          if (fbBad) parts.push(`Facebook: ${s.facebook.error}`);
          if (chBad) parts.push(`Curiosity Hook: ${s.curiosity.error}`);
          logEvent({ actor: "system", message: `Content metrics refresh degraded — ${parts.join(" | ")}. Backing off, will keep retrying.`, level: "warn" });
        }
      } else if (failStreak) {
        failStreak = 0;
        logEvent({ actor: "system", message: "Content metrics refresh recovered — back to the 90s cadence.", level: "success" });
      }
    } catch (e) {
      failStreak++;
      if (failStreak === 1) {
        logEvent({ actor: "system", message: `Content metrics refresh failed: ${String(e.message || e).slice(0, 160)}`, level: "error" });
      }
    } finally {
      const delay = POLL_MS * (1 + Math.min(failStreak, 9)) + Math.floor(Math.random() * 15_000);
      setTimeout(tick, delay);
    }
  };
  // first refresh shortly after boot so the dashboard has data within seconds
  setTimeout(tick, 3_000 + Math.floor(Math.random() * 5_000));
}
