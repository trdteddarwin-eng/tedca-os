# heygen — drive HeyGen's web UI instead of its API

## Why this exists

The Avatar Video skill in the OS already goes **topic → script → your approval → ElevenLabs VO**
(`/api/skills/avatar-video/script` and `/api/skills/avatar-video/voice`). It stops there, and the
last step is done by hand: take the mp3, open HeyGen, upload it, pick the avatar, generate,
download.

This folder closes that gap **without touching the HeyGen API**, because API runs bill separately
from the subscription. Driving the web UI spends the plan credits already paid for.

## The credential rule

**No HeyGen password lives in this repo, in `.env`, or in any script.** You log in once, by hand,
in a real Chrome window. Chrome stores the session in a profile directory kept deliberately
outside the workspace:

```
~/.tedca/heygen-profile
```

Every later run reuses it headlessly. If HeyGen signs you out, run `login.mjs` again. That
directory holds live session cookies — treat it like a credential, never copy it anywhere.

## Files

| file | what it does |
|---|---|
| `login.mjs` | Opens a visible Chrome on HeyGen, waits for you to sign in, saves the session. Run once. |
| `probe.mjs` | Reuses the session, dumps real DOM + screenshots to `_probe/`. Spends no credits. |
| `make_video.mjs` | The driver: audio file in, finished MP4 out. *(written against probe output)* |

## Why there is a probe step

Selectors for a third-party SPA cannot be written from memory. HeyGen renames and re-nests its
controls, and a guessed selector fails **silently** — it clicks nothing, or clicks the wrong
thing and burns a credit on a broken render. `probe.mjs` writes down what is actually on the
page so the driver targets real elements.

This is also the repair procedure. When HeyGen ships a redesign and `make_video.mjs` starts
failing, re-run `probe.mjs`, diff `_probe/*.json` against what the driver expects, and fix the
selector. Do not "fix" it by adding waits.

## Where this runs

On the Mac, not in the cloud — it needs a real browser holding your logged-in session. The OS
already has this pattern: cloud queues a job, the Mac worker picks it up (see the `job.type`
dispatch in `worker/index.js`, e.g. `tts`, `livephoto`, `motion_graphic`). The HeyGen step
becomes one more job type, so the OS button works the same way the others do — it just needs
the Mac awake.

## Cost

Each generated video spends **HeyGen plan credits**, same as if you clicked the buttons
yourself. That is the entire point. Nothing here calls a metered API.
