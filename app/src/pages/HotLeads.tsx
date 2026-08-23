import { useEffect, useRef, useState } from "react";
import { api, apiForm } from "../api";
import { fmtET, fmtAgo } from "../format";

type HotLead = {
  id: number;
  business_name: string;
  email: string | null;
  ceo_name: string | null;
  status: string;
  sentiment: string | null;
  inbox_used: string | null;
  last_touch_at: string | null;
  city: string | null;
  state: string | null;
  inbound_count: number;
  outbound_count: number;
  last_direction: "in" | "out" | null;
  last_at: string | null;
  snippet: string;
  awaiting_reply: boolean;
};

type ThreadEmail = {
  id: number;
  inbox: string | null;
  direction: "in" | "out";
  subject: string | null;
  body: string | null;
  kind: string | null;
  sent_at: string | null;
};

type Thread = {
  lead: { id: number; business_name: string; email: string | null; ceo_name: string | null; status: string };
  emails: ThreadEmail[];
  compose: { inbox: string | null; to: string | null; subject: string; can_reply: boolean; refusal: string | null };
};

export default function HotLeads() {
  const [leads, setLeads] = useState<HotLead[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [body, setBody] = useState("");
  const [aiWant, setAiWant] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = () =>
    api("/api/hot-leads")
      .then((d) => {
        setLeads(d);
        setLoaded(true);
      })
      .catch(() => {});

  const loadThread = (id: number) =>
    api(`/api/hot-leads/${id}/thread`)
      .then(setThread)
      .catch(() => {});

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 15000);
    return () => clearInterval(t);
  }, []);

  // load + live-refresh the open conversation (composer state lives separately,
  // so a background refresh never clobbers what Ted is typing)
  useEffect(() => {
    if (sel == null) {
      setThread(null);
      return;
    }
    setThread(null);
    setError("");
    setNotice("");
    setConfirming(false);
    loadThread(sel);
    const t = setInterval(() => loadThread(sel), 15000);
    return () => clearInterval(t);
  }, [sel]);

  // keep the newest message in view
  const msgCount = thread?.emails.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sel, msgCount]);

  // Two AI modes in one call: with an empty composer it WRITES from the instruction;
  // with text already in the composer it IMPROVES Ted's own draft per the instruction.
  const draft = async () => {
    if (sel == null || !aiWant.trim()) return;
    setDrafting(true);
    setError("");
    try {
      const r = await api(`/api/hot-leads/${sel}/draft`, {
        method: "POST",
        body: JSON.stringify({ instructions: aiWant.trim(), draft: body }),
      });
      setBody(r.draft || "");
    } catch (e: any) {
      setError(`AI draft failed (${e?.message || e}). Try again.`);
    } finally {
      setDrafting(false);
    }
  };

  const send = async () => {
    if (sel == null || (!body.trim() && !files.length)) return;
    setSending(true);
    setError("");
    try {
      const form = new FormData();
      form.append("body", body.trim());
      for (const f of files) form.append("files", f, f.name);
      const r = await apiForm(`/api/hot-leads/${sel}/reply`, form);
      setBody("");
      setAiWant("");
      setFiles([]);
      setConfirming(false);
      setNotice(`Sent from ${r.inbox} → ${r.to}${r.threaded ? " (same thread)" : ""}.`);
      await loadThread(sel);
      loadList();
    } catch (e: any) {
      setConfirming(false);
      setError(`Send failed (${e?.message || e}).`);
    } finally {
      setSending(false);
    }
  };

  const awaiting = leads.filter((l) => l.awaiting_reply).length;

  return (
    <div>
      <h2 className="font-display text-4xl">
        Hot Leads <span className="italic text-signal">{leads.length}</span>
      </h2>
      <p className="text-paper/50 text-sm mt-2">
        Every lead that wrote back — the full conversation, reply from the same inbox in the same
        thread, or let the AI draft it first.
        {awaiting > 0 && (
          <span className="text-emerald-400 font-semibold"> {awaiting} waiting on you.</span>
        )}
      </p>

      <div className="mt-5 flex flex-col md:flex-row gap-4 md:h-[calc(100vh-230px)] md:min-h-[420px]">
        {/* ── LEFT: conversation list ─────────────────────────────────────── */}
        <div
          className={`md:w-80 md:shrink-0 bg-panel border border-edge rounded-lg overflow-y-auto ${
            sel != null ? "hidden md:block" : ""
          }`}
        >
          {loaded && leads.length === 0 && (
            <p className="text-paper/50 text-sm p-5">
              No hot leads yet. When someone replies to a cold email, the whole conversation lands
              here.
            </p>
          )}
          {leads.map((l) => (
            <button
              key={l.id}
              onClick={() => setSel(l.id)}
              className={`w-full text-left p-4 border-b border-edge/50 hover:bg-ink/40 ${
                sel === l.id ? "bg-signal/10" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{l.business_name}</span>
                {l.awaiting_reply && (
                  <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/15 text-emerald-400">
                    your turn
                  </span>
                )}
              </div>
              <p className="font-mono text-[11px] text-paper/40 truncate mt-0.5">
                {l.ceo_name || l.email || "—"}
              </p>
              <p className="text-xs text-paper/60 mt-1 line-clamp-2">
                {l.last_direction === "in" ? "← " : "→ "}
                {l.snippet || "(no text)"}
              </p>
              <p className="font-mono text-[10px] text-paper/40 mt-1">{fmtAgo(l.last_at)}</p>
            </button>
          ))}
        </div>

        {/* ── RIGHT: thread + composer ────────────────────────────────────── */}
        <div
          className={`flex-1 min-w-0 bg-panel border border-edge rounded-lg flex-col ${
            sel == null ? "hidden md:flex" : "flex"
          }`}
        >
          {sel == null || !thread ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <p className="text-paper/40 text-sm font-mono">
                {sel == null ? "pick a conversation" : "loading…"}
              </p>
            </div>
          ) : (
            <>
              {/* header */}
              <div className="border-b border-edge px-4 py-3 flex items-center gap-3">
                <button
                  onClick={() => setSel(null)}
                  className="md:hidden font-mono text-xs text-paper/60 hover:text-paper shrink-0"
                >
                  ← back
                </button>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{thread.lead.business_name}</p>
                  <p className="font-mono text-[11px] text-paper/40 truncate">
                    {thread.compose.inbox || "?"} ↔ {thread.lead.email || "?"} ·{" "}
                    {thread.compose.subject}
                  </p>
                </div>
              </div>

              {/* messages */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[240px] max-h-[45vh] md:max-h-none"
              >
                {thread.emails.length === 0 && (
                  <p className="text-paper/40 text-sm">No messages recorded for this lead yet.</p>
                )}
                {thread.emails.map((e) => (
                  <div
                    key={e.id}
                    className={`flex ${e.direction === "out" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[88%] md:max-w-[72%] rounded-lg border px-4 py-3 ${
                        e.direction === "out"
                          ? "bg-signal/10 border-signal/30"
                          : "bg-ink/60 border-edge"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-paper/40">
                        <span className="truncate">
                          {e.direction === "in"
                            ? `← ${thread.lead.business_name}`
                            : `→ from ${e.inbox || "us"}`}
                        </span>
                        <span className="text-paper/30 shrink-0">{e.kind || ""}</span>
                      </div>
                      <pre className="mt-1.5 text-sm text-paper/85 whitespace-pre-wrap font-sans leading-relaxed break-words">
                        {e.body}
                      </pre>
                      <p className="font-mono text-[10px] text-paper/35 mt-1.5 text-right">
                        {fmtET(e.sent_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* composer */}
              <div className="border-t border-edge p-3 md:p-4">
                {!thread.compose.can_reply ? (
                  <p className="text-sm text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded p-3">
                    Can't reply here: {thread.compose.refusal}.
                  </p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <input
                        value={aiWant}
                        onChange={(e) => setAiWant(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && aiWant.trim() && !drafting) draft();
                        }}
                        placeholder='tell the AI: "yes we can do that, offer a call thursday" — or type your reply below, then "make this better"'
                        className="flex-1 min-w-0 bg-ink border border-edge rounded px-3 py-2 text-sm text-paper outline-none focus:border-signal"
                      />
                      <button
                        onClick={draft}
                        disabled={drafting || !aiWant.trim()}
                        className="shrink-0 font-mono text-[11px] uppercase tracking-widest px-3 py-2 rounded border border-edge text-paper/70 hover:text-paper hover:bg-ink disabled:opacity-40"
                      >
                        {drafting ? "drafting…" : "AI draft"}
                      </button>
                    </div>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={5}
                      placeholder={`Write the reply — it sends from ${thread.compose.inbox}…`}
                      className="mt-2 w-full bg-ink border border-edge rounded px-3 py-2.5 text-sm text-paper outline-none focus:border-signal leading-relaxed"
                    />
                    {/* attachments: picked files ride the same send, shown as removable chips */}
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const picked = Array.from(e.target.files || []);
                        if (picked.length) setFiles((cur) => [...cur, ...picked].slice(0, 5));
                        e.target.value = "";
                      }}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => fileRef.current?.click()}
                        className="font-mono text-[11px] uppercase tracking-widest px-3 py-1.5 rounded border border-edge text-paper/60 hover:text-paper hover:bg-ink"
                        title="attach files (max 5, 25MB each)"
                      >
                        + attach file
                      </button>
                      {files.map((f, i) => (
                        <span
                          key={`${f.name}-${i}`}
                          className="flex items-center gap-1.5 font-mono text-[11px] bg-ink border border-edge rounded px-2 py-1 text-paper/80"
                        >
                          {f.name}
                          <button
                            onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                            className="text-paper/40 hover:text-red-400"
                            title="remove"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                    {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
                    {notice && <p className="mt-2 text-sm text-emerald-400">{notice}</p>}
                    {confirming ? (
                      <div className="mt-2 bg-amber-400/10 border border-amber-400/30 rounded p-3">
                        <p className="text-sm text-paper/80">
                          Send this reply from{" "}
                          <span className="font-mono text-amber-300">{thread.compose.inbox}</span>{" "}
                          to{" "}
                          <span className="font-mono text-amber-300">{thread.compose.to}</span>?
                        </p>
                        <p className="font-mono text-[11px] text-paper/50 mt-1">
                          subject: {thread.compose.subject}
                        </p>
                        {files.length > 0 && (
                          <p className="font-mono text-[11px] text-paper/50 mt-1">
                            attaching: {files.map((f) => f.name).join(", ")}
                          </p>
                        )}
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={send}
                            disabled={sending}
                            className="bg-signal text-paper rounded px-4 py-2 font-mono text-[11px] uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
                          >
                            {sending ? "sending…" : "confirm send"}
                          </button>
                          <button
                            onClick={() => setConfirming(false)}
                            disabled={sending}
                            className="font-mono text-[11px] uppercase tracking-widest px-4 py-2 rounded border border-edge text-paper/60 hover:text-paper"
                          >
                            cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setNotice("");
                          setConfirming(true);
                        }}
                        disabled={!body.trim() && !files.length}
                        className="mt-2 bg-signal text-paper rounded px-4 py-2 font-mono text-[11px] uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
                      >
                        Send reply{files.length ? ` + ${files.length} file${files.length > 1 ? "s" : ""}` : ""}
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
