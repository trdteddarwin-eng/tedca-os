// Probe AI STUDIO (app.heygen.com/create-v4/...) — the editor Ted actually uses.
//
// Target controls, per his screenshot:
//   Script panel   — audio upload; shows the mp3 + a "Recorded voice" badge when set
//   Avatar & Voice — Avatar = "tedca"
//   Motion Engine  — MUST be "Avatar V" (the Presenter quick-bar defaults to Avatar IV)
//   Generate       — top bar, the credit spender
//
// SAFETY: never clicks Generate / Render Scene. Opening the editor creates a draft project,
// which is free.
//
// usage: node probe_studio.mjs [existingCreateV4Url]
import { chromium } from '/Users/yoljean/Downloads/Ted Workspace/linkedin-visuals/node_modules/playwright-core/index.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.homedir(), '.tedca', 'heygen-profile');
const OUT = path.join(__dirname, '_probe');
fs.mkdirSync(OUT, { recursive: true });

const FORBIDDEN = /generate|render scene|render|export|submit|delete|remove|upgrade|buy|purchase|subscribe/i;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1600, height: 1000 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

// The studio shell (Generate, Add scene) mounts well before the panels paint — a fixed delay
// captured a blank white page with 14 controls. Wait for content that only exists once the
// Avatar & Voice panel is actually rendered.
async function waitForEditor() {
  const ready = page.locator('text=/Motion Engine|Avatar & Voice/i').first();
  try {
    await ready.waitFor({ state: 'visible', timeout: 90000 });
    console.log('  [ready] editor panels painted');
  } catch {
    console.log('  [warn] editor panels never appeared within 90s — capturing whatever is there');
  }
  await page.waitForTimeout(2500);
}

async function snapshot(tag) {
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const controls = Array.from(
      document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=combobox], select, input, textarea, [contenteditable=true], [data-testid]')
    )
      .filter(vis)
      .slice(0, 500)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid') || '',
        aria: el.getAttribute('aria-label') || '',
        cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 60),
        text: (el.innerText || el.value || '').trim().slice(0, 50).replace(/\s+/g, ' '),
      }))
      .filter((c) => c.text || c.testid || c.aria);
    const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).map((el) => ({
      accept: el.getAttribute('accept') || '',
      testid: el.getAttribute('data-testid') || '',
      id: el.id || '',
      hidden: el.offsetParent === null,
    }));
    return { url: location.href, controls, fileInputs };
  });
  fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(data, null, 2));
  console.log(`\n=== ${tag}  ${data.url}`);
  console.log(`    ${data.controls.length} controls, ${data.fileInputs.length} file input(s)`);
  for (const f of data.fileInputs) console.log(`    FILE INPUT accept="${f.accept}" testid="${f.testid}" hidden=${f.hidden}`);
  const key = data.controls.filter((c) =>
    /avatar|motion|voice|upload|record|script|generate|scene|tedca/i.test(`${c.text} ${c.aria} ${c.testid}`)
  );
  if (key.length) {
    console.log('    key controls:');
    for (const c of key) console.log(`      ${c.tag} aria="${c.aria}" testid="${c.testid}" ${JSON.stringify(c.text)}`);
  }
  return data;
}

async function safeClick(desc, locator) {
  try {
    const el = locator.first();
    if (!(await el.count())) { console.log(`  [skip] ${desc} — not found`); return false; }
    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (FORBIDDEN.test(label)) { console.log(`  [BLOCKED] ${desc} — "${label}" spends or destroys`); return false; }
    await el.click({ timeout: 8000 });
    console.log(`  [click] ${desc}`);
    return true;
  } catch (e) {
    console.log(`  [fail] ${desc} — ${e.message.split('\n')[0]}`);
    return false;
  }
}

const existing = process.argv[2];
if (existing) {
  await page.goto(existing, { waitUntil: 'domcontentloaded' });
  await waitForEditor();
} else {
  await page.goto('https://app.heygen.com/home', { waitUntil: 'domcontentloaded' });
  // Wait for the nav to actually hydrate. domcontentloaded fires long before this SPA
  // attaches handlers, and a click that lands early is accepted and does nothing.
  await page.locator('[aria-label="Scene by scene"]').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  // "Scene by scene" is the AI Studio entry point (create-v4), unlike "Single scene"
  // which opens the Presenter quick-bar.
  await safeClick('Scene by scene', page.locator('[aria-label="Scene by scene"]'));
  // The studio is heavy; wait for the URL to actually turn into create-v4 rather than
  // guessing at a fixed delay.
  await page.waitForURL(/create-v4/, { timeout: 60000 }).catch(() => console.log('  (no create-v4 URL yet)'));
  await page.waitForTimeout(6000);
}
await snapshot('06-studio');

if (!/create-v4/.test(page.url())) {
  console.log('\nNOT in create-v4 yet. Whatever landed is captured in 06-studio.*');
  console.log('Re-run with an existing project URL to probe the editor directly:');
  console.log('  node probe_studio.mjs "https://app.heygen.com/create-v4/<id>?panel=scene"');
}

console.log('\nProbe done. Browser stays open 30s.');
await page.waitForTimeout(30000);
await ctx.close();
