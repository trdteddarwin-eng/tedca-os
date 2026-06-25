// Tedca OS local worker — runs on the Mac, streams activity to the backend,
// and executes scrape jobs by shelling out to the workspace execution/ scripts.
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8790";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";

if (!WORKER_TOKEN) {
  console.error("WORKER_TOKEN missing — put it in tedca-os/.env (worker loads ../.env).");
  process.exit(1);
}

// native macOS desktop notification (banner + sound) on Ted's Mac
function notifyMac(title, message) {
  try {
    const t = String(title).replace(/["\\]/g, "");
    const m = String(message).replace(/["\\]/g, "");
    execFile("osascript", ["-e", `display notification "${m}" with title "${t}" sound name "Glass"`], () => {});
  } catch {
    /* notifications are best-effort, never fail a job over one */
  }
}

// quick text ping to the user's phone
async function sendTelegramText(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    console.warn("[telegram] skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env var missing");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      console.warn(`[telegram] sendMessage failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    return res.ok;
  } catch (e) {
    console.warn(`[telegram] sendMessage exception: ${e.message}`);
    return false;
  }
}

// deliver finished content straight to the user's phone
async function sendTelegramFile(filePath, caption = "", kind = "document") {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    console.warn("[telegram] skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env var missing");
    return false;
  }
  const fs = await import("node:fs");
  const method = { audio: "sendAudio", photo: "sendPhoto", video: "sendVideo" }[kind] || "sendDocument";
  const field = { audio: "audio", photo: "photo", video: "video" }[kind] || "document";
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      console.warn(`[telegram] ${method} failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    return res.ok;
  } catch (e) {
    console.warn(`[telegram] ${method} exception: ${e.message}`);
    return false;
  }
}

async function postEvent({ message, level = "info", actor = "worker", run_id = null, raw = null }) {
  const res = await fetch(`${BACKEND_URL}/api/activity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WORKER_TOKEN}`,
    },
    body: JSON.stringify({ message, level, actor, run_id, raw }),
  });
  if (!res.ok) throw new Error(`postEvent failed: ${res.status}`);
  return res.json();
}

// ---- job execution ---------------------------------------------------------
async function claimJob() {
  const res = await fetch(`${BACKEND_URL}/api/worker/jobs/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  return (await res.json()).job;
}

async function completeJob(id, ok, result) {
  await fetch(`${BACKEND_URL}/api/worker/jobs/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WORKER_TOKEN}` },
    body: JSON.stringify({ ok, result }),
  });
}

function runPython(script, args, timeoutMs = 9 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(WORKSPACE, ".venv-leadgen", "bin", "python"),
      [path.join(WORKSPACE, "execution", script), ...args],
      { cwd: WORKSPACE, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${script} failed: ${stderr || err.message}`.slice(0, 500)));
        resolve(stdout);
      }
    );
  });
}

// Launch a headless Claude Code agent on the Mac. Used by the video-edit and
// motion-graphic skills: the agent reads a playbook/directive and produces a
// finished MP4 at an exact path. cwd = WORKSPACE so it sees CLAUDE.md, the
// execution/ scripts, the playbooks, AND the security hooks (which still block
// .env / secret reads even in bypass mode).
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");

function runClaudeAgent(prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Headless claude must use Ted's OAuth login (~/.claude), NOT an ANTHROPIC_API_KEY that
    // may have leaked into the worker's env (e.g. inherited from the launching shell) — an
    // invalid key makes claude exit immediately with "Invalid API key". Strip it so the CLI
    // falls back to the stored login. stdin is ignored so there's no "no stdin data" wait.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(CLAUDE_BIN, ["-p", prompt, "--permission-mode", "bypassPermissions"], {
      cwd: WORKSPACE,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const CAP = 64 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent timed out after ${Math.round(timeoutMs / 60000)}m`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; if (out.length > CAP) out = out.slice(-CAP); });
    child.stderr.on("data", (d) => { err += d; if (err.length > CAP) err = err.slice(-CAP); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`agent spawn failed: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`agent exited ${code}: ${(err || out).slice(-800)}`));
    });
  });
}

