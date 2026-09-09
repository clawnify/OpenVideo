# OpenVideo — agent guide

This app turns **HTML compositions into MP4 videos** using HeyGen HyperFrames.
You author compositions as plain HTML, the user drops in media (logos, product
demos), and renders run on the managed Clawnify render service. You never touch
Chrome or FFmpeg — you write HTML and call this app's API.

Base URL: this app's own origin. All endpoints are under `/api`.

## Composition format (HyperFrames)

A composition is one HTML fragment with a root element carrying
`data-composition-id`, `data-width`, `data-height`. Timed elements get
`class="clip"` plus `data-start` / `data-duration` (seconds) /
`data-track-index`. Animate with a **paused** GSAP timeline registered on
`window.__timelines[<composition-id>]`.

```html
<div id="root" data-composition-id="promo" data-start="0" data-width="1920" data-height="1080"
     style="width:1920px;height:1080px;background:#0b1020;position:relative;font-family:sans-serif">
  <img src="assets/logo.png" class="clip" data-start="0" data-duration="6" data-track-index="0"
       style="position:absolute;top:80px;left:80px;width:160px" />
  <h1 id="title" class="clip" data-start="0.5" data-duration="6" data-track-index="0"
      style="position:absolute;top:48%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:90px">
    Introducing Northwind
  </h1>
  <video src="assets/demo.mp4" class="clip" data-start="2" data-duration="6" data-track-index="1"
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 1 }, 0.5);
    window.__timelines = window.__timelines || {};
    window.__timelines["promo"] = tl;
  </script>
</div>
```

Keep `data-composition-id` unique per composition and matching the
`window.__timelines` key.

## Embedding the user's media

Media the user uploads lives in the **Media library** and is referenced from the
HTML by path: `assets/<key>`. Reference it as `<img src="assets/logo.png">` or
`<video src="assets/demo.mp4">`. At render time the app automatically ships only
the assets your HTML actually references — you don't attach them manually.

To list what's available: `GET /api/assets` → `[{ key, name, content_type }]`.
Use the exact `key` in `assets/<key>`. (Users upload via the Media tab; you can
also upload programmatically with a multipart `POST /api/assets`.)

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/compositions` | List compositions |
| GET  | `/api/compositions/{id}` | Get one (includes `html`) |
| POST | `/api/compositions` | Create `{ name, description?, html?, fps? }` |
| PUT  | `/api/compositions/{id}` | Update any of `name/description/html/fps` |
| DELETE | `/api/compositions/{id}` | Delete |
| GET  | `/api/assets` | List uploaded media |
| POST | `/api/renders` | Render `{ composition_id }` → returns the job |
| GET  | `/api/renders` | List render jobs |
| GET  | `/api/projects` | List footage edit projects |
| GET  | `/api/projects/{id}` | Get one (includes the `edl` document and `brief`) |
| POST | `/api/projects` | Create `{ name, brief?, edl? }` (empty 720p timeline if omitted) |
| PUT  | `/api/projects/{id}` | Update `{ name?, brief?, edl? }` — the EDL is validated on save |
| POST | `/api/projects/{id}/autocut` | `{ asset_ids, prompt? }` — AI assembles the main track from several clips |
| DELETE | `/api/projects/{id}` | Delete a project and its export history |
| POST | `/api/projects/{id}/export` | Export `{ quality? }` → returns the job (blocks until done) |
| GET  | `/api/exports?project_id={id}` | Export history |
| POST | `/api/assets/{id}/analyze` | AI cut/caption proposals for a clip (ms timestamps) |

## Footage edit projects (EDL)

Compositions are for motion graphics you author as HTML. **Edit projects are
for real footage**: cut, trim and sequence the user's uploaded clips, overlay
images and text, and mix music underneath — then export to MP4. The document
is an **EDL (edit decision list)**, plain JSON you read and transform.

Rules that make editing easy to reason about:

- **The main track is an ordered array.** Clips play end-to-end in array
  order — there are no start times to recompute. Reordering is moving array
  elements; splicing a clip in is an array insert.
- **Media is referenced as `asset:<id>`** using ids from `GET /api/assets`
  (video, image and audio files all work). `https://` URLs are also accepted
  for small public media.
