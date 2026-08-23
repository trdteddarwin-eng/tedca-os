// Reconnaissance pass. Reuses the saved session, walks to the create-video area, and writes
// down what is ACTUALLY on the page: screenshots, the visible control names, file inputs, and
// a trimmed DOM. Nothing is clicked that would spend a credit.
//
// WHY. Selectors for a third-party SPA cannot be written from memory — HeyGen renames and
// re-nests its controls, and a guessed selector fails silently (clicks nothing, or worse,
// clicks the wrong thing). This dumps ground truth so make_video.mjs targets real elements.
//
// usage: node probe.mjs [startUrl]
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

if (!fs.existsSync(PROFILE)) {
  console.log('No saved session. Run:  node login.mjs');
  process.exit(1);
}

const START = process.argv[2] || 'https://app.heygen.com/';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

async function snapshot(tag) {
  await page.waitForTimeout(2500);
  const url = page.url();
  await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: false });

  // Every interactive thing, with the attributes worth targeting.
  const controls = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const sel = 'button, a[href], [role=button], input, textarea, [contenteditable=true], [data-testid]';
    return Array.from(document.querySelectorAll(sel))
      .filter(vis)
      .slice(0, 300)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        testid: el.getAttribute('data-testid') || '',
        aria: el.getAttribute('aria-label') || '',
        href: (el.getAttribute('href') || '').slice(0, 80),
        accept: el.getAttribute('accept') || '',
        text: (el.innerText || el.value || '').trim().slice(0, 60).replace(/\s+/g, ' '),
      }))
      .filter((c) => c.text || c.testid || c.aria || c.tag === 'input');
  });

  // File inputs are the ones that matter for "upload my mp3" — list them even when hidden,
  // because HeyGen (like most SPAs) hides the real <input type=file> behind a styled button.
  const fileInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type=file]')).map((el) => ({
      accept: el.getAttribute('accept') || '',
      testid: el.getAttribute('data-testid') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      hidden: el.offsetParent === null,
    }))
  );

  fs.writeFileSync(
    path.join(OUT, `${tag}.json`),
    JSON.stringify({ url, controls, fileInputs }, null, 2)
  );
  console.log(`\n=== ${tag}  ${url}`);
  console.log(`    ${controls.length} visible controls, ${fileInputs.length} file input(s)`);
  return { url, controls, fileInputs };
}

await page.goto(START, { waitUntil: 'domcontentloaded' });
const home = await snapshot('01-home');

if (/\/(login|signup|auth|sso)/i.test(home.url)) {
  console.log('\nSession is not logged in anymore. Run:  node login.mjs');
  await ctx.close();
  process.exit(1);
}

// Surface the routes worth trying, rather than hardcoding a guess at the create flow.
const links = home.controls
  .filter((c) => c.href && /avatar|video|create|studio|project/i.test(c.href + ' ' + c.text))
  .map((c) => `${c.text || '(no text)'}  ->  ${c.href}`);
console.log('\nCandidate entry points found on the home page:');
console.log(links.length ? links.map((l) => '  ' + l).join('\n') : '  (none matched)');

console.log('\nProbe written to heygen/_probe/. Browser left OPEN so the next step can drive it.');
console.log('Close it yourself when done, or it closes with the script.');

// Hold the window open briefly so a human can look at the same thing the script saw.
await page.waitForTimeout(20000);
await ctx.close();
