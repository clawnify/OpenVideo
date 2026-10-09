# OpenVideo — agent guide

This app edits **real footage into MP4 videos**. The user (or you) uploads
clips, stills and music to the media library; a **project** arranges them on a
timeline (cut, trimmed and sequenced, with text and images on top and music
underneath) and exports run on the managed Clawnify edit service. You never
touch a video encoder: you read and write a project's plain-JSON document and
call this app's API.

Base URL: this app's own origin. All endpoints are under `/api`.

## Media library

Everything a project uses lives in the media library. `GET /api/assets` lists
it as `[{ id, key, name, content_type, size, duration }]`; a project references
a file as `asset:<id>`. Users upload from the editor's Media panel; you can
upload with a multipart `POST /api/assets` (field `file`), which returns the
new asset row.

A video uploaded in the editor or imported from Drive goes to the managed
media service rather than this app's storage: it can be hours long (up to
30 GB), the bytes never pass through this app, and the export reads only the
seconds a cut needs. Such an asset carries `media_uid` and is not playable
until `GET /api/assets/{id}/playback` answers `ready`. The editor uploads a
video in three steps: `POST /api/assets/uploads { name, size, type?, duration? }`
returns a one-time resumable (tus) `upload_url`, the browser sends the file
there, and `POST /api/assets/media { uid }` adds it to the library. An upload
nobody registered is settled on its own: once finished it joins the library,
and one left unfinished past its 6-hour link is deleted. Stills, sound, and anything posted to `POST /api/assets` stay
in app storage, where a file has to be 500 MB or smaller to export.

When the org has Google Drive (or Google Workspace) connected, files can also come from Google
Drive: search with `GET /api/drive/files`, then `POST /api/drive/import` with a
file's `id` to copy it into the library. The import returns the new asset row,
the same as an upload, and the project references it as `asset:<id>`. Check
`GET /api/drive` first: `{ "connected": false }` means the org has to connect
Google Drive in the Clawnify dashboard before any of this works. It also
returns `folder`: when set, the org limited browsing and importing to that one
Drive folder and its subfolders, and a file outside it is refused. Pass
`folder=<id>` to `GET /api/drive/files` to list one folder (its subfolders come
back as `folders`); a search looks inside that folder only, never the subtree.

## Footage from a Drive folder

A shoot usually arrives as a Google Drive folder shared with "anyone with the
link": a folder per camera, hundreds of clips. Start a project from it, or add
one to a project:

```
POST /api/projects                     { "folder": "<folder link>", "name"?, "brief"?, "language"?: "en" }
POST /api/projects/{id}/footage/folders { "url": "<folder link>", "language"?: "en" }
```

Every video in the folder, and in every folder inside it, becomes the
project's own footage (photos and other files are left out). It is listed with
that project only (`GET /api/assets?project={id}`), and deleting the project
deletes it. No Drive connection is needed: the folder only has to be shared
with the link, and one that isn't answers 422 `folder_unreadable`. The answer's
`footage` says how many videos were found and how many were new.

Each clip is then copied to the media service and **logged** by the
platform's video analysis, a few at a time, in the background. The platform
queue moves the work on every minute, so nothing has to stay open; every read
below also moves it on. Read progress and the logs with:

```
GET /api/projects/{id}/footage             50 clips a page with full logs (limit up to 200, offset)
GET /api/projects/{id}/footage?logs=0      every clip, with only each log's summary, kind and quality
    &folder=Day 1/Cam B                    one folder and everything inside it
    &kind=interview|stage|b-roll|other     what the log says the clip is
    &status=waiting|importing|ready|failed
GET /api/projects/{id}/footage/{clipId}    one clip with its full log
```

The answer carries `counts` (`total`, `waiting`, `importing`, `ready`,
`failed`, `logged`, `logging`, `log_failed`), `imports_paused` and
`logging_paused` (why nothing more is starting when the workspace has hit a
limit: storage full, the plan's monthly video allowance, credits; null
otherwise), `next_offset`, and `items`:

```jsonc
{
  "id": "…", "name": "B_0012.MP4", "folder": "Day 1/Cam B",
  "status": "ready",                       // waiting | importing | ready | failed
  "asset": { "id": "…", "duration": 41.2 }, // the EDL uses "asset:<id>"
  "log_status": "done",                    // preparing | running | done | failed
  "log": {
    "summary": "…", "kind": "interview", "quality": "good", "issues": "",
    "quotes": [{ "start": 12.0, "end": 18.4, "text": "…", "speaker": "woman in a green blazer" }],
    "moments": [{ "start": 3.0, "end": 8.5, "description": "…" }],
    "visible_text": ["…"]
  }
}
```

