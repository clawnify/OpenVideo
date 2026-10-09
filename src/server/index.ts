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
import { verifyDelivery } from "@clawnify/queue";
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
  driveCopyForImport,
  driveCreateFolder,
  driveDownloadLink,
  driveRemove,
  driveFolderName,
  driveStatus,
  listDriveFiles,
  withinFolder,
} from "./drive";
import { parseDriveLink, type FolderVideo } from "./drive-link";
import { addFolderVideos, bookStep, readFolder, removeCopy, stepFootage, type DriveSource, type StepOutcome } from "./footage";
import { HIGHLIGHTS_NO_KEY, highlightsPending, stepHighlights, type HighlightKind } from "./highlights";
import { highlightsCsv, highlightsXml, rateOf } from "./nle";
import { starterEdl, validateEdl, type Edl } from "./edl";
import { isAbandonedExport, renderKey, renderKeyFor } from "../shared/renders";
import { instructEdit, type InstructHighlight } from "./instruct";
import { analyzeAsset, autocutAssets, copyOutput, pollEdit, resolveEdlSources, startEdit, type ExportConfig, type ExportFailure } from "./export";
import { makeShareToken, notePage, sharePage } from "./share";

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
  // Footage a project took from a Drive folder is that project's own: it is
  // listed only with ?project=<its id>, never in the library at large.
  const rows = await query<Asset>(
    `SELECT * FROM assets a
      WHERE NOT EXISTS (SELECT 1 FROM project_footage f WHERE f.asset_id = a.id AND f.project_id IS NOT ?)
      ORDER BY created_at DESC`,
    [c.req.query("project") ?? null],
  );
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
      // Not deleted on the service: kept, and tried again on the next sweep.
      if (!(await deleteMedia(mediaCfg(env), up.uid).then(() => true, () => false))) continue;
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
  try {
    await deleteMedia(mediaCfg(c.env), uid);
  } catch (e) {
    return c.json({ error: "delete_failed", detail: `the upload could not be deleted from storage, try again: ${(e as Error).message}` }, 502);
  }
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
      // Not deleted on the service: the asset stays, so deleting it again
      // finishes the job, instead of an ok that leaves the copy counting.
      try {
        await deleteMedia({ servicesUrl: c.env.SERVICES_URL, token: c.env.CLAWNIFY_TOKEN }, row.media_uid);
      } catch (e) {
        return c.json({ error: "delete_failed", detail: `the video could not be deleted from storage, try again: ${(e as Error).message}` }, 502);
      }
    } else {
      await deleteUpload(row.key);
    }
    if (row.proxy_key) await deleteUpload(row.proxy_key);
    await run("DELETE FROM assets WHERE id = ?", [row.id]);
    // A clip from a project's Drive folder stays listed as removed, so
    // checking the folder for new files does not bring it back.
    await run(
      "UPDATE project_footage SET status = 'removed', asset_id = NULL, updated_at = datetime('now') WHERE asset_id = ?",
      [row.id],
    );
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
            (SELECT COUNT(*) FROM project_footage f WHERE f.project_id = p.id AND f.status != 'removed') AS footage,
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
  return c.json(projectOut(row));
});

app.post("/api/projects", async (c) => {
  const b = await c.req.json<{ name?: string; edl?: unknown; brief?: string; folder?: string; language?: string }>();
  // A project can start from a Drive folder shared with the link: every video
  // in it, and in the folders inside it, becomes this project's footage.
  let folder: { id: string; name: string; videos: FolderVideo[]; truncated: boolean } | null = null;
  if (b.folder !== undefined) {
    const link = parseDriveLink(String(b.folder));
    if (link?.kind !== "folder") return c.json({ error: "invalid_request", detail: "that isn't a Google Drive folder link" }, 400);
    const walk = await readFolder(link.id);
    if ("failure" in walk) return c.json({ error: "folder_unreadable", detail: walk.failure }, 422);
    folder = { id: link.id, ...walk };
  }
  const name = b.name?.trim() || folder?.name;
  if (!name) return c.json({ error: "name is required" }, 400);

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
    name.slice(0, 200),
    JSON.stringify(edl),
    b.brief?.trim() ?? "",
  ]);
  let footage: FolderAdded | undefined;
  if (folder) footage = await addFolder(c, id, folder, b.language);
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [id]);
  return c.json({ ...projectOut(row!), ...(footage ? { footage } : {}) }, 201);
});

