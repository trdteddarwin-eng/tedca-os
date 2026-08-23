// Log into HeyGen ONCE, by hand, into a persistent Chrome profile.
//
// WHY THIS EXISTS. The point of driving HeyGen's web UI instead of its API is that UI runs
// spend the subscription credits you already pay for, while API runs bill separately. To do
// that the automation needs a logged-in browser session — but we do NOT want the password
// anywhere in this repo, in .env, or in a script.
//
// So: you log in yourself, one time, in a real visible browser. Chrome writes the session into
// a profile directory OUTSIDE the workspace (~/.tedca/heygen-profile), and every later headless
// run reuses it. No credential ever touches the code. If the session expires, run this again.
//
// usage: node login.mjs
import { chromium } from '/Users/yoljean/Downloads/Ted Workspace/linkedin-visuals/node_modules/playwright-core/index.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// fileURLToPath, NOT new URL(...).pathname — the workspace path contains a space, and .pathname
// hands back "Ted%20Workspace", which silently creates a whole stray directory tree.
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Deliberately outside the repo: this directory holds live session cookies.
const PROFILE = path.join(os.homedir(), '.tedca', 'heygen-profile');
fs.mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://app.heygen.com/', { waitUntil: 'domcontentloaded' });

console.log('');
console.log('  A Chrome window just opened on HeyGen.');
console.log('  Log in there like you normally would. I am watching for it to land.');
console.log('  (Nothing you type is read or stored by this script.)');
console.log('');

// Poll for a logged-in app URL rather than a specific element: HeyGen moves its UI around,
// but "we are no longer sitting on a login/auth route" is stable.
const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes to finish, incl. 2FA
let loggedIn = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  let url = '';
  try {
    url = page.url();
  } catch {
    break; // window closed
  }
  const onAuthRoute = /\/(login|signup|auth|sso)/i.test(url);
  if (!onAuthRoute && /app\.heygen\.com/i.test(url)) {
    // give the SPA a beat to actually paint the workspace before declaring victory
    await page.waitForTimeout(3000);
    if (!/\/(login|signup|auth|sso)/i.test(page.url())) {
      loggedIn = true;
      break;
    }
  }
}

if (loggedIn) {
  const shot = path.join(__dirname, '_probe');
  fs.mkdirSync(shot, { recursive: true });
  await page.screenshot({ path: path.join(shot, 'logged-in.png'), fullPage: false });
  console.log('  Logged in. Session saved to ' + PROFILE);
  console.log('  Screenshot: heygen/_probe/logged-in.png');
  console.log('  You will not have to do this again unless HeyGen signs you out.');
} else {
  console.log('  Did not detect a login before the timeout (or the window was closed).');
  console.log('  Nothing was saved beyond whatever Chrome itself wrote. Re-run when ready.');
}

await ctx.close();