Times in a log are seconds into the clip, so a quote is a main-track clip as
it stands: `{ "type": "video", "src": "asset:<asset.id>", "trimStart": start,
"duration": end - start }`. A log quotes only the strongest lines; the clip's
transcript (`GET /api/assets/{id}/transcript`) has every word.

To cut a video from a shoot: read every log (page through, or `logs=0` first
and then the folders you need in full), choose the soundbites and the moments
to cut away to for the brief, and write the main track. One scene filmed by
several cameras shows up once per camera folder: use one angle, or cut between
them. Then add titles, music and transitions as usual.

### Highlights: the selects, chosen for you

Rather than read every log yourself, ask for the project's **highlights**: for
every logged clip, whether it is worth an editor's time (and why not, when it
isn't) and the parts to cut from, each with a 1 to 5 score against the brief
and the reason. They are read from the logs and transcripts in the background,
a folder at a time, and clips logged later join by themselves.

```
POST  /api/projects/{id}/highlights          { "brief"?: "…", "again"?: true }
GET   /api/projects/{id}/highlights          best first, 100 a page (limit up to 1000, offset)
      &kind=soundbite|broll  &min_score=2..5  &folder=Day 1/Cam B
      &pick=open|keep|drop|not_dropped|all   &sort=score|clip  &skipped=1
PATCH /api/projects/{id}/highlights/{hid}    { "pick"?: "keep"|"drop"|null, "start"?, "end"?, "speaker"?, "text"? }
POST  /api/projects/{id}/highlights/items    { "clip": "<clipId>", "start"?, "end"?, "kind"?, "text"? }
GET   /api/projects/{id}/highlights/export?format=csv|xml&pick=keep|not_dropped&root=&fps=
```

`again` reads every clip again; what a person kept or dropped stays as it is.
A soundbite's `speaker` is who says it as the clip's log describes them; it
names a person only when the clip itself does (said, shown or logged), so
correct it with the person's name and title when you know them.
A highlight is `{ id, clip: { id, name, folder, asset_id }, kind, start, end,
text, speaker, score, reason, pick }`, times in seconds into the clip: as a
main-track clip, `{ "type": "video", "src": "asset:<clip.asset_id>",
"trimStart": start, "duration": end - start }` (b-roll usually with
`"sourceAudio": false`). `skipped=1` adds the clips set aside, with `reason`.

`format=xml` is a timeline for Premiere Pro or DaVinci Resolve (FCP7 XML: a
Soundbites and a B-roll sequence, the picks end to end on the camera files,
the words, score and reason on a marker per clip). The editor downloads the
footage folder without renaming anything, imports the .xml and points their
editor at that folder; `root=` is where they downloaded it, so the files are
found without relinking. The file carries no camera timecode yet: in Resolve,
set Project Settings > Conform Options > Use Timecode to "From the source clip
frame count" before importing. `format=csv` is the same list as a sheet, with
each file's Drive link.

`POST /api/projects/{id}/instruct` sees the highlights too: "make a 60 second
cut from the kept soundbites" places them with its `add_highlight` operation.

Google Drive limits how often a file shared with the link can be downloaded,
and on a heavy day it refuses the files of a whole folder for a while. A clip it
refuses is not failed: it waits (`status: "waiting"` with `retry_at`, counted in
`counts.drive_waiting`) and is tried again by itself, further apart each time,
for about a day, after which it fails with the reason. `imports_paused` says so
when every waiting clip is waiting on Drive. A copy of the folder in another
Drive account has its own limit.

When the org has a Google Drive connection whose account can open the
folder, clips are downloaded through it instead, as that account, which
Drive's limit on shared links doesn't touch. Those downloads run in the
background steps only. A file too big for the connection's temporary storage
(seen at 9 GB; 3.4 GB passed) is copied inside Google into a temporary
folder of the connected account ("OpenVideo imports (temporary)"), shared
with the link, imported from the copy, and the copy is deleted once the
import is over (or with the project). Only if that fails too does it come by
the original's shared link.

A source over the video host's 200 Mbps cap (all-intra camera files) is
re-encoded on the way in, by itself: it imports a little later, as high-quality
H.264.