app.put("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const b = await c.req.json<{ name?: string; edl?: unknown; brief?: string }>();
  let edlJson = existing.edl;
  if (b.edl !== undefined) {
    const v = validateEdl(b.edl);
    if ("invalid" in v) return c.json(v.invalid, 422);
    edlJson = JSON.stringify(v.edl);
  }
  await run(
    "UPDATE edit_projects SET name = ?, edl = ?, brief = ?, updated_at = datetime('now') WHERE id = ?",
    [b.name?.trim() || existing.name, edlJson, b.brief !== undefined ? b.brief.trim() : existing.brief, id],
  );
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [id]);
  return c.json(projectOut(row!));
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
/** The project's highlights for the AI editor: never a dropped one; kept first, then the best. */
async function instructHighlights(projectId: string): Promise<InstructHighlight[]> {
  const rows = await query<{ id: string; asset_id: string; kind: HighlightKind; src_in: number; src_out: number; text: string; speaker: string; score: number; pick: string | null }>(
    `SELECT h.id, f.asset_id, h.kind, h.src_in, h.src_out, h.text, h.speaker, h.score, h.pick
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id
      WHERE h.project_id = ? AND f.status = 'ready' AND f.asset_id IS NOT NULL AND (h.pick IS NULL OR h.pick = 'keep')
      ORDER BY h.pick IS NULL, h.score DESC, f.folder, f.name, h.src_in
      LIMIT 120`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    src: `asset:${r.asset_id}`,
    kind: r.kind,
    start: r.src_in,
    end: r.src_out,
    text: r.text,
    speaker: r.speaker,
    score: r.score,
    kept: r.pick === "keep",
  }));
}

app.post("/api/projects/:id/instruct", async (c) => {
  const project = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const b = await c.req.json<{ instruction?: string }>().catch(() => ({}) as { instruction?: string });
  const instruction = b.instruction?.trim();
  if (!instruction) return c.json({ error: "invalid_request", detail: "instruction is required" }, 422);

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
    await instructHighlights(project.id),
  );
  if ("failure" in out) return c.json(out.failure, 422);

  await run("UPDATE edit_projects SET edl = ?, updated_at = datetime('now') WHERE id = ?", [
    JSON.stringify(out.edl),
    project.id,
  ]);
  return c.json({ edl: out.edl, said: out.said, applied: out.applied });
});

app.post("/api/projects/:id/autocut", async (c) => {
  const project = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json({ error: "Auto-cut runs on deployed apps (missing CLAWNIFY_TOKEN)." }, 503);
  }

  const b = await c.req
    .json<{ asset_ids?: string[]; prompt?: string }>()
    .catch(() => ({}) as { asset_ids?: string[]; prompt?: string });
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
  await run("UPDATE edit_projects SET edl = ?, updated_at = datetime('now') WHERE id = ?", [
    JSON.stringify(v.edl),
    project.id,
  ]);
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [project.id]);
  return c.json({ ...projectOut(row!), notes: cut.result.notes });
});

app.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  // Its footage from Drive goes first. Each clip is a copy on the media
  // service, counted against the org's storage until it is deleted there, so
  // a big shoot is deleted a batch per call: 202 says how many are left, and
  // calling again carries on. A clip another project uses stays, in the library.
  const footage = await query<{ id: string; asset_id: string | null; media_uid: string | null; copy_id: string | null }>(
    `SELECT f.id, f.asset_id, a.media_uid, f.copy_id FROM project_footage f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE f.project_id = ? LIMIT ?`,
    [id, FOOTAGE_DELETE_BATCH],
  );
  // A copy made in the connected account's Drive for an import still under
  // way goes too: it is the size of the original.
  // One that can't be deleted keeps its clip for the next call. Without the
  // connection there is no way to reach it, and the project goes regardless.
  const copies = footage.filter((f) => f.copy_id);
  const copyLeft = new Set<string>();
  if (copies.length) {
    const drive = await driveSource(c.env);
    if (drive) {
      await Promise.all(
        copies.map(async (f) => {
          if (!(await removeCopy(drive, f.copy_id!))) copyLeft.add(f.id);
        }),
      );
    }
  }
  if (footage.length > 0) {
    await Promise.all(
      footage.map(async (f) => {
        if (copyLeft.has(f.id)) return;
        if (f.asset_id) {
          const usedElsewhere = await get(
            "SELECT 1 AS used FROM edit_projects WHERE id != ? AND edl LIKE ? LIMIT 1",
            [id, `%"asset:${f.asset_id}"%`],
          );
          if (!usedElsewhere) {
            try {
              if (f.media_uid) await deleteMedia(mediaCfg(c.env), f.media_uid);
            } catch {
              return; // unreachable: kept for the next call
            }
            await run("DELETE FROM assets WHERE id = ?", [f.asset_id]);
          }
        }
        await run("DELETE FROM project_footage WHERE id = ?", [f.id]);
      }),
    );
    const left = await get<{ n: number }>("SELECT COUNT(*) AS n FROM project_footage WHERE project_id = ?", [id]);
    if (left && left.n > 0) return c.json({ ok: false, remaining: left.n }, 202);
  }
  await run("DELETE FROM footage_sources WHERE project_id = ?", [id]);
  await run("DELETE FROM footage_highlights WHERE project_id = ?", [id]);
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

// ── Footage from Drive folders ──────────────────────────────────────
// A project's own clips, from folders shared with the link: imported and
// logged in the background, a few at a time. See src/server/footage.ts.

const FOOTAGE_DELETE_BATCH = 100;
const LANGUAGE = /^[a-z]{2}$/;

interface FolderAdded {
  folder: { id: string; name: string };
  /** Videos in the folder and the folders inside it. */
  found: number;
  /** Of those, the ones new to the project. */
  added: number;
  /** A walk limit was reached, and some videos were left out. */
  truncated: boolean;
}

