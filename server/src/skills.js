// One-click content skills: avatar video VO, TikTok Live Photo VO, carousel copy.
// LLM calls go through OpenRouter (workspace standard). TTS runs on the Mac via the jobs queue.
import { db } from "./db.js";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const LLM_MODEL = "anthropic/claude-sonnet-4.5";

// locked voices (from the user's playbooks)
export const VOICE_AVATAR = "19STyYD15bswVz51nqLf"; // Tedca female avatar "her"
export const VOICE_PERSONAL = "OBxBRsbBsFdxuMVMaacO"; // Ted's own cloned voice

let logEvent = () => {};
export function bindSkillLogger(fn) {
  logEvent = fn;
}

async function llm(system, user, maxTokens = 1500) {
  const key = process.env.OPENROUTER_API_KEY || "";
  if (!key) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const cost = Number(data.usage?.cost ?? 0);
  if (cost) db.prepare("INSERT INTO costs (run_id, provider, amount_usd) VALUES (NULL, 'openrouter', ?)").run(cost);
  return data.choices?.[0]?.message?.content || "";
}

// ---- Avatar Video: topic → emotion-tagged script → ElevenLabs VO -----------
const AVATAR_SCRIPT_SYSTEM = `You write 45-75 second voiceover scripts for Tedca's female avatar reels (B2B audience: business owners, founders, agency owners). Follow the locked reel formula reverse-engineered from @nick_saraev's top reels (ig-reel-engine/PLAYBOOK.md), beat by beat:
1. COLD-OPEN HOOK (<3 seconds, no greeting): negation or newsjack. "You don't need to pay for X anymore..." / "Forget X, because..." / "[Big name] just [dropped/changed] X..."
2. NAME + SPECIFIC PROOF: the exact tool/skill plus 2-4 concrete nouns (real counts, named platforms, "no credit card").
3. HOW-IT-WORKS MICRO-DEMO: 2-4 if-then steps, second person, present tense ("You just type X, hit run, and watch Y happen").
4. "Think of it like [one vivid everyday analogy]."
5. NEGATION TRIPLET: "No X. No Y. No Z."
6. WHO IT'S FOR + STAKES (one line).
7. LOCKED CTA, always this shape: "So, want [the thing]? Just comment [KEYWORD] down below... and I'll DM it to you directly."
Style: conversational, short declarative sentences, contractions, spell numbers out, NEVER use em dashes (use ... for pauses). Insert ElevenLabs v3 audio tags ONLY from this set: [excited] [serious] [curious] [thoughtful] [warmly] — at beat transitions and on big numbers, 4-6 total, never one per line. Output ONLY the tagged script text, no titles or notes. Sound like a human talking, never use the words "game-changer", "unlock", "seamless", "elevate".`;

export async function avatarVideoScript(topic, { previous = null, notes = null } = {}) {
  if (previous && notes) {
    return llm(
      AVATAR_SCRIPT_SYSTEM,
      `Here is the current draft of the avatar video script:\n"""${previous}"""\n\nThe user wants these changes: ${notes}\n\nRewrite the full script applying the changes. Keep the structure and audio tags. Output only the revised tagged script.`
    );
  }
  return llm(
    AVATAR_SCRIPT_SYSTEM,
    `Topic for today's avatar video (must tie back to Tedca's AI agency services — AI receptionists, missed-call text-back, lead-gen automation, AI chatbots, follow-up systems for local businesses): ${topic}`
  );
}

