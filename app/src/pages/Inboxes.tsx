import { useEffect, useState } from "react";
import { api } from "../api";

type InboxStatus = { email: string; authorized: boolean; transport?: "gmail" | "smtp"; cap?: number; firstName?: string };
type Status = { configured: boolean; inboxes: InboxStatus[]; test_recipient: string | null };
type SendResult = { email: string; ok: boolean; id?: string; error?: string };

export default function Inboxes() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [error, setError] = useState("");

  function refresh() {
    api("/api/gmail/status").then(setStatus).catch(console.error);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // pick up authorizations as they complete
    return () => clearInterval(t);
  }, []);

  async function connect(email: string) {
    setError("");
    setBusy(email);
    try {
      const { authUrl } = await api("/api/gmail/auth", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      window.open(authUrl, "_blank");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function testSend() {
    setError("");
    setBusy("__send__");
    setResults(null);
    try {
      const r = await api("/api/gmail/test-send", { method: "POST", body: JSON.stringify({}) });
      setResults(r.results);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const ready = status?.inboxes.filter((i) => i.authorized).length ?? 0;

  return (
    <div>
      <h2 className="font-display text-4xl">
        Inboxes <span className="italic text-signal">{ready}/{status?.inboxes.length ?? 0} connected</span>
      </h2>

      {status && !status.configured && (
        <div className="mt-6 bg-panel border border-signal/40 rounded-lg p-5 text-sm text-paper/80">
          Gmail isn't configured yet. Fill <span className="font-mono">GMAIL_OAUTH_CLIENT_ID</span>,{" "}
          <span className="font-mono">GMAIL_OAUTH_CLIENT_SECRET</span> and{" "}
          <span className="font-mono">INBOXES</span> in <span className="font-mono">tedca-os/.env</span>,
          then restart the server.
        </div>
      )}

      {status?.configured && (
        <>
          <div className="mt-6 space-y-3">
            {status.inboxes.map((i) => (
              <div key={i.email} className="bg-panel border border-edge rounded-lg p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-sm">{i.email}</p>
                  <p className={`font-mono text-[11px] uppercase tracking-widest mt-1 ${i.authorized ? "text-emerald-400" : "text-paper/40"}`}>
                    {i.authorized ? "● connected" : "○ not connected"}
                    {i.transport === "smtp" && (
                      <span className="text-paper/40 normal-case tracking-normal"> · Zapmail SMTP · {i.cap}/day today</span>
                    )}
                  </p>
                </div>
                {i.transport === "smtp" ? (
                  <span className="font-mono text-[10px] uppercase tracking-widest text-paper/40 border border-edge rounded px-3 py-2 whitespace-nowrap">
                    app password
                  </span>
                ) : (
                  <button
                    onClick={() => connect(i.email)}
                    disabled={busy !== null}
                    className={`rounded px-4 py-2 font-mono text-xs uppercase tracking-widest disabled:opacity-40 ${
                      i.authorized
                        ? "border border-edge text-paper/60 hover:text-paper"
                        : "bg-signal text-paper hover:opacity-90"
                    }`}
                  >
                    {busy === i.email ? "…" : i.authorized ? "Reconnect" : "Connect"}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-8 bg-panel border border-edge rounded-lg p-5">
            <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">Test send</p>
            <p className="text-sm text-paper/70 mt-2">
              Sends one real test email from every connected inbox to{" "}
              <span className="font-mono">{status.test_recipient || "(set TEST_RECIPIENT in .env)"}</span>.
            </p>
            <button
              onClick={testSend}
              disabled={busy !== null || ready === 0 || !status.test_recipient}
              className="mt-4 bg-signal text-paper rounded px-4 py-2 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
            >
              {busy === "__send__" ? "Sending…" : `Send test from ${ready} inbox${ready === 1 ? "" : "es"}`}
            </button>
            {results && (
              <ul className="mt-4 space-y-1">
                {results.map((r) => (
                  <li key={r.email} className={`font-mono text-xs ${r.ok ? "text-emerald-400" : "text-signal"}`}>
                    {r.ok ? "✓" : "✗"} {r.email} {r.ok ? `(message ${r.id})` : `— ${r.error}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {error && <p className="text-signal font-mono text-sm mt-4">{error}</p>}

      <CopyEditor />
    </div>
  );
}

function CopyEditor() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api("/api/settings").then(setSettings).catch(console.error);
  }, []);

  async function save() {
    if (!settings) return;
    setErr("");
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          email_subject: settings.email_subject,
          email_body: settings.email_body,
          followup_body: settings.followup_body,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (!settings) return null;
  const field = (key: string, label: string, rows: number) => (
    <label className="block mt-4 font-mono text-[11px] uppercase tracking-widest text-paper/50">
      {label}
      <textarea
        rows={rows}
        value={settings[key] || ""}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
        className="w-full mt-1 bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper leading-relaxed"
      />
    </label>
  );

  return (
    <div className="mt-8 bg-panel border border-edge rounded-lg p-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
        Email copy · what the Courier sends
      </p>
      <p className="text-paper/50 text-xs mt-2">
        Merge fields: <span className="font-mono">{"{business_name} {first_name} {category} {rating} {review_count}"}</span>
      </p>
      {field("email_subject", "subject", 1)}
      {field("email_body", "first email", 10)}
      {field("followup_body", "the one follow-up", 4)}
      <button
        onClick={save}
        className="mt-4 bg-signal text-paper rounded px-4 py-2 font-mono text-xs uppercase tracking-widest hover:opacity-90"
      >
        {saved ? "Saved ✓" : "Save copy"}
      </button>
      {err && <p className="text-signal font-mono text-xs mt-2">{err}</p>}
    </div>
  );
}