async function handleAgentosPostRevise(job) {
  const { folder, notes } = job.params;
  const base = path.basename(folder || "post");
  const noteText = [
    notes?.overall ? `Overall: ${notes.overall}` : "",
    ...Object.entries(notes?.slides || {}).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `Slide ${k}: ${v}`),
  ].filter(Boolean).join("\n");
  await postEvent({ run_id: job.run_id, actor: "research", level: "info", message: `Mac worker: revising the post "${base}" with your notes…` });
  await sendTelegramText(`✏️ Revising post "${base}" — applying your slide changes and re-rendering.`);

  const prompt = [
    `You are revising an existing AgentOS Instagram carousel post (DO NOT make a new one).`,
    `Post folder: ${folder}`,
    `It contains meta.json (the copy), slide_01.html … slide_NN.html (slide source), and slide_NN.mp4 (rendered output).`,
    `The user wants these changes — apply ONLY what is asked, leave every other slide untouched:`,
    noteText,
    `Steps: (1) update meta.json's copy for the affected slides; (2) edit the matching slide_NN.html to reflect the new copy — change ONLY the text, keep ALL animation/GSAP/layout/styling and the window.__seek(ms) contract exactly intact; (3) re-render each changed slide to its slide_NN.mp4 with: node ${WORKSPACE}/execution/render_demo_posts.mjs <abs out .mp4> <abs slide .html> 120 30`,
    `When finished, output ONLY this JSON on the final line: {"folder":"${folder}","slides":["<abs path to every slide_NN.mp4 in order>"]}`,
  ].join("\n\n");

  const out = await runClaudeAgent(prompt, 30 * 60 * 1000);
  let result = { folder, slides: [] };
  const m = out.match(/\{[\s\S]*"slides"[\s\S]*\}/);
  if (m) { try { result = JSON.parse(m[0]); } catch { /* keep default */ } }
  await postEvent({ run_id: job.run_id, actor: "research", level: "success", message: `Post "${base}" revised and re-rendered.` });
  await sendTelegramText(`✅ Post "${base}" re-rendered with your changes.`);
  return result;
}

async function handleMotionGraphic(job) {
  const { topic } = job.params;
  const fs = await import("node:fs");
  const outDir = path.join(WORKSPACE, "tedca-os", "output", `motion_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "final.mp4");
  await sendTelegramText(
    `🎬 Mac worker starting a pure motion-graphic video for "${topic}". A real editor agent is building it — script → narration → SFX → render. I'll send the MP4 when it's done (can take 10-30 min).`
  );
  await postEvent({ run_id: job.run_id, actor: "research", level: "info", message: `Mac worker: launching the motion-graphic agent for "${topic}"…` });
  const prompt = [
    `You are running headless as the Tedca motion-graphic video producer. Produce ONE fully finished, PURE motion-graphic video (NO talking-head avatar, NO uploaded footage) on this topic:`,
    ``,
    `TOPIC: ${topic}`,
    ``,
    `Your COMPLETE instruction set is Ted's motion-graphic playbook — read it IN FULL and follow it exactly. It documents his exact method and points to the reusable render engine + assets you MUST reuse:`,
    path.join(WORKSPACE, "signature-motion-graphic", "PLAYBOOK.md"),
    ``,
    `Per the playbook: write a human-toned script (not AI-sounding), generate narration with the locked voice, design the kinetic mixed-weight type + UI-card scenes, add SFX anchored to every visible change, and render DETERMINISTICALLY (HTML/CSS/JS + window.__seek(ms) + headless-Chrome/Playwright frame capture + ffmpeg — NEVER MediaRecorder). Reuse the render.mjs / insiderforce-recreate pipeline the playbook points to instead of writing a renderer from scratch. Run the playbook's self-critique loop to its target score (>=95).`,
    ``,
    `When finished, the single deliverable MP4 MUST be saved to EXACTLY this absolute path (overwrite if present):`,
    outPath,
    ``,
    `Work fully autonomously — do NOT ask any questions, do NOT wait for approval. Reuse existing scripts/assets rather than rebuilding from scratch. When the file exists at that exact path, you are done.`,
  ].join("\n");
  const stdout = await runClaudeAgent(prompt, 30 * 60 * 1000);
  if (!fs.existsSync(outPath)) {
    throw new Error(`agent finished but no MP4 at ${outPath}. Agent said: ${stdout.slice(-400)}`);
  }
  await postEvent({ run_id: job.run_id, actor: "research", level: "success", message: `Motion graphic ready: ${outPath}` });
  await sendTelegramFile(outPath, `🎬 Motion graphic ready — "${topic}"`, "video");
  execFile("open", ["-R", outPath], () => {});
  return { path: outPath, topic };
}

