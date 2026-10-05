import { Hono, type Context, type MiddlewareHandler } from "hono";
import { initDB, query, get, run } from "./db";
import {
  initUploads,
  putUpload,
  putUploadFromUrl,
  deleteUpload,
  serveUpload,
  makeKey,
} from "./uploads";
import type { ConnectionsEnv } from "@clawnify/connections";
import {
  deleteMedia,
  frameUrl,
  importMedia,
  mediaPlayback,
  mediaState,
  mediaTranscript,
  openMediaUpload,
  prepareMedia,
} from "./media";
import {
  DRIVE_FILE_ID,
  SHARED_WITH_ME,
  driveDownloadLink,
  driveFolderName,
  driveStatus,
  listDriveFiles,
  withinFolder,
} from "./drive";
import { starterEdl, validateEdl, type Edl } from "./edl";
import { isAbandonedExport, renderKey, renderKeyFor } from "../shared/renders";
import { instructEdit } from "./instruct";
import { analyzeAsset, autocutAssets, copyOutput, pollEdit, resolveEdlSources, startEdit, type ExportConfig } from "./export";
import { makeShareToken, notePage, sharePage } from "./share";
import { etagMatches } from "../shared/sync";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  // Injected into every WfP app at deploy time; authorizes managed services.
  CLAWNIFY_TOKEN?: string;
  // Override for local dev (defaults to https://services.clawnify.com).
  SERVICES_URL?: string;
  // The org's OpenRouter key (declared in clawnify.json `env`, injected at
  // deploy) — powers footage analysis; usage bills the org's own metering.
  OPENROUTER_API_KEY?: string;
  // Injected because clawnify.json lists `credentials`: the org's connected
  // integrations (Google Drive import) and which org this app serves.
  CREDENTIALS?: ConnectionsEnv["CREDENTIALS"];
  CLAWNIFY_ORG_ID?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const init: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  initDB(c.env);
  initUploads(c.env.UPLOADS);
  await next();
};
app.use("/api/*", init);
app.use("/s/*", init);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// ── Assets (media library) ───────────────────────────────────────────

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
  /** Seconds, probed at upload or reported by the media service. */
  duration: number | null;
  /** Set when the footage lives on the media service rather than in storage. */
  media_uid: string | null;
}

app.get("/api/assets", async (c) => {
  const rows = await query<Asset>("SELECT * FROM assets ORDER BY created_at DESC");
  c.executionCtx.waitUntil(sweepUploads(c.env).catch((err) => console.error("upload sweep:", String(err))));
  return c.json(rows);
});

app.post("/api/assets", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return c.json({ error: "No file provided" }, 400);

  const key = await uniqueKey(file.name);
  const data = await file.arrayBuffer();
  const contentType = file.type || "application/octet-stream";
  await putUpload(key, data, contentType);

  // Client-probed media length (seconds) — see schema note on assets.duration.
  const durRaw = Number(body["duration"]);
  const duration = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null;

  const res = await run(
    "INSERT INTO assets (key, name, content_type, size, duration) VALUES (?, ?, ?, ?, ?)",
    [key, file.name || key, contentType, data.byteLength, duration],
  );
  const row = await get<Asset>("SELECT * FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
  return c.json(row, 201);
});

// ── Video uploads, straight to the media service ──────────────────
// A video is not posted to this app: the browser sends it to the media
// service itself, resumably, so a clip of any size uploads and gets the same
// playback, frames and transcript as one imported from Drive. Three steps:
// open an upload, send the bytes (browser to service), then register the
// asset.
//
// Each open upload has a `media_uploads` row from the moment it is opened
// until it becomes an asset or is dropped. The row is the app's proof that the
// video is its own, so a cancel or a discard can delete it at any stage, and
// an upload whose browser went away is still settled: a finished one joins
// the library, an expired one is deleted (sweepUploads).

const MEDIA_UID = /^[0-9a-f]{32}$/;

interface MediaUpload {
  uid: string;
  name: string;
  content_type: string;
  size: number;
  duration: number | null;
  created_at: string;
}

function mediaCfg(env: Bindings) {
  return { servicesUrl: env.SERVICES_URL, token: env.CLAWNIFY_TOKEN };
}

/** Turn an open upload into a library asset. Safe to call twice: the asset key is unique. */
async function promoteUpload(uid: string): Promise<Asset | null> {
  await run(
    `INSERT INTO assets (key, name, content_type, size, duration, media_uid)
     SELECT 'media/' || uid, name, content_type, size, duration, uid FROM media_uploads WHERE uid = ?
     ON CONFLICT(key) DO NOTHING`,
    [uid],
  );
  await run("DELETE FROM media_uploads WHERE uid = ?", [uid]);
  return (await get<Asset>("SELECT * FROM assets WHERE media_uid = ?", [uid])) ?? null;
}

// An upload link lives 6 hours on the service; past that, a pending upload
// can never finish.
const UPLOAD_SETTLE_MINUTES = 10;
const UPLOAD_EXPIRED_HOURS = 7;

/**
 * Settle uploads the browser never finished registering (closed tab, lost
 * connection). Left alone, a finished one would count against the org's
 * footage allowance while appearing nowhere. Runs after a library listing,
 * a few rows at a time, and only for rows old enough that no browser is
 * still working on them.
 */