// ---- Personal Ted Video: his cloned voice + iterative voice-revision session -
// Read by a clone of Ted's OWN voice (VOICE_PERSONAL). His clone reads fast, so
// v1 is generated at natural speed 1.0 (NOT the 1.2 avatar default). Same reel
// formula as the avatar script, but first person for his personal brand.
const PERSONAL_SCRIPT_SYSTEM = `You write 30-60 second FIRST-PERSON voiceover scripts for Ted's PERSONAL brand (audience: people curious about AI, Claude Code, building software solo, and automating real work). This is read by a clone of Ted's own voice, so write the way a real person talks to camera. Follow the locked reel formula reverse-engineered from top reels (ig-reel-engine/PLAYBOOK.md), beat by beat:
1. COLD-OPEN HOOK (<3 seconds, no greeting): a bold first-person claim or negation. "I just ..." / "You don't need ... anymore" / "Nobody tells you that ...".
2. THE SPECIFIC PROOF: the exact thing you did or built, with 2-4 concrete nouns (real counts, named tools, what it replaced).
3. HOW IT WORKS, FAST: 2-4 if-then steps in second person, present tense ("You type X, hit run, and Y happens").
4. "It's like [one vivid everyday analogy]."
5. NEGATION TRIPLET: "No X. No Y. No Z."
6. WHO SHOULD CARE + the stakes (one line).
7. CTA that fits a personal brand: invite a comment or a follow, natural and low-pressure ("If you want the exact setup, comment [KEYWORD] and I'll send it.").
Style: conversational, short declarative sentences, contractions, spell numbers out, NEVER use em dashes (use ... for pauses). Insert ElevenLabs v3 audio tags ONLY from this set: [excited] [serious] [curious] [thoughtful] [warmly] at beat transitions and on big moments, 4-6 total, never one per line. Output ONLY the tagged script text, no titles or notes. Sound like a real human, never use the words "game-changer", "unlock", "seamless", "elevate".`;

export async function personalVideoScript(topic, { previous = null, notes = null } = {}) {
  if (previous && notes) {
    return llm(
      PERSONAL_SCRIPT_SYSTEM,
      `Here is the current draft of Ted's personal-brand script:\n"""${previous}"""\n\nHe wants these changes: ${notes}\n\nRewrite the full script applying the changes. Keep the first-person voice, the structure and the audio tags. Output only the revised tagged script.`
    );
  }
  return llm(PERSONAL_SCRIPT_SYSTEM, `Topic for Ted's personal-brand video: ${topic}`);
}

// Apply one free-text revision note to the CURRENT voice version. The note can be
// about pace ("slow down the ending", "pick up the pace") -> change playback speed,
// or about wording/emotion ("more excited on the hook", "change X to Y") -> rewrite
// the tagged script. It can be both. Returns { script, speed } for the next take.
const PERSONAL_REVISE_SYSTEM = `You are helping Ted iterate on a first-person personal-brand voiceover script read by a clone of HIS OWN voice (ElevenLabs v3). You take the current tagged script plus one revision note and return the adjusted version. Keep his voice: first person, conversational, short declarative sentences, contractions, numbers spelled out, NEVER use em dashes (use ... for pauses). Use ElevenLabs v3 audio tags ONLY from this set: [excited] [serious] [curious] [thoughtful] [warmly]. Never invent tags. Preserve everything the note does not ask you to change. Never add commentary.`;

export async function reviseTedVoice({ script, note, speed }) {
  const raw = await llm(
    PERSONAL_REVISE_SYSTEM,
    `Current playback speed: ${speed} (1.0 = natural pace, lower = slower, min 0.7, max 1.2).\n\nCurrent tagged script:\n"""${script}"""\n\nTed's revision note: ${note}\n\nApply the note. If it is about pace/timing (faster, slower, "slow down the ending", "pick up the pace"), change SPEED. If it is about wording, emotion or emphasis, rewrite the SCRIPT (adjust the audio tags for the emotion). You may do both. Respond in EXACTLY this format and nothing else:\nSPEED: <number between 0.7 and 1.2>\nSCRIPT:\n<the full revised tagged script>`
  );
  const speedMatch = raw.match(/SPEED:\s*([0-9.]+)/i);
  let s = speedMatch ? Number(speedMatch[1]) : speed;
  if (!isFinite(s)) s = speed;
  s = Math.max(0.7, Math.min(1.2, s));
  let newScript = script;
  const scrIdx = raw.search(/SCRIPT:\s*/i);
  if (scrIdx !== -1) {
    const body = raw.slice(scrIdx).replace(/SCRIPT:\s*/i, "").trim();
    if (body) newScript = body;
  }
  return { script: newScript, speed: s };
}

// Session state for the active Personal Ted Video (single session at a time).
// Kept in the settings table as JSON so a server restart never loses the version
// history. { topic, script, speed, versions: [{ version, note, file, path, ... }] }
const PV_KEY = "personal_video_session";
export function pvLoad() {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(PV_KEY);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
export function pvSave(state) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(PV_KEY, JSON.stringify(state));
}

