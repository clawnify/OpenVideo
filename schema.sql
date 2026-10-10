-- Media library: footage, stills and audio the user uploads. Stored in R2
-- under `key`; an edit references them as `asset:<id>`.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Edit-service staging pointer: uploaded once, reused by every export.
  -- Staged copies expire (~30 days); exports re-stage transparently when the
  -- pointer is missing or stale, so this is a cache, not a source of truth.
  service_key TEXT,
  service_key_expires_at TEXT,
  -- Media length in seconds, probed client-side at upload (the browser reads
  -- it from the local file instantly). Data, not a runtime probe — the
  -- timeline needs it synchronously, and moov-at-end files make network
  -- probing arbitrarily slow.
  duration REAL,
  -- Small 360p transcode used for AI analysis (models take base64 with a hard
  -- request cap; full-res footage doesn't fit). Made once via the edit
  -- service, cached here in app storage.
  proxy_key TEXT
);

-- Footage edit projects: the EDL (edit decision list) JSON is the document.
-- Clips reference media-library assets as "asset:<id>"; exports resolve them
-- to staged sources and run on the managed edit service.
CREATE TABLE IF NOT EXISTS edit_projects (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  edl TEXT NOT NULL,
  -- The video's purpose ("30s product teaser for Instagram, energetic").
  -- Anchors every AI call — cuts are only "effective" relative to a goal.
  brief TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Export jobs: one row per export of an edit project. The MP4 is copied into
-- this app's storage and served from output_url. status: exporting | completed | failed.
CREATE TABLE IF NOT EXISTS export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'exporting',
  output_url TEXT,
  error TEXT,
  duration REAL,
  size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_project ON export_jobs(project_id);

-- A project's share link: anyone with /s/<token> can watch the export it is
-- pinned to, without signing in. A later export (a draft, say) never reaches
-- viewers until someone moves the pin. The token is the capability, so turning
-- the link off deletes the row and turning it on again mints a new one.
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  export_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- App-wide settings, one row per key. Today only `drive_folder`: the Google
-- Drive folder the picker is limited to, stored as JSON {"id","name"}. Absent
-- means the whole Drive is browsable.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Long footage lives on the managed media service instead of this app's
-- storage; the row then carries the service's id and `key` holds no object.
ALTER TABLE assets ADD COLUMN media_uid TEXT;

-- The media service's transcript of a clip (WebVTT, cue-timed), fetched once
-- it is ready. NULL: not fetched yet. '': known to have no speech. Captions are
-- worked out from it on every preview and export, never stored per caption.
ALTER TABLE assets ADD COLUMN transcript TEXT;
ALTER TABLE assets ADD COLUMN transcript_lang TEXT;

-- A video upload in flight from a browser to the media service, from the
-- moment it is opened until it joins the library as an asset, or is
-- cancelled or expires. It is how the app knows the video is its own.
CREATE TABLE IF NOT EXISTS media_uploads (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An export renders in the background on the edit service; this is its job
-- there. The row stays 'exporting' until a read of the job finds the outcome
-- and settles it, so a closed tab or a long render never loses the export.
ALTER TABLE export_jobs ADD COLUMN service_job_id TEXT;

-- Google Drive folders a project takes its footage from: shared "with the
-- link", so nothing is connected and anyone with the link could read them.
-- `language` is what the clips' speech is transcribed in.
CREATE TABLE IF NOT EXISTS footage_sources (
  project_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, folder_id)
);

-- One row per video in those folders and every folder inside them. The video
-- belongs to its project: the media library lists it with that project only,
-- and deleting the project deletes it. It moves on by itself (see
-- src/server/footage.ts):
--   status:     waiting | importing | ready | failed | removed
--   log_status: NULL (not started) | preparing | running | done | failed
-- `log` is the analysis's log of the clip as JSON (ClipLog), times in seconds.
-- `folder` is the path below the shared folder, its own name first ("Day 1/Cam B").
CREATE TABLE IF NOT EXISTS project_footage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'waiting',
  error TEXT,
  asset_id TEXT,
  log_status TEXT,
  log_job TEXT,
  log TEXT,
  log_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_project_footage_asset ON project_footage(asset_id);

-- When the project's next footage step is booked on the platform queue
-- (ISO time). NULL: none booked.
ALTER TABLE edit_projects ADD COLUMN footage_step_at TEXT;

-- Highlights (src/server/highlights.ts): the selects an editor looks at
-- first, judged from each clip's log and transcript against the brief.
-- `highlights_at`: when the project asked for them; NULL, it hasn't. Clips
-- logged after that join in by themselves.
ALTER TABLE edit_projects ADD COLUMN highlights_at TEXT;
-- When a person stopped the reading; NULL, it runs. Stopped, clips in line go
-- back and clips logged later don't join, until highlights are asked again.
ALTER TABLE edit_projects ADD COLUMN highlights_stopped_at TEXT;
-- Per clip: NULL (not asked) | waiting | running | done | failed. A clip done
-- with a skip_reason was judged not worth an editor's time, and why.
ALTER TABLE project_footage ADD COLUMN highlights_status TEXT;
ALTER TABLE project_footage ADD COLUMN highlights_error TEXT;
ALTER TABLE project_footage ADD COLUMN skip_reason TEXT;
-- The original's frame rate and size, as the media service measured them:
-- what a timeline for the editor's own software is laid out with.
ALTER TABLE project_footage ADD COLUMN fps REAL;
ALTER TABLE project_footage ADD COLUMN width INTEGER;
ALTER TABLE project_footage ADD COLUMN height INTEGER;

-- One row per pick: a soundbite (speech that stands on its own) or a stretch
-- of b-roll, `src_in`..`src_out` seconds into its clip. `pick` is a person's
-- call: NULL until reviewed, then keep | drop. Finding again replaces only
-- unreviewed picks; `origin` is ai, or person for one a person added.
CREATE TABLE IF NOT EXISTS footage_highlights (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT NOT NULL,
  footage_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  src_in REAL NOT NULL,
  src_out REAL NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 3,
  reason TEXT NOT NULL DEFAULT '',
  pick TEXT,
  origin TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_footage_highlights_project ON footage_highlights(project_id, score);
CREATE INDEX IF NOT EXISTS idx_footage_highlights_clip ON footage_highlights(footage_id);

-- A clip Google Drive refuses to hand over (its download limit for the file,
-- or for the owner's shared files, is used up) waits until `retry_at` (ISO
-- time) and is tried again, further apart each time; `drive_tries` counts the
-- refusals. NULL retry_at: it can be tried now.
ALTER TABLE project_footage ADD COLUMN retry_at TEXT;
ALTER TABLE project_footage ADD COLUMN drive_tries INTEGER NOT NULL DEFAULT 0;

-- How a clip comes in when the org has a Drive connection: 0 downloaded
-- through it; 1 too big for that, so from a copy the connection makes (see
-- copy_id); 2 neither worked, so by the shared link.
ALTER TABLE project_footage ADD COLUMN link_only INTEGER NOT NULL DEFAULT 0;

-- A file too big to download through the Drive connection comes in from a
-- copy the connection makes in its own account, shared with the link: this
-- is that copy, deleted once the import is over.
ALTER TABLE project_footage ADD COLUMN copy_id TEXT;

-- A source the media service's video host refuses for its bitrate (over
-- 200 Mbps: all-intra camera files) is re-encoded on the way in: `transcode`
-- 1 marks the clip for it, 2 once the host has the re-encode; `transcode_job`
-- is the re-encode under way. Only a refused re-encode fails the clip: any
-- other refusal sends it back to be re-encoded.
ALTER TABLE project_footage ADD COLUMN transcode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_footage ADD COLUMN transcode_job TEXT;

-- A file Google Drive won't hand over whole (its download limit) still serves
-- byte ranges, so it comes in a piece at a time, into an upload on the media
-- service (src/server/relay.ts). Set while that upload is open: its id and
-- link, when the link expires, the file's size, and how much is in so far
-- (for showing; the upload itself says where it stands).
ALTER TABLE project_footage ADD COLUMN upload_uid TEXT;
ALTER TABLE project_footage ADD COLUMN upload_url TEXT;
ALTER TABLE project_footage ADD COLUMN upload_expires TEXT;
ALTER TABLE project_footage ADD COLUMN upload_size INTEGER;
ALTER TABLE project_footage ADD COLUMN upload_done INTEGER;