async function sweepUploads(env: Bindings): Promise<void> {
  const stale = await query<MediaUpload>(
    `SELECT * FROM media_uploads WHERE created_at < datetime('now', ?) ORDER BY created_at LIMIT 5`,
    [`-${UPLOAD_SETTLE_MINUTES} minutes`],
  );
  for (const up of stale) {
    const state = await mediaState(mediaCfg(env), up.uid);
    if ("failure" in state) {
      if (state.failure.error === "not_found") await run("DELETE FROM media_uploads WHERE uid = ?", [up.uid]);
      continue;
    }
    if (state.media.state !== "pendingupload") {
      await promoteUpload(up.uid);
    } else if (Date.parse(up.created_at + "Z") < Date.now() - UPLOAD_EXPIRED_HOURS * 3600_000) {
      await deleteMedia(mediaCfg(env), up.uid);
      await run("DELETE FROM media_uploads WHERE uid = ?", [up.uid]);
    }
  }
}

app.post("/api/assets/uploads", async (c) => {
  const b = await c.req
    .json<{ name?: string; type?: string; size?: number; duration?: number }>()
    .catch(() => ({}) as { name?: string; type?: string; size?: number; duration?: number });
  if (!b.name || !b.size || !Number.isInteger(b.size) || b.size <= 0) {
    return c.json({ error: "invalid_request", detail: "name and size are required" }, 400);
  }
  const duration = typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration > 0 ? b.duration : null;
  // Until it completes, an upload reserves its maximum length of the
  // platform's video storage (released when the link expires). The browser
  // read the real length from the file, so reserve that, with room for a
  // probe that is a little short: a video longer than this is refused.
  const maxDuration = duration ? Math.ceil(duration * 1.1 + 30) : undefined;
  const name = b.name.slice(0, 200);
  const opened = await openMediaUpload(mediaCfg(c.env), b.size, name, maxDuration);
  // media_unavailable (local dev) tells the browser to post the file here instead.
  if ("failure" in opened) return c.json(opened.failure, opened.failure.error === "media_unavailable" ? 503 : 422);
  await run("INSERT INTO media_uploads (uid, name, content_type, size, duration) VALUES (?, ?, ?, ?, ?)", [
    opened.id,
    name,
    b.type?.startsWith("video/") ? b.type : "video/mp4",
    b.size,
    duration,
  ]);
  return c.json({ uid: opened.id, upload_url: opened.uploadUrl }, 201);
});

// The bytes are in: the upload joins the library.
app.post("/api/assets/media", async (c) => {
  const b = await c.req.json<{ uid?: string }>().catch(() => ({}) as { uid?: string });
  if (!b.uid || !MEDIA_UID.test(b.uid)) return c.json({ error: "invalid_request", detail: "uid is required" }, 400);
  const asset = await promoteUpload(b.uid);
  if (!asset) return c.json({ error: "not_found", detail: "no upload with that id was opened here" }, 404);
  return c.json(asset, 201);
});

// Cancel or discard an upload that has not joined the library, at any stage.
// Only one this app opened: footage in the library goes through
// DELETE /api/assets/:id, which checks the projects first.
app.delete("/api/assets/uploads/:uid", async (c) => {
  const uid = c.req.param("uid");
  if (!MEDIA_UID.test(uid) || !(await get<MediaUpload>("SELECT uid FROM media_uploads WHERE uid = ?", [uid]))) {
    return c.json({ error: "not_found", detail: "no open upload with that id" }, 404);
  }
  await deleteMedia(mediaCfg(c.env), uid);
  await run("DELETE FROM media_uploads WHERE uid = ?", [uid]);
  return c.json({ ok: true });
});

// ── Google Drive (a source for the media library) ──────────────────
// Import copies the file in, like an upload; see src/server/drive.ts.

/** The folder the org limited the picker to, or null for the whole Drive. */
async function driveFolder(): Promise<{ id: string; name: string } | null> {
  const row = await get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'drive_folder'");
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { id?: string; name?: string };
    return parsed.id ? { id: parsed.id, name: parsed.name || "Drive folder" } : null;
  } catch {
    return null;
  }
}

app.get("/api/drive", async (c) => c.json({ ...(await driveStatus(c.env)), folder: await driveFolder() }));

// Limit the picker to one folder, or clear the limit with `null`. Anyone in
// the org can set it: an app sees who is calling, never their role.
app.put("/api/drive/folder", async (c) => {
  const b = await c.req.json<{ folderId?: string | null }>().catch(() => ({}) as { folderId?: string | null });
  if (b.folderId === null) {
    await run("DELETE FROM app_settings WHERE key = 'drive_folder'");
    return c.json({ folder: null });
  }
  if (!b.folderId || !DRIVE_FILE_ID.test(b.folderId)) return c.json({ error: "folderId is required" }, 400);
  const name = await driveFolderName(c.env, b.folderId);
  if (!name) return c.json({ error: "no such folder in Drive" }, 404);
  const folder = { id: b.folderId, name };
  await run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('drive_folder', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(folder)],
  );
  return c.json({ folder });
});