`POST /api/projects/{id}/footage/sync` looks in the folders again and takes in
files added since; a clip deleted from the project stays out.
`POST /api/projects/{id}/footage/retry` puts every failed import and log back
in line, and asks Drive again now for the clips waiting on it. `DELETE /api/projects/{id}` deletes the footage a batch at a time: a
`202 { remaining }` means call it again.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/assets` | List uploaded media; `?project={id}` adds that project's footage from Drive |
| POST | `/api/assets` | Upload one file into app storage (multipart, field `file`) → the asset |
| POST | `/api/assets/uploads` | `{ name, size, type?, duration? }` opens a resumable upload of a video on the media service → `{ uid, upload_url }` (503 `media_unavailable` in local dev) |
| POST | `/api/assets/media` | `{ uid }` adds a finished upload to the library → the asset |
| DELETE | `/api/assets/uploads/{uid}` | Cancels or discards an upload that has not joined the library |
| POST | `/api/assets/{id}/analyze` | AI cut/caption proposals for a clip (ms timestamps) |
| GET  | `/api/drive` | Whether Google Drive is connected: `{ connected }` |
| GET  | `/api/drive/files?kind=media\|audio&q=&page=` | Search the org's Drive, newest first → `{ files, nextPageToken }` |
| POST | `/api/drive/import` | `{ fileId, duration? }` brings a Drive file into the library → the asset |
| GET  | `/api/assets/{id}/source` | The asset's bytes, wherever they live (a redirect) |
| GET  | `/api/assets/{id}/playback` | For long footage: `{ ready, hls, thumbnail, duration }` |
| GET  | `/api/assets/{id}/frame?t=` | One frame of long footage, as an image |
| GET  | `/api/assets/{id}/transcript?lang=en` | The clip's transcript for captions → `{ status, vtt? }` |
| DELETE | `/api/assets/{id}` | Remove from the library; 409 `in_use`, naming the projects, while any project uses it |
| PUT  | `/api/drive/folder` | `{ folderId }` limits browsing to one folder, `null` clears it |
| GET  | `/api/projects` | List projects |
| GET  | `/api/projects/{id}` | Get one (includes the `edl` document and `brief`) |
| POST | `/api/projects` | Create `{ name, brief?, edl? }` (empty 720p timeline if omitted), or `{ folder, name?, brief?, language? }` from a Drive folder |
| GET  | `/api/projects/{id}/footage` | The project's footage from Drive and each clip's log; moves the import and logging on → `{ counts, items, next_offset, imports_paused, logging_paused }` |
| GET  | `/api/projects/{id}/footage/{clipId}` | One clip with its full log |
| POST | `/api/projects/{id}/footage/folders` | `{ url, language? }` adds a Drive folder shared with the link |
| POST | `/api/projects/{id}/footage/sync` | Takes in files added to the folders since → `{ added }` |
| POST | `/api/projects/{id}/footage/retry` | Puts failed imports and logs back in line → `{ imports, logs }` |
| POST | `/api/projects/{id}/highlights` | Find the footage's highlights `{ brief?, again? }` (in the background) |
| GET  | `/api/projects/{id}/highlights` | The highlights, best first, filtered and paged → `{ clips, counts, highlights, next_offset, paused }` |
| PATCH | `/api/projects/{id}/highlights/{hid}` | A person's call `{ pick?: keep\|drop\|null, start?, end?, speaker?, text? }` |
| POST | `/api/projects/{id}/highlights/items` | A person's own pick `{ clip, start?, end?, kind?, text? }`, kept |
| GET  | `/api/projects/{id}/highlights/export` | `format=csv\|xml`: a sheet, or a Premiere Pro / Resolve timeline of the picks |
| PUT  | `/api/projects/{id}` | Update `{ name?, brief?, edl? }` — the EDL is validated on save |
| POST | `/api/projects/{id}/autocut` | `{ asset_ids, prompt? }` — AI assembles the main track from several clips |
| POST | `/api/projects/{id}/instruct` | `{ instruction }` — change the existing cut in words → `{ edl, said, applied }` |
| DELETE | `/api/projects/{id}` | Delete a project, its export history and its footage from Drive; `202 { remaining }` means call again |
| POST | `/api/projects/{id}/export` | Export `{ quality? }` → returns the job, `status: "exporting"` |
| GET  | `/api/exports/{id}` | One export; read it until it is no longer `exporting` |
| GET  | `/api/exports?project_id={id}` | Export history |
| GET  | `/api/projects/{id}/share` | The project's share link → `{ url, export_id, newer_export }` (`url: null` when off) |
| PUT  | `/api/projects/{id}/share` | Turn the link on, or move it to the newest export → `{ url }`; the address stays the same |
| DELETE | `/api/projects/{id}/share` | Turn the link off; the address stops working for everyone |

## The project document (EDL)

A project's document is an **EDL (edit decision list)**: plain JSON you read
and transform, then save back.

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
      { "id": "outro", "type": "image", "src": "asset:5e8b1f4a7c2d9063", "duration": 3,
        "transition": { "type": "dissolve", "duration": 0.5 } }
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
      { "id": "bed", "type": "audio", "src": "asset:7d2a5f8c1e4b9036", "startTime": 0, "volume": 0.35, "fadeIn": 1, "fadeOut": 2 }
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
and crop); on a `"cover"` clip, `anchor: { x, y }` (0..1, default 0.5/0.5)
picks which part stays in frame, as CSS object-position does: `x: 0` keeps
the left edge, `x: 1` the right, and only the side that spills over moves;
`crop: { x, y, width, height }` keeps one rectangle of the source frame, in
shares of its width and height (`{ "x": 0.5, "y": 0, "width": 0.5, "height": 1 }`
is the right half). The crop is cut out first, then fitted or filled like
footage shot at that size, so a crop of the output's own shape on a `"cover"`
clip shows exactly the crop. Media overlays take `crop` too (a face cut out
of a screen recording for a picture-in-picture), and their height follows
what is kept. Leave `crop` out to keep the whole frame;
`sourceAudio: false` mutes a clip's own sound; images need an
explicit `duration`. Every clip and overlay takes `fadeIn` and `fadeOut`, in
seconds (0..30). On a main-track clip they fade the picture up from black and
down to black, and the clip's own sound with it: end the video on a fade with
`fadeOut` on the last clip, and make a fade through black between two clips
with `fadeOut` on one and `fadeIn` on the next. Nothing on the timeline moves,
so overlay and audio times stay as they are. On a text or media overlay they
fade it from and to transparent; a fade-out on an overlay that runs past the
end of the video ends where the video does. A main-track clip after the first
takes `transition: { "type", "duration" }`, how it comes in from the clip
before it instead of a hard cut: `dissolve` (a cross-dissolve), `fade-black`
and `fade-white` (through a colour), `wipe-left`, `wipe-right`, `wipe-up`,
`wipe-down` (the edge travels that way), `slide-left`, `slide-right`,
`slide-up`, `slide-down` (the next clip pushes the last one out), `blur` or
`pixelize`; `duration` is 0.05 to 5 seconds, and 0.5 suits most cuts. It is
centred on the cut, half before it and half after, and moves no clip: the
outgoing clip plays on past its out-point and the incoming one starts before
its in-point, into the footage beyond their trims (a clip that starts at 0:00
holds its first frame for that part). So overlay and audio times stay where
they are and the video keeps its length. One longer than the clips on either
side allow is shortened to fit, and one on the first clip is left out of the
export. Every main-track clip and media overlay takes `adjust: { "brightness",
"contrast", "saturation", "temperature" }`, each -1..1 with 0 leaving the
picture alone (the editor shows -100..100): brightness is a gain (1 doubles,
-1 halves), contrast pivots on mid grey, saturation -1 is black and white, and
temperature above 0 is warmer. Leave out what you do not change. Flat log
footage usually wants contrast and saturation up (0.2 to 0.4 each); footage
from one camera usually wants the same values on every clip of it. You cannot
see the picture: change colour when asked, or when a clip's log says it is
flat, dark or off-colour, and say what you set. Text overlays: `fontFamily`
(`sans`/`serif`/`mono`), `fontSize` in px at output resolution, optional boxed
`background` (`#RRGGBBAA` works), optional `stroke: { "color": "#000000",
"width": 4 }` for an outline around the letters (opaque colour; `width` in px
at output resolution, drawn outside them and at most a fifth of `fontSize`,
since a wider outline fills the letters in; white text with a black stroke
reads on any footage without a box). Media overlays: `width` as a fraction of
canvas width, height keeps aspect. Audio elements: `volume` 0..2, `duration`
defaults to the source's length minus trims; `fadeIn` and `fadeOut` are
seconds (0..30) of ramp from and to silence. The fade-out ends where the clip
is last heard, which is the end of the video when the clip runs past it, so
music laid under a shorter cut needs no trimming to end cleanly: set
`fadeOut: 2` and leave its length alone. Output duration (sum of the main
track) maxes at 5 minutes.

**Format** (the video's shape) is `output.width` x `output.height`: even
numbers, at most 3840x2160. At the default resolution the presets are 1280x720
(16:9), 720x1280 (9:16, Reels, TikTok, Shorts), 1280x1280 (1:1), 1024x1280
(4:5, Instagram feed) and 1280x960 (4:3). To reshape a finished edit, ask for
it through `/instruct` ("make it vertical"): it applies the editor's own rule,
which keeps the long side, scales `fontSize` (and a text `stroke`) by the change in the short side
and keeps each logo's size on screen and the side of the frame it sits on.
Clips keep their `fit`; set `"cover"` on each to fill the new frame instead of
showing bars.

**Captions** are a project setting, not overlays: an optional `captions` block,
`{ "enabled": true, "lang": "en", "style": { "size": 0.055, "position":
"bottom", "margin": 0.08, "background": true, "outline": false, "color":
"#ffffff", "maxChars": 32 } }` (`size` and `margin` are shares of the frame's
height; `outline` draws a black outline sized to the text, with or without
the box). The words come
from each clip's transcript and the part of it the clip plays, so captions
follow every trim, split and reorder; nothing is stored per caption. Only
footage on the media service (uploaded in the editor, or imported from Drive) has a transcript: poll
`GET /api/assets/{id}/transcript` until `status` is `ready` (`no_speech` for a
silent clip, `unavailable` for footage in app storage). Languages: en, it, es,
fr, de, nl, pt, pl, cs, ru, ja, ko. Use text overlays for titles and anything
placed by hand; don't add captions on footage that already shows subtitles.

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
{ "mode": "cuts" | "captions" | "both", "prompt": "optional brief, e.g. keep only the demo moments",
  "window": { "start": 5, "end": 25 } }
```