async function addFolder(
  c: Context<{ Bindings: Bindings }>,
  projectId: string,
  folder: { id: string; name: string; videos: FolderVideo[]; truncated: boolean },
  language?: string,
): Promise<FolderAdded> {
  const lang = language && LANGUAGE.test(language) ? language : "en";
  const added = await addFolderVideos(projectId, folder, folder.videos, lang);
  if (added > 0) await keepFootageMoving(c, projectId, "read");
  return { folder: { id: folder.id, name: folder.name }, found: folder.videos.length, added, truncated: folder.truncated };
}

/** The org's Google Drive connection as a footage source, when it has one. */
async function driveSource(env: Bindings): Promise<DriveSource | undefined> {
  if (!env.CREDENTIALS) return undefined;
  const status = await driveStatus(env).catch(() => ({ connected: false }));
  if (!status.connected) return undefined;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Copies for import land in one folder of the connected account's Drive,
  // made the first time one is needed (and again if someone deleted it).
  const copyFolder = async (fresh: boolean): Promise<string> => {
    const row = fresh ? null : await get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'drive_copy_folder'");
    if (row?.value) return row.value;
    const id = await driveCreateFolder(env, "OpenVideo imports (temporary)");
    await run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('drive_copy_folder', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [id],
    );
    return id;
  };
  return {
    async download(fileId) {
      try {
        const file = await driveDownloadLink(env, fileId);
        return { url: file.url, mimeType: file.mimeType };
      } catch (e) {
        return { error: message(e) };
      }
    },
    async copy(fileId, name) {
      try {
        return { fileId: await driveCopyForImport(env, fileId, name, await copyFolder(false)) };
      } catch {
        try {
          return { fileId: await driveCopyForImport(env, fileId, name, await copyFolder(true)) };
        } catch (e) {
          return { error: message(e) };
        }
      }
    },
    remove: (fileId) => driveRemove(env, fileId),
  };
}

/** Book the next background step while there is work a step can do. */
async function keepFootageMoving(
  c: Context<{ Bindings: Bindings }>,
  projectId: string,
  after: "delivery" | "read",
  at: string | null = null,
): Promise<string | null> {
  const row = await get<{ footage_step_at: string | null }>("SELECT footage_step_at FROM edit_projects WHERE id = ?", [projectId]);
  return bookStep(c.env, new URL(c.req.url).origin, projectId, { after, bookedAt: row?.footage_step_at ?? null, at });
}

async function advanceFootage(
  c: Context<{ Bindings: Bindings }>,
  projectId: string,
  after: "delivery" | "read",
): Promise<{ outcome: StepOutcome; nextStepAt: string | null }> {
  // With the org's Drive connection, clips come in through it, on deliveries
  // only: a download through it takes from seconds to minutes.
  const drive = await driveSource(c.env);
  const outcome = await stepFootage(mediaCfg(c.env), projectId, {
    drive: after === "delivery" ? drive : undefined,
    startImports: !(drive && after === "read"),
  });
  // Highlights are read only on a delivery: a model call takes up to half a
  // minute, and a read answers at once. A read still keeps the chain booked.
  const highlightsMoving =
    after === "delivery"
      ? (await stepHighlights(mediaCfg(c.env), c.env.OPENROUTER_API_KEY, projectId)).moving
      : !!c.env.OPENROUTER_API_KEY && (await highlightsPending(projectId)) > 0;
  const nextStepAt =
    outcome.moving || highlightsMoving
      ? await keepFootageMoving(c, projectId, after)
      : outcome.nextAt
        ? await keepFootageMoving(c, projectId, after, outcome.nextAt)
        : null;
  return { outcome, nextStepAt };
}

interface FootageItemRow {
  id: string;
  name: string;
  folder: string;
  status: string;
  error: string | null;
  log_status: string | null;
  log_error: string | null;
  log: string | null;
  retry_at: string | null;
  asset_id: string | null;
  key: string | null;
  content_type: string | null;
  size: number | null;
  duration: number | null;
  media_uid: string | null;
}

function footageOut(r: FootageItemRow) {
  return {
    id: r.id,
    name: r.name,
    folder: r.folder,
    status: r.status,
    error: r.error,
    // Set while the clip waits on Google Drive: when it is tried again.
    retry_at: r.retry_at,
    asset: r.asset_id
      ? {
          id: r.asset_id,
          key: r.key,
          name: r.name,
          content_type: r.content_type,
          size: r.size,
          duration: r.duration,
          media_uid: r.media_uid,
        }
      : null,
    log_status: r.log_status,
    log_error: r.log_error,
    log: r.log ? JSON.parse(r.log) : null,
  };
}

const FOOTAGE_COLUMNS = `f.id, f.name, f.folder, f.status, f.error, f.retry_at, f.log_status, f.log_error, f.asset_id,
       a.key, a.content_type, a.size, a.duration, a.media_uid`;