// ---- TikTok Live Photo: topic discovery + personal-voice VO ----------------
const TOPIC_SYSTEM = `You suggest TikTok Live Photo topics for Ted's personal brand: "Claude Code things you didn't know it could do". Audience: people curious about AI coding agents. Each topic must be a specific, demonstrable capability or real build (not generic AI hype). Return EXACTLY 5 topics as a JSON array of objects: [{"topic": "...", "hook": "one-line caption hook"}]. No other text.`;

export async function suggestLivephotoTopics() {
  // topics already covered live in a small history table so we never repeat
  const done = db.prepare("SELECT value FROM settings WHERE key='livephoto_topics_done'").get()?.value || "[]";
  const doneList = JSON.parse(done);
  const past = [
    "the passcom ticker build",
    "auto-trade paper-trading bot on live Kraken prices",
    "rank-and-rent local SEO site generator",
    "TikTok Live Photo renderer itself",
    "cold-email engine with Gmail API",
    ...doneList,
  ];
  const raw = await llm(
    TOPIC_SYSTEM,
    `Things Ted has ALREADY covered or built (avoid repeating, but real past builds like these are GOOD source material to feature if not yet covered): ${past.join("; ")}. Suggest 5 fresh topics.`
  );
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("topic suggestions came back malformed");
  return JSON.parse(raw.slice(start, end + 1));
}

// The full Live Photo build (copy + 2160x2700 slide render + Live Photo mint + Photos import)
// runs on the Mac via execution/run_livephoto.py — queued as a 'livephoto' job for the worker.
export function queueLivephoto(topic) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'livephoto', ?)")
    .run(JSON.stringify({ topic }));
  return Number(info.lastInsertRowid);
}

export function markTopicDone(topic) {
  const done = db.prepare("SELECT value FROM settings WHERE key='livephoto_topics_done'").get()?.value || "[]";
  const list = JSON.parse(done);
  if (!list.includes(topic)) list.push(topic);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('livephoto_topics_done', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify(list));
}

// ---- Instagram Carousel: full render (copy + animated slide 1 + static 2-6) --
// Runs on the Mac via execution/run_tedca_carousel.py — queued as a 'carousel' job.
export function queueCarousel(topic) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'carousel', ?)")
    .run(JSON.stringify({ topic }));
  return Number(info.lastInsertRowid);
}

// ---- Motion Graphic: topic → fully produced motion-graphic MP4 ---------------
// Pure motion graphic (no avatar, no upload). The Mac worker launches a headless
// Claude Code agent that scripts, narrates, renders and delivers the finished MP4.
// ---- HeyGen avatar video -----------------------------------------------------
// Runs on the Mac, not in the cloud: it drives HeyGen's web UI in a real logged-in
// browser so the render spends the SUBSCRIPTION credits, not the metered API. See
// tedca-os/heygen/README.md.
//
// audioFile is the mp3 the voice step already produced. Passing it means the Mac
// reuses that exact take instead of paying ElevenLabs for a second one; when it is
// null (e.g. the voice was generated on the Mac itself) the pipeline makes its own.
export function queueHeygenVideo({ topic, script, audioFile = null, aspect = "9:16" }) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'heygen_video', ?)")
    .run(JSON.stringify({ topic, script, audio_file: audioFile, aspect }));
  return Number(info.lastInsertRowid);
}

export function queueMotionGraphic(topic) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'motion_graphic', ?)")
    .run(JSON.stringify({ topic }));
  return Number(info.lastInsertRowid);
}