app.get("/api/drive/files", async (c) => {
  const kind = c.req.query("kind") === "audio" ? "audio" : "media";
  const limit = await driveFolder();
  const asked = c.req.query("folder");
  // Outside the limit, fall back to it rather than serving the wider Drive.
  let folderId = asked && DRIVE_FILE_ID.test(asked) ? asked : limit?.id;
  // A limit means one folder and its subfolders: shared-with-me is not in it.
  if (limit && folderId !== limit.id && (folderId === SHARED_WITH_ME || !(await withinFolder(c.env, folderId!, limit.id)))) {
    folderId = limit.id;
  }
  return c.json({
    ...(await listDriveFiles(c.env, {
      kind,
      search: c.req.query("q"),
      pageToken: c.req.query("page") || undefined,
      folderId,
    })),
    folder: folderId && limit && folderId !== limit.id ? { id: folderId } : null,
  });
});

app.post("/api/drive/import", async (c) => {
  const b = await c.req.json<{ fileId?: string; duration?: number }>().catch(() => ({}) as { fileId?: string; duration?: number });
  if (!b.fileId || !DRIVE_FILE_ID.test(b.fileId)) return c.json({ error: "fileId is required" }, 400);

  const limit = await driveFolder();
  if (limit && !(await withinFolder(c.env, b.fileId, limit.id))) {
    return c.json({ error: `that file is outside ${limit.name}` }, 403);
  }

  const file = await driveDownloadLink(c.env, b.fileId);

  // A video goes to the media service: it fetches the link itself, so nothing
  // passes through this app and no size ceiling applies. Stills and sound are
  // small, and stay in the app's own storage.
  if (file.mimeType.startsWith("video/")) {
    const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };
    const imported = await importMedia(cfg, file.url, file.name);
    if ("failure" in imported) return c.json(imported.failure, 422);
    const res = await run(
      "INSERT INTO assets (key, name, content_type, size, duration, media_uid) VALUES (?, ?, ?, ?, ?, ?)",
      [`media/${imported.media.id}`, file.name, file.mimeType, 0, b.duration ?? null, imported.media.id],
    );
    const row = await get<Asset>("SELECT * FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
    return c.json(row, 201);
  }

  const key = await uniqueKey(file.name);
  const stored = await putUploadFromUrl(file.url, key, file.mimeType);
  // Drive's own probe of the video length, when the picker had it.
  const duration = typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration > 0 ? b.duration : null;

  const res = await run(
    "INSERT INTO assets (key, name, content_type, size, duration) VALUES (?, ?, ?, ?, ?)",
    [key, file.name, stored.contentType, stored.size, duration],
  );
  const row = await get<Asset>("SELECT * FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
  return c.json(row, 201);
});

/**
 * Where to play a media-backed asset from, and where its frames come from.
 * The URLs are signed and short-lived, so the client asks again rather than
 * storing them.
 */
app.get("/api/assets/:id/playback", async (c) => {
  const asset = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!asset) return c.json({ error: "Not found" }, 404);
  if (!asset.media_uid) return c.json({ error: "not_media", detail: "this asset plays from app storage" }, 400);

  const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };
  const state = await mediaState(cfg, asset.media_uid);
  if ("failure" in state) return c.json(state.failure, 502);
  if (!state.media.ready) {
    return c.json({ ready: false, state: state.media.state, progress: state.media.progress });
  }
  const play = await mediaPlayback(cfg, asset.media_uid);
  if ("failure" in play) return c.json(play.failure, 502);
  // The MP4 the edit service cuts from is made only on request, so ask for it
  // the moment the clip can play: by the time someone exports or analyses it,
  // it is usually ready, instead of the first attempt failing.
  if (state.media.download?.status !== "ready" && state.media.download?.status !== "inprogress") {
    c.executionCtx.waitUntil(prepareMedia(cfg, asset.media_uid).then(() => {}));
  }
  // The length the service measured beats the one the picker guessed.
  if (state.media.duration && Math.abs((asset.duration ?? 0) - state.media.duration) > 0.5) {
    await run("UPDATE assets SET duration = ? WHERE id = ?", [state.media.duration, asset.id]);
  }
  // The source's own frame size, for the format picker's "Original" choices.
  return c.json({
    ready: true,
    duration: state.media.duration,
    width: state.media.width,
    height: state.media.height,
    ...play.playback,
  });
});

/**
 * Where an asset's bytes are, whichever side they live on. A redirect keeps
 * one URL shape for the whole client, and the range requests a video element
 * makes survive it.
 */
app.get("/api/assets/:id/source", async (c) => {
  const asset = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!asset) return c.json({ error: "Not found" }, 404);
  if (!asset.media_uid) return c.redirect(`/api/uploads/${encodeURIComponent(asset.key)}`, 302);

  const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };
  const play = await mediaPlayback(cfg, asset.media_uid);
  if ("failure" in play) return c.json(play.failure, 502);
  return c.redirect(play.playback.download, 302);
});

/**
 * A clip's transcript, for captions. Asks the media service for it in `lang`
 * and keeps it once ready. Footage in app storage has none: only the media
 * service transcribes.
 */