function intParam(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// The project's footage and each clip's log, moving the work on by a step
// first (step=0 skips that, for a quick first look). Pages: with logs (the
// default) 50 a page, at most 200; with logs=0 only each log's summary, kind
// and quality, and up to 3000 a page. Narrow with folder= (a folder and
// everything inside it), kind=, status=.
app.get("/api/projects/:id/footage", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT 1 AS found FROM edit_projects WHERE id = ?", [id]))) return c.json({ error: "Not found" }, 404);
  const { outcome, nextStepAt } =
    c.req.query("step") === "0" ? { outcome: null, nextStepAt: null } : await advanceFootage(c, id, "read");

  const full = c.req.query("logs") !== "0";
  const limit = intParam(c.req.query("limit"), full ? 50 : 3000, 1, full ? 200 : 3000);
  const offset = intParam(c.req.query("offset"), 0, 0, 1_000_000);
  const where = ["f.project_id = ?", "f.status != 'removed'"];
  const params: unknown[] = [id];
  const folder = c.req.query("folder")?.replace(/\/+$/, "");
  if (folder) {
    where.push("(f.folder = ? OR substr(f.folder, 1, ?) = ?)");
    params.push(folder, folder.length + 1, `${folder}/`);
  }
  const kind = c.req.query("kind");
  if (kind) {
    where.push("json_extract(f.log, '$.kind') = ?");
    params.push(kind);
  }
  const status = c.req.query("status");
  if (status) {
    where.push("f.status = ?");
    params.push(status);
  }
  const rows = await query<FootageItemRow>(
    `SELECT ${FOOTAGE_COLUMNS},
            CASE WHEN f.log IS NULL THEN NULL
                 WHEN ? THEN f.log
                 ELSE json_object('summary', json_extract(f.log, '$.summary'),
                                  'kind', json_extract(f.log, '$.kind'),
                                  'quality', json_extract(f.log, '$.quality')) END AS log
       FROM project_footage f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE ${where.join(" AND ")}
      ORDER BY f.folder, f.name, f.id
      LIMIT ? OFFSET ?`,
    [full ? 1 : 0, ...params, limit, offset],
  );
  const tally = await query<{ status: string; log_status: string | null; on_drive: number; n: number }>(
    `SELECT status, log_status, retry_at IS NOT NULL AS on_drive, COUNT(*) AS n FROM project_footage
      WHERE project_id = ? AND status != 'removed' GROUP BY status, log_status, on_drive`,
    [id],
  );
  const count = (pick: (t: { status: string; log_status: string | null; on_drive: number }) => boolean) =>
    tally.filter(pick).reduce((sum, t) => sum + t.n, 0);
  const sources = await query<{ folder_id: string; name: string; language: string }>(
    "SELECT folder_id, name, language FROM footage_sources WHERE project_id = ? ORDER BY created_at",
    [id],
  );
  return c.json({
    sources: sources.map((s) => ({
      id: s.folder_id,
      name: s.name,
      language: s.language,
      url: `https://drive.google.com/drive/folders/${s.folder_id}`,
    })),
    counts: {
      total: count(() => true),
      waiting: count((t) => t.status === "waiting"),
      // Of those, the ones waiting until Google Drive hands them over.
      drive_waiting: count((t) => t.status === "waiting" && t.on_drive === 1),
      importing: count((t) => t.status === "importing"),
      ready: count((t) => t.status === "ready"),
      failed: count((t) => t.status === "failed"),
      logged: count((t) => t.log_status === "done"),
      logging: count((t) => t.log_status === "preparing" || t.log_status === "running"),
      log_failed: count((t) => t.log_status === "failed"),
    },
    // Why nothing more is starting, when the org has hit a limit.
    imports_paused: outcome?.importsBlocked ?? null,
    logging_paused: outcome?.logsBlocked ?? null,
    next_step_at: nextStepAt,
    items: rows.map(footageOut),
    next_offset: rows.length === limit ? offset + limit : null,
  });
});

app.get("/api/projects/:id/footage/:clip", async (c) => {
  const row = await get<FootageItemRow>(
    `SELECT ${FOOTAGE_COLUMNS}, f.log FROM project_footage f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE f.project_id = ? AND f.id = ?`,
    [c.req.param("id"), c.req.param("clip")],
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(footageOut(row));
});

// Add a folder shared with the link: its videos and those in every folder
// inside it. Adding one again adds only what is new.
app.post("/api/projects/:id/footage/folders", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT 1 AS found FROM edit_projects WHERE id = ?", [id]))) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ url?: string; language?: string }>().catch(() => ({}) as { url?: string; language?: string });
  const link = parseDriveLink(b.url ?? "");
  if (link?.kind !== "folder") return c.json({ error: "invalid_request", detail: "that isn't a Google Drive folder link" }, 400);
  const walk = await readFolder(link.id);
  if ("failure" in walk) return c.json({ error: "folder_unreadable", detail: walk.failure }, 422);
  return c.json(await addFolder(c, id, { id: link.id, ...walk }, b.language), 201);
});