async function handleVideoEdit(job) {
  const { video_path, playbook, style_name, notes, prev_path, learn } = job.params;
  const fs = await import("node:fs");
  if (!fs.existsSync(video_path)) throw new Error(`uploaded video not found: ${video_path}`);
  const outDir = path.join(WORKSPACE, "tedca-os", "output", `edit_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "edited.mp4");
  const learningsPath = path.join(WORKSPACE, path.dirname(playbook), "LEARNINGS.md");
  await sendTelegramText(
    notes
      ? `✂️ Re-editing your "${style_name}" video with your notes: "${String(notes).slice(0, 120)}". New version coming — I'll send it here.`
      : `✂️ Mac worker starting the "${style_name}" edit of your video. An editor agent is reading the playbook and cutting it — a real edit, a few minutes. I'll send the finished MP4 here.`
  );
  await postEvent({ run_id: job.run_id, actor: "research", level: "info", message: `Mac worker: launching the editor agent — style "${style_name}", reading ${playbook}…` });
  const reviseBlock = notes
    ? [
        ``,
        `THIS IS A REVISION. The user reviewed the previous version and asked for changes. Previous render:`,
        prev_path || "(previous version)",
        `The user's change request — apply it faithfully and keep everything they did NOT ask to change:`,
        notes,
      ]
    : [];
  const prompt = [
    `You are running headless as a Tedca video editor. Edit the user's already-recorded video into a finished, polished reel that matches a style playbook AND the user's accumulated preferences.`,
    ``,
    `STYLE PLAYBOOK (read IN FULL, follow exactly — your complete instruction set; it points to the scripts/assets/SFX you must reuse):`,
    path.join(WORKSPACE, playbook),
    ``,
    `LEARNINGS — the user's accumulated corrections/preferences from past edits. READ THIS FILE and OBEY it: never repeat anything listed as a mistake, always do what's listed as preferred. (If the file is missing or empty, ignore it.)`,
    learningsPath,
    ``,
    `THE USER'S RAW VIDEO TO EDIT (the talking-head take the playbook refers to — do NOT regenerate it, edit THIS exact file):`,
    video_path,
    ...reviseBlock,
    ``,
    `Apply the full playbook treatment (Signature style = text-behind intro → riser drop → kinetic motion-graphic body → comment-keyword CTA, grade-matched splices, SFX anchored to visible changes, loudnorm). Use the deterministic render pipelines the playbook points to, and run its self-critique loop to the target score.`,
    ``,
    `When finished, the single finished MP4 MUST be saved to EXACTLY this absolute path (overwrite if present):`,
    outPath,
    ``,
    `Work fully autonomously — do NOT ask any questions, do NOT wait for approval. When the finished video exists at that exact path, you are done.`,
  ].join("\n");
  const stdout = await runClaudeAgent(prompt, 45 * 60 * 1000);
  if (!fs.existsSync(outPath)) {
    throw new Error(`editor agent finished but no MP4 at ${outPath}. Agent said: ${stdout.slice(-400)}`);
  }
  // self-learning: persist this change-note so the editor obeys it on every future run —
  // ONLY when learn !== false (Ted can apply a change to just this video without teaching it).
  if (notes && String(notes).trim() && learn !== false) {
    try {
      fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
      if (!fs.existsSync(learningsPath)) {
        fs.writeFileSync(learningsPath, "# Editor Learnings\n\nThe video editor reads this file on every run and obeys it. One correction per line.\n\n");
      }
      fs.appendFileSync(learningsPath, `- ${String(notes).trim()}\n`);
    } catch (e) {
      console.warn(`[learnings] could not append: ${e.message}`);
    }
  }
  await postEvent({ run_id: job.run_id, actor: "research", level: "success", message: `Edited video ready: ${outPath}` });
  notifyMac("Tedca OS — Clip Editor ✓", notes ? "new version ready" : "first cut ready");
  await sendTelegramFile(outPath, `✂️ Edited (${style_name})${notes ? " · revised" : ""} — ready`, "video");
  return { path: outPath, style: style_name, notes: notes || "" };
}

