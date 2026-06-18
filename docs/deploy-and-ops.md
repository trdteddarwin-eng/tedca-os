# Deploy & Ops

Everything needed to run, change, and ship Tedca OS. ([README](./README.md) · [architecture](./architecture.md))

## Local dev — `./tedca-os/dev.sh` (ALWAYS run after changes)

Idempotent: kills :8790 / vite / worker, restarts all three, health-checks, prints the app URL. **Confirm its three ✓ lines before telling the user anything is ready** (locked feedback rule — the stack used to die silently mid-session).

- Server: `:8790` (**not** 8787 — that's taken by the PRD's `http.server`)
- App: vite `:5173`, **drifts to :5175** if 5173 is busy — dev.sh prints whichever it picked
- Worker: polls `BACKEND_URL` (currently the **cloud** — flip to `http://localhost:8790` in `tedca-os/.env` if you need local scrape jobs)
- Logs: `/tmp/tedca-server.log`, `/tmp/tedca-app.log`, `/tmp/tedca-worker.log`

## Secrets & env

All in `tedca-os/.env` (gitignored). **Never read it directly — the workspace security hook blocks reads of .env files.** Scripts load it at runtime (`node --env-file`). The server also loads the workspace root `.env` (`--env-file-if-exists=../../.env`) for shared keys.

Keys that exist (names only, see `deploy-vars.mjs` for the authoritative list): `OS_PASSWORD` (user-set, not the old dev passcode), `WORKER_TOKEN`, `GMAIL_OAUTH_CLIENT_ID/SECRET`, `INBOXES` (comma-separated tedcas.org addresses), `TEST_RECIPIENT`, `BACKEND_URL`; from the workspace .env: `OPENROUTER_API_KEY`, `ANYMAILFINDER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PATIENT_ENGINE_URL`.

## Cloud (Railway) — deployed 2026-06-11

- **URL:** https://tedca-os-production.up.railway.app · health: `/api/health`
- **Project:** `tedca-os`, id `6215778c-add2-4c91-95fe-5c5d3925029e`, account `trdteddarwin@gmail.com`
- **Shape:** ONE Docker container (`Dockerfile`: `node:24-alpine`, builds the React app, runs `node server/src/index.js` with `DATA_DIR=/data`, `APP_DIST=/os/app/dist`). SQLite lives on a Railway **volume mounted at `/data`** — survives redeploys. `railway.json` sets the Dockerfile builder + healthcheck + on-failure restarts.
- **CLI:** `/Users/yoljean/.npm-global/bin/railway` (npm global bin is **not on PATH** — use the absolute path), already logged in.

Common commands (run from `tedca-os/`):

```bash
/Users/yoljean/.npm-global/bin/railway up --service tedca-os   # deploy current dir
/Users/yoljean/.npm-global/bin/railway logs --service tedca-os
/Users/yoljean/.npm-global/bin/railway variables --service tedca-os   # CAREFUL: prints values
```

**Never deploy without the user's explicit go.**

## One-shot helper scripts (in `tedca-os/`, already run once — rerun if state drifts)

| Script | Does |
|---|---|
| `deploy-vars.mjs` | Copies required env vars from local `.env` files to the Railway service (values never printed) |
| `upload-tokens.mjs` | Logs into the cloud with OS_PASSWORD and POSTs `server/data/gmail_tokens.json` to `/api/gmail/import-tokens`, then prints ✓/✗ per inbox |
| `migrate-data.mjs` | Pushes local leads + email history to cloud `/api/admin/import-data` (dedupes by business+domain) |
| `cloud-test.mjs` | Triggers a cloud test-send from every connected inbox; prints results |

All four read `OS_PASSWORD` from `.env` at runtime. Verified results: 5/5 inbox tokens imported, 5/5 cloud test-sends ✓, 33 leads + history migrated.

## Gotchas (each one cost real time)

1. **Workspace root `.gitignore` ignores ALL `package.json`.** Railway respects git ignores when uploading — without `tedca-os/.gitignore` re-including them (`!package.json`, `!**/package.json`), builds fail with "package.json not found". Don't remove those lines.
2. **better-sqlite3 won't compile on Node 24** — the project deliberately uses built-in `node:sqlite`. Don't add it back.
3. **Port 8787 is occupied** by the visual-PRD `http.server` — the OS server is on **8790**.
4. **Vite port drifts** 5173 ↔ 5175. dev.sh detects and prints the real one.
5. **`railway` is not on PATH** — `/Users/yoljean/.npm-global/bin/railway`.
6. **Worker points at the cloud** (`BACKEND_URL` in `.env`) — local-engine scrape jobs will time out after 10 min unless you repoint it.
7. **Session tokens are in-memory** — every server restart/redeploy logs everyone out. Expected, not a bug.
8. `.railwayignore` excludes `server/data/`, `output/`, `node_modules/`, `.env` from uploads — local DB/tokens never ship in the image; cloud state lives on the volume.
9. **Security hook blocks `.env` reads and key-pattern commands** — don't fight it; write scripts that read env at runtime.

## Visual PRDs (reference pages, not the app)

- `tedca-os/index.html` — full OS PRD: `cd tedca-os && python3 -m http.server 4317`
- `tedca-os/email-prd.html` — email-engine PRD ("the machine as built"): port **4319**