// ---- Video Edit: upload a video → an AI agent edits it to a style ------------
// Each "style" is a PLAYBOOK.md the agent reads and follows. Adding a new style
// later = drop a PLAYBOOK.md and add one entry here. The agent (headless Claude
// Code on the Mac) reads the playbook and edits the user's uploaded video to match.
export const EDIT_STYLES = [
  {
    id: "signature",
    name: "Tedca Signature",
    description:
      "Text-behind intro → riser drop → kinetic motion-graphic body. The lead-gen reel look.",
    playbook: "signature-video-style/PLAYBOOK.md",
  },
  {
    id: "locked",
    name: "Tedca Locked (Paper World)",
    description:
      "The locked ManyChat look: paper+grid MG beats, Playfair behind-words with clean cutout mattes, Saraev cutout opener, 3D shadow accents. Ted-approved across 6 review rounds.",
    playbook: "ig-reel-engine/affiliate-video/manychat/EDIT_PLAYBOOK.md",
  },
  {
    id: "pixel",
    name: "Pixel Dotted-Grid (Fable 5 look)",
    description:
      "Fully code-generated dot-matrix/halftone animation on near-black: terracotta pixel Claude pup, one looping hero motion, warm light beat. No footage. Recreate a reference video exactly or make an original in the style.",
    playbook: "pixel-animation-style/PLAYBOOK.md",
  },
];

export function editStyles() {
  return EDIT_STYLES.map(({ id, name, description }) => ({ id, name, description }));
}

export function queueVideoEdit({ videoPath, styleId, notes = "", prevPath = "", learn = true, project = null, model = "", effort = "" }) {
  const style = EDIT_STYLES.find((s) => s.id === styleId) || EDIT_STYLES[0];
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'video_edit', ?)")
    .run(
      JSON.stringify({
        video_path: videoPath,
        playbook: style.playbook,
        style_name: style.name,
        notes,
        prev_path: prevPath,
        learn,
        // Clip Editor project context (null for legacy one-shot edits): the worker uses this
        // to keep incremental per-project state and write per-version outputs + BUILD_LOG.
        project,
        // optional per-job editor overrides ("claude-opus-4-8" / "xhigh"); empty = CLI defaults
        model,
        effort,
      })
    );
  return Number(info.lastInsertRowid);
}

// ---- Clip Editor projects: version history + branching -----------------------
// Creates the v(n) row + the job carrying project context. `fromVersion` = the
// edit_versions row being revised (null for v1). Returns {versionId, jobId, versionN}.
export function queueEditVersion({ projectId, notes = "", learn = true, fromVersion = null, model = "", effort = "" }) {
  const proj = db.prepare("SELECT * FROM edit_projects WHERE id = ?").get(projectId);
  if (!proj) throw new Error(`project ${projectId} not found`);
  const maxN = db
    .prepare("SELECT COALESCE(MAX(version_n), 0) AS n FROM edit_versions WHERE project_id = ?")
    .get(projectId).n;
  const versionN = Number(maxN) + 1;
  const projectDir = `tedca-os/output/edit_projects/${projectId}`;
  const project = {
    project_id: projectId,
    version_n: versionN,
    project_dir: projectDir,
    state_dir: `${projectDir}/state`,
    out_path: `${projectDir}/v${versionN}/output.mp4`,
    build_log_path: `${projectDir}/v${versionN}/BUILD_LOG.md`,
    parent_version_n: fromVersion ? fromVersion.version_n : null,
    parent_composition: fromVersion
      ? `${projectDir}/state/composition_v${fromVersion.version_n}.html`
      : null,
    parent_output: fromVersion ? fromVersion.output_path : null,
  };
  const jobId = queueVideoEdit({
    videoPath: proj.source_path,
    styleId: proj.style_id,
    notes,
    prevPath: fromVersion ? fromVersion.output_path || "" : "",
    learn,
    project,
    model,
    effort,
  });
  const info = db
    .prepare(
      `INSERT INTO edit_versions (project_id, version_n, parent_version_id, job_id, status, notes)
       VALUES (?, ?, ?, ?, 'rendering', ?)`
    )
    .run(projectId, versionN, fromVersion ? fromVersion.id : null, jobId, notes || null);
  return { versionId: Number(info.lastInsertRowid), jobId, versionN };
}

// ---- Educational Post: topic -> coherent 5-slide pixel post copy -------------
// Two-phase like Avatar Video: first generate/edit the COPY, then render.
const EDU_SCENES = [
  "hook_dots", "hook_moon", "hook_spark",
  "terminal_slash", "subagents_clones", "claude_md_memory",
  "inbox_emails", "ship_deploy", "upload_posts",
  "build_website", "map_leads", "automation_conveyor", "designer_easel",
  "cta_wave", "cta_sunrise",
];

