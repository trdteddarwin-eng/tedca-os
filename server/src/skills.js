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
const AVATAR_SCRIPT_SYSTEM = `You write 30-45 second voiceover scripts for Tedca's female avatar videos (B2B audience: local business owners). Style: conversational, energetic, ~190 wpm, hook-first. Structure: Hook+Stat → the Gap → the Solution → Who needs it (with quick math) → CTA ("comment X"). Insert ElevenLabs v3 audio tags at beat transitions: [emphatic], [thoughtful], [excited] — sparingly, 3-5 total. Output ONLY the tagged script text, no titles or notes. Sound like a human talking, never use the words "game-changer", "unlock", "seamless", "elevate".`;

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
];

export function editStyles() {
  return EDIT_STYLES.map(({ id, name, description }) => ({ id, name, description }));
}

export function queueVideoEdit({ videoPath, styleId, notes = "", prevPath = "", learn = true }) {
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
      })
    );
  return Number(info.lastInsertRowid);
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
export function queueTts({ text, voice, outName, runId = null }) {
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (?, 'tts', ?)")
    .run(runId, JSON.stringify({ text, voice, outName }));
  return Number(info.lastInsertRowid);
}

export function jobStatus(id) {
  return db.prepare("SELECT id, status, result FROM jobs WHERE id=?").get(id);
}