async function handleEduPost(job) {
  const { topic, slides } = job.params;
  const fs = await import("node:fs");
  const outDir = path.join(WORKSPACE, "tedca-os", "output", `edupost_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const copyPath = path.join(outDir, "copy.json");
  fs.writeFileSync(copyPath, JSON.stringify({ topic: topic || "", slides }, null, 2));

  notifyMac("Tedca OS — Educational Post", `Rendering "${topic || "your post"}"…`);
  await sendTelegramText(`🎬 Mac worker rendering your ${Array.isArray(slides) ? slides.length : 5}-slide educational post${topic ? ` ("${topic}")` : ""} → animated Live Photos. I'll ping you when they're in Photos.`);
  await postEvent({ run_id: job.run_id, actor: "research", level: "info", message: `Mac worker: rendering educational post "${topic || ""}" (${slides?.length || 0} slides → MP4 → Live Photos)…` });

  const stdout = await runPython("run_edu_post.py", ["--copy", copyPath, "--outdir", outDir], 30 * 60 * 1000);
  const lines = stdout.trim().split("\n");
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("{")) { try { result = JSON.parse(lines[i]); } catch {} if (result) break; }
  }
  if (!result) throw new Error(`no JSON in run_edu_post output: ${stdout.slice(-300)}`);

  const live = Array.isArray(result.live_photos) ? result.live_photos : [];
  await postEvent({ run_id: job.run_id, actor: "research", level: "success", message: `Educational post rendered — ${live.length} Live Photos in ${outDir}` });
  notifyMac("Tedca OS — Educational Post ✓", live.length ? `${live.length} Live Photos in Photos.app` : "post.html ready");

  if (live.length) {
    await sendTelegramText(`✅ Your educational post is done — ${live.length} animated Live Photos are in Photos.app ("Claude Live Photos"). AirDrop them to your phone and post.`);
    execFile("open", ["-a", "Photos"], () => {});
  } else {
    await sendTelegramText(`✅ Your educational post copy rendered to ${result.post_html || outDir}. (Live Photo step produced none — opening the preview.)`);
  }
  // always open the composed preview so it's right there
  if (result.post_html) execFile("open", [result.post_html], () => {});
  return result;
}

async function handleTts(job) {
  const { text, voice, outName } = job.params;
  const outDir = path.join(WORKSPACE, "tedca-os", "output");
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${outName}.mp3`);
  await postEvent({ run_id: job.run_id, actor: "research", message: "Mac worker: generating the voiceover with ElevenLabs…", level: "info" });
  await runPython("gen_avatar_vo.py", ["--text", text, "--voice", voice, "--output", outPath]);
  await postEvent({ run_id: job.run_id, actor: "research", message: `Voiceover ready: ${outPath}`, level: "success" });
  await sendTelegramFile(outPath, "🎙 Voiceover ready", "audio");
  // open the folder so the file is right there
  execFile("open", ["-R", outPath], () => {});
  return { path: outPath };
}

async function handleLivephoto(job) {
  const { topic } = job.params;
  const outdir = path.join(WORKSPACE, "tiktok-livephoto", "runs", `os_${Date.now()}`);
  notifyMac("Tedca OS — Live Photo", `Generating "${topic}" on your Mac…`);
  await sendTelegramText(`🎬 Your Mac just started the Live Photo build for "${topic}" — 6 slides (hook → tips → comment CTA). I'll ping you when they're in Photos.`);
  await postEvent({
    run_id: job.run_id, actor: "research", level: "info",
    message: `Mac worker: building the Live Photo set for "${topic}" — copy, 2160x2700 slide loops, Live Photo mint + Photos import (a few minutes)…`,
  });
  const stdout = await runPython("run_livephoto.py", ["--topic", topic, "--outdir", outdir], 30 * 60 * 1000);
  // last stdout line is the JSON result
  const lines = stdout.trim().split("\n");
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("{")) { result = JSON.parse(lines[i]); break; }
  }
  if (!result) throw new Error(`no JSON in run_livephoto output: ${stdout.slice(-300)}`);
  await postEvent({
    run_id: job.run_id, actor: "research", level: "success",
    message: `Mac worker: Live Photos are in Photos.app ("Claude Live Photos" album). ${result.live_photo}`,
  });
  const captions = Array.isArray(result.captions) ? result.captions : [];
  await sendTelegramText(
    `✅ Live Photo set for "${topic}" is done — all 6 are in Photos.app ("Claude Live Photos" album), and Photos is open on your Mac. AirDrop them to your phone and post.` +
      (captions.length ? `\n\nCaption 1: ${captions[0] || ""}\nCaption 2: ${captions[1] || ""}` : "")
  );
  // pop Photos.app open so the set is right there
  notifyMac("Tedca OS — Live Photo ✓", `"${topic}" is in Photos.app — AirDrop & post.`);
  execFile("open", ["-a", "Photos"], () => {});
  return result;
}

