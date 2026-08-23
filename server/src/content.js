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

// ── persistence ──────────────────────────────────────────────────────────────
const upsertPost = db.prepare(`
  INSERT INTO content_posts (id, network, external_id, permalink, caption, media_type, thumbnail_url, posted_at, first_seen, last_refreshed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    permalink = excluded.permalink,
    caption = excluded.caption,
    media_type = excluded.media_type,
    thumbnail_url = excluded.thumbnail_url,
    posted_at = excluded.posted_at,
    last_refreshed = excluded.last_refreshed
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
};
export function contentStatus() {
  return lastStatus;
}

// Fetch both networks, upsert posts, append metric snapshots. A per-network
// failure lands in that network's {ok, error} — this function never throws for
// API trouble. In-flight guard: the 90s loop and a manual "Refresh now" click
// share one refresh instead of hammering the Graph API twice.
let inflight = null;
export function refreshContent() {
  if (inflight) return inflight;
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh() {
  const now = new Date().toISOString();
  const [ig, fb] = await Promise.all([fetchInstagramPosts(), fetchFacebookVideos()]);
  let snapshots = 0;
  for (const p of [...ig.posts, ...fb.posts]) {
    const id = `${p.network}:${p.external_id}`;
    upsertPost.run(id, p.network, p.external_id, p.permalink, p.caption, p.media_type, p.thumbnail_url, p.posted_at, now, now);
    if (recordSnapshot(id, p.metrics, now)) snapshots++;
  }
  lastStatus = {
    refreshed_at: now,
    instagram: { configured: ig.configured, ok: ig.ok, error: ig.error },
    facebook: { configured: fb.configured, ok: fb.ok, error: fb.error },
  };
  return { ...lastStatus, posts_seen: ig.posts.length + fb.posts.length, snapshots_written: snapshots };
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
      if (igBad || fbBad) {
        failStreak++;
        if (failStreak === 1) {
          const parts = [];
          if (igBad) parts.push(`Instagram: ${s.instagram.error}`);
          if (fbBad) parts.push(`Facebook: ${s.facebook.error}`);
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
