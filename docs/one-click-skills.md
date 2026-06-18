# One-Click Content Skills

The "/skills" page (One-Click Run) holds three content buttons. Server side: `server/src/skills.js` (LLM via OpenRouter, model `anthropic/claude-sonnet-4.5`) queues `jobs`; the **Mac worker executes them locally** (filesystem + Python + ffmpeg + Photos.app), so **the worker must be running** and pointed at whichever backend you clicked the button on (it currently points at the **cloud** — see [architecture](./architecture.md)). Outputs land in `tedca-os/output/` (or `tiktok-livephoto/runs/`) and Finder opens on the result. ([README](./README.md))

## Locked voices (do not change)

| Voice | ID | Used for |
|---|---|---|
| Tedca female avatar "her" | `19STyYD15bswVz51nqLf` | Avatar Video VO |
| Ted's own cloned voice | `OBxBRsbBsFdxuMVMaacO` | Live Photo / personal brand |

## 1. Avatar Video (`POST /api/skills/avatar-video`)

Topic → emotion-tagged 30–45s script (ElevenLabs v3 audio tags `[emphatic]` etc., 3–5 total, hook-first, ~190 wpm) → `tts` job → worker runs `execution/gen_avatar_vo.py` with the "her" voice → MP3 in `tedca-os/output/avatar_vo_*.mp3`. **Topics must tie back to Tedca's agency services** (AI receptionists, missed-call text-back, lead-gen automation, chatbots, follow-up systems) — this is baked into the prompt. The script is shown in the UI; the user then hands over avatar footage for editing (the skill does NOT generate video). The locked VO method (stability 0.5, style 0.0, ellipses for pauses, spelled-out numbers, 1.20x atempo) lives in `gen_avatar_vo.py` + `directives/tedca_avatar_vo_and_script.md`.

## 2. TikTok Live Photo (`/api/skills/livephoto/topics` + `/run`)

Two-step: **Suggest 5 topics** (LLM, for the personal-brand series "Claude Code things you didn't know it could do", excluding already-covered topics tracked in the `livephoto_topics_done` setting plus a hardcoded past-builds list) → user picks one → `livephoto` job → worker runs `execution/run_livephoto.py`: LLM writes 5-slide poster copy + 2 captions, renders seamless 3s loops at **full 2160×2700 4:5** (never downscale — locked memory rule), mints real Apple Live Photos via `execution/video_to_livephoto.py --max-dim 2700`, auto-imports into Photos.app ("Claude Live Photos" album). User AirDrops to iPhone and posts manually (TikTok has no Live Photo upload API). Uses Ted's personal voice where VO applies. Output dir: `tiktok-livephoto/runs/os_<timestamp>/`. Directive: `directives/tedca_mg_edit_and_livephoto.md`.

## 3. Instagram Carousel (`POST /api/skills/carousel`)

Topic → `carousel` job → worker runs `execution/run_tedca_carousel.py`: LLM writes 6-slide copy, then deterministic local rendering (PIL + ffmpeg, no image-API cost):
- `slide1.mp4` — **animated 6s looping cover** (charcoal, Anton headline, ringing-phone illustration)
- `slide2..6.png` — **static** editorial cards (cream, locked v3 style)
- `caption.txt` + `manifest.json`

⚠️ **This INVERTS the older Tedca carousel directive** (which was: slide 1 static PNG, slides 2–6 looping MP4s). The inversion is per the user's 2026-06 spec — trust the script, not the old memory/directive.

## Current status (honest)

- **All three are wired end-to-end** (UI → API → job queue → worker → Python → output).
- **Carousel: test-rendered ✓** — see `tedca-os/output/carousel_test/` (slide1.mp4 + 5 PNGs + caption + a visual-audit frame).
- **Live Photo:** the background agent building it **crashed at the finish (API 529)** but the artifacts were verified good. A VO test output exists (`tedca-os/output/livephoto_vo_*.mp3`).
- **Needs one verification pass across all three skills, clicked from the live cloud UI with the worker running.** This is the user's current focus (next-steps ④).
- Remember the **visual-audit rule**: read the rendered PNGs/frames before telling the user a render is good.
