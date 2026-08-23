// Drive HeyGen AI Studio: audio file in, rendered MP4 out.
//
// THE SPLIT (Ted's call, and it is the right one):
//   GENERATE through the browser  -> spends the subscription credits already paid for
//   FETCH through the API         -> POST /v3/videos is the billable call and we never touch it;
//                                    GET /v1/video.list and GET /v3/videos/{id} are free reads
//
// The join between the halves: the AI Studio project id in the create-v4 URL IS the API
// video_id. Verified against Ted's own draft (2dbc221a... appeared in /v1/video.list). So the
// browser captures the id, clicks Generate, and the API polls that same id to completion.
//
// SPENDING IS OPT-IN. Without --generate this sets the scene up completely and stops, leaving
// the browser open so a human can look before anything is charged. A 60s video is ~18 credits
// (Presenter bills 0.3 credits/sec); Ted's recent videos ran 11-76 credits each.
//
// usage:
//   node make_video.mjs --audio /path/vo.mp3                      # set up only, spends nothing
//   node make_video.mjs --audio /path/vo.mp3 --generate           # actually renders
//   node make_video.mjs --audio /path/vo.mp3 --generate --aspect 16:9 --out ~/Desktop
//   node make_video.mjs --project <create-v4 url> --audio x.mp3   # reuse an existing project
import { chromium } from '/Users/yoljean/Downloads/Ted Workspace/linkedin-visuals/node_modules/playwright-core/index.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.homedir(), '.tedca', 'heygen-profile');
const SHOTS = path.join(__dirname, '_runs');

// ---- args -------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(name);

const AUDIO = arg('--audio');
const PROJECT = arg('--project');
const ASPECT = arg('--aspect', '9:16');
const OUTDIR = arg('--out', path.join(__dirname, 'out'));
const DO_GENERATE = flag('--generate');
const AVATAR_NAME = arg('--avatar', 'tedca');
const ENGINE = arg('--engine', 'Avatar V');
const TITLE = arg('--title');