async function handleCarousel(job) {
  const { topic } = job.params;
  const outdir = path.join(WORKSPACE, "tedca-os", "output", `carousel_${Date.now()}`);
  await postEvent({
    run_id: job.run_id, actor: "research", level: "info",
    message: `Mac worker: rendering the carousel for "${topic}" — copy, animated slide 1 (MP4) + static slides 2-6 (PNG)…`,
  });
  const stdout = await runPython("run_tedca_carousel.py", ["--topic", topic, "--outdir", outdir], 15 * 60 * 1000);
  const lines = stdout.trim().split("\n");
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("{")) { result = JSON.parse(lines[i]); break; }
  }
  if (!result) throw new Error(`no JSON in run_tedca_carousel output: ${stdout.slice(-300)}`);
  await postEvent({
    run_id: job.run_id, actor: "research", level: "success",
    message: `Mac worker: carousel rendered — ${result.slides.length} slides in ${outdir}`,
  });
  // deliver to the phone: animated slide 1 as video, the rest as photos, caption as text file
  for (const slide of result.slides) {
    const kind = slide.endsWith(".mp4") ? "video" : "photo";
    await sendTelegramFile(slide, "", kind);
  }
  if (result.caption) await sendTelegramFile(result.caption, "📝 carousel caption", "document");
  execFile("open", [outdir], () => {});
  return result;
}

async function handleScrape(job) {
  const { search, limit } = job.params;
  await postEvent({ run_id: job.run_id, actor: "scrape", message: `Mac worker: running Apify scrape "${search}" (limit ${limit})`, level: "info" });
  const stdout = await runPython("scrape_google_maps.py", ["--search", search, "--limit", String(limit), "--json"]);
  // script may print log lines before the JSON array — find the array start
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`no JSON in scraper output: ${stdout.slice(0, 200)}`);
  const items = JSON.parse(stdout.slice(start));
  await postEvent({ run_id: job.run_id, actor: "scrape", message: `Mac worker: scrape finished with ${items.length} results`, level: "success" });
  return items;
}

async function handleAgentosPost(job) {
  const { keyword } = job.params;
  await sendTelegramText(`🎬 Mac worker starting AgentOS post for "${keyword}"…`);
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "info",
    message: `Mac worker: generating AgentOS animated post for "${keyword}"…`,
  });
  let stdout;
  try {
    stdout = await runPython("agentos_animated_post.py", ["--keyword", keyword], 20 * 60 * 1000);
  } catch (e) {
    if (e.message.includes("ENOENT") || e.message.includes("No such file")) {
      throw new Error("agentos_animated_post.py not found — script is not yet installed in execution/");
    }
    throw e;
  }
  // last stdout line should be the JSON result { outdir, files, ... }
  const lines = stdout.trim().split("\n");
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("{")) {
      try { result = JSON.parse(lines[i]); } catch {}
      if (result) break;
    }
  }
  const outdir = result?.outdir || "(see Mac output folder)";
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "success",
    message: `AgentOS post for "${keyword}" done — ${outdir}`,
  });
  // the post script sends the carousel to Telegram itself; worker just confirms
  return result || { keyword, outdir };
}

async function handleAgentosNewSkill(job) {
  const { name, keyword, price, desc, tags, stripe_link, inactive } = job.params;
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "info",
    message: `Mac worker: registering new AgentOS skill "${name}" (${keyword})…`,
  });
  const args = [
    "--name", name, "--keyword", keyword, "--price", price,
    "--desc", desc, "--tags", tags || "", "--stripe-link", stripe_link,
    "--no-card", // site card is published separately via a deploy
  ];
  if (inactive) args.push("--inactive");
  let stdout;
  try {
    stdout = await runPython("agentos_new_skill.py", args, 5 * 60 * 1000);
  } catch (e) {
    if (e.message.includes("ENOENT") || e.message.includes("No such file")) {
      throw new Error("agentos_new_skill.py not found — script not yet installed in execution/");
    }
    throw e;
  }
  const summary = inactive
    ? `"${name}" (${keyword}) staged — sheet row INACTIVE until you flip it`
    : `"${name}" (${keyword}) registered and live`;
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "success",
    message: `AgentOS new skill: ${summary}`,
  });
  return { name, keyword, inactive };
}