// Look in the project's folders again and take in what has been added since.
app.post("/api/projects/:id/footage/sync", async (c) => {
  const id = c.req.param("id");
  const sources = await query<{ folder_id: string; language: string }>(
    "SELECT folder_id, language FROM footage_sources WHERE project_id = ?",
    [id],
  );
  if (sources.length === 0) return c.json({ error: "not_found", detail: "this project has no Drive folder" }, 404);
  const folders: (FolderAdded | { folder: { id: string }; error: string })[] = [];
  for (const s of sources) {
    const walk = await readFolder(s.folder_id);
    folders.push(
      "failure" in walk
        ? { folder: { id: s.folder_id }, error: walk.failure }
        : await addFolder(c, id, { id: s.folder_id, ...walk }, s.language),
    );
  }
  return c.json({ added: folders.reduce((n, f) => n + ("added" in f ? f.added : 0), 0), folders });
});

// Put every clip that failed to import or to be logged back in line.
app.post("/api/projects/:id/footage/retry", async (c) => {
  const id = c.req.param("id");
  const imports = await run(
    `UPDATE project_footage SET status = 'waiting', error = NULL, retry_at = NULL, drive_tries = 0,
            transcode = CASE WHEN error LIKE '%bitrate exceeded%' THEN 1 ELSE transcode END, updated_at = datetime('now')
      WHERE project_id = ? AND (status = 'failed' OR (status = 'waiting' AND retry_at IS NOT NULL))`,
    [id],
  );
  const logs = await run(
    `UPDATE project_footage SET log_status = NULL, log_error = NULL, log_job = NULL, updated_at = datetime('now')
      WHERE project_id = ? AND log_status = 'failed'`,
    [id],
  );
  if (imports.changes + logs.changes > 0) await keepFootageMoving(c, id, "read");
  return c.json({ imports: imports.changes, logs: logs.changes });
});

// ── Highlights ───────────────────────────────────────────────────────
// The selects: for every logged clip, whether it is worth an editor's time
// and the parts to cut from, each with a score and the reason. Found in the
// background from the logs and transcripts (src/server/highlights.ts); a
// person keeps or drops each one; the kept ones export to an editor's own
// software (src/server/nle.ts).

interface HighlightListRow {
  id: string;
  footage_id: string;
  kind: HighlightKind;
  src_in: number;
  src_out: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  pick: "keep" | "drop" | null;
  origin: string;
  name: string;
  folder: string;
  drive_file_id: string;
  asset_id: string | null;
  media_uid: string | null;
  duration: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
}

function highlightOut(r: HighlightListRow) {
  return {
    id: r.id,
    clip: { id: r.footage_id, name: r.name, folder: r.folder, asset_id: r.asset_id, media_uid: r.media_uid, duration: r.duration },
    kind: r.kind,
    start: r.src_in,
    end: r.src_out,
    text: r.text,
    speaker: r.speaker,
    score: r.score,
    reason: r.reason,
    pick: r.pick,
    origin: r.origin,
  };
}

const PICKS = ["open", "keep", "drop", "not_dropped", "all"] as const;
type PickFilter = (typeof PICKS)[number];

/** The WHERE for a project's highlights, narrowed by the list's and export's shared filters. */
function highlightFilter(projectId: string, q: (k: string) => string | undefined, defaultPick: PickFilter) {
  const where = ["h.project_id = ?", "f.status != 'removed'"];
  const params: unknown[] = [projectId];
  const kind = q("kind");
  if (kind === "soundbite" || kind === "broll") {
    where.push("h.kind = ?");
    params.push(kind);
  }
  const min = Number.parseInt(q("min_score") ?? "", 10);
  if (min >= 2 && min <= 5) {
    where.push("h.score >= ?");
    params.push(min);
  }
  const pick = (PICKS as readonly string[]).includes(q("pick") ?? "") ? (q("pick") as PickFilter) : defaultPick;
  if (pick === "open") where.push("h.pick IS NULL");
  else if (pick === "keep") where.push("h.pick = 'keep'");
  else if (pick === "drop") where.push("h.pick = 'drop'");
  else if (pick === "not_dropped") where.push("(h.pick IS NULL OR h.pick = 'keep')");
  const folder = q("folder")?.replace(/\/+$/, "");
  if (folder) {
    where.push("(f.folder = ? OR substr(f.folder, 1, ?) = ?)");
    params.push(folder, folder.length + 1, `${folder}/`);
  }
  return { where: where.join(" AND "), params, pick };
}

const HIGHLIGHT_COLUMNS = `h.id, h.footage_id, h.kind, h.src_in, h.src_out, h.text, h.speaker, h.score, h.reason, h.pick, h.origin,
       f.name, f.folder, f.drive_file_id, f.asset_id, f.fps, f.width, f.height, a.media_uid, a.duration`;

