// Walk into the Single-scene editor and find the "use my own audio" path.
//
// SAFETY: this clicks navigation and panel-opening controls ONLY. It never clicks Submit /
// Generate / Export, so it cannot spend a credit. Entering the editor may leave an untitled
// DRAFT in Projects (HeyGen does that on its own); that is free and deletable.
//
// usage: node probe_editor.mjs
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

// Anything matching this is a credit-spender or a destructive action. Never click it.
const FORBIDDEN = /submit|generate|export|render|create video|delete|remove|upgrade|buy|purchase|subscribe/i;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

async function snapshot(tag) {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const controls = Array.from(
      document.querySelectorAll('button, a[href], [role=button], [role=tab], input, textarea, [contenteditable=true], [data-testid]')
    )
      .filter(vis)
      .slice(0, 400)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid') || '',
        aria: el.getAttribute('aria-label') || '',
        href: (el.getAttribute('href') || '').slice(0, 60),
        text: (el.innerText || el.value || '').trim().slice(0, 50).replace(/\s+/g, ' '),
      }))
      .filter((c) => c.text || c.testid || c.aria);
    // hidden file inputs matter most: that is where an mp3 actually goes
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
  const interesting = data.controls.filter((c) =>
    /audio|voice|upload|mic|sound|my own|import/i.test(`${c.text} ${c.aria} ${c.testid}`)
  );
  if (interesting.length) {
    console.log('    voice/audio-ish controls:');
    for (const c of interesting) console.log(`      ${c.tag} aria="${c.aria}" testid="${c.testid}" ${JSON.stringify(c.text)}`);
  }
  return data;
}

async function safeClick(desc, locator) {
  try {
    const el = locator.first();
    if (!(await el.count())) { console.log(`  [skip] ${desc} — not found`); return false; }
    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (FORBIDDEN.test(label)) { console.log(`  [BLOCKED] ${desc} — label "${label}" looks like it spends/destroys`); return false; }
    await el.click({ timeout: 8000 });
    console.log(`  [click] ${desc}`);
    return true;
  } catch (e) {
    console.log(`  [fail] ${desc} — ${e.message.split('\n')[0]}`);
    return false;
  }
}

await page.goto('https://app.heygen.com/home', { waitUntil: 'domcontentloaded' });
await snapshot('02-home');

// Single scene = one avatar talking. That is the shape of an avatar VO video.
await safeClick('Single scene', page.locator('[aria-label="Single scene"]'));
await page.waitForTimeout(5000);
const editor = await snapshot('03-single-scene');

// "Single scene" lands on a mode chooser, not the editor. Presenter (Avatar V, 0.3 credits/sec)
// is the talking-head mode; Cinematic (Seedance, 60 credits, 15s max) is a different product.
// "Start with a script" only OPENS the editor — it does not render anything.
await safeClick('Start with a script (Presenter)', page.locator('button:has-text("Start with a script")'));
await page.waitForTimeout(8000);
await snapshot('04-presenter-editor');

// The audio-upload option lives behind the voice control. Try the likely openers in order and
// snapshot whichever one opens, so the real panel contents get recorded either way.
for (const [desc, loc] of [
  ['Voice control', page.locator('[role=tab]:has-text("Voice"), button:has-text("Voice"), [aria-label*="oice"]')],
  ['Audio control', page.locator('[role=tab]:has-text("Audio"), button:has-text("Audio"), [aria-label*="udio"]')],
  ['Upload control', page.locator('button:has-text("Upload"), [aria-label*="pload"]')],
]) {
  if (await safeClick(desc, loc)) {
    await snapshot('05-voice-panel');
    break;
  }
}

console.log('\nProbe done. Files in heygen/_probe/. Browser stays open 30s.');
await page.waitForTimeout(30000);
await ctx.close();