- **Times are seconds. Positions and sizes are canvas fractions** (0..1), so
  you never do pixel math.
- **Overlays and audio float on the output timeline** with `startTime` +
  `duration`; overlay tracks composite in array order (later = on top).
- Validation errors (on `PUT` and on export) return
  `{ error, detail, path }` where `path` is a JSON pointer like
  `/main/elements/2/trimStart` — go to that node, fix it, save again.

A complete document:

```json
{
  "version": 1,
  "output": { "width": 1280, "height": 720, "fps": 30, "background": "#000000" },
  "main": {
    "elements": [
      { "id": "intro", "type": "video", "src": "asset:3f9c2a1b8d4e6f70", "trimStart": 2 },
      { "id": "screen", "type": "video", "src": "asset:9a1d4c7e2b5f8036", "fit": "cover", "sourceAudio": false },
      { "id": "outro", "type": "image", "src": "asset:5e8b1f4a7c2d9063", "duration": 3 }
    ]
  },
  "overlays": [
    { "id": "titles", "elements": [
      { "id": "hook", "type": "text", "text": "Three features.\nOne minute.", "fontSize": 72,
        "startTime": 0.5, "duration": 3, "x": 0.5, "y": 0.12, "align": "center",
        "color": "#ffffff", "background": "#00000080" }
    ]},
    { "id": "brand", "elements": [
      { "id": "logo", "type": "image", "src": "asset:1c6f3e9b5a8d2074",
        "startTime": 0, "duration": 60, "x": 0.85, "y": 0.05, "width": 0.1, "opacity": 0.85 }
    ]}
  ],
  "audio": [
    { "id": "music", "elements": [
      { "id": "bed", "type": "audio", "src": "asset:7d2a5f8c1e4b9036", "startTime": 0, "volume": 0.35 }
    ]}
  ]
}
```

Field reference (main-track clips): `trimStart`/`trimEnd` cut seconds off the
source's head/tail; video clips also accept `duration` — **play N seconds from
`trimStart`** — which wins over `trimEnd` and lets you cut without knowing the
source's length (prefer it when working from analysis timestamps:
`trimStart: start_ms/1000, duration: (end_ms-start_ms)/1000`); `fit` is
`"contain"` (letterbox on the background color, default) or `"cover"` (fill
and crop); `sourceAudio: false` mutes a clip's own sound; images need an
explicit `duration`. Text overlays: `fontFamily`
(`sans`/`serif`/`mono`), `fontSize` in px at output resolution, optional boxed
`background` (`#RRGGBBAA` works). Media overlays: `width` as a fraction of
canvas width, height keeps aspect. Audio elements: `volume` 0..2, `duration`
defaults to the source's length minus trims. Output duration (sum of the main
track) maxes at 5 minutes.

### Worked examples (read → transform → save)

Every edit is the same loop: `GET /api/projects/{id}` → change the `edl`
object → `PUT /api/projects/{id}` with `{ "edl": … }`. The PUT validates and
tells you exactly what's wrong if anything is.

**1. "Cut the first 10 seconds off the intro"** — add trim to that clip:

```json
{ "id": "intro", "type": "video", "src": "asset:3f9c2a1b8d4e6f70", "trimStart": 10 }
```

**2. "Put the demo clip between the intro and the outro"** — array insert at
index 1 of `main.elements` (nothing else changes — no start-time math):

```json
"elements": [
  { "id": "intro",  "type": "video", "src": "asset:3f9c2a1b8d4e6f70" },
  { "id": "demo",   "type": "video", "src": "asset:9a1d4c7e2b5f8036" },
  { "id": "outro",  "type": "image", "src": "asset:5e8b1f4a7c2d9063", "duration": 3 }
]
```

**3. "Show 'Try it free' in the last 4 seconds"** — if the main track sums to
48s, add to an overlay track:

```json
{ "id": "cta", "type": "text", "text": "Try it free", "fontSize": 96,
  "startTime": 44, "duration": 4, "x": 0.5, "y": 0.45, "align": "center",
  "color": "#ffffff", "background": "#000000aa" }
```