// Ask for highlights, or ask again. Without `again`, only clips not yet read
// (and ones that failed) are read; with it, every logged clip is read again,
// and what a person kept or dropped stays as it is. `brief`, when given,
// becomes the project's brief: what the video is for.
app.post("/api/projects/:id/highlights", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT 1 AS found FROM edit_projects WHERE id = ?", [id]))) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ brief?: unknown; again?: unknown }>().catch(() => ({}) as { brief?: unknown; again?: unknown });
  const brief = typeof b.brief === "string" ? b.brief.trim().slice(0, 2000) : null;
  await run(
    "UPDATE edit_projects SET highlights_at = COALESCE(highlights_at, datetime('now')), highlights_stopped_at = NULL, brief = COALESCE(?, brief) WHERE id = ?",
    [brief, id],
  );
  await run(
    `UPDATE project_footage SET highlights_status = 'waiting', highlights_error = NULL
      WHERE project_id = ? AND status = 'ready' AND log_status = 'done'
        AND (highlights_status IS NULL OR highlights_status = 'failed' OR (? AND highlights_status = 'done'))`,
    [id, b.again === true ? 1 : 0],
  );
  const pending = await highlightsPending(id);
  const nextStepAt = pending > 0 && c.env.OPENROUTER_API_KEY ? await keepFootageMoving(c, id, "read") : null;
  return c.json({ ok: true, pending, next_step_at: nextStepAt, paused: c.env.OPENROUTER_API_KEY ? null : HIGHLIGHTS_NO_KEY }, 202);
});

// Stop reading. Clips in line go back to how they were (read before: their
// picks stay; never read: not asked), and clips logged later don't join until
// highlights are asked for again. A batch already with the model still lands.
app.post("/api/projects/:id/highlights/stop", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT 1 AS found FROM edit_projects WHERE id = ?", [id]))) return c.json({ error: "Not found" }, 404);
  await run("UPDATE edit_projects SET highlights_stopped_at = datetime('now') WHERE id = ? AND highlights_at IS NOT NULL", [id]);
  await run(
    `UPDATE project_footage SET highlights_status = CASE
        WHEN skip_reason IS NOT NULL OR EXISTS (SELECT 1 FROM footage_highlights h WHERE h.footage_id = project_footage.id) THEN 'done'
        ELSE NULL END
      WHERE project_id = ? AND highlights_status IN ('waiting', 'running')`,
    [id],
  );
  return c.json({ ok: true, pending: await highlightsPending(id) });
});

