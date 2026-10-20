// Step-by-step driver for a HeyGen Chrome that is ALREADY running with the saved profile and
// --remote-debugging-port. Used for exploring/repairing the UI interactively: each call
// connects, runs one snippet against the HeyGen tab, screenshots, and disconnects WITHOUT
// closing the browser, so state (open dialogs, uploads) survives between steps.
//
// start the browser once:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --user-data-dir="$HOME/.tedca/heygen-profile" --remote-debugging-port=9333 \
//     --use-mock-keychain --password-store=basic https://app.heygen.com/home
// The two keychain flags are REQUIRED: login.mjs runs through Playwright, which stores the
// profile's cookies under a mock keychain. A plain Chrome launch reads them with the real
// macOS Keychain, cannot decrypt them, and HeyGen shows the sign-in modal (2026-10-14).
// then:
//   node hg_exec.mjs snippet.js [shot.png]
// The snippet is the body of an async function receiving { page, ctx, shot, log }.
import { chromium } from '/Users/yoljean/Downloads/Ted Workspace/linkedin-visuals/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';

const [file, shotPath] = process.argv.slice(2);
const PORT = process.env.HG_PORT || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages.find((p) => /heygen\.com/.test(p.url())) || pages[0];
page.setDefaultTimeout(30000);
const log = (...a) => console.log(...a);
const shot = (p) => page.screenshot({ path: p, fullPage: false });
const body = fs.readFileSync(file, 'utf8');
const fn = new Function('ctx', 'page', 'shot', 'log', `return (async () => {\n${body}\n})();`);
try {
  const r = await fn(ctx, page, shot, log).catch((e) => { console.log('ERROR:', e.message.split('\n').slice(0, 4).join(' | ')); });
  if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
} finally {
  if (shotPath) await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
  console.log('URL:', page.url());
  // disconnect only — never close Ted's session browser from a step
  process.exit(0);
}
