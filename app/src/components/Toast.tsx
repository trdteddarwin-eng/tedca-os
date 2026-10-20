import { useEffect, useRef, useState } from "react";
import { openFeed } from "../api";

type Toast = { id: number; title: string; body: string; tone: string };

// Which live-feed events surface as a pop-up. Sends + replies are the high-signal
// ones Ted asked to see; everything else stays in the Activity feed only.
function toastFor(e: any): { title: string; body: string; tone: string } | null {
  const actor = e.actor || e.agent;
  const msg = String(e.message || "");
  if (actor === "send" && /sent to|follow-?up sent|Replied to/i.test(msg))
    return { title: "📨 Email sent", body: msg, tone: "ok" };
  if (actor === "reply" && e.level === "success" && /replied!/i.test(msg))
    return { title: "🎉 New reply", body: msg, tone: "hot" };
  if (actor === "reply" && (e.level === "warn" || /flagged|bounce|opted out/i.test(msg)))
    return { title: "⚠️ Needs you", body: msg, tone: "warn" };
  if (actor === "intake" && e.level === "success") return { title: "🥣 Leads imported", body: msg, tone: "ok" };
  if (actor === "intake" && e.level === "warn") return { title: "⚠️ Queue running low", body: msg, tone: "warn" };
  return null;
}

export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(1);

  useEffect(() => {
    // ask once for native OS notifications (best-effort; in-app toast always shows)
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    const feed = openFeed((e) => {
      const t = toastFor(e);
      if (!t) return;
      const id = idRef.current++;
      setToasts((cur) => [...cur, { id, ...t }].slice(-4));
      setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 6500);
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification(t.title, { body: t.body.slice(0, 120) });
        } catch {
          /* ignore */
        }
      }
    });
    return () => feed.close();
  }, []);

  if (!toasts.length) return null;
  const toneClass: Record<string, string> = {
    ok: "border-emerald-400/40 bg-emerald-400/10",
    hot: "border-signal/50 bg-signal/15",
    warn: "border-amber-400/40 bg-amber-400/10",
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
          className={`cursor-pointer rounded-lg border px-4 py-3 backdrop-blur shadow-lg animate-[fadeIn_.2s_ease] ${toneClass[t.tone] || "border-edge bg-panel"}`}
        >
          <div className="font-mono text-[11px] uppercase tracking-wider text-paper/90">{t.title}</div>
          <div className="text-sm text-paper/70 mt-0.5 line-clamp-2">{t.body}</div>
        </div>
      ))}
    </div>
  );
}