app.get("/api/assets/:id/transcript", async (c) => {
  const asked = c.req.query("lang") ?? "en";
  const lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(asked) ? asked : "en";
  const asset = await get<Asset & { transcript: string | null; transcript_lang: string | null }>(
    "SELECT * FROM assets WHERE id = ?",
    [c.req.param("id")],
  );
  if (!asset) return c.json({ error: "Not found" }, 404);

  if (asset.transcript !== null && asset.transcript_lang === lang) {
    return c.json({ status: asset.transcript ? "ready" : "no_speech", vtt: asset.transcript });
  }
  if (!asset.media_uid) return c.json({ status: "unavailable" });

  const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };
  // Idempotent: asks for the transcript the first time, reports on it after.
  const prepared = await prepareMedia(cfg, asset.media_uid, lang);
  if ("failure" in prepared) {
    if (prepared.failure.error === "not_ready") return c.json({ status: "preparing" });
    return c.json(prepared.failure, 502);
  }
  if (prepared.media.no_audio) {
    await run("UPDATE assets SET transcript = '', transcript_lang = ? WHERE id = ?", [lang, asset.id]);
    return c.json({ status: "no_speech", vtt: "" });
  }
  const vtt = await mediaTranscript(cfg, asset.media_uid, lang);
  if (vtt === null) return c.json({ status: "transcribing" });
  await run("UPDATE assets SET transcript = ?, transcript_lang = ? WHERE id = ?", [vtt, lang, asset.id]);
  return c.json({ status: "ready", vtt });
});

/** One frame of a media-backed asset, for covers and the timeline. */
app.get("/api/assets/:id/frame", async (c) => {
  const asset = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!asset?.media_uid) return c.json({ error: "Not found" }, 404);
  const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };
  const play = await mediaPlayback(cfg, asset.media_uid);
  if ("failure" in play) return c.json(play.failure, 502);
  const at = Number(c.req.query("t") ?? 0);
  return c.redirect(frameUrl(play.playback, Number.isFinite(at) ? at : 0), 302);
});

