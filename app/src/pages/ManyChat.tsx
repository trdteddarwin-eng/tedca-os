import { useEffect, useState } from "react";
import { api } from "../api";

type KwRow = {
  row_n: number;
  keyword: string;
  link: string;
  message?: string;
  triggers?: string;
  active?: string;
  post_url?: string;
  match_type?: string;
  follow_gate?: string;
  gate_intro?: string;
  gate_nudge?: string;
  [k: string]: string | number | undefined; // future Sheet columns pass through untouched
};
type ActRow = { time: string; keyword: string; source: string; username: string; sender_id: string };
type Health = { ig: string; fb: string; token_days_left: number; token_est_expiry: string };
type Data = { header: string[]; rows: KwRow[]; activity: ActRow[]; health?: Health; warnings?: string[] };

const EMPTY = { keyword: "", link: "", message: "", triggers: "dm,comment", active: "TRUE", post_url: "", match_type: "word", follow_gate: "", gate_intro: "", gate_nudge: "" };

export default function ManyChat() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string>("");
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>("");

  const load = () =>
    api("/api/ig-keywords")
      .then((d) => { setData(d); setErr(""); })
      .catch((e) => setErr(String(e?.message || e)));

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      await api("/api/ig-keywords", { method: "POST", body: JSON.stringify(form) });
      setNotice(`"${form.keyword}" saved — live on the bot within ~30 seconds.`);
      setForm({ ...EMPTY });
      await load();
    } catch (e: any) {
      setNotice(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: KwRow) => {
    const next = (r.active || "TRUE").toUpperCase() === "FALSE" ? "TRUE" : "FALSE";
    await api("/api/ig-keywords", { method: "POST", body: JSON.stringify({ ...r, active: next }) });
    await load();
  };

  const remove = async (r: KwRow) => {
    if (!confirm(`Delete keyword "${r.keyword}"? The bot stops responding to it within ~30s.`)) return;
    await api(`/api/ig-keywords/${encodeURIComponent(r.keyword)}`, { method: "DELETE" });
    await load();
  };

  // carry EVERY sheet column through an edit (a save that dropped unknown columns once
  // wiped follow-gate settings — never let the OS be lossier than the Sheet)
  const edit = (r: KwRow) => {
    const all: Record<string, string> = { ...EMPTY };
    for (const [k, v] of Object.entries(r)) if (k !== "row_n" && v !== undefined) all[k] = String(v);
    setForm(all);
  };

  return (
    <div>
      <h2 className="font-display text-4xl">ManyChat <span className="text-paper/40 text-2xl italic">comment → DM bot</span></h2>
      <p className="text-paper/50 text-sm mt-2 max-w-2xl">
        Your self-built bot on @tedcaorg + your Facebook Page. Someone comments or DMs a keyword →
        it DMs them the link and replies "Sent you a DM 📩". Edits here write straight to the bot's
        Google Sheet — <span className="text-paper/80">live on Instagram within ~30 seconds.</span>
      </p>

      {err && <p className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/30 rounded p-3">{err}</p>}

      {/* health strip: webhooks + token countdown */}
      {data?.health && (
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[11px]">
          <span className={`px-2.5 py-1 rounded ${data.health.ig === "up" ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400"}`}>
            IG bot: {data.health.ig}
          </span>
          <span className={`px-2.5 py-1 rounded ${data.health.fb === "up" ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400"}`}>
            FB bot: {data.health.fb}
          </span>
          <span className={`px-2.5 py-1 rounded ${data.health.token_days_left > 21 ? "bg-paper/10 text-paper/60" : "bg-amber-400/15 text-amber-300"}`}>
            Meta token: ~{data.health.token_days_left} days left (est. {data.health.token_est_expiry})
          </span>
        </div>
      )}

      {/* IG token expiry warning + the ACTUAL refresh procedure. When the token dies the bot
          goes silent with no error anywhere — this is the single biggest operational risk. */}
      {data?.health && data.health.token_days_left <= 30 && (
        <div className={`mt-3 rounded border p-3.5 text-xs ${data.health.token_days_left <= 7
          ? "border-red-400/40 bg-red-400/10 text-red-200"
          : "border-amber-400/30 bg-amber-400/10 text-amber-200"}`}>
          <p className="font-bold text-sm">
            {data.health.token_days_left <= 0
              ? "🛑 Instagram token has EXPIRED — the bot is silent right now."
              : `⚠ Instagram token expires in ~${data.health.token_days_left} days (${data.health.token_est_expiry}).`}
          </p>
          <p className="mt-1.5 opacity-90">
            When it dies, comment→DM stops firing silently — no error, no alert. Facebook is unaffected (its Page token never expires).
          </p>

          <p className="mt-3 font-bold">Refresh it (takes ~2 minutes):</p>
          <ol className="mt-1 ml-4 list-decimal space-y-1.5 opacity-90">
            <li>
              Refresh in place — works while the token is still alive and at least 24h old. Extends ~60 more days:
              <code className="mt-1 block overflow-x-auto rounded bg-black/40 p-2 font-mono text-[10.5px]">
                curl -s "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&amp;access_token=&lt;CURRENT_TOKEN&gt;"
              </code>
            </li>
            <li>Copy the new <code className="font-mono">access_token</code> from the response.</li>
            <li>
              Update the Modal secret <code className="font-mono">ig-comment-dm</code> → set{" "}
              <code className="font-mono">IG_PAGE_ACCESS_TOKEN</code> to the new value.
            </li>
            <li>Come back here and press <b>“I refreshed it”</b> so this countdown resets.</li>
          </ol>
          <p className="mt-2 opacity-75">
            If it already lapsed past 60 days, refresh won’t work — mint a fresh long-lived token (ig-comment-dm/SETUP.md §10).
            Symptom of expiry: <code className="font-mono">modal app logs ig-comment-dm</code> shows Graph error 190.
          </p>

          <button
            onClick={async () => {
              await api("/api/ig-token-refreshed", { method: "POST" });
              load();
            }}
            className="mt-3 rounded bg-paper/15 px-3 py-1.5 text-xs font-bold hover:bg-paper/25"
          >
            I refreshed it — reset the 60-day clock
          </button>
        </div>
      )}
      {(data?.warnings || []).map((w, i) => (
        <p key={i} className="mt-3 text-xs text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded p-2.5">⚠ {w}</p>
      ))}

      {/* add / edit form */}
      <div className="mt-6 bg-panel border border-edge rounded-lg p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">Add or update a keyword</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-xs text-paper/60">keyword (what they comment)
            <input value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })}
              placeholder="DM" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono" />
          </label>
          <label className="text-xs text-paper/60">link (what the bot sends)
            <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })}
              placeholder="https://…" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono" />
          </label>
          <label className="text-xs text-paper/60 md:col-span-2">custom message (optional — {"{link}"} inserts the URL; blank = "Here you go 👉 link")
            <input value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Here's your guide 👉 {link}" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper" />
          </label>
          <label className="text-xs text-paper/60">fires on
            <select value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })}
              className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono">
              <option value="dm,comment">comments + DMs</option>
              <option value="comment">comments only</option>
              <option value="dm">DMs only</option>
            </select>
          </label>
          <label className="text-xs text-paper/60">lock to one reel (optional — paste the post URL; blank = every post + Facebook)
            <input value={form.post_url} onChange={(e) => setForm({ ...form, post_url: e.target.value })}
              placeholder="https://www.instagram.com/reel/…" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono" />
          </label>
          <label className="text-xs text-paper/60">follow gate (IG only — must follow @tedcaorg before the link; real API check)
            <select value={form.follow_gate || ""} onChange={(e) => setForm({ ...form, follow_gate: e.target.value })}
              className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper font-mono">
              <option value="">off — send link instantly</option>
              <option value="yes">on — require follow first</option>
            </select>
          </label>
          {form.follow_gate === "yes" && (
            <>
              <label className="text-xs text-paper/60">gate intro (optional — text on the first button card)
                <input value={form.gate_intro || ""} onChange={(e) => setForm({ ...form, gate_intro: e.target.value })}
                  placeholder="I got you! Tap below and I'll send it over 👇" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper" />
              </label>
              <label className="text-xs text-paper/60">gate nudge (optional — the "please follow" message)
                <input value={form.gate_nudge || ""} onChange={(e) => setForm({ ...form, gate_nudge: e.target.value })}
                  placeholder="This one's just for my followers — tap follow and hit the button again!" className="mt-1 w-full bg-ink border border-edge rounded px-3 py-2 text-sm text-paper" />
              </label>
            </>
          )}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={save} disabled={saving || !form.keyword || !form.link}
            className="bg-signal/90 hover:bg-signal text-ink font-semibold text-sm rounded px-5 py-2 disabled:opacity-40">
            {saving ? "Saving…" : "Save keyword"}
          </button>
          {notice && <span className="text-xs text-paper/60">{notice}</span>}
        </div>
      </div>

      {/* live keywords */}
      <div className="mt-6 bg-panel border border-edge rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50 text-left">
              <th className="p-3">Keyword</th>
              <th className="p-3">Sends</th>
              <th className="p-3">Fires on</th>
              <th className="p-3">Scope</th>
              <th className="p-3">Gate</th>
              <th className="p-3">Status</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => {
              const off = (r.active || "TRUE").toUpperCase() === "FALSE";
              return (
                <tr key={r.row_n} className="border-t border-edge/50">
                  <td className="p-3 font-mono font-semibold">{r.keyword}</td>
                  <td className="p-3 font-mono text-xs text-paper/70 max-w-[260px] truncate">{r.link}</td>
                  <td className="p-3 font-mono text-[11px] text-paper/60">{r.triggers || "dm,comment"}</td>
                  <td className="p-3 font-mono text-[11px] text-paper/60">{r.post_url ? "one reel" : "everywhere"}</td>
                  <td className="p-3 font-mono text-[11px]">
                    {String(r.follow_gate || "").toLowerCase() === "yes"
                      ? <span className="text-signal">🔒 follow first</span>
                      : <span className="text-paper/40">instant</span>}
                  </td>
                  <td className="p-3">
                    <button onClick={() => toggle(r)}
                      className={`font-mono text-[11px] px-2 py-0.5 rounded ${off ? "bg-paper/10 text-paper/50" : "bg-emerald-400/15 text-emerald-400"}`}>
                      {off ? "paused" : "live"}
                    </button>
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => edit(r)} className="font-mono text-[11px] text-paper/60 hover:text-paper mr-3">edit</button>
                    <button onClick={() => remove(r)} className="font-mono text-[11px] text-red-400/70 hover:text-red-400">delete</button>
                  </td>
                </tr>
              );
            })}
            {data && data.rows.length === 0 && (
              <tr><td className="p-4 text-paper/50" colSpan={7}>No keywords yet — add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* recent hits */}
      <div className="mt-6 bg-panel border border-edge rounded-lg p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-3">Recent hits (people the bot DM'd)</p>
        {(data?.activity || []).length === 0 && <p className="text-paper/40 text-sm">No hits logged yet.</p>}
        <div className="space-y-1.5">
          {(data?.activity || []).map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
              <span className="text-paper/40 w-40 shrink-0">{a.time}</span>
              <span className="bg-signal/15 text-signal px-2 py-0.5 rounded">{a.keyword}</span>
              <span className="text-paper/50">{a.source}</span>
              <span className="text-paper/80">@{a.username || a.sender_id}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
