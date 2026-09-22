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

-- App-wide settings, one row per key. Today only `drive_folder`: the Google
-- Drive folder the picker is limited to, stored as JSON {"id","name"}. Absent
-- means the whole Drive is browsable.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
