// Gmail integration: per-inbox OAuth (loopback flow), token storage, send, profile check.
// Tokens are stored server-side in server/data/gmail_tokens.json — never sent to the browser.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "data"),
  "gmail_tokens.json"
);

const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET || "";

export function inboxes() {
  return (process.env.INBOXES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function gmailConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && inboxes().length);
}

// ---- token store -----------------------------------------------------------
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTokens(all) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// cloud bootstrap: accept the token file from the local instance
export function importTokens(tokens) {
  saveTokens(tokens);
  return Object.keys(tokens).length;
}

export function exportTokens() {
  return loadTokens();
}

export function authorizedInboxes() {
  const tokens = loadTokens();
  return inboxes().map((email) => ({ email, authorized: Boolean(tokens[email]?.refresh_token) }));
}

// ---- OAuth loopback flow ---------------------------------------------------
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

// One in-flight authorization at a time. Starts a temporary loopback server,
// returns the URL the user must open; resolves when Google redirects back.
let pending = null;

export function startAuth(expectedEmail) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Gmail OAuth client not configured in .env");
  if (pending) {
    pending.server.close();
    pending = null;
  }

  const state = crypto.randomBytes(16).toString("hex");

  return new Promise((resolveStart) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      try {
        if (!code || gotState !== state) throw new Error("bad callback");
        const port = server.address().port;
        const token = await exchangeCode(code, `http://127.0.0.1:${port}/callback`);
        const email = await whoAmI(token.access_token);
        if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) {
          throw new Error(`You authorized ${email}, but this slot is for ${expectedEmail}. Sign into the right account and retry.`);
        }
        const all = loadTokens();
        const prev = all[email] || {};
        all[email] = {
          refresh_token: token.refresh_token || prev.refresh_token,
          authorized_at: new Date().toISOString(),
        };
        if (!all[email].refresh_token) throw new Error("Google did not return a refresh token — remove the app's prior grant at myaccount.google.com/permissions and retry.");
        saveTokens(all);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<body style="font-family:monospace;background:#111;color:#e8e4dd;padding:40px"><h2 style="color:#39d98a">✓ ${email} connected to Tedca OS</h2>You can close this tab.</body>`);
        pending?.resolveResult({ ok: true, email });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<body style="font-family:monospace;background:#111;color:#e8e4dd;padding:40px"><h2 style="color:#E63B2E">✗ ${e.message}</h2></body>`);
        pending?.resolveResult({ ok: false, error: e.message });
      } finally {
        setTimeout(() => server.close(), 200);
        pending = null;
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirect = `http://127.0.0.1:${port}/callback`;
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          state,
          ...(expectedEmail ? { login_hint: expectedEmail } : {}),
        });
      let resolveResult;
      const result = new Promise((r) => (resolveResult = r));
      pending = { server, resolveResult };
      resolveStart({ authUrl, result });
    });
  });
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(email) {
  const all = loadTokens();
  const rec = all[email];
  if (!rec?.refresh_token) throw new Error(`${email} is not authorized yet`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: rec.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed for ${email}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function whoAmI(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`profile lookup failed: ${await res.text()}`);
  return (await res.json()).emailAddress;
}

// ---- read (reply polling) ----------------------------------------------------
export async function listInboxMessages(email, q) {
  const accessToken = await refreshAccessToken(email);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "20");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`list failed for ${email}: ${await res.text()}`);
  return (await res.json()).messages || [];
}

export async function getMessage(email, id) {
  const accessToken = await refreshAccessToken(email);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`get message failed for ${email}: ${await res.text()}`);
  const msg = await res.json();
  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
  );
  // plain-text body: walk parts for text/plain, fall back to snippet
  let body = "";
  function walk(part) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      body += Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    (part.parts || []).forEach(walk);
  }
  walk(msg.payload);
  if (!body) body = msg.snippet || "";
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers.from || "",
    subject: headers.subject || "",
    messageIdHeader: headers["message-id"] || null,
    body: body.slice(0, 4000),
  };
}

// ---- send ------------------------------------------------------------------
function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendEmail({ from, to, subject, body, inReplyTo = null }) {
  const accessToken = await refreshAccessToken(from);
  subject = String(subject || "").replace(/[\r\n]+/g, " "); // guard against header injection
  // RFC 2047 encode the subject so non-ASCII (em-dashes, accents) survives transit
  const encSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    `List-Unsubscribe: <mailto:${from}?subject=unsubscribe>`,
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }
  const raw = b64url(headers.join("\r\n") + "\r\n\r\n" + body);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`send failed from ${from}: ${await res.text()}`);
  return res.json();
}