// The highlights, best first by default. Filters: kind=soundbite|broll,
// min_score=2..5, pick=open|keep|drop|not_dropped|all (default all),
// folder= (a folder and everything inside it), sort=score|clip. Pages of 100,
// at most 1000. skipped=1 adds the clips judged not worth using, and why.
app.get("/api/projects/:id/highlights", async (c) => {
  const id = c.req.param("id");
  const project = await get<{ brief: string; highlights_at: string | null; highlights_stopped_at: string | null }>(
    "SELECT brief, highlights_at, highlights_stopped_at FROM edit_projects WHERE id = ?",
    [id],
  );
  if (!project) return c.json({ error: "Not found" }, 404);
  const q = (k: string) => c.req.query(k);
  const { where, params } = highlightFilter(id, q, "all");
  const limit = intParam(q("limit"), 100, 1, 1000);
  const offset = intParam(q("offset"), 0, 0, 1_000_000);
  const order = q("sort") === "clip" ? "f.folder, f.name, h.src_in" : "h.score DESC, f.folder, f.name, h.src_in";
  const rows = await query<HighlightListRow>(
    `SELECT ${HIGHLIGHT_COLUMNS}
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id LEFT JOIN assets a ON a.id = f.asset_id
      WHERE ${where}
      ORDER BY ${order}, h.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const clips = await query<{ highlights_status: string | null; skipped: number; n: number }>(
    `SELECT highlights_status, skip_reason IS NOT NULL AS skipped, COUNT(*) AS n FROM project_footage
      WHERE project_id = ? AND status = 'ready' AND log_status = 'done' GROUP BY highlights_status, skipped`,
    [id],
  );
  const picks = await query<{ kind: string; pick: string | null; n: number }>(
    `SELECT h.kind, h.pick, COUNT(*) AS n FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id
      WHERE h.project_id = ? AND f.status != 'removed' GROUP BY h.kind, h.pick`,
    [id],
  );
  const clipCount = (pick: (r: { highlights_status: string | null; skipped: number }) => boolean) =>
    clips.filter(pick).reduce((sum, r) => sum + r.n, 0);
  const pickCount = (pick: (r: { kind: string; pick: string | null }) => boolean) =>
    picks.filter(pick).reduce((sum, r) => sum + r.n, 0);
  const pending = clipCount((r) => r.highlights_status === "waiting" || r.highlights_status === "running");
  const nextStepAt = pending > 0 && c.env.OPENROUTER_API_KEY ? await keepFootageMoving(c, id, "read") : null;
  const skipped =
    q("skipped") === "1"
      ? await query<{ id: string; name: string; folder: string; skip_reason: string; asset_id: string | null; media_uid: string | null; duration: number | null }>(
          `SELECT f.id, f.name, f.folder, f.skip_reason, f.asset_id, a.media_uid, a.duration
             FROM project_footage f LEFT JOIN assets a ON a.id = f.asset_id
            WHERE f.project_id = ? AND f.status = 'ready' AND f.skip_reason IS NOT NULL
            ORDER BY f.folder, f.name`,
          [id],
        )
      : undefined;
  return c.json({
    asked: !!project.highlights_at,
    stopped: !!project.highlights_stopped_at,
    brief: project.brief,
    clips: {
      logged: clipCount(() => true),
      done: clipCount((r) => r.highlights_status === "done"),
      pending,
      failed: clipCount((r) => r.highlights_status === "failed"),
      skipped: clipCount((r) => r.highlights_status === "done" && r.skipped === 1),
      not_asked: clipCount((r) => r.highlights_status === null),
    },
    counts: {
      total: pickCount(() => true),
      soundbites: pickCount((r) => r.kind === "soundbite"),
      broll: pickCount((r) => r.kind === "broll"),
      kept: pickCount((r) => r.pick === "keep"),
      dropped: pickCount((r) => r.pick === "drop"),
      open: pickCount((r) => r.pick === null),
    },
    paused: project.highlights_at && pending > 0 && !c.env.OPENROUTER_API_KEY ? HIGHLIGHTS_NO_KEY : null,
    next_step_at: nextStepAt,
    highlights: rows.map(highlightOut),
    next_offset: rows.length === limit ? offset + limit : null,
    ...(skipped ? { skipped: skipped.map((s) => ({ id: s.id, name: s.name, folder: s.folder, reason: s.skip_reason, asset_id: s.asset_id, media_uid: s.media_uid, duration: s.duration })) } : {}),
  });
});

// A person's call on one highlight: pick keep | drop | null (back to
// unreviewed), its in and out (seconds into the clip) if they move them, and
// who says it or what it shows when they know better (a name and title).
app.patch("/api/projects/:id/highlights/:hid", async (c) => {
  const row = await get<HighlightListRow>(
    `SELECT ${HIGHLIGHT_COLUMNS}
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id LEFT JOIN assets a ON a.id = f.asset_id
      WHERE h.project_id = ? AND h.id = ?`,
    [c.req.param("id"), c.req.param("hid")],
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  const b = await c.req
    .json<{ pick?: unknown; start?: unknown; end?: unknown; speaker?: unknown; text?: unknown }>()
    .catch(() => ({}) as { pick?: unknown; start?: unknown; end?: unknown; speaker?: unknown; text?: unknown });
  if (b.speaker !== undefined && typeof b.speaker !== "string") return c.json({ error: "invalid_request", detail: "speaker is text" }, 400);
  if (b.text !== undefined && (typeof b.text !== "string" || !b.text.trim())) return c.json({ error: "invalid_request", detail: "text can't be empty" }, 400);
  let pick = row.pick;
  if (b.pick !== undefined) {
    if (b.pick !== null && b.pick !== "keep" && b.pick !== "drop") return c.json({ error: "invalid_request", detail: "pick is keep, drop or null" }, 400);
    pick = b.pick;
  }
  const length = row.duration ?? Infinity;
  const start = b.start === undefined ? row.src_in : Number(b.start);
  const end = b.end === undefined ? row.src_out : Number(b.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > length + 0.05 || end - start < 0.2) {
    return c.json({ error: "invalid_request", detail: "start and end must lie inside the clip, end after start" }, 400);
  }
  await run("UPDATE footage_highlights SET pick = ?, src_in = ?, src_out = ?, speaker = ?, text = ?, updated_at = datetime('now') WHERE id = ?", [
    pick,
    Math.round(start * 100) / 100,
    Math.round(Math.min(end, length) * 100) / 100,
    typeof b.speaker === "string" ? b.speaker.trim().slice(0, 120) : row.speaker,
    typeof b.text === "string" ? b.text.trim().slice(0, 1000) : row.text,
    row.id,
  ]);
  const updated = await get<HighlightListRow>(
    `SELECT ${HIGHLIGHT_COLUMNS}
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id LEFT JOIN assets a ON a.id = f.asset_id
      WHERE h.id = ?`,
    [row.id],
  );
  return c.json(highlightOut(updated!));
});

// A person's own pick, for a part the model passed over or a clip it skipped.
// It starts out kept.
app.post("/api/projects/:id/highlights/items", async (c) => {
  const id = c.req.param("id");
  const b = await c.req
    .json<{ clip?: unknown; start?: unknown; end?: unknown; kind?: unknown; text?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const clip = await get<{ id: string; duration: number | null }>(
    `SELECT f.id, a.duration FROM project_footage f JOIN assets a ON a.id = f.asset_id WHERE f.project_id = ? AND f.id = ? AND f.status = 'ready'`,
    [id, String(b.clip ?? "")],
  );
  if (!clip) return c.json({ error: "Not found", detail: "no such clip in this project" }, 404);
  const length = clip.duration ?? Infinity;
  const start = b.start === undefined ? 0 : Number(b.start);
  const end = b.end === undefined ? length : Number(b.end);
  const kind = b.kind === "soundbite" ? "soundbite" : "broll";
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > length + 0.05 || end - start < 0.2) {
    return c.json({ error: "invalid_request", detail: "start and end must lie inside the clip, end after start" }, 400);
  }
  const hid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await run(
    `INSERT INTO footage_highlights (id, project_id, footage_id, kind, src_in, src_out, text, score, reason, pick, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 3, '', 'keep', 'person')`,
    [hid, id, clip.id, kind, Math.round(start * 100) / 100, Math.round(Math.min(end, length) * 100) / 100, typeof b.text === "string" ? b.text.trim().slice(0, 1000) : ""],
  );
  const row = await get<HighlightListRow>(
    `SELECT ${HIGHLIGHT_COLUMNS}
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id LEFT JOIN assets a ON a.id = f.asset_id
      WHERE h.id = ?`,
    [hid],
  );
  return c.json(highlightOut(row!), 201);
});

// The highlights as a file for an editor's own software. format=csv (a sheet)
// or xml (a Premiere Pro / DaVinci Resolve timeline). Same filters as the
// list; by default everything not dropped.
app.get("/api/projects/:id/highlights/export", async (c) => {
  const id = c.req.param("id");
  const project = await get<{ name: string }>("SELECT name FROM edit_projects WHERE id = ?", [id]);
  if (!project) return c.json({ error: "Not found" }, 404);
  const q = (k: string) => c.req.query(k);
  const { where, params } = highlightFilter(id, q, "not_dropped");
  const rows = await query<HighlightListRow>(
    `SELECT ${HIGHLIGHT_COLUMNS}
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id LEFT JOIN assets a ON a.id = f.asset_id
      WHERE ${where}
      ORDER BY f.folder, f.name, h.src_in, h.id
      LIMIT 5000`,
    params,
  );
  const base = `${project.name.replace(/[^\w .-]+/g, "").trim() || "highlights"} highlights`;
  const format = q("format") === "xml" ? "xml" : "csv";
  if (format === "csv") {
    return new Response(highlightsCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
      },
    });
  }
  // A timeline: the picks on the camera files, for Premiere Pro or Resolve.
  // root= is where the editor downloaded the footage folder, so the files are
  // found without relinking; fps= sets the timeline's rate.
  const fps = Number(q("fps"));
  const xml = highlightsXml(
    `${project.name.trim() || "Highlights"} highlights`,
    rows.map((r) => ({
      kind: r.kind,
      src_in: r.src_in,
      src_out: r.src_out,
      text: r.text,
      speaker: r.speaker,
      score: r.score,
      reason: r.reason,
      file: { id: r.footage_id, name: r.name, folder: r.folder, duration: r.duration ?? r.src_out, fps: r.fps, width: r.width, height: r.height },
    })),
    { root: (q("root") ?? "").slice(0, 1000), rate: fps >= 10 && fps <= 120 ? rateOf(fps) : undefined },
  );
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.xml"`,
    },
  });
});

