# CLIPEDITOR_BUILDLOG — clip-editor-with-history (Ted's OS priority feature)

Builder: editfix-builder-fable. Started 2026-07-05 ~00:20. Order: lead relay of Ted's GO.
Rule inherited from the video rounds: honest timestamped log; reviewers verify claims vs files.

## Design (committed before code)

CONTEXT (from code recon): sqlite via node:sqlite (server/src/db.js, try/catch migrations);
jobs table polled by the Mac worker (worker/index.js) which launches a headless Claude editor
agent per video_edit job (90m timeout, playbook-driven, LEARNINGS.md self-teaching); express
API in server/src/index.js (/api/skills/*, requireUser); file streaming via /api/skills/file
guarded to _FILE_ROOT = tedca-os/output; existing ClipEditor.tsx keeps versions ONLY in React
state (lost on refresh, no projects, no branching).

### 1. Data (server/src/db.js)
- edit_projects: id, name, source_path, style_id (default 'locked'), created_at.
- edit_versions: id, project_id, version_n, parent_version_id (branching), job_id,
  status (rendering|done|failed|seeded), notes, output_path, build_log_path, created_at.
- Status truth: the jobs table remains the execution source of truth; edit_versions rows with
  status='rendering' are lazily synced on read (server checks the linked job; on done ->
  persist output_path/build_log_path, set status, chmod 444 the output = IMMUTABILITY rule).
  No worker->DB coupling added.

### 2. Worker (worker/index.js, video_edit path ONLY)
- job.params gains optional project context: {project_id, version_n, project_dir,
  out_path, build_log_path, state_dir, parent_composition, parent_output}.
- With project context the prompt (a) uses the style playbook as bible — for the 'locked'
  style that is ig-reel-engine/affiliate-video/manychat/EDIT_PLAYBOOK.md (the locked look);
  (b) instructs INCREMENTAL work: shared per-project state_dir for raw frames/mattes/assets;
  composition snapshot per version at state/composition_v<N>.html; revisions START from the
  parent version's snapshot (branch-from-old = start from that old snapshot) — GOALS/BUILD_LOG
  round style, not from-scratch; (c) requires a per-version BUILD_LOG.md; (d) output to
  v<N>/output.mp4 under the project dir. Legacy (no project context) path unchanged.
- 90m timeout kept.

### 3. API (server/src/index.js — new endpoints only, no engine/send-path edits)
- POST /api/edit-projects {name?, source_path, style?} -> create project + queue v1
- GET  /api/edit-projects -> list with version counts + latest status
- GET  /api/edit-projects/:id -> project + versions (lazy-synced)
- POST /api/edit-projects/:id/revise {from_version_id, notes, learn} -> v(n+1) branched
  from any prior version
- GET  /api/edit-versions/:id -> single version status/output
- POST /api/edit-projects/:id/seed {output_path, notes} -> import an existing finished mp4 as
  a version (status='seeded', honest label; used to seed the manychat v3 as the test project's
  v1 without faking a render).

### 4. UI (app/src/pages/ClipEditor.tsx rewrite)
- No project param: PROJECT LIST (name, created, versions, latest status) + "open".
- Project view: version timeline v1..vN with notes/status/branch-parent shown, play any done
  version (stream via /api/skills/file — project dirs live under tedca-os/output ✓ in root),
  notes box + "revise this version" on ANY version (branching), refresh-safe (all from DB),
  poll rendering versions via /api/edit-versions/:id.
- Legacy entry (Skills -> upload -> location.state) now creates a persistent project first.
  "No button exists unless it actually works."

### 5. Guardrails
- engine.js / replies.js / smtp / imap / send paths untouched.
- Version outputs chmod 444 at done-sync; never rewritten (reviewer/Ted-watched rule).
- Live stack note: server is UP during the build — NO job rows inserted until the supervised
  E2E phase (a live worker would execute them).

### 6. Verification plan
- Pre-restart (stack running old code): syntax/type checks (node --check, tsc/vite build),
  DB migration dry-run on a COPY of the sqlite file, module unit test of queue function
  (in-memory/temp DB), endpoint code review.
- Report code-complete -> LEAD restarts via dev.sh (their step) ->
- E2E: create test project from avatar6 source; seed manychat_full_v3.mp4 as v1 ('seeded',
  honest); submit ONE real tiny revision ("VERIFICATION RUN: 2-second excerpt only") to prove
  notes -> job -> agent -> version-done -> immutable -> UI loop; keep the render SHORT.

## Actions

- 00:20 Code recon: db.js (sqlite, try/catch migrations), skills.js (EDIT_STYLES + queueVideoEdit
  -> jobs table), index.js (/api/skills/video-edit*, /api/skills/file guarded to tedca-os/output),
  worker handleVideoEdit (headless Claude agent, 90m, LEARNINGS.md), ClipEditor.tsx (state-only
  versions), entries from Skills.tsx:86 (new upload) and Jobs.tsx:204 (existing video). Stack UP
  during build -> no live job inserts pre-E2E.
- 00:30 Design committed (above) + posted to lead.
- 00:40 server/src/db.js: edit_projects + edit_versions tables (+index) in the house style.
- 00:45 server/src/skills.js: 'locked' style -> ig-reel-engine/affiliate-video/manychat/
  EDIT_PLAYBOOK.md; queueVideoEdit gains optional `project` context (legacy calls unchanged);
  new queueEditVersion(projectId, notes, learn, fromVersion) — computes version_n, project dir
  layout (state/, v<N>/output.mp4, v<N>/BUILD_LOG.md, composition_v<N>.html snapshots), inserts
  the version row linked to the queued job.
- 00:55 server/src/index.js: six endpoints (create[+skip_initial], list, detail, revise, version
  status, seed) + syncEditVersion (lazy job->version sync; chmod 444 output at done = version
  immutability). No engine/replies/send-path edits (verified: my diff touches only the skills
  import list + the new block before /api/skills/video-edit/revise).
- 01:05 worker/index.js handleVideoEdit: project-context branch (per-project state dir, per-
  version outDir, BUILD_LOG requirement, incremental prompt block: start from parent composition
  snapshot, reuse extracted frames/mattes, prior outputs immutable). Legacy path byte-compatible.
  Result now returns build_log_path/project_id/version_n when project context is present.
- 01:15 app/src/pages/ClipEditor.tsx rewritten: project list view + refresh-safe project detail
  (?p=<id>), version timeline with notes + branch-parent labels, play any version with output,
  revise-from-SELECTED-version (branching), 4s polling while rendering. Entry flows kept: Skills
  upload -> create project + v1; Jobs existing video -> create project (skip_initial) + seed as
  v1 'seeded' (no phantom render). Fixed two self-caught bugs pre-commit: navigate was wiping
  the fresh ?p param; existing-entry was queueing an unwanted real render before seeding.
- 01:25 PRE-RESTART VERIFICATION: node --check clean on all 4 touched JS files; tsc --noEmit
  exit 0; vite build ✓ (285.8kB bundle); migration dry-run on a DB COPY (DATA_DIR override)
  created both tables; unit test on the copy: project -> v1 queued -> v1 done -> revise from v1
  -> v2 row has parent_version_id=v1, version_n=2, job params carry
  out_path=edit_projects/1/v2/output.mp4 + parent composition snapshot + the locked playbook.
- 01:26 CODE-COMPLETE reported to lead. E2E (test project + tiny scoped revision) awaits the
  lead's dev.sh restart per order #7.

## E2E (post-restart, lead's green light; times EDT)

- 04:10 Lead restarted the stack (3 checkmarks, migration confirmed live). Temp session token
  inserted directly into sessions (mirrors login; removed after the test).
- 04:11 POST /api/edit-projects {avatar6 source, style locked, skip_initial} -> project_id 1.
- 04:12 POST /seed with manychat_full_v3.mp4 -> v1 status='seeded', honest notes ("no render was
  performed for this row") + pointer to the original rounds' BUILD_LOG. GET /:id returns it.
- 04:12 POST /revise {from_version_id:1, learn:false, notes: scoped VERIFICATION RUN — 2.0s
  excerpt only, no full edit} -> version_id 2, job 34. Live worker claimed it; headless agent ran.
- 04:15 v2 DONE (~2.5 min). VERIFIED:
  - output: edit_projects/1/v2/output.mp4 — 2.005s, 1080x1920, and PERMISSIONS -r--r--r--
    (syncEditVersion chmod 444 fired on read: version immutability is live).
  - v2/BUILD_LOG.md written by the agent: honest smoke-test transcript, parent marked read-only.
  - state/composition_v2.html snapshot written (incremental-state contract obeyed).
  - LEARNINGS.md absent in the locked playbook dir: learn:false respected (test note NOT taught).
  - version rows: v1 {seeded, parent null, job null}, v2 {done, parent_version_id=1, job 34}.
- 04:17 Temp session token deleted. VERIFIED reported to lead.

FEATURE COMPLETE pending lead/Ted review: projects persist, versions branch, outputs immutable,
the agent works incrementally against the locked playbook, and the whole loop is proven live.

- 04:25 LEAD VERIFICATION: independently confirmed against the live DB + filesystem (project 1,
  seeded v1, branched v2 via job 34, output probes 2.005s 1080x1920, -r--r--r--). Ruling: KEEP
  project 1 as Ted's demo (honestly labeled). FEATURE ACCEPTED — BUILD CLOSED. Builder released.