// The whole avatar-video pipeline, end to end, from one topic.
//
//   topic -> script (OpenRouter)  -> audio (ElevenLabs, locked avatar voice)
//         -> video (HeyGen UI, plan credits)  -> thumbnail (HeyGen API, free)
//         -> Telegram
//
// Every stage reuses code that already exists and is already trusted:
//   script    server/src/skills.js      avatarVideoScript()  — same prompt the OS uses
//   voice     server/src/elevenlabs.js  generateVoice()      — locked eleven_v3 settings
//   video     ./make_video.mjs                               — the browser driver
//   telegram  execution/send_telegram_video.py               — handles w/h/duration/thumb
//
// SPENDS CREDITS. HeyGen bills ~0.3 credits/sec of finished video.
//
// usage:
//   node --env-file-if-exists=../../.env --env-file-if-exists=../.env run_pipeline.mjs \
//        --topic "why local businesses lose leads after hours"
//   ...add --dry to stop before the HeyGen render.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY = argv.includes('--dry');
const TOPIC = arg('--topic');
const ASPECT = arg('--aspect', '9:16');
// Reuse an already-generated VO instead of paying ElevenLabs again. Retrying the HeyGen stage
// should not re-bill the stages that already succeeded.
const REUSE_AUDIO = arg('--audio');
const REUSE_SCRIPT = arg('--script');
if (!TOPIC) { console.error('need --topic "..."'); process.exit(1); }

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });

const stamp = Date.now();
console.log(`\n=== AVATAR VIDEO PIPELINE ===`);
console.log(`topic: ${TOPIC}\n`);

// ---- 1. script ---------------------------------------------------------------------------
// skills.js opens the OS SQLite database on import, so only load it when a stage actually
// needs it. When the worker passes --script and --audio, this script must stay a pure
// video-delivery step and touch nothing else.
let script;
let scriptFile;
if (REUSE_SCRIPT) {
  console.log(`[1/5] reusing script ${path.basename(REUSE_SCRIPT)} (no LLM call)`);
  script = fs.readFileSync(REUSE_SCRIPT, 'utf8');
  scriptFile = REUSE_SCRIPT;
} else {
  console.log('[1/5] writing the script (OpenRouter)…');
  const { avatarVideoScript } = await import(path.join(__dirname, '..', 'server', 'src', 'skills.js'));
  script = await avatarVideoScript(TOPIC);
  scriptFile = path.join(OUT, `pipeline_${stamp}_script.txt`);
  fs.writeFileSync(scriptFile, script);
}
console.log(`      ${script.length} chars -> ${path.basename(scriptFile)}`);
console.log('      ---');
console.log(script.split('\n').map((l) => '      ' + l).join('\n'));
console.log('      ---');

// ---- 2. audio ----------------------------------------------------------------------------
let audioFile;
if (REUSE_AUDIO) {
  console.log(`\n[2/5] reusing VO ${path.basename(REUSE_AUDIO)} (no ElevenLabs call)`);
  audioFile = REUSE_AUDIO;
} else {
  console.log('\n[2/5] generating the voice (ElevenLabs, locked avatar voice)…');
  const { VOICE_AVATAR } = await import(path.join(__dirname, '..', 'server', 'src', 'skills.js'));
  const { generateVoice } = await import(path.join(__dirname, '..', 'server', 'src', 'elevenlabs.js'));
  const audio = await generateVoice({ text: script, voice: VOICE_AVATAR });
  audioFile = path.join(OUT, `pipeline_${stamp}_vo.mp3`);
  fs.writeFileSync(audioFile, audio);
  console.log(`      ${audio.length.toLocaleString()} bytes -> ${path.basename(audioFile)}`);
}

if (DRY) {
  console.log('\n--dry: stopping before the HeyGen render. Nothing charged.');
  console.log(`script: ${scriptFile}\naudio:  ${audioFile}`);
  process.exit(0);
}

// ---- 3+4. video + thumbnail --------------------------------------------------------------
console.log('\n[3/5] HeyGen: browser generates (plan credits), API fetches (free)…');
const resultFile = path.join(OUT, `pipeline_${stamp}_result.json`);
await run(process.execPath, [
  path.join(__dirname, 'make_video.mjs'),
  '--audio', audioFile,
  '--aspect', ASPECT,
  '--title', TOPIC.slice(0, 60),
  '--generate',
  '--out', OUT,
  '--result', resultFile,
]);
if (!fs.existsSync(resultFile)) throw new Error('make_video.mjs finished but wrote no result file');
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
console.log(`\n[4/5] video: ${result.file}`);
console.log(`      thumb: ${result.thumb || '(none returned)'}`);

// ---- 5. telegram -------------------------------------------------------------------------
console.log('\n[5/5] sending to Telegram…');
const [w, h] = ASPECT === '16:9' ? [1920, 1080] : [1080, 1920];

// Read duration from the file rather than trusting the API field, which can come back null.
const probe = (f, entries) =>
  new Promise((resolve) => {
    let out = '';
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', f]);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
const dur = Math.round(Number(await probe(result.file, 'format=duration')) || result.duration || 60);

// Telegram's bot API rejects uploads over 50 MB. HeyGen renders 1080p at ~15 Mbps, so a
// 95-second video lands around 175 MB and gets a bare 413. Transcode to fit, targeting the
// bitrate that lands just under the cap for THIS duration rather than a fixed guess.
const MAX_TG = 48 * 1024 * 1024;
let sendFile = result.file;
const rawSize = fs.statSync(sendFile).size;
if (rawSize > MAX_TG) {
  const AUDIO_KBPS = 128;
  const videoKbps = Math.max(500, Math.floor((MAX_TG * 8) / dur / 1000) - AUDIO_KBPS - 50);
  sendFile = result.file.replace(/\.mp4$/, '_tg.mp4');
  console.log(`      ${(rawSize / 1048576).toFixed(1)} MB is over Telegram's 50 MB cap — re-encoding at ${videoKbps}k`);
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', result.file,
    '-c:v', 'libx264', '-preset', 'medium',
    '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
    '-movflags', '+faststart',
    sendFile,
  ]);
  console.log(`      -> ${(fs.statSync(sendFile).size / 1048576).toFixed(1)} MB`);
}
const caption = `🎬 Avatar video — ${TOPIC}\n\n${script.slice(0, 600)}`;
const py = fs.existsSync(path.join(WS, '.venv-leadgen/bin/python'))
  ? path.join(WS, '.venv-leadgen/bin/python')
  : 'python3';
await run(py, [
  path.join(WS, 'execution', 'send_telegram_video.py'),
  sendFile,
  caption,
  result.thumb || '',
  String(w),
  String(h),
  String(dur),
]);

console.log('\n=== PIPELINE COMPLETE ===');
console.log(`script: ${scriptFile}`);
console.log(`audio:  ${audioFile}`);
console.log(`video:  ${result.file}`);
console.log(`thumb:  ${result.thumb || '(none)'}`);
