import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtET } from "../format";
import { ContentTabs } from "./Upcoming";

type NetHealth = { configured: boolean; ok: boolean; error: string | null };
type Post = {
  id: string;
  network: "instagram" | "facebook" | "youtube" | "tiktok";
  account: string | null; // "curiosity_hook" for the history-shorts channel
  external_id: string;
  permalink: string | null;
  caption: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
  posted_at: string | null;
  first_seen: string | null;
  last_refreshed: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  metrics_at: string | null;
};
type Channel = {
  youtube: { followers: number | null } | null;
  facebook: { followers: number | null; reach: number | null; impressions: number | null } | null;
};
type Data = {
  posts: Post[];
  refreshed_at: string | null;
  instagram: NetHealth;
  facebook: NetHealth;
  curiosity?: NetHealth & { channel: Channel | null };
};
type HistoryPoint = { captured_at: string; views: number | null };

const fmtNum = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M"
  : n >= 10_000 ? Math.round(n / 1000) + "k"
  : n >= 1000 ? (n / 1000).toFixed(1) + "k"
  : String(n);

// Embed URL per network. Instagram: shortcode from the permalink → /embed.
// Facebook: the official video plugin (works for Page videos without any SDK).
function embedUrl(p: Post): string | null {
  if (!p.permalink) return null;
  if (p.network === "youtube") {
    const m = p.permalink.match(/(?:v=|shorts\/|youtu\.be\/)([\w-]{6,})/);
    return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1` : null;
  }
  if (p.network === "instagram") {
    const m = p.permalink.match(/instagram\.com\/(reel|p|tv)\/([^/?#]+)/);
    return m ? `https://www.instagram.com/${m[1]}/${m[2]}/embed/` : null;
  }
  if (p.network === "tiktok") {
    const m = p.permalink.match(/\/video\/(\d+)/);
    return m ? `https://www.tiktok.com/player/v1/${m[1]}?autoplay=1` : null;
  }
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(p.permalink)}&show_text=false&autoplay=true`;
}

// Plain-SVG growth curve of views over time — no chart library.
function Sparkline({ points }: { points: HistoryPoint[] }) {
  const vals = points.filter((pt) => typeof pt.views === "number");
  if (vals.length < 2) {
    return <span className="font-mono text-[10px] text-paper/30">growth curve appears after a few refreshes</span>;
  }
  const w = 150, h = 34, pad = 3;
  const ts = vals.map((pt) => new Date(pt.captured_at).getTime());
  const vs = vals.map((pt) => pt.views as number);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - v0) / Math.max(1, v1 - v0)) * (h - 2 * pad);
  const d = vals.map((_, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(vs[i]).toFixed(1)}`).join(" ");
  return (
    <span className="flex items-center gap-2" title={`views: ${fmtNum(v0)} → ${fmtNum(v1)}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-signal">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x(ts[ts.length - 1])} cy={y(vs[vs.length - 1])} r="2" fill="currentColor" />
      </svg>
      <span className="font-mono text-[10px] text-paper/40">views {fmtNum(v0)}→{fmtNum(v1)}</span>
    </span>
  );
}

function Card({ post, history }: { post: Post; history: HistoryPoint[] }) {
  // Lazy embed: the iframe mounts on click only — a page of autoplaying IG/FB
  // embeds would grind the dashboard to a halt.
  const [playing, setPlaying] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const src = embedUrl(post);
  const ig = post.network === "instagram";
  const yt = post.network === "youtube";
  // omit any metric the network didn't return instead of showing a fake 0
  const metrics = (
    [
      ["views", post.views],
      ["likes", post.likes],
      ["comments", post.comments],
      ["reach", post.reach],
      ["saves", post.saves],
      ["shares", post.shares],
    ] as [string, number | null][]
  ).filter(([, v]) => typeof v === "number");

  return (
    <div className="bg-panel border border-edge rounded-lg overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className={`font-mono text-[10px] font-bold px-2 py-0.5 rounded ${ig ? "bg-fuchsia-400/15 text-fuchsia-300" : yt ? "bg-red-400/15 text-red-300" : post.network === "tiktok" ? "bg-white/10 text-white" : "bg-sky-400/15 text-sky-300"}`}>
          {ig ? "IG" : yt ? "YT" : post.network === "tiktok" ? "TT" : "FB"}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-paper/40">{post.media_type || "post"}</span>
        <span className="ml-auto font-mono text-[10px] text-paper/40">{fmtET(post.posted_at)}</span>
      </div>

      <div className="relative bg-ink h-80">
        {playing && src ? (
          <iframe
            src={src}
            title={post.id}
            className="w-full h-full"
            allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share"
            allowFullScreen
            frameBorder="0"
            scrolling="no"
          />
        ) : (
          <button onClick={() => src && setPlaying(true)} className="group w-full h-full relative" title={src ? "Play inline" : "No embed available"}>
            {post.thumbnail_url && !thumbBroken ? (
              <img src={post.thumbnail_url} alt="" onError={() => setThumbBroken(true)} className="w-full h-full object-cover opacity-80 group-hover:opacity-100" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-panel to-ink" />
            )}
            {src && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="w-14 h-14 rounded-full bg-ink/70 border border-paper/30 flex items-center justify-center group-hover:bg-signal/80 transition-colors">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-paper ml-0.5"><path d="M8 5.5v13l11-6.5z" /></svg>
                </span>
              </span>
            )}
          </button>
        )}
      </div>

      <div className="px-4 py-3 flex-1 flex flex-col gap-2.5">
        {post.caption && <p className="text-xs text-paper/70 leading-relaxed">{post.caption.length > 140 ? post.caption.slice(0, 140) + "…" : post.caption}</p>}
        <div className="flex flex-wrap gap-1.5">
          {metrics.map(([label, v]) => (
            <span key={label} className="font-mono text-[11px] bg-ink border border-edge rounded px-2 py-0.5">
              <span className="text-paper font-semibold">{fmtNum(v as number)}</span> <span className="text-paper/45">{label}</span>
            </span>
          ))}
          {metrics.length === 0 && <span className="font-mono text-[11px] text-paper/35">no metrics returned yet</span>}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2">
          <Sparkline points={history} />
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-paper/40 hover:text-signal shrink-0">
              open ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function HealthChip({ name, h }: { name: string; h?: NetHealth }) {
  if (!h) return null;
  const cls = !h.configured
    ? "bg-paper/10 text-paper/50"
    : h.ok ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400";
  return (
    <span className={`px-2.5 py-1 rounded ${cls}`} title={h.error || ""}>
      {name}: {!h.configured ? "not configured" : h.ok ? "live" : "error"}
    </span>
  );
}

// Curiosity Hook totals: summed from the latest snapshot of every post, plus the
// channel-level follower counts Upload-Post reads from each platform.
function ChannelStrip({ posts, channel }: { posts: Post[]; channel: Channel | null | undefined }) {
  const sum = (net: string | null, k: "views" | "likes" | "comments") =>
    posts.filter((p) => !net || p.network === net).reduce((a, p) => a + (p[k] || 0), 0);
  const tiles: [string, number | null | undefined, string?][] = [
    ["total views", sum(null, "views")],
    ["YouTube views", sum("youtube", "views")],
    ["Facebook views", sum("facebook", "views")],
    ["TikTok views", sum("tiktok", "views")],
    ["likes", sum(null, "likes")],
    ["comments", sum(null, "comments")],
    ["YT subscribers", channel?.youtube?.followers],
    ["FB followers", channel?.facebook?.followers],
    ["FB reach (28d)", channel?.facebook?.reach],
  ];
  return (
    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2">
      {tiles.map(([label, v]) => (
        <div key={label} className="bg-panel border border-edge rounded-lg px-3 py-2.5">
          <div className="font-display text-2xl text-paper">{typeof v === "number" ? fmtNum(v) : "–"}</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-paper/45 mt-0.5">{label}</div>
        </div>
      ))}
    </div>
  );
}

export default function ContentPosted() {
  const [data, setData] = useState<Data | null>(null);
  const [histories, setHistories] = useState<Record<string, HistoryPoint[]>>({});
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0); // re-render every 5s so "updated Ns ago" stays honest

  const load = () =>
    api("/api/content")
      .then(async (d: Data) => {
        setData(d);
        setErr("");
        // per-post growth history for the sparklines (served from SQLite — cheap)
        const entries = await Promise.all(
          d.posts.map((p) =>
            api(`/api/content/${encodeURIComponent(p.id)}/history`)
              .then((r) => [p.id, r.points as HistoryPoint[]] as const)
              .catch(() => [p.id, []] as const)
          )
        );
        setHistories(Object.fromEntries(entries));
      })
      .catch((e) => setErr(String(e?.message || e)));

  useEffect(() => {
    load();
    const poll = setInterval(load, 30000); // server refreshes from Meta every ~90s
    const tick = setInterval(() => setTick((t) => t + 1), 5000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await api("/api/content/refresh", { method: "POST" });
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setRefreshing(false);
    }
  };

  const chPosts = (data?.posts || []).filter((p) => p.account === "curiosity_hook");
  const tedcaPosts = (data?.posts || []).filter((p) => p.account !== "curiosity_hook");
  const agoS = data?.refreshed_at ? Math.max(0, Math.floor((Date.now() - new Date(data.refreshed_at).getTime()) / 1000)) : null;
  const netErrors = [
    data?.instagram?.configured && !data.instagram.ok ? `Instagram: ${data.instagram.error}` : null,
    data?.facebook?.configured && !data.facebook.ok ? `Facebook: ${data.facebook.error}` : null,
    data?.curiosity?.configured && !data.curiosity.ok ? `Curiosity Hook: ${data.curiosity.error}` : null,
  ].filter(Boolean) as string[];

  return (
    <div>
      <ContentTabs />
      <h2 className="font-display text-4xl">Content Posted <span className="text-paper/40 text-2xl italic">reels & videos, live numbers</span></h2>
      <p className="text-paper/50 text-sm mt-2 max-w-2xl">
        Everything published on Instagram, the Facebook Page and the Curiosity Hook channel, with views / likes / comments refreshed
        from Meta every ~90 seconds. Each snapshot is kept, so every card carries its own growth curve.
      </p>

      {err && <p className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/30 rounded p-3">{err}</p>}

      {/* health strip (ManyChat-style) */}
      <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <HealthChip name="IG metrics" h={data?.instagram} />
        <HealthChip name="FB metrics" h={data?.facebook} />
        <HealthChip name="Curiosity Hook" h={data?.curiosity} />
        <span className="px-2.5 py-1 rounded bg-paper/10 text-paper/60">
          {agoS === null ? "no refresh yet" : agoS < 60 ? `updated ${agoS}s ago` : `updated ${Math.floor(agoS / 60)}m ago`}
        </span>
        <button
          onClick={forceRefresh}
          disabled={refreshing}
          className="px-2.5 py-1 rounded bg-signal/15 text-signal hover:bg-signal/25 disabled:opacity-40"
        >
          {refreshing ? "refreshing…" : "↻ refresh now"}
        </button>
      </div>
      {netErrors.map((e, i) => (
        <p key={i} className="mt-2 text-xs text-red-300 bg-red-400/10 border border-red-400/30 rounded p-2.5 font-mono">⚠ {e}</p>
      ))}

      {/* the honest Facebook limitation — not a bug, a Meta permission gate */}
      <p className="mt-3 text-xs text-paper/45 bg-panel border border-edge rounded p-2.5 max-w-3xl">
        <span className="text-paper/70 font-semibold">Facebook coverage is videos only.</span> Reading the Page's
        non-video posts (<span className="font-mono">/posts</span>, <span className="font-mono">/feed</span>) and watch-time
        insights needs <span className="font-mono">pages_read_engagement</span> / <span className="font-mono">read_insights</span> Advanced
        Access via Meta App Review, which this app doesn't have. Videos with their view, like and comment counts are fully covered;
        Instagram is fully covered.
      </p>

      {/* Curiosity Hook: the daily history-shorts channel (YouTube + its own FB Page, via Upload-Post) */}
      {chPosts.length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-2xl">Curiosity Hook <span className="text-paper/40 text-base italic">YouTube Shorts + Facebook Reels, refreshed every 10 min</span></h3>
          <ChannelStrip posts={chPosts} channel={data?.curiosity?.channel} />
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {chPosts.map((p) => (
              <Card key={p.id} post={p} history={histories[p.id] || []} />
            ))}
          </div>
        </section>
      )}

      {/* Tedca IG + FB card grid, newest first */}
      {chPosts.length > 0 && tedcaPosts.length > 0 && <h3 className="mt-10 font-display text-2xl">Tedca <span className="text-paper/40 text-base italic">Instagram + Facebook Page</span></h3>}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tedcaPosts.map((p) => (
          <Card key={p.id} post={p} history={histories[p.id] || []} />
        ))}
      </div>
      {data && data.posts.length === 0 && (
        <p className="mt-6 text-paper/50 text-sm">
          Nothing tracked yet — the first refresh lands within ~90 seconds of the server starting (or hit "refresh now").
        </p>
      )}
    </div>
  );
}
