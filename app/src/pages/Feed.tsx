// FEED LEADS — drop a lead file in, the engine takes it from there.
//
// Flow: drop / paste / Sheet link → PREVIEW (column mapping, dupes, credit cost)
// → Import. Nothing is inserted and no credit is spent until Import is clicked,
// which is the "ask before spending" gate. Below the feeder: every batch with its
// live progress, pausable, plus the queue runway.
import { useEffect, useRef, useState } from "react";
import { api, apiForm } from "../api";

const btnCls =
  "bg-signal text-paper rounded px-4 py-2.5 font-mono text-xs uppercase tracking-widest disabled:opacity-40 hover:opacity-90";
const btnGhost =
  "border border-edge rounded px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-paper/70 hover:text-paper hover:border-paper/40 disabled:opacity-40";
const inputCls =
  "w-full bg-ink border border-edge rounded px-3 py-2.5 font-mono text-xs text-paper placeholder:text-paper/30";

function Card({ title, tag, children, right }: { title: string; tag?: string; children: any; right?: any }) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          {tag && <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-1">{tag}</div>}
          <h2 className="font-display text-xl">{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Chip({ label, value, tone = "" }: { label: string; value: any; tone?: string }) {
  const color = tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-rose-400" : "text-paper";
  return (
    <div className="border border-edge rounded-lg px-3 py-2 bg-ink">
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40">{label}</div>
      <div className={`font-display text-2xl leading-tight ${color}`}>{value}</div>
    </div>
  );
}

type Preview = {
  token: string;
  source: string;
  filename: string | null;
  headers: string[];
  mapping: Record<string, string | null>;
  fields: string[];
  total: number;
  new: number;
  rejected: number;
  dupes: Record<string, number>;
  supplied: number;
  generic: number;
  need_lookup: number;
  valid_rate: number;
  est_credits: number;
  expected_sendable: number;
  sample: any[];
  niche_warnings: string[];
  credits_today: number;
  credits_budget: number;
};

type Batch = {
  id: number;
  name: string;
  source: string;
  niche: string;
  status: string;
  priority: number;
  created_at: string;
  skipped: Record<string, number>;
  counts: { fed: number; inserted: number; pending: number; ready: number; sent: number; replied: number; bounced: number; dead: number };
};

type Runway = { ready: number; pending: number; days: number; perDay: number; validRate: number; expected: number };

// Why a verify pass declined to run, in words Ted can act on.
const SKIP_REASON: Record<string, string> = {
  not_owner: "Another Tedca OS instance holds the send lock right now (it hands over within 90 seconds). Try again shortly.",
  send_disabled: "This instance is the dormant cloud mirror — it never verifies or sends.",
  disabled: "Verify-ahead is switched off in settings.",
  paused: "The engine is paused, so nothing is verifying.",
  run_in_progress: "A run is going right now and is already verifying — nothing to do.",
  busy: "A verify pass is already running.",
  no_credits_today: "AnyMailFinder reported no credits. Backing off for a few hours.",
  no_key: "No AnyMailFinder key is configured, so nothing can be verified.",
};

export default function Feed() {
  const [mode, setMode] = useState<"file" | "paste" | "sheet">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [pv, setPv] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [priority, setPriority] = useState(10);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [runway, setRunway] = useState<Runway | null>(null);
  const [credits, setCredits] = useState({ today: 0, budget: 0 });
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadBatches() {
    try {
      const r = await api("/api/batches");
      setBatches(r.batches || []);
      setRunway(r.queue || null);
      setCredits({ today: r.credits_today || 0, budget: r.credits_budget || 0 });
    } catch (e: any) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    loadBatches();
    const t = setInterval(loadBatches, 15000);
    return () => clearInterval(t);
  }, []);

  async function doPreview() {
    setErr("");
    setNote("");
    setBusy("preview");
    try {
      let r: Preview;
      if (mode === "file") {
        if (!file) throw new Error("Pick a CSV first.");
        const form = new FormData();
        form.append("file", file);
        r = await apiForm("/api/intake/preview", form);
      } else {
        r = await api("/api/intake/preview", {
          method: "POST",
          body: JSON.stringify(mode === "sheet" ? { sheet_url: sheetUrl } : { text }),
        });
      }
      setPv(r);
      setName(r.filename ? r.filename.replace(/\.[a-z]+$/i, "") : `Feed ${new Date().toISOString().slice(0, 10)}`);
    } catch (e: any) {
      setErr(e.message);
      setPv(null);
    } finally {
      setBusy("");
    }
  }

  async function remap(header: string, field: string) {
    if (!pv) return;
    const mapping = { ...pv.mapping, [header]: field || null };
    setBusy("remap");
    try {
      const r = await api("/api/intake/remap", { method: "POST", body: JSON.stringify({ token: pv.token, mapping }) });
      setPv(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function doImport() {
    if (!pv) return;
    setErr("");
    setBusy("import");
    try {
      const r = await api("/api/intake/commit", {
        method: "POST",
        body: JSON.stringify({ token: pv.token, name, niche, priority, mapping: pv.mapping }),
      });
      setNote(`Imported ${r.inserted} leads into "${r.batch.name}". The engine takes it from here.`);
      setPv(null);
      setFile(null);
      setText("");
      setSheetUrl("");
      loadBatches();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function verifyNow() {
    setErr("");
    setBusy("verify");
    setNote("");
    try {
      const r = await api("/api/intake/verify-now", { method: "POST" });
      if (r.skipped) setNote(SKIP_REASON[r.skipped] || `Verify pass skipped: ${String(r.skipped).replace(/_/g, " ")}.`);
      else if (!r.verified) setNote("Nothing to verify — every queued lead already has a verdict.");
      else setNote(`Verified ${r.verified}: ${r.ready} ready to send, ${r.dead} dead, ${r.errors} will retry. Spent ${r.spent} credits.`);
      loadBatches();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function patchBatch(id: number, patch: any) {
    try {
      await api(`/api/batches/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      loadBatches();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const dupeTotal = pv ? Object.values(pv.dupes).reduce((a, b) => a + b, 0) : 0;
  const runwayTone = !runway ? "" : runway.days < 1 ? "bad" : runway.days < 3 ? "warn" : "ok";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-display text-3xl">Feed Leads</h1>
        <p className="text-paper/60 text-sm mt-1">
          Drop a list in. The engine dedupes it, finds or verifies the owner email, sends at the daily rate, follows up, and watches replies.
        </p>
      </div>

      {runway && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Chip label="Ready to send" value={runway.ready} tone={runway.ready ? "ok" : "bad"} />
          <Chip label="Awaiting verify" value={runway.pending} />
          <Chip label="Runway" value={`${runway.days}d`} tone={runwayTone} />
          <Chip label="Verify credits today" value={`${credits.today}/${credits.budget}`} />
        </div>
      )}

      {err && <div className="border border-signal/50 bg-signal/10 text-paper rounded-lg px-4 py-3 text-sm">{err}</div>}
      {note && <div className="border border-emerald-500/40 bg-emerald-500/10 text-paper rounded-lg px-4 py-3 text-sm">{note}</div>}

      <Card
        title="New batch"
        tag="Intake"
        right={
          <div className="flex gap-1">
            {(["file", "paste", "sheet"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setPv(null); setErr(""); }}
                className={`px-3 py-1.5 rounded font-mono text-[10px] uppercase tracking-widest border ${mode === m ? "border-signal text-signal" : "border-edge text-paper/50 hover:text-paper"}`}
              >
                {m === "file" ? "CSV" : m}
              </button>
            ))}
          </div>
        }
      >
        {mode === "file" && (
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
            className={`block border border-dashed rounded-lg px-4 py-10 text-center cursor-pointer transition-colors ${dragging ? "border-signal bg-signal/5" : "border-edge hover:border-paper/30"}`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            {file ? (
              <div>
                <div className="font-mono text-sm text-paper">{file.name}</div>
                <div className="font-mono text-[11px] text-paper/40 mt-1">{(file.size / 1024).toFixed(0)} KB</div>
                <button
                  onClick={(e) => { e.preventDefault(); setFile(null); setPv(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="mt-3 font-mono text-[10px] uppercase tracking-widest text-paper/40 hover:text-signal"
                >
                  clear
                </button>
              </div>
            ) : (
              <div>
                <div className="font-mono text-sm text-paper/70">Drop a CSV here, or click to pick one</div>
                <div className="font-mono text-[11px] text-paper/35 mt-2">Any columns. Business name, website, or email is enough.</div>
              </div>
            )}
          </label>
        )}

        {mode === "paste" && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={"Paste rows from a spreadsheet, or one email / website per line:\n\nsmiledental.com\nbrightsmiles.com\ndr@familydental.com"}
            className={inputCls + " resize-y"}
          />
        )}

        {mode === "sheet" && (
          <div>
            <input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className={inputCls}
            />
            <p className="font-mono text-[11px] text-paper/40 mt-2">
              Share the sheet (Viewer is enough) with the OS service account first. If it can't open, the error will name the exact address.
            </p>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button onClick={doPreview} disabled={!!busy} className={btnCls}>
            {busy === "preview" ? "Reading…" : "Preview"}
          </button>
          <button onClick={verifyNow} disabled={!!busy} className={btnGhost}>
            {busy === "verify" ? "Verifying…" : "Verify queue now"}
          </button>
        </div>
      </Card>

      {pv && (
        <Card title="Check it before importing" tag={`${pv.source} · ${pv.total} rows`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <Chip label="New" value={pv.new} tone={pv.new ? "ok" : "bad"} />
            <Chip label="Duplicates" value={dupeTotal} tone={dupeTotal ? "warn" : ""} />
            <Chip label="Need lookup" value={pv.need_lookup} />
            <Chip label="Est. credits" value={`~${pv.est_credits}`} tone={pv.est_credits > pv.credits_budget ? "warn" : ""} />
          </div>

          <p className="text-sm text-paper/70 mb-5">
            {pv.supplied} came with an email address (verified for ~0.2 credits each). {pv.need_lookup} need an owner lookup
            (~2 credits per hit, {Math.round(pv.valid_rate * 100)}% hit rate lately). Expect roughly <b>{pv.expected_sendable}</b> sendable.
            {pv.generic > 0 && <> {pv.generic} are generic inbox addresses like info@ — allowed, but they reply less.</>}
            {pv.rejected > 0 && <> {pv.rejected} rows were unusable and were dropped.</>}
          </p>

          <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-2">Column mapping</div>
          <div className="bg-panel border border-edge rounded-lg overflow-x-auto mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
                  <th className="text-left px-3 py-2">Your column</th>
                  <th className="text-left px-3 py-2">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {pv.headers.map((h) => (
                  <tr key={h} className="border-t border-edge/50">
                    <td className="px-3 py-2 font-mono text-xs text-paper/80">{h || <i className="text-paper/30">(blank)</i>}</td>
                    <td className="px-3 py-2">
                      <select
                        value={pv.mapping[h] || ""}
                        onChange={(e) => remap(h, e.target.value)}
                        disabled={busy === "remap"}
                        className="bg-ink border border-edge rounded px-2 py-1 font-mono text-[11px] text-paper"
                      >
                        <option value="">— ignore —</option>
                        {pv.fields.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-2">First rows</div>
          <div className="bg-panel border border-edge rounded-lg overflow-x-auto mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
                  <th className="text-left px-3 py-2">Business</th>
                  <th className="text-left px-3 py-2">Website</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">City</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {pv.sample.map((r, i) => (
                  <tr key={i} className="border-t border-edge/50">
                    <td className="px-3 py-2">{r.business_name}</td>
                    <td className="px-3 py-2 text-paper/60 font-mono text-xs">{r.website}</td>
                    <td className="px-3 py-2 text-paper/60 font-mono text-xs">{r.email}</td>
                    <td className="px-3 py-2 text-paper/60">{r.city}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {r.verdict?.ok ? <span className="text-emerald-400">new</span> : <span className="text-paper/40">{r.verdict?.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid md:grid-cols-3 gap-3 mb-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-1">Batch name</div>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-1">Niche (optional)</div>
              <input value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="dentist" className={inputCls} />
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-paper/40 mb-1">Priority (lower goes first)</div>
              <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className={inputCls} />
            </div>
          </div>

          <button onClick={doImport} disabled={!!busy || !pv.new} className={btnCls}>
            {busy === "import" ? "Importing…" : `Import ${pv.new} leads`}
          </button>
          <span className="ml-3 font-mono text-[11px] text-paper/40">
            Credits are only spent when the engine verifies, not on import.
          </span>
        </Card>
      )}

      <Card title="Batches" tag={`${batches.length} fed`}>
        {!batches.length ? (
          <p className="text-paper/50 text-sm">Nothing fed yet. Drop a list above and it starts flowing on the next run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[11px] uppercase tracking-widest text-paper/50">
                  <th className="text-left px-3 py-2">Batch</th>
                  <th className="text-right px-3 py-2">Queued</th>
                  <th className="text-right px-3 py-2">Ready</th>
                  <th className="text-right px-3 py-2">Sent</th>
                  <th className="text-right px-3 py-2">Replied</th>
                  <th className="text-right px-3 py-2">Dead</th>
                  <th className="text-right px-3 py-2">Priority</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const c = b.counts;
                  const done = c.sent + c.dead;
                  const pct = c.inserted ? Math.round((done / c.inserted) * 100) : 0;
                  return (
                    <tr key={b.id} className="border-t border-edge/50 hover:bg-paper/5">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className={b.status === "active" ? "" : "text-paper/40"}>{b.name}</span>
                          {b.status !== "active" && (
                            <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400 border border-amber-400/40 rounded px-1.5 py-0.5">{b.status}</span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-paper/35 mt-1">
                          {b.source} · {b.created_at?.slice(0, 10)} · {c.inserted} of {c.fed} rows kept
                        </div>
                        <div className="mt-2 h-1 w-40 bg-ink rounded overflow-hidden">
                          <div className="h-full bg-signal" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs">{c.pending}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-emerald-400">{c.ready}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs">{c.sent}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-signal">{c.replied}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-paper/40">{c.dead}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-paper/50">{b.priority}</td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {b.status === "archived" ? null : b.status === "active" ? (
                          <button onClick={() => patchBatch(b.id, { status: "paused" })} className={btnGhost}>pause</button>
                        ) : (
                          <button onClick={() => patchBatch(b.id, { status: "active" })} className={btnGhost}>resume</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