// The platform queue's call for the next background step. Public, because the
// queue calls from outside the app's sign-in; the signature is the check.
app.post("/api/footage/step", async (c) => {
  const body = await c.req.text();
  const signed = await verifyDelivery(body, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  if (!signed) return c.json({ error: "unauthorized" }, 401);
  let projectId = "";
  try {
    projectId = String((JSON.parse(body) as { project_id?: unknown }).project_id ?? "");
  } catch {
    /* no project: answered below */
  }
  // A project deleted since the step was booked: nothing to do, and a 2xx so
  // the queue does not try again.
  if (!(await get("SELECT 1 AS found FROM edit_projects WHERE id = ?", [projectId]))) return c.json({ ok: true });
  const { outcome, nextStepAt } = await advanceFootage(c, projectId, "delivery");
  return c.json({ ok: true, pending: outcome.pending, next_step_at: nextStepAt });
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

  // Hand the render to the edit service. This runs to the end even if the
  // caller goes away mid-request (a phone locking, a laptop closing): cut off
  // between the insert and the render's start, an export used to be left
  // with no render at all, failing only when a read noticed, 15 minutes on.
  const handover: Promise<{ ok: true } | ExportFailure> = (async () => {
    try {
      const resolved = await resolveEdlSources(parsed.edl, cfg);
      if ("failure" in resolved) return resolved.failure;
      const started = await startEdit(resolved.edl, { quality, filename: `${makeKey(project.name)}.mp4` }, cfg);
      if ("failure" in started) return started.failure;
      // The render is on its way; reads of this job settle it (settleExport).
      await run("UPDATE export_jobs SET service_job_id = ?, updated_at = datetime('now') WHERE id = ?", [
        started.jobId,
        jobId,
      ]);
      return { ok: true as const };
    } catch (err) {
      return { error: "export_failed", detail: String(err).slice(0, 500) };
    }
  })().then(async (outcome) => {
    if ("error" in outcome) {
      const msg = `${outcome.error}: ${outcome.detail}${outcome.path ? ` (at ${outcome.path})` : ""}`.slice(0, 1000);
      await run("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", [msg, jobId]);
    }
    return outcome;
  });
  c.executionCtx.waitUntil(handover.then(() => {}));
  const outcome = await handover;

  const job = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
  if ("error" in outcome) {
    // Machine-readable failure alongside the job row, so an editing loop can
    // jump straight to the offending EDL node.
    const { error, detail, path } = outcome;
    return c.json({ ...job, failure: { error, detail, ...(path ? { path } : {}) } }, 201);
  }
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