if (!AUDIO) {
  console.error('need --audio <file.mp3>');
  process.exit(1);
}
if (!fs.existsSync(AUDIO)) {
  console.error(`audio not found: ${AUDIO}`);
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const RUN = stamp();
let step = 0;

// ---- helpers ----------------------------------------------------------------------------
function heygenKey() {
  // Same hand-parse as tedca-videos/speed-to-lead/heygen_v8.py — the workspace .env is not
  // strictly dotenv-parseable, so do not swap this for a library.
  const env = fs.readFileSync(path.join(WS, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    if (line.startsWith('HEYGEN_API_KEY=')) return line.split('=')[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('HEYGEN_API_KEY missing from .env');
}

async function api(pathname) {
  const res = await fetch('https://api.heygen.com' + pathname, {
    headers: { 'x-api-key': heygenKey(), accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HeyGen API ${res.status} on ${pathname}`);
  return res.json();
}

// Set once this run creates its OWN draft. Cleanup only ever touches this id, so a run given
// an existing --project can never delete something it did not make.
let createdDraftId = null;
let generated = false;

// Delete the throwaway draft a FAILED run left behind. Deliberately narrow: only a draft this
// run created, only before Generate succeeded, and any error here is swallowed — failing to
// tidy up must never mask the real failure.
async function cleanupDraft() {
  if (!createdDraftId || generated) return;
  for (const [method, url] of [
    ['POST', `https://api.heygen.com/v1/video.delete?video_id=${createdDraftId}`],
    ['DELETE', `https://api.heygen.com/v1/video/${createdDraftId}`],
  ]) {
    try {
      const res = await fetch(url, { method, headers: { 'x-api-key': heygenKey(), accept: 'application/json' } });
      if (res.ok) { console.log(`  [cleanup] deleted draft ${createdDraftId}`); return; }
    } catch {}
  }
  console.log(`  [cleanup] could not delete draft ${createdDraftId} — remove it by hand if it bothers you`);
}

// Every failure gets a screenshot. A UI driver that dies without one is untriageable.
async function die(page, why) {
  const p = path.join(SHOTS, `${RUN}-FAIL-${String(++step).padStart(2, '0')}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); } catch {}
  await cleanupDraft();
  throw new Error(`${why}\n  screenshot: ${p}`);
}
async function shot(page, tag) {
  const p = path.join(SHOTS, `${RUN}-${String(++step).padStart(2, '0')}-${tag}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

// ---- browser ----------------------------------------------------------------------------
if (!fs.existsSync(PROFILE)) {
  console.error('No saved HeyGen session. Run:  node login.mjs');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false, // headed: HeyGen's editor is canvas-heavy and behaves better with a real window
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.setDefaultTimeout(45000);

console.log(`\nHeyGen run ${RUN}`);
console.log(`  audio   ${AUDIO}`);
console.log(`  aspect  ${ASPECT}`);
console.log(`  engine  ${ENGINE}`);
console.log(`  spend   ${DO_GENERATE ? 'YES — will click Generate' : 'no (set-up only; pass --generate to render)'}`);

// 1. Get into an AI Studio project ------------------------------------------------------
if (PROJECT) {
  await page.goto(PROJECT, { waitUntil: 'domcontentloaded' });
} else {
  // "?page=studio" is SPA state, not a real route — loading it directly lands back on Home.
  // So the sidebar click is genuinely required. Two things make it flaky: this app hydrates
  // slowly after a cold Chrome start, and the sidebar can be left collapsed by a previous run
  // (HeyGen remembers that per profile). Handle both rather than just waiting longer.
  await page.goto('https://app.heygen.com/home', { waitUntil: 'domcontentloaded' });
  const sceneBtn = page.locator('[aria-label="Scene by scene"]').first();
  try {
    await sceneBtn.waitFor({ state: 'visible', timeout: 60000 });
  } catch {
    console.log('  sidebar item not visible — expanding the nav and retrying');
    await page.locator('[aria-label="Toggle navigation"], [aria-label="Collapse navigation"]').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await sceneBtn
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => die(page, 'never found "Scene by scene" in the sidebar, collapsed or expanded'));
  }
  await page.waitForTimeout(1200);
  await clickOrDie('Scene by scene', sceneBtn);
  // AI Studio landing -> the "New video" card opens a fresh create-v4 project.
  // "New video" is the CAPTION UNDER the card, not the click target — clicking it only focuses
  // the tile (dashed outline, no navigation). The clickable area is the big "+" tile above the
  // caption, so click by geometry relative to the label.
  const label = page.locator('text=/^New video$/i').first();
  await label
    .waitFor({ state: 'visible', timeout: 45000 })
    .catch(() => die(page, 'AI Studio landing never showed a "New video" card'));
  const box = await label.boundingBox();
  if (!box) await die(page, 'found the "New video" caption but it has no box');
  await page.mouse.click(box.x + box.width / 2, box.y - 120);
  // Confirm we actually navigated; if the geometry click missed, say so instead of timing out
  // 90s later on a panel that was never going to appear.
  await page.waitForURL(/create-v4/, { timeout: 45000 }).catch(async () => {
    await die(page, 'clicked the New video tile but never navigated to create-v4');
  });
}

// The shell mounts long before the panels paint — gate on panel content, never a fixed delay.
// Reusable because several actions (notably the aspect toggle) REMOUNT the whole editor: the
// app drops to a logo splash and rebuilds, so anything found before is stale afterwards.
async function waitForEditorReady(why) {
  const ready = page.locator('text=/Motion Engine|Avatar & Voice/i').first();
  await ready
    .waitFor({ state: 'visible', timeout: 90000 })
    .catch(() => die(page, `editor panels never painted (${why})`));
  // VISIBLE IS NOT CLICKABLE. HeyGen paints the panels underneath a fixed loading veil
  // (DraftLoadingPrism), so every click silently retries for 45s against the overlay and then
  // times out. Wait for the veil to actually detach before touching anything.
  await page
    .locator('[data-pacific-component="DraftLoadingPrism"]')
    .waitFor({ state: 'detached', timeout: 90000 })
    .catch(() => die(page, `loading overlay never cleared (${why})`));
  await page.waitForTimeout(2000);
}

// Any click can hang against an unexpected overlay; make sure that dies WITH a screenshot
// instead of a bare Playwright TimeoutError.
async function clickOrDie(desc, locator, opts = {}) {
  try {
    await locator.click({ timeout: 20000, ...opts });
  } catch (e) {
    await die(page, `click failed: ${desc} — ${e.message.split('\n')[0]}`);
  }
}
await waitForEditorReady('initial load');

// A NEW project sits at /create-v4/draft and only gets its hex id once HeyGen autosaves
// (which the audio upload triggers). So accept "draft" here and resolve the real id later.
if (!/create-v4\//.test(page.url())) await die(page, `not in the studio editor — url is ${page.url()}`);
let projectId = (page.url().match(/create-v4\/([a-f0-9]{16,})/i) || [])[1] || null;
console.log(`\n  project ${projectId || '(unsaved draft — id assigned on autosave)'}`);
await shot(page, 'editor-open');

// Epoch at run start, so the API fallback can identify "the video this run just made" by
// created_at rather than guessing at ordering.
const runStartedAt = Math.floor(Date.now() / 1000) - 60;

async function resolveProjectId() {
  if (projectId) return projectId;
  const fromUrl = (page.url().match(/create-v4\/([a-f0-9]{16,})/i) || [])[1];
  if (fromUrl) {
    projectId = fromUrl;
    // Only a project THIS run created is ever eligible for cleanup.
    if (!PROJECT) createdDraftId = fromUrl;
    return projectId;
  }
  return null;
}

// 2. Aspect ratio -------------------------------------------------------------------------
const aspectLabel = ASPECT === '16:9' ? 'Landscape (16:9)' : 'Portrait (9:16)';
const aspectBtn = page.locator(`[aria-label="${aspectLabel}"]`).first();
if (await aspectBtn.count()) {
  await aspectBtn.click().catch(() => {});
  console.log(`  aspect set ${ASPECT} — editor remounts, waiting for it to come back`);
  // Switching aspect tears the editor down to a splash screen and rebuilds it. Without this
  // re-wait, the very next lookup (Motion Engine) searches a page that is still blank.
  await page.waitForTimeout(3000);
  await waitForEditorReady('after aspect switch');
}

// 3. Motion Engine MUST be Avatar V -------------------------------------------------------
// This is the setting that silently regresses: the Presenter quick-bar defaults to Avatar IV,
// and a wrong engine is only visible after paying to render. Verify by reading the control.
const engineBtn = page.locator('button', { hasText: /^Avatar (IV|V|III)$/ }).first();
if (!(await engineBtn.count())) await die(page, 'Motion Engine control not found');
let engineNow = (await engineBtn.innerText()).trim();
if (engineNow !== ENGINE) {
  console.log(`  engine is "${engineNow}" — switching to "${ENGINE}"`);
  await clickOrDie('Motion Engine dropdown', engineBtn);
  await page.waitForTimeout(1500);
  const opt = page.locator(`[role=option]:has-text("${ENGINE}"), li:has-text("${ENGINE}"), div[role=menuitem]:has-text("${ENGINE}")`).first();
  if (!(await opt.count())) await die(page, `engine dropdown opened but no "${ENGINE}" option found`);
  await clickOrDie(`"${ENGINE}" option`, opt);
  await page.waitForTimeout(2000);
  engineNow = (await engineBtn.innerText()).trim();
}
if (engineNow !== ENGINE) await die(page, `engine is "${engineNow}", expected "${ENGINE}"`);
console.log(`  engine verified: ${engineNow}`);

// 4. Upload the audio ----------------------------------------------------------------------
// The real <input type=file> is mounted on demand, so race a filechooser against clicking each
// plausible affordance. The mic button sits next to "Add scene" in the Script panel.
// The Script panel of an EMPTY scene shows a labelled "Upload audio" button. (Earlier guesses
// at a mic icon were wrong — the mic next to "Add scene" is record-voice, not file upload.)
// Note this button only exists while the script is empty; on a scene that already has audio the
// control becomes the "Recorded voice" swap chip instead.
const uploadCandidates = [
  ['Upload audio button', () => page.locator('button:has-text("Upload audio")').first()],
  ['Recorded voice swap chip', () => page.locator('button:has-text("Recorded voice")').first()],
  ['upload/record link', () => page.locator('text=/upload\\/record/i').first()],
];

let uploaded = false;
for (const [desc, mk] of uploadCandidates) {
  const el = mk();
  if (!(await el.count().catch(() => 0))) { console.log(`  [skip] ${desc}`); continue; }
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      el.click({ timeout: 10000 }),
    ]);
    await chooser.setFiles(AUDIO);
    console.log(`  [upload] via ${desc}`);
    uploaded = true;
    break;
  } catch (e) {
    console.log(`  [miss] ${desc} — ${e.message.split('\n')[0]}`);
    // Some flows open a modal with a dropzone instead of firing a native chooser. If a real
    // audio file input got mounted, feed it directly rather than giving up.
    // Exclude the bulk-create spreadsheet inputs by ATTRIBUTE. (`filter({hasNot})` matches on
    // descendants, and an <input> has none — using it here silently matched the .csv input and
    // would have fed an mp3 to the wrong field.)
    const audioInput = page.locator('input[type=file][accept*="audio"], input[type=file][accept*="mp3"], input[type=file][accept*="mpeg"]').first();
    const anyInput = page
      .locator('input[type=file]:not([accept*="csv"]):not([accept*="xls"]):not([accept*="txt"])')
      .first();
    const target = (await audioInput.count()) ? audioInput : (await anyInput.count()) ? anyInput : null;
    if (target) {
      try {
        await target.setInputFiles(AUDIO);
        console.log(`  [upload] via mounted file input after ${desc}`);
        uploaded = true;
        break;
      } catch (e2) {
        console.log(`  [miss] mounted input — ${e2.message.split('\n')[0]}`);
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }
}
if (!uploaded) await die(page, 'could not open a file chooser for the audio upload');

// Picking the file does NOT attach it. HeyGen opens a "Confirm Audio" dialog showing the
// filename and duration, with a Voice Mirroring toggle, and the audio is only attached once
// "Add audio" is clicked. Leave Voice Mirroring at its default — it changes how the avatar
// treats the source voice, and nobody asked for that.
const confirmBtn = page.locator('button:has-text("Add audio")').first();
await confirmBtn
  .waitFor({ state: 'visible', timeout: 45000 })
  .catch(() => die(page, 'file was accepted but the "Confirm Audio" dialog never appeared'));
const dur = await page.locator('text=/\\d{2}:\\d{2}s? \\/ \\d{2}:\\d{2}s?/').first().innerText().catch(() => '');
console.log(`  [confirm] dialog shows ${dur || '(duration not read)'} — clicking "Add audio"`);
await clickOrDie('Add audio', confirmBtn);
await page.waitForTimeout(3000);

// Verify the upload actually took. "Recorded voice" is the badge HeyGen shows when a scene is
// driven by uploaded audio instead of TTS — that badge IS the proof the voice was overridden.
const base = path.basename(AUDIO);
const proof = page.locator(`text=/Recorded voice/i`).first();
await proof.waitFor({ state: 'visible', timeout: 90000 }).catch(() => die(page, `uploaded ${base} but the "Recorded voice" badge never appeared — audio may not have attached`));
console.log(`  [verified] "Recorded voice" badge present — TTS is overridden`);
await page.waitForTimeout(2500);
// The upload triggers an autosave, which is when a fresh draft earns its hex id.
for (let i = 0; i < 10 && !(await resolveProjectId()); i++) await page.waitForTimeout(3000);
console.log(`  project id: ${projectId || 'still unsaved — will resolve via API after Generate'}`);
await shot(page, 'audio-attached');

// 5. Generate (only with explicit opt-in) --------------------------------------------------
if (!DO_GENERATE) {
  console.log('\n  STOPPING before Generate. Nothing was charged.');
  console.log('  Look at the browser, then re-run with --generate to render.');
  console.log(`  project url: ${page.url()}`);
  await page.waitForTimeout(120000);
  await ctx.close();
  process.exit(0);
}

const genBtn = page.locator('button:has-text("Generate")').first();
if (!(await genBtn.count())) await die(page, 'Generate button not found');
await genBtn.click();
console.log('\n  [generate] opened the Generate Video dialog');
await page.waitForTimeout(3000);
await shot(page, 'generate-dialog');

// "Generate" only OPENS a dialog (Title / Resolution / Format / Save to / Watermark). Nothing
// renders until Submit. Skipping this left the project sitting at status=pending for 29 minutes
// while the poller waited for a render that had never been queued.
const submitBtn = page.locator('button:has-text("Submit")').first();
await submitBtn
  .waitFor({ state: 'visible', timeout: 30000 })
  .catch(() => die(page, 'clicked Generate but the Generate Video dialog never appeared'));

// Give the render a real name instead of "Untitled Video", so Projects stays readable.
if (TITLE) {
  const titleInput = page.locator('input[value="Untitled Video"], input[placeholder*="itle"]').first();
  if (await titleInput.count()) {
    await titleInput.fill(TITLE).catch(() => {});
    console.log(`  title set: ${TITLE}`);
  }
}

await clickOrDie('Submit', submitBtn);
generated = true; // ONLY now is a render actually queued and credits committed
console.log('  [SUBMIT] clicked — render queued, credits committed');
await page.waitForTimeout(8000);
await shot(page, 'submitted');

// Generate always persists the project, so the hex id should be in the URL by now.
for (let i = 0; i < 10 && !(await resolveProjectId()); i++) await page.waitForTimeout(3000);
await ctx.close();

if (!projectId) {
  // Last resort: the newest video created since this run started. Safe because we just made
  // one, and created_at is a real field on /v1/video.list.
  console.log('  id not in the URL — resolving via /v1/video.list');
  const r = await api('/v1/video.list?limit=10');
  const vids = ((r.data || {}).videos || []).filter((v) => (v.created_at || 0) >= runStartedAt);
  vids.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!vids.length) throw new Error('Generate was clicked but no new video appeared in the API list');
  projectId = vids[0].video_id;
  console.log(`  resolved ${projectId}`);
}

// 6. Fetch through the API (free reads) ----------------------------------------------------
console.log(`\n  polling API for ${projectId}`);
const deadline = Date.now() + 30 * 60 * 1000;
let videoUrl = null;
let thumbUrl = null;
let durationS = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15000));
  let status = null;
  let d = null;
  try {
    const r = await api(`/v3/videos/${projectId}`);
    d = r.data || r;
    status = d.status;
  } catch {
    // fall back to the list endpoint if the per-id read is not available for UI-made videos
    const r = await api('/v1/video.list?limit=10');
    const vids = (r.data || {}).videos || [];
    d = vids.find((v) => v.video_id === projectId);
    status = d && d.status;
  }
  console.log(`    status=${status}`);
  if (status === 'completed') {
    videoUrl = (d && d.video_url) || null;
    thumbUrl = (d && d.thumbnail_url) || null;
    durationS = (d && d.duration) || null;
    break;
  }
  if (status === 'failed') throw new Error(`render failed: ${JSON.stringify(d).slice(0, 300)}`);
}
if (!videoUrl) {
  console.log('\n  Render did not report completed within 30 min, or the list endpoint does not');
  console.log('  expose a download url for UI-made videos. Check Projects in the browser.');
  process.exit(1);
}

const outFile = path.join(OUTDIR, `heygen_${projectId}.mp4`);
const res = await fetch(videoUrl);
fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
console.log(`\nDONE: ${outFile}  (${fs.statSync(outFile).size.toLocaleString()} bytes)`);

// Thumbnail comes free from the same API read — no extra render, no extra credit.
let thumbFile = null;
if (thumbUrl) {
  try {
    thumbFile = path.join(OUTDIR, `heygen_${projectId}.jpg`);
    const t = await fetch(thumbUrl);
    fs.writeFileSync(thumbFile, Buffer.from(await t.arrayBuffer()));
    console.log(`THUMB: ${thumbFile}`);
  } catch (e) {
    thumbFile = null;
    console.log(`  (thumbnail fetch failed: ${e.message})`);
  }
}

// Structured handoff so an orchestrator does not have to scrape stdout.
const RESULT = arg('--result');
if (RESULT) {
  fs.writeFileSync(
    RESULT,
    JSON.stringify({ projectId, file: outFile, thumb: thumbFile, videoUrl, thumbUrl, duration: durationS }, null, 2)
  );
  console.log(`RESULT: ${RESULT}`);
}