// Backfill a probed duration onto a legacy asset (self-healing library).
app.patch("/api/assets/:id", async (c) => {
  const b = await c.req.json<{ duration?: number }>().catch(() => ({}) as { duration?: number });
  if (typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration > 0) {
    await run("UPDATE assets SET duration = ? WHERE id = ? AND duration IS NULL", [
      b.duration,
      c.req.param("id"),
    ]);
  }
  const row = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.delete("/api/assets/:id", async (c) => {
  const row = await get<Asset & { proxy_key?: string | null }>("SELECT * FROM assets WHERE id = ?", [
    c.req.param("id"),
  ]);
  if (row) {
    // Deleting footage a project still uses would leave that project with a
    // clip pointing at nothing, which fails at export. Say where it is used.
    const users = await query<{ name: string }>(
      "SELECT name FROM edit_projects WHERE edl LIKE ?",
      [`%"asset:${row.id}"%`],
    );
    if (users.length > 0) {
      return c.json(
        {
          error: "in_use",
          detail: `Still used in ${users.map((u) => `"${u.name}"`).join(", ")}. Remove it from ${users.length > 1 ? "those projects" : "that project"} first.`,
        },
        409,
      );
    }
    // Footage on the media service counts against the org's storage minutes
    // until it is deleted there; dropping only our row left it counting.
    if (row.media_uid) {
      await deleteMedia({ servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN }, row.media_uid);
    } else {
      await deleteUpload(row.key);
    }
    if (row.proxy_key) await deleteUpload(row.proxy_key);
    await run("DELETE FROM assets WHERE id = ?", [row.id]);
  }
  return c.json({ ok: true });
});

// AI footage analysis: a multimodal model watches the clip and proposes cuts
// (millisecond timestamps, keep flags) and caption lines — raw material for
// EDL edits. See agent.md ("Analyzing footage").
app.post("/api/assets/:id/analyze", async (c) => {
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json(
      { error: "Analysis service not configured (missing CLAWNIFY_TOKEN). Analysis runs on deployed apps." },
      503,
    );
  }
  const b = (await c.req.json<{ mode?: string; prompt?: string; window?: { start?: number; end?: number } }>().catch(() => ({}))) as {
    mode?: string;
    prompt?: string;
    window?: { start?: number; end?: number };
  };
  // The part of the source the clip plays now, so proposals stay inside it.
  const w = b.window;
  const window =
    w && Number.isFinite(w.start) && Number.isFinite(w.end) && (w.end as number) > (w.start as number)
      ? { start: Math.max(0, w.start as number), end: w.end as number }
      : undefined;
  const res = await analyzeAsset(
    c.req.param("id"),
    { mode: b.mode, prompt: b.prompt, window },
    {
      servicesUrl: c.env.SERVICES_URL,
      token: c.env.CLAWNIFY_TOKEN,
      openrouterKey: c.env.OPENROUTER_API_KEY,
    },
  );
  if ("failure" in res) return c.json(res.failure, 422);
  return c.json(res.result);
});

// Serve any R2 object (uploaded media + exported videos), range-aware.
app.get("/api/uploads/:key", async (c) => {
  const res = await serveUpload(c.req.param("key"), c.req.header("Range"), {
    "Cache-Control": "public, max-age=31536000",
  });
  return res ?? c.json({ error: "Not found" }, 404);
});

// ── Edit projects (footage EDL) ──────────────────────────────────────
// A project's document is an EDL: real footage cut/trimmed/sequenced on a
// main track, with overlay and audio tracks. See agent.md for the format.

interface EditProject {
  id: string;
  name: string;
  edl: string;
  brief: string;
  created_at: string;
  updated_at: string;
  /** Adds one on every write; a guarded write names the revision it read. */
  revision: number;
}

interface ExportJob {
  id: number;
  project_id: string;
  status: string;
  output_url: string | null;
  error: string | null;
  duration: number | null;
  size: number | null;
  /** The render's job on the edit service; null until it is submitted. */
  service_job_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Project row with the EDL parsed for the response. */
function projectOut(row: EditProject) {
  return { ...row, edl: JSON.parse(row.edl) as Edl };
}

app.get("/api/projects", async (c) => {
  // The first main-track clip is the project's cover: the frame a list of cuts
  // is recognised by. `substr(…, 7)` strips the "asset:" prefix; a URL source
  // matches no asset id and simply has no cover.
  const rows = await query<
    Omit<EditProject, "edl" | "brief"> & { cover_key: string | null; cover_type: string | null; cover_at: number | null }
  >(
    `SELECT p.id, p.name, p.created_at, p.updated_at,
            a.key AS cover_key, a.content_type AS cover_type,
            a.id AS cover_asset, a.media_uid AS cover_media,
            json_extract(p.edl, '$.main.elements[0].trimStart') AS cover_at
       FROM edit_projects p
       LEFT JOIN assets a ON a.id = substr(json_extract(p.edl, '$.main.elements[0].src'), 7)
      ORDER BY p.updated_at DESC`,
  );
  return c.json(rows);
});

app.get("/api/projects/:id", async (c) => {
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  // The revision is the ETag, so an open editor can ask "anything new?" every
  // few seconds and get an empty 304 back instead of the whole document.
  const etag = `"${row.revision}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-store");
  if (etagMatches(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json(projectOut(row));
});

/** 409 for a write based on a revision the project has moved past. */
function conflict(c: Context, revision: number, detail: string) {
  return c.json({ error: "conflict", detail, revision }, 409);
}

app.post("/api/projects", async (c) => {
  const b = await c.req.json<{ name?: string; edl?: unknown; brief?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name is required" }, 400);

  let edl: Edl;
  if (b.edl !== undefined) {
    const v = validateEdl(b.edl);
    if ("invalid" in v) return c.json(v.invalid, 422);
    edl = v.edl;
  } else {
    edl = starterEdl();
  }

  const id = crypto.randomUUID();
  await run("INSERT INTO edit_projects (id, name, edl, brief) VALUES (?, ?, ?, ?)", [
    id,
    b.name.trim(),
    JSON.stringify(edl),
    b.brief?.trim() ?? "",
  ]);
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [id]);
  return c.json(projectOut(row!), 201);
});

app.put("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const b = await c.req.json<{ name?: string; edl?: unknown; brief?: string; revision?: unknown }>();
  // `revision` is optional: without it the write wins, as it always did.
  // With it, the write only lands on the version the writer read.
  if (b.revision !== undefined && b.revision !== existing.revision) {
    return conflict(
      c,
      existing.revision,
      `The project changed since you read it: it is at revision ${existing.revision}. Read it again and redo your change on that.`,
    );
  }
  let edlJson = existing.edl;
  if (b.edl !== undefined) {
    const v = validateEdl(b.edl);
    if ("invalid" in v) return c.json(v.invalid, 422);
    edlJson = JSON.stringify(v.edl);
  }
  // Guarded on the revision read above, so fields this request left out are
  // never filled from a version another write has already replaced.
  const [row] = await guardedWrite<EditProject>(
    `UPDATE edit_projects SET name = ?, edl = ?, brief = ?, revision = revision + 1, updated_at = datetime('now')
      WHERE id = ? AND revision = ? RETURNING *`,
    [b.name?.trim() || existing.name, edlJson, b.brief !== undefined ? b.brief.trim() : existing.brief, id, existing.revision],
  );
  if (!row) return changedWhileRunning(c, id, "The project changed while this was being saved. Read it again and redo your change on that.");
  return c.json(projectOut(row));
});

// Auto-cut: assemble the project's main track from several clips in ONE model
// pass — the model watches every clip together (ordering and cross-clip
// redundancy can't be judged one clip at a time) against the project brief.
// Replaces the main track and adds a captions overlay; other overlay/audio
// tracks are left untouched.
/**
 * Change the cut by asking for it. The model calls a fixed set of checked
 * operations rather than writing the document, and the whole instruction
 * lands as one edit, so the editor can undo it in one step.
 */
app.post("/api/projects/:id/instruct", async (c) => {
  const project = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const b = await c.req
    .json<{ instruction?: string; revision?: unknown }>()
    .catch(() => ({}) as { instruction?: string; revision?: unknown });
  const instruction = b.instruction?.trim();
  if (!instruction) return c.json({ error: "invalid_request", detail: "instruction is required" }, 422);
  // The caller names the version it is looking at, so the model never edits
  // one it has not seen.
  if (b.revision !== undefined && b.revision !== project.revision) {
    return conflict(c, project.revision, "The project changed since you read it. Read it again, then ask.");
  }

  const current = validateEdl(JSON.parse(project.edl));
  if ("invalid" in current) return c.json(current.invalid, 422);

  // The model reads clip names, not asset ids; lengths say where a clip ends.
  const names = new Map<string, string>();
  const lengths = new Map<string, number>();
  for (const row of await query<Asset>("SELECT id, name, duration FROM assets")) {
    names.set(`asset:${row.id}`, row.name);
    if (row.duration) lengths.set(`asset:${row.id}`, row.duration);
  }

  const analysisCfg = {
    servicesUrl: c.env.SERVICES_URL,
    token: c.env.CLAWNIFY_TOKEN ?? "",
    openrouterKey: c.env.OPENROUTER_API_KEY,
  };
  const out = await instructEdit(
    current.edl,
    instruction,
    names,
    { openrouterKey: c.env.OPENROUTER_API_KEY, servicesUrl: c.env.SERVICES_URL },
    lengths,
    // What the model uses to act on what is in the footage.
    async (assetId, window, focus) => {
      const r = await analyzeAsset(assetId, { mode: "cuts", prompt: focus, window }, analysisCfg);
      if ("failure" in r) return { error: r.failure.detail };
      return {
        keeps: r.result.cuts
          .filter((cut) => cut.keep)
          .sort((a, b) => a.start_ms - b.start_ms)
          .map((cut) => ({ start: cut.start_ms / 1000, end: cut.end_ms / 1000 })),
        notes: r.result.notes,
      };
    },
  );
  if ("failure" in out) return c.json(out.failure, 422);

  // The model worked on the version read at the start, which can be a minute
  // old by now: write only if nothing else saved in between.
  const [saved] = await guardedWrite(
    "UPDATE edit_projects SET edl = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ? AND revision = ? RETURNING revision",
    [JSON.stringify(out.edl), project.id, project.revision],
  );
  if (!saved) return changedWhileRunning(c, project.id);
  return c.json({ edl: out.edl, said: out.said, applied: out.applied, revision: project.revision + 1 });
});

app.post("/api/projects/:id/autocut", async (c) => {
  const project = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json({ error: "Auto-cut runs on deployed apps (missing CLAWNIFY_TOKEN)." }, 503);
  }

  const b = await c.req
    .json<{ asset_ids?: string[]; prompt?: string; revision?: unknown }>()
    .catch(() => ({}) as { asset_ids?: string[]; prompt?: string; revision?: unknown });
  if (b.revision !== undefined && b.revision !== project.revision) {
    return conflict(c, project.revision, "The project changed since you read it. Read it again, then run Auto-cut.");
  }
  const ids = Array.isArray(b.asset_ids) ? b.asset_ids : [];
  if (ids.length === 0) return c.json({ error: "autocut_failed", detail: "asset_ids is required" }, 422);

  const clips: { id: string; name: string }[] = [];
  for (const id of ids) {
    const a = await get<Asset>("SELECT * FROM assets WHERE id = ?", [id]);
    if (!a) return c.json({ error: "autocut_failed", detail: `no asset with id "${id}"` }, 422);
    if (!a.content_type.startsWith("video/")) {
      return c.json({ error: "autocut_failed", detail: `"${a.name}" is not a video` }, 422);
    }
    clips.push({ id: a.id, name: a.name });
  }

  const brief = [project.brief, b.prompt].filter((s) => s?.trim()).join(" — ");
  const cut = await autocutAssets(clips, brief, {
    servicesUrl: c.env.SERVICES_URL,
    token: c.env.CLAWNIFY_TOKEN,
    openrouterKey: c.env.OPENROUTER_API_KEY,
  });
  if ("failure" in cut) return c.json(cut.failure, 422);

  // Sequence → main track (duration = play-window, no source length needed);
  // captions → one overlay track with cumulative output-time offsets.
  const edl = JSON.parse(project.edl) as Edl;
  const rid = () => Math.random().toString(36).slice(2, 10);
  edl.main.elements = cut.result.sequence.map((s) => ({
    id: rid(),
    type: "video" as const,
    src: `asset:${clips[s.clip_index].id}`,
    trimStart: Math.round(s.start_ms) / 1000,
    duration: Math.max(0.05, Math.round(s.end_ms - s.start_ms) / 1000),
  }));
  let at = 0;
  const captions = [];
  for (const s of cut.result.sequence) {
    const dur = Math.max(0.05, (s.end_ms - s.start_ms) / 1000);
    if (s.caption.trim()) {
      captions.push({
        id: rid(),
        type: "text" as const,
        text: s.caption.trim(),
        fontSize: Math.round(edl.output.height * 0.055),
        startTime: Math.round(at * 100) / 100,
        duration: Math.min(dur, 6),
        x: 0.5,
        y: 0.82,
        align: "center" as const,
        color: "#ffffff",
        background: "#000000a0",
      });
    }
    at += dur;
  }
  if (captions.length) {
    edl.overlays = edl.overlays ?? [];
    edl.overlays.push({ id: rid(), elements: captions });
  }

  const v = validateEdl(edl);
  if ("invalid" in v) return c.json(v.invalid, 422);
  const [row] = await guardedWrite<EditProject>(
    "UPDATE edit_projects SET edl = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ? AND revision = ? RETURNING *",
    [JSON.stringify(v.edl), project.id, project.revision],
  );
  if (!row) return changedWhileRunning(c, project.id);
  return c.json({ ...projectOut(row), notes: cut.result.notes });
});

/**
 * A write guarded by `WHERE ... AND revision = ?`, answered with RETURNING:
 * no row back means it did not land. Read from the rows rather than the
 * `changes` count, because not every storage this app can run on reports
 * one, and a missing count reads as 0, which would refuse every save.
 */
function guardedWrite<T = { revision: number }>(sql: string, params: unknown[]) {
  return query<T>(sql, params);
}

/** A guarded write found the project at another revision; 404 if it is gone. */
async function changedWhileRunning(
  c: Context,
  id: string,
  detail = "The project was saved somewhere else while this ran, so nothing was applied. Try again on the latest version.",
) {
  const row = await get<{ revision: number }>("SELECT revision FROM edit_projects WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return conflict(c, row.revision, detail);
}

app.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  // Drop each completed export's rendered file from storage before the rows go,
  // otherwise the renders/*.mp4 objects outlive the only rows that point to them
  // and are orphaned forever. Best-effort: a storage hiccup must not strand the
  // project (an unreachable object is a smaller problem than an undeletable one).
  const jobs = await query<{ output_url: string | null }>(
    "SELECT output_url FROM export_jobs WHERE project_id = ? AND output_url IS NOT NULL",
    [id],
  );
  const keys = jobs.map((j) => renderKey(j.output_url)).filter((k): k is string => k !== null);
  if (keys.length) await deleteUpload(keys).catch(() => {});
  await run("DELETE FROM share_links WHERE project_id = ?", [id]);
  await run("DELETE FROM export_jobs WHERE project_id = ?", [id]);
  await run("DELETE FROM edit_projects WHERE id = ?", [id]);
  return c.json({ ok: true });
});

// ── Exports ──────────────────────────────────────────────────────────

app.get("/api/exports", async (c) => {
  const projectId = c.req.query("project_id");
  const rows: ExportJob[] = projectId
    ? await query<ExportJob>(
        "SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
        [projectId],
      )
    : await query<ExportJob>("SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT 50");
  return c.json(await Promise.all(rows.map((r) => settleExport(r, exportConfig(c.env)))));
});

app.get("/api/exports/:id", async (c) => {
  const row = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await settleExport(row, exportConfig(c.env)));
});

function exportConfig(env: Bindings): ExportConfig | null {
  return env.CLAWNIFY_TOKEN ? { servicesUrl: env.SERVICES_URL, token: env.CLAWNIFY_TOKEN } : null;
}

/**
 * Bring an 'exporting' row up to date. The render runs in the background on
 * the edit service, and nothing calls back when it ends, so whichever read
 * comes next (the editor polling, an agent, a reload) settles it: a finished
 * render is copied into this app's storage, a failed one records why. Every
 * write is guarded on status = 'exporting', so concurrent reads settle a row
 * once; a duplicate copy lands on the same key (renderKeyFor).
 */
async function settleExport(job: ExportJob, cfg: ExportConfig | null): Promise<ExportJob> {
  if (job.status !== "exporting") return job;
  const failed = async (msg: string) => {
    await run(
      "UPDATE export_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'exporting'",
      [msg.slice(0, 1000), job.id],
    );
  };

  if (!job.service_job_id) {
    // Still staging inside its request, or that request was cut off.
    if (!isAbandonedExport(job.created_at, Date.now())) return job;
    await failed("export_failed: the export stopped before it finished — export again");
  } else {
    if (!cfg) return job;
    const poll = await pollEdit(job.service_job_id, cfg);
    if (poll.status === "running") return job;
    if (poll.status === "failed") {
      await failed(`edit_failed: ${poll.detail}`);
    } else {
      const key = renderKeyFor(job.id, job.service_job_id);
      try {
        await copyOutput(poll.result, key);
        await run(
          "UPDATE export_jobs SET status = 'completed', output_url = ?, duration = ?, size = ?, updated_at = datetime('now') WHERE id = ? AND status = 'exporting'",
          [`/api/uploads/${encodeURIComponent(key)}`, poll.result.duration, poll.result.size, job.id],
        );
      } catch (err) {
        await failed(`export_failed: ${String(err).slice(0, 500)}`);
      }
    }
  }
  return (await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [job.id])) ?? job;
}

app.post("/api/projects/:id/export", async (c) => {
  const project = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [
    c.req.param("id"),
  ]);
  if (!project) return c.json({ error: "Project not found" }, 404);

  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json(
      { error: "Edit service not configured (missing CLAWNIFY_TOKEN). Exports run on deployed apps." },
      503,
    );
  }

  const parsed = validateEdl(JSON.parse(project.edl));
  if ("invalid" in parsed) return c.json(parsed.invalid, 422);
  if (parsed.edl.main.elements.length === 0) {
    return c.json(
      { error: "edl_invalid", detail: "the main track is empty — add clips before exporting", path: "/main/elements" },
      422,
    );
  }

  const b = (await c.req.json<{ quality?: string }>().catch(() => ({}))) as { quality?: string };
  const quality = ["draft", "standard", "high"].includes(b.quality ?? "") ? b.quality! : "standard";
  const cfg = { servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN };

  const res = await run("INSERT INTO export_jobs (project_id, status) VALUES (?, 'exporting')", [
    project.id,
  ]);
  const jobId = res.lastInsertRowid as number;
  const fail = async (error: string, detail: string, path?: string) => {
    const msg = `${error}: ${detail}${path ? ` (at ${path})` : ""}`.slice(0, 1000);
    await run("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", [msg, jobId]);
    const job = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
    // Machine-readable failure alongside the job row, so an editing loop can
    // jump straight to the offending EDL node.
    return c.json({ ...job, failure: { error, detail, ...(path ? { path } : {}) } }, 201);
  };

  try {
    const resolved = await resolveEdlSources(parsed.edl, cfg);
    if ("failure" in resolved) return fail(resolved.failure.error, resolved.failure.detail, resolved.failure.path);

    const started = await startEdit(
      resolved.edl,
      { quality, filename: `${makeKey(project.name)}.mp4` },
      cfg,
    );
    if ("failure" in started) return fail(started.failure.error, started.failure.detail, started.failure.path);

    // The render is on its way; reads of this job settle it (settleExport).
    await run("UPDATE export_jobs SET service_job_id = ?, updated_at = datetime('now') WHERE id = ?", [
      started.jobId,
      jobId,
    ]);
  } catch (err) {
    return fail("export_failed", String(err).slice(0, 500));
  }

  const job = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
  return c.json(job, 201);
});

// ── Share by link ────────────────────────────────────────────────────
// One link per project, pinned to one finished export. Exporting again does
// not change what viewers see (drafts are exports too); moving the pin to the
// newest export is a deliberate step. Turning the link off deletes the token,
// and turning it on again gives a new address.

interface ShareLink {
  token: string;
  project_id: string;
  export_id: number;
  created_at: string;
}

/** The project's newest finished export, which a link is pinned to on create or update. */
async function latestExport(projectId: string) {
  return get<Pick<ExportJob, "id" | "output_url" | "updated_at">>(
    "SELECT id, output_url, updated_at FROM export_jobs WHERE project_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
    [projectId],
  );
}

async function shareOut(c: { req: { url: string } }, projectId: string) {
  const link = await get<ShareLink & { exported_at: string }>(
    `SELECT s.*, e.updated_at AS exported_at FROM share_links s JOIN export_jobs e ON e.id = s.export_id
      WHERE s.project_id = ?`,
    [projectId],
  );
  const latest = await latestExport(projectId);
  if (!link) return { url: null, can_share: Boolean(latest) };
  return {
    url: new URL(`/s/${link.token}`, c.req.url).toString(),
    export_id: link.export_id,
    exported_at: link.exported_at,
    // A finished export newer than the one viewers see.
    newer_export: latest && latest.id !== link.export_id ? latest.id : null,
    created_at: link.created_at,
  };
}

app.get("/api/projects/:id/share", async (c) => c.json(await shareOut(c, c.req.param("id"))));

// Turns the link on, or moves it to the newest export. The token is kept, so
// the address already sent out keeps working.
app.put("/api/projects/:id/share", async (c) => {
  const id = c.req.param("id");
  const project = await get<{ id: string }>("SELECT id FROM edit_projects WHERE id = ?", [id]);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const latest = await latestExport(id);
  if (!latest) {
    return c.json({ error: "nothing_exported", detail: "export the project first; a link plays a finished export" }, 409);
  }
  await run(
    `INSERT INTO share_links (token, project_id, export_id) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET export_id = excluded.export_id`,
    [makeShareToken(), id, latest.id],
  );
  return c.json(await shareOut(c, id));
});

app.delete("/api/projects/:id/share", async (c) => {
  await run("DELETE FROM share_links WHERE project_id = ?", [c.req.param("id")]);
  return c.json({ url: null, can_share: true });
});

// The public half: the only routes reachable without signing in (clawnify.json
// `api.public_routes`). A token that matches no row is indistinguishable from
// one that never existed.

/** The link's project and the export it is pinned to, if the link is live. */
async function sharedExport(token: string) {
  return get<{ name: string; export_id: number; output_url: string | null }>(
    `SELECT p.name, s.export_id, e.output_url
       FROM share_links s
       JOIN edit_projects p ON p.id = s.project_id
       JOIN export_jobs e ON e.id = s.export_id AND e.status = 'completed'
      WHERE s.token = ?`,
    [token],
  );
}

const PUBLIC_HEADERS = { "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };

app.get("/s/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(PUBLIC_HEADERS)) c.header(k, v);
  const shared = await sharedExport(c.req.param("token"));
  if (!shared) {
    return c.html(notePage("This link doesn't work", "It may have been turned off. Ask whoever sent it for a new one."), 404);
  }
  return c.html(sharePage(shared.name, `/s/${encodeURIComponent(c.req.param("token"))}/video?v=${shared.export_id}`));
});

// `v` names the export the page was rendered with. Only the pinned one is
// served: a stale `v` (the pin moved meanwhile) gets a 404 rather than another
// file's bytes mid-playback, and other cuts are never reachable by guessing ids.
app.get("/s/:token/video", async (c) => {
  const shared = await sharedExport(c.req.param("token"));
  const key = renderKey(shared?.output_url);
  const v = c.req.query("v");
  if (!shared || !key || (v !== undefined && v !== String(shared.export_id))) {
    return c.text("Not found", 404, PUBLIC_HEADERS);
  }
  const download = c.req.query("download") !== undefined;
  const res = await serveUpload(key, c.req.header("Range"), {
    ...PUBLIC_HEADERS,
    "Cache-Control": "no-store",
    ...(download ? { "Content-Disposition": `attachment; filename="${makeKey(shared.name)}.mp4"` } : {}),
  });
  return res ?? c.text("Not found", 404, PUBLIC_HEADERS);
});

// ── helpers ──────────────────────────────────────────────────────────

/** A storage key from a file name, suffixed when another asset already has it. */
async function uniqueKey(name: string): Promise<string> {
  const key = makeKey(name || "file");
  const clash = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
  if (!clash) return key;
  const dot = key.lastIndexOf(".");
  const suffix = lower8();
  return dot > 0 ? `${key.slice(0, dot)}-${suffix}${key.slice(dot)}` : `${key}-${suffix}`;
}

function lower8(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default app;