const EDU_SYSTEM = `You write the COPY for a 5-slide animated educational carousel about Claude Code (the CLI coding agent) for @tedca.ai, in a Pinterest "crumpled paper + serif" style. Audience: people who want to get more out of Claude Code.

STRUCTURE (must be coherent): slide 1 = HOOK that sets a promise (often a numbered teaser like "3 ..."). slides 2-4 = three POINTS, each delivering ONE piece of the hook's promise, in order. slide 5 = CTA (save/follow). If the hook promises "3", give exactly 3 points. Every point must follow from the hook.

Pick a "scene" per slide from THIS FIXED LIST (choose the most literal match to the slide's meaning): ${EDU_SCENES.join(", ")}.
- Hook slide: a hook_* scene (hook_dots for "top N", hook_moon for overnight/while-you-sleep, hook_spark generic).
- CTA slide: cta_wave (generic) or cta_sunrise (overnight/morning topics).
- Point slides: the most literal match — terminal_slash (slash commands), subagents_clones (parallel agents/subagents), claude_md_memory (CLAUDE.md/memory/context), inbox_emails (email/replies), ship_deploy (code/tests/deploy/bugs), upload_posts (content/posting/social), build_website (building sites/apps), map_leads (leads/research/scraping), automation_conveyor (automation/busywork), designer_easel (design/graphics).

COPY RULES: lowercase, punchy, human (never "unlock/seamless/game-changer/elevate"). Headlines short (each line <= ~16 chars). Exactly one line per slide is the coral ACCENT (the key word). Subtitle = a short handwritten aside in parentheses. Stay truthful about real Claude Code abilities.

Output ONLY valid JSON, no prose:
{"topic":"...","slides":[
 {"kind":"hook","line1":"...","line2":"...","accent":"...","sub":"(...)","scene":"hook_dots"},
 {"kind":"point","kicker":"trick 1 / 3","accent":"...","line2":"...","sub":"(...)","scene":"terminal_slash"},
 {"kind":"point","kicker":"trick 2 / 3","accent":"...","line2":"...","sub":"(...)","scene":"subagents_clones"},
 {"kind":"point","kicker":"trick 3 / 3","accent":"...","line2":"...","sub":"(...)","scene":"claude_md_memory"},
 {"kind":"cta","line1":"...","line2":"...","accent":"...","sub":"(...)","scene":"cta_wave"}
]}`;

function _parseEduJson(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("edu post copy came back malformed");
  return JSON.parse(raw.slice(start, end + 1));
}

export async function eduPostCopy(topic, { previous = null, notes = null } = {}) {
  let user;
  if (previous && notes) {
    user = `Here is the current 5-slide post copy JSON:\n"""${JSON.stringify(previous)}"""\n\nThe user wants these changes: ${notes}\n\nApply them and output the full updated JSON (same schema, keep it coherent).`;
  } else if (topic) {
    user = `Topic for the post: ${topic}\n\nWrite the coherent 5-slide copy JSON.`;
  } else {
    user = `No topic given — pick a fresh, specific, genuinely useful Claude Code topic yourself (not a generic one), then write the coherent 5-slide copy JSON.`;
  }
  const raw = await llm(EDU_SYSTEM, user, 1400);
  const data = _parseEduJson(raw);
  // normalize scene ids to the allowed set
  for (const s of data.slides || []) {
    if (!EDU_SCENES.includes(s.scene)) s.scene = s.kind === "cta" ? "cta_wave" : s.kind === "hook" ? "hook_spark" : "hook_spark";
  }
  return data;
}

export function queueEduPost({ topic, slides }) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (NULL, 'edu_post', ?)")
    .run(JSON.stringify({ topic: topic || "", slides }));
  return Number(info.lastInsertRowid);
}

// ---- TTS via worker job ------------------------------------------------------
// speed is optional — when set, the Mac worker passes it to gen_avatar_vo.py's
// --speed (Ted's personal clone wants 1.0, not the script's 1.20 default).
export function queueTts({ text, voice, outName, speed = null, runId = null }) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (?, 'tts', ?)")
    .run(runId, JSON.stringify({ text, voice, outName, speed }));
  return Number(info.lastInsertRowid);
}

export function jobStatus(id) {
  return db.prepare("SELECT id, status, result FROM jobs WHERE id=?").get(id);
}