async function handleAgentosWire(job) {
  const { keyword, link, message, video_path, post_url } = job.params;

  await sendTelegramText(`🔗 Wiring comment trigger: '${keyword}' → ${link}…`);
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "info",
    message: `Mac worker: writing keyword "${keyword}" → ${link} to the bot's Google Sheet…`,
  });

  // 1. Spawn add_keyword.py to write/update the Sheet row
  const args = [
    path.join(WORKSPACE, "ig-comment-dm", "add_keyword.py"),
    "--keyword", keyword,
    "--link", link,
    "--match-type", "word",
    "--active", "TRUE",
  ];
  if (message) args.push("--message", message);
  if (post_url) args.push("--post-url", post_url);

  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execFile(
        path.join(WORKSPACE, "ig-comment-dm", ".venv", "bin", "python"),
        args,
        { cwd: WORKSPACE, timeout: 60_000 },
        (err, out, stderr) => {
          if (err) return reject(new Error(`add_keyword.py failed: ${(stderr || err.message).slice(0, 500)}`));
          resolve(out);
        }
      );
    });
  } catch (e) {
    if (e.message.includes("ENOENT") || e.message.includes("No such file")) {
      throw new Error("ig-comment-dm/add_keyword.py or its venv not found — check workspace path");
    }
    throw e;
  }

  const firstLine = stdout.trim().split("\n")[0] || "";
  await postEvent({
    run_id: job.run_id, actor: "agentos", level: "success",
    message: `Sheet row written: "${keyword}" → ${link}. ${firstLine}`,
  });

  // 2. Send video to Telegram if one was uploaded
  if (video_path) {
    const fs = await import("node:fs");
    if (fs.existsSync(video_path)) {
      const caption = `📲 New campaign wired: comment '${keyword}' → ${link}. Here's the video — post it to IG + FB.`;
      await sendTelegramFile(video_path, caption, "video");
    } else {
      await sendTelegramText(`⚠️ Campaign "${keyword}" wired but video file not found: ${video_path}`);
    }
  }

  // 3. Done ping
  const scope = post_url ? `locked to ${post_url}` : "fires on all IG + FB posts";
  await sendTelegramText(
    `✅ Campaign wired: comment '${keyword}' on IG or FB now sends people to ${link} (${scope}).` +
    (video_path ? " Video sent above — post it to IG + FB." : "")
  );

  return { keyword, link, video_path };
}

async function pollJobs() {
  try {
    const job = await claimJob();
    if (!job) return;
    console.log(`claimed job #${job.id} (${job.type})`);
    try {
      let result;
      if (job.type === "scrape") result = await handleScrape(job);
      else if (job.type === "tts") result = await handleTts(job);
      else if (job.type === "livephoto") result = await handleLivephoto(job);
      else if (job.type === "carousel") result = await handleCarousel(job);
      else if (job.type === "agentos_post") result = await handleAgentosPost(job);
      else if (job.type === "agentos_new_skill") result = await handleAgentosNewSkill(job);
      else if (job.type === "agentos_wire") result = await handleAgentosWire(job);
      else if (job.type === "motion_graphic") result = await handleMotionGraphic(job);
      else if (job.type === "video_edit") result = await handleVideoEdit(job);
      else if (job.type === "edu_post") result = await handleEduPost(job);
      else if (job.type === "agentos_post_revise") result = await handleAgentosPostRevise(job);
      else throw new Error(`unknown job type ${job.type}`);
      await completeJob(job.id, true, result);
    } catch (e) {
      console.error(`job #${job.id} failed:`, e.message);
      await postEvent({ run_id: job.run_id, actor: "agentos", message: `Mac worker job failed: ${e.message}`, level: "error" });
      if (["livephoto", "carousel", "tts", "agentos_post", "agentos_new_skill", "agentos_wire", "motion_graphic", "video_edit", "edu_post", "agentos_post_revise"].includes(job.type)) {
        await sendTelegramText(`❌ The ${job.type} job hit a problem: ${e.message.slice(0, 300)}`);
      }
      await completeJob(job.id, false, e.message);
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
}

async function main() {
  await postEvent({
    message: `Local worker online on ${os.hostname()} (pid ${process.pid})`,
    level: "success",
  });
  console.log("Worker connected. Polling for jobs every 3s. Ctrl-C to stop.");

  setInterval(pollJobs, 3000);
  setInterval(() => {
    postEvent({ message: "Worker heartbeat", level: "info" }).catch((e) =>
      console.error("heartbeat failed:", e.message)
    );
  }, 60_000);
}

main().catch((e) => {
  console.error("Worker failed to connect:", e.message);
  process.exit(1);
});