`window` (optional, seconds into the source) is the part of the source the clip
plays. Pass it: the model then watches only that part, which is also what lets a
short clip cut from a long master be analysed at all (a clip that itself plays
longer than 5 minutes is refused), and every returned timestamp stays inside it,
so applying the result never brings back footage already trimmed away.
Timestamps are always in source time, whether or not a window was given.

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
review cuts, then export `high` for the final). The call returns once the
render is submitted, with the job at `status: "exporting"`. The render runs in
the background, so read `GET /api/exports/{id}` every few seconds until the
status changes: `"completed"` with `output_url`, `duration` and `size`, or
`"failed"` with the reason in `error`. Each read is what collects a finished
render, so keep reading; nothing arrives on its own. A long cut can take
several minutes, longer if other renders for the org are queued ahead of it.

If the EDL is refused before the render starts, the POST already returns
`status: "failed"` plus a `failure` object with the same `{ error, detail,
path }` shape as validation, so you can fix the EDL and export again. Your
library media is staged to the edit service automatically on first use; you
never manage that.

### Sharing

`output_url` only opens for people signed in to this workspace. To send the
video to anyone else (a client, a reviewer), `PUT /api/projects/{id}/share`
once an export has finished, and give them the returned `url`: a page that plays
that export, with a Download button, no sign-in. The link is pinned to the
export that was newest when you called it, so a later draft never reaches
viewers. After exporting the version they should see, `PUT` again: the same
address now plays it (`newer_export` in the response tells you one exists).
With nothing exported the call answers 409 `nothing_exported`. Only turn the
link off (`DELETE`) when the user asks: it cannot be brought back, and a new
link gets a new address.

## Typical flow

1. Get the purpose and set it as the project's `brief` (ask if you don't know).
2. `GET /api/assets` to see the user's footage, or upload what they sent you.
   A shoot in a shared Drive folder: create the project from the folder, wait
   for the logs, and choose from them (see "Footage from a Drive folder").
3. Several raw clips: `POST /api/projects/{id}/autocut`. One clip: analyze it,
   then write the main track from the keep segments.
4. Adjust with read → transform → `PUT`, fixing anything validation points at.
5. Export `draft` to review, then `high` for the final. To send it to someone
   outside the workspace, turn on the share link and give them its `url`.