### The brief: purpose comes first

A cut is only "effective" relative to a goal — without one, the only honest
edit is mechanical cleanup (dead air, false starts). So: **set the project's
`brief`** ("30-second product teaser for Instagram — energetic") before asking
for AI help, and it anchors every AI action. Ask the user for the purpose if
you don't know it.

### Auto-cut: assemble from several clips

When the user has multiple raw clips ("cut these together the best way"),
don't analyze them one at a time — ordering and cross-clip redundancy can't be
judged per clip. Use:

```
POST /api/projects/{id}/autocut
{ "asset_ids": ["<video asset ids>"], "prompt": "optional extra steer" }
```

One model pass watches **all** the clips together against the project brief
and replaces the main track with the assembled sequence (using
`trimStart`+`duration` windows) plus a captions overlay track. The response is
the updated project (with `notes` on the editorial choices). Up to 8 clips.
Review the result, adjust, export.

### Analyzing footage (single-clip clean-up)

For one clip with obvious good parts (interview take, screen recording), ask
for a clean-up analysis — and pass the brief + surroundings as `prompt` so
even cleanup isn't blind:

```
POST /api/assets/{id}/analyze
{ "mode": "cuts" | "captions" | "both", "prompt": "optional brief, e.g. keep only the demo moments" }
```

A multimodal model watches the clip and returns, in a few seconds:

```json
{
  "cuts": [
    { "start_ms": 3200, "end_ms": 21400, "label": "product walkthrough", "keep": true },
    { "start_ms": 21400, "end_ms": 29800, "label": "presenter searches for a tab", "keep": false }
  ],
  "captions": [
    { "start_ms": 3600, "end_ms": 6100, "text": "This is the new dashboard" }
  ],
  "notes": "…editorial observations…"
}
```

Turning that into an EDL is arithmetic (divide by 1000):

- A **keep segment** `[start_ms, end_ms]` of a clip you reference as `asset:X`
  becomes a main-track element with `trimStart: start_ms/1000` and
  `trimEnd: sourceDuration - end_ms/1000`. Several keep segments from the same
  source are simply several main-track elements with the same `src` and
  different trims — in order.
- A **caption** becomes a text overlay with `startTime`/`duration` computed on
  the **output timeline** (after cutting, output time ≠ source time — offset
  each caption by the total duration of the kept segments before it).

Analysis is advisory — you decide what to keep. Re-run with a sharper `prompt`
if the proposal misses the brief.

### Exporting

`POST /api/projects/{id}/export` with optional
`{ "quality": "draft" | "standard" | "high" }` (draft is fast — use it for
review cuts, then export `high` for the final). The call blocks (up to a few
minutes) and returns the job: `status: "completed"` with `output_url`,
`duration`, `size` — or `status: "failed"` plus a `failure` object with the
same `{ error, detail, path }` shape as validation, so you can fix the EDL and
export again. Your library media is staged to the edit service automatically
on first use; you never manage that.

## Authoring flow

1. Read the brief. Pick dimensions (1920×1080 landscape, 1080×1080 square,
   1080×1920 vertical/reel) from the use case.
2. `GET /api/assets` to see the user's logo / demo clips and their `key`s.
3. Write the composition HTML, referencing media as `assets/<key>`, and
   `POST /api/compositions` (or `PUT` to revise an existing one).
4. `POST /api/renders { composition_id }`. The call blocks until the MP4 is
   ready (up to ~a minute) and returns the job with `output_url`, or
   `status: "failed"` with an `error` to fix and retry.
5. Share the rendered video's `output_url`.

## How rendering works (so you can reason about failures)

`POST /api/renders` ships your composition HTML + referenced assets to
Clawnify's managed render service, which runs `hyperframes render` and returns
the MP4. The app itself does no rendering — it's a thin client. Failures usually
mean: a malformed composition (missing `data-composition-id`/dimensions, or a
timeline not registered on `window.__timelines`), or a referenced asset path
that doesn't match a real `key`. Read `error`, fix the HTML, render again.
