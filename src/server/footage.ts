// A project's footage from Google Drive folders, and the log the platform's
// video analysis writes about each clip.
//
// A shoot arrives as a shared folder: a folder per camera, a few hundred clips
// a day. Every video in it becomes a row of project_footage, which moves on by
// itself:
//   waiting → importing (the media service pulls it from Drive, or, for a
//             file Drive won't hand over whole, this app sends it a piece at
//             a time: src/server/relay.ts) → ready
// and once ready, its log:
//   preparing (the platform makes the copy analysis reads) → running → done
//
// Work advances in bounded steps, a few clips at a time, so a day of footage
// never floods the media service, the render container that makes analysis
// copies, or the model. A step runs whenever anyone reads the footage, and
// while work is left the platform queue books the next one a minute later, so
// nobody has to keep the project open while a shoot comes in.

import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import { query, get, run } from "./db";
import { deleteMedia, importMedia, mediaState, openMediaUpload, prepareMedia, startTranscode, transcodeState, type MediaConfig } from "./media";
import { refusalDetail } from "./refusal";
import { directDownloadUrl, folderListingUrl, judgeLinkResponse, listFolderVideos, type FolderVideo } from "./drive-link";
import {
  MAX_RELAY_BYTES,
  RELAY_AT_ONCE,
  RELAY_BUDGET_MS,
  RELAY_EXPIRY_MARGIN_MS,
  rangedSize,
  relayPieces,
  sharedLinkReader,
  type PieceReader,
} from "./relay";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

export type FootageStatus = "waiting" | "importing" | "ready" | "failed" | "removed";
export type LogStatus = "preparing" | "running" | "done" | "failed";

/** How many clips are in each stage at once, per project. */
export const STEP_LIMITS = { importing: 10, preparing: 4, running: 8 };

// A row claimed by a step that died before recording what it started.
const STALE_CLAIM_MS = 3 * 60_000;
// Stages that never finish are given up on, so the chain of steps ends.
const IMPORT_TIMEOUT_MS = 3 * 60 * 60_000;
const PREPARE_TIMEOUT_MS = 60 * 60_000;

// ── the log ─────────────────────────────────────────────────────────────────

export interface ClipLog {
  summary: string;
  kind: "interview" | "stage" | "b-roll" | "other";
  quality: "good" | "usable" | "unusable";
  issues: string;
  /** Seconds into the clip. */
  quotes: { start: number; end: number; text: string; speaker: string }[];
  moments: { start: number; end: number; description: string }[];
  visible_text: string[];
}

/**
 * A clip shorter than this is an accidental recording (a tap of the record
 * button). It is logged as too short without asking for an analysis, which
 * has nothing to read in it and fails.
 */
export const MIN_LOG_SECONDS = 1;

export function tooShortLog(duration: number): ClipLog {
  return {
    summary: `A ${duration.toFixed(1)} s clip, too short to use.`,
    kind: "other",
    quality: "unusable",
    issues: "too short to use",
    quotes: [],
    moments: [],
    visible_text: [],
  };
}

const KINDS = ["interview", "stage", "b-roll", "other"] as const;
const QUALITIES = ["good", "usable", "unusable"] as const;

const TIME = { type: "string", description: "position in this clip, M:SS with tenths allowed, e.g. 0:42.5" };

export const LOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "kind", "quality", "issues", "quotes", "moments", "visible_text"],
  properties: {
    summary: { type: "string", description: "one or two sentences: what the clip shows, where, and what happens in it" },
    kind: {
      type: "string",
      enum: [...KINDS],
      description:
        "interview: someone talks to the camera or to an interviewer beside it. stage: a talk, panel or presentation filmed from the room. b-roll: places, people, objects and activity, with nobody addressing the camera. other: test shots, black frames, accidental recordings",
    },
    quality: {
      type: "string",
      enum: [...QUALITIES],
      description:
        "good: steady, in focus, well exposed, and clear sound where someone speaks. usable: has a flaw an editor can work around. unusable: nothing in it could go in a finished video",
    },
    issues: {
      type: "string",
      description: "the technical problems, e.g. shaky, soft focus, wind noise, clipped sound. Empty when there are none",
    },
    quotes: {
      type: "array",
      description:
        "the strongest things said, word for word: complete sentences that make sense on their own, best first, at most 6. Empty when nobody speaks",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text", "speaker"],
        properties: {
          start: TIME,
          end: TIME,
          text: { type: "string" },
          speaker: {
            type: "string",
            description: "who says it, as they appear (\"woman in a green blazer\"). A name only when the clip says or shows it",
          },
        },
      },
    },
    moments: {
      type: "array",
      description:
        "the best stretches to show without their sound: steady, in focus, something worth seeing, 2 to 10 seconds each, best first, at most 6",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "description"],
        properties: { start: TIME, end: TIME, description: { type: "string" } },
      },
    },
    visible_text: {
      type: "array",
      description: "brand names, logos, signs, screens and captions that can be read in the clip, each once",
      items: { type: "string" },
    },
  },
};

export function logPrompt(clip: { name: string; folder: string }): string {
  const name = clip.name.slice(0, 200);
  const folder = clip.folder.slice(0, 200);
  return [
    "Log this clip for an editor who will choose the best parts of a whole shoot later.",
    `The clip is the file "${name}"${folder ? ` in the folder "${folder}"` : ""}.`,
    "Describe only what is in it. Quote speech exactly as it is said. Give times as positions in this clip.",
    "Never identify a person from their face or voice: name someone only when the clip says or shows the name.",
  ].join("\n");
}

/** "1:25:20", "0:42.5" or "42.5" → seconds. NaN when unreadable. */
export function parseClock(s: string): number {
  const plain = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (plain) return Number(plain[1]);
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * The analysis answer → a log, times in seconds and inside the clip. Entries
 * that can't be read are dropped; an answer without a summary is no log.
 */
export function readLog(raw: unknown, duration: number | null): ClipLog | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const summary = text(r.summary, 600);
  if (!summary) return null;
  const end = duration && duration > 0 ? duration : Infinity;
  const span = (a: unknown, b: unknown) => {
    const s = parseClock(String(a ?? ""));
    const e = parseClock(String(b ?? ""));
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    const start = Math.max(0, Math.min(s, end));
    const stop = Math.min(e, end);
    return stop > start ? { start: round1(start), end: round1(stop) } : null;
  };
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  return {
    summary,
    kind: KINDS.includes(r.kind as ClipLog["kind"]) ? (r.kind as ClipLog["kind"]) : "other",
    quality: QUALITIES.includes(r.quality as ClipLog["quality"]) ? (r.quality as ClipLog["quality"]) : "usable",
    issues: text(r.issues, 300),
    quotes: list(r.quotes)
      .map((q) => {
        const at = span(q.start, q.end);
        const said = text(q.text, 1000);
        return at && said ? { ...at, text: said, speaker: text(q.speaker, 120) } : null;
      })
      .filter((q): q is ClipLog["quotes"][number] => q !== null)
      .slice(0, 6),
    moments: list(r.moments)
      .map((m) => {
        const at = span(m.start, m.end);
        const description = text(m.description, 300);
        return at && description ? { ...at, description } : null;
      })
      .filter((m): m is ClipLog["moments"][number] => m !== null)
      .slice(0, 6),
    visible_text: [...new Set((Array.isArray(r.visible_text) ? r.visible_text : []).map((t) => text(t, 120)).filter(Boolean))].slice(0, 20),
  };
}

// ── the analysis service ────────────────────────────────────────────────────
// /video/analyze watches and listens to a video on the media service. The
// answer comes back as a job: watching takes a while.

interface ServiceFailure {
  status: number;
  error: string;
  detail: string;
}

export async function startLog(
  cfg: MediaConfig,
  mediaUid: string,
  clip: { name: string; folder: string },
): Promise<{ jobId: string } | { failure: ServiceFailure }> {
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/video/analyze`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: `media:${mediaUid}`,
      prompt: logPrompt(clip),
      schema: LOG_SCHEMA,
      thinking: "low",
      max_output_tokens: 8000,
    }),
  }).catch(() => null);
  if (!res) return { failure: { status: 503, error: "unreachable", detail: "the analysis service could not be reached" } };
  const body = (await res.json().catch(() => null)) as { job_id?: string; error?: string; detail?: string } | null;
  if (res.ok && body?.job_id) return { jobId: body.job_id };
  return {
    failure: { status: res.status, error: body?.error ?? "analyze_failed", detail: refusalDetail(body, `the analysis service answered ${res.status}`) },
  };
}

export type LogPoll = { status: "running" } | { status: "done"; result: unknown } | { status: "failed"; detail: string };

/** An outage or a 5xx reads as still running: the next step asks again. */
export async function pollLog(cfg: MediaConfig, jobId: string): Promise<LogPoll> {
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/video/analyze/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  }).catch(() => null);
  if (res?.status === 404) return { status: "failed", detail: "the analysis service no longer has this job" };
  if (!res?.ok) return { status: "running" };
  const body = (await res.json().catch(() => null)) as { status?: string; result?: unknown; detail?: string } | null;
  if (body?.status === "done") return { status: "done", result: body.result };
  if (body?.status === "failed") return { status: "failed", detail: body.detail ?? "the analysis failed" };
  return { status: "running" };
}

// ── folders ─────────────────────────────────────────────────────────────────

/** Every video in a public folder and the folders inside it, or why not. */
export async function readFolder(
  folderId: string,
): Promise<{ name: string; videos: FolderVideo[]; truncated: boolean } | { failure: string }> {
  try {
    const walk = await listFolderVideos(async (id) => {
      const res = await fetch(folderListingUrl(id), { headers: { "User-Agent": "OpenVideo" } });
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }, folderId);
    if (walk.videos.length === 0) {
      return { failure: "no videos in that folder. Is it shared with anyone who has the link?" };
    }
    return { name: walk.name ?? "Drive folder", videos: walk.videos, truncated: walk.truncated };
  } catch {
    return { failure: "couldn't open that folder. Is it shared with anyone who has the link?" };
  }
}

/**
 * Add a folder's videos to a project. A file already there is skipped, so
 * adding the same folder again picks up only what is new. Returns how many
 * were added.
 */
export async function addFolderVideos(
  projectId: string,
  folder: { id: string; name: string },
  videos: FolderVideo[],
  language: string,
): Promise<number> {
  await run(
    `INSERT INTO footage_sources (project_id, folder_id, name, language) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, folder_id) DO UPDATE SET name = excluded.name`,
    [projectId, folder.id, folder.name.slice(0, 200), language],
  );
  let added = 0;
  // Five values a row, and D1 takes at most 100 bound values a statement.
  for (let i = 0; i < videos.length; i += 20) {
    const chunk = videos.slice(i, i + 20);
    const res = await run(
      `INSERT OR IGNORE INTO project_footage (project_id, drive_file_id, name, folder, language) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      chunk.flatMap((v) => [
        projectId,
        v.id,
        v.name.slice(0, 200),
        (v.folder ? `${folder.name}/${v.folder}` : folder.name).slice(0, 400),
        language,
      ]),
    );
    added += res.changes;
  }
  return added;
}

// ── the step ────────────────────────────────────────────────────────────────

interface WorkRow {
  id: string;
  status: FootageStatus;
  drive_file_id: string;
  name: string;
  folder: string;
  language: string;
  asset_id: string | null;
  log_status: LogStatus | null;
  log_job: string | null;
  updated_at: string;
  media_uid: string | null;
  duration: number | null;
  retry_at: string | null;
  drive_tries: number;
  link_only: number;
  copy_id: string | null;
  transcode: number;
  transcode_job: string | null;
  upload_uid: string | null;
  upload_url: string | null;
  upload_expires: string | null;
  upload_size: number | null;
}

/**
 * The org's Google Drive connection, when it has one. Drive's limit on how
 * often a file shared with the link is downloaded doesn't apply to it.
 */
export interface DriveSource {
  /** A short-lived link to the file's bytes, fetched as the connected account. */
  download(fileId: string): Promise<{ url: string; mimeType: string } | { error: string }>;
  /** Delete a copy an earlier version made in the connected account for an import. */
  remove(fileId: string): Promise<void>;
  /**
   * One piece of a file through the connection: Drive's answer, with its own
   * status and headers. It serves pieces the shared link refuses.
   */
  piece?(fileId: string, start: number, end: number, signal: AbortSignal): Promise<Response | null>;
}

/**
 * Delete a copy made in the connected account. True once it is gone (one
 * already deleted counts); false keeps it on the row, so the next try deletes
 * it instead of forgetting a file that is still shared with the link.
 */
export async function removeCopy(drive: DriveSource, fileId: string): Promise<boolean> {
  return drive.remove(fileId).then(
    () => true,
    (e: unknown) => /not.?found|404/i.test(String(e)),
  );
}

export interface StepOptions {
  /** Import through the org's Drive connection; the shared link stays the fallback. */
  drive?: DriveSource;
  /** False: start no imports this step (a read, while imports go through the connection, which is slow). */
  startImports?: boolean;
  /** Move files coming in a piece at a time a few pieces on: deliveries only, as it takes a while. */
  relay?: boolean;
}

export interface StepOutcome {
  /** Clips still on their way in or being logged. */
  pending: number;
  /** Whether a later step can move any of them on: false when everything left is held by a limit. */
  moving: boolean;
  /** Why no more clips are being imported, when the org has hit a limit. */
  importsBlocked: string | null;
  /** Why no more clips are being logged, when the org has hit a limit. */
  logsBlocked: string | null;
  /** When nothing can move before then (clips waiting on Google Drive): when to look again. */
  nextAt: string | null;
}

// Errors that are about the org, not the clip: every clip would fail the same
// way, so the clip waits and nothing more starts until the next step.
const ORG_LIMITS = new Set(["storage_full", "quota_exceeded", "insufficient_credits", "media_unavailable", "invalid_token", "not_configured"]);

const age = (sqlTime: string) => Date.now() - Date.parse(`${sqlTime.replace(" ", "T")}Z`);

async function setRow(id: string, fields: Record<string, unknown>, where = ""): Promise<boolean> {
  const keys = Object.keys(fields);
  const res = await run(
    `UPDATE project_footage SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?${where}`,
    [...keys.map((k) => fields[k]), id],
  );
  return res.changes > 0;
}

/**
 * Move a project's footage on by one bounded step: settle what finished,
 * start what has room. Safe to run from several places at once: every start
 * claims its row first, and a row only one step can claim.
 */
export async function stepFootage(cfg: MediaConfig, projectId: string, opts: StepOptions = {}): Promise<StepOutcome> {
  // With a connection, clips waiting on the shared link's limit can come in
  // now: only those the connection already couldn't take keep waiting. And a
  // copy made for an import that is over goes.
  if (opts.drive) {
    await run(
      `UPDATE project_footage SET retry_at = NULL, error = NULL
        WHERE project_id = ? AND status = 'waiting' AND retry_at IS NOT NULL AND link_only = 0`,
      [projectId],
    );
    const done = await query<{ id: string; copy_id: string }>(
      "SELECT id, copy_id FROM project_footage WHERE project_id = ? AND copy_id IS NOT NULL AND status IN ('ready', 'failed', 'removed')",
      [projectId],
    );
    for (const d of done) {
      if (await removeCopy(opts.drive, d.copy_id)) await setRow(d.id, { copy_id: null });
    }
  }
  const rows = await query<WorkRow>(
    `SELECT f.id, f.status, f.drive_file_id, f.name, f.folder, f.language, f.asset_id, f.log_status, f.log_job,
            f.updated_at, f.retry_at, f.drive_tries, f.link_only, f.copy_id, f.transcode, f.transcode_job,
            f.upload_uid, f.upload_url, f.upload_expires, f.upload_size, a.media_uid, a.duration
       FROM project_footage f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE f.project_id = ?
        AND (f.status IN ('waiting', 'importing')
             OR (f.status = 'ready' AND (f.log_status IS NULL OR f.log_status IN ('preparing', 'running'))))
      ORDER BY f.folder, f.name`,
    [projectId],
  );
  const out: StepOutcome = { pending: rows.length, moving: false, importsBlocked: null, logsBlocked: null, nextAt: null };
  if (rows.length === 0 || !cfg.token) {
    if (rows.length && !cfg.token) {
      out.importsBlocked = "importing needs the managed media service, which deployed apps have and local dev does not";
    }
    return out;
  }

  // 1. Imports that finished, or never will.
  const importing = rows.filter((r) => r.status === "importing");
  const relaying: WorkRow[] = [];
  await Promise.all(
    importing.map(async (r) => {
      // Being re-encoded: once it has a media id it imports like any other.
      if (r.transcode_job) {
        const t = await transcodeState(cfg, r.transcode_job);
        if (t.status === "done") {
          const res = await run("INSERT INTO assets (key, name, content_type, size, media_uid) VALUES (?, ?, ?, ?, ?)", [
            `media/${t.id}`,
            r.name,
            "video/mp4",
            0,
            t.id,
          ]);
          const asset = await get<{ id: string }>("SELECT id FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
          // 2: what the host now has is the re-encode.
          await setRow(r.id, { asset_id: asset!.id, transcode_job: null, transcode: 2 });
        } else if (t.status === "failed") {
          await setRow(r.id, { status: "failed", error: t.detail, transcode_job: null });
          r.status = "failed";
        } else if (age(r.updated_at) > IMPORT_TIMEOUT_MS) {
          await setRow(r.id, { status: "failed", error: "the re-encode did not finish", transcode_job: null });
          r.status = "failed";
        }
        return;
      }
      // Coming in a piece at a time: moved on below, on deliveries. It has no
      // media id until the last piece is in, and is not a stale claim.
      if (r.upload_uid) {
        relaying.push(r);
        return;
      }
      if (!r.media_uid) {
        if (age(r.updated_at) > STALE_CLAIM_MS) await setRow(r.id, { status: "waiting" }, " AND status = 'importing'");
        return;
      }
      const s = await mediaState(cfg, r.media_uid);
      if ("failure" in s) {
        if (s.failure.error === "not_found") await setRow(r.id, { status: "failed", error: "the media service no longer has this video" });
        return;
      }
      if (s.media.ready) {
        await run("UPDATE assets SET duration = COALESCE(duration, ?) WHERE id = ?", [s.media.duration, r.asset_id]);
        await setRow(r.id, { status: "ready" });
        r.status = "ready";
        r.duration = r.duration ?? s.media.duration;
      } else if (s.media.state === "error" && r.transcode < 2 && BITRATE_REFUSED.test(s.media.error ?? "")) {
        // Over the video host's bitrate cap: back in line, to be re-encoded
        // on the way in. The refused copy is of no use.
        await deleteMedia(cfg, r.media_uid).catch(() => {});
        if (r.asset_id) await run("DELETE FROM assets WHERE id = ?", [r.asset_id]);
        await setRow(r.id, { status: "waiting", asset_id: null, transcode: 1, error: null });
        // This same step may claim it again: it must see what the row now says.
        Object.assign(r, { status: "waiting", asset_id: null, media_uid: null, transcode: 1 });
      } else if (s.media.state === "error") {
        await setRow(r.id, { status: "failed", error: s.media.error || "the video could not be processed" });
        r.status = "failed";
      } else if (age(r.updated_at) > IMPORT_TIMEOUT_MS) {
        await setRow(r.id, { status: "failed", error: "the import did not finish" });
        r.status = "failed";
      }
    }),
  );

  // 1b. Files Drive won't hand over whole: a few more pieces each. The time
  //     counts from here, so it doesn't matter what ran before.
  if (opts.relay && relaying.length) {
    const until = Date.now() + RELAY_BUDGET_MS;
    await Promise.all(relaying.slice(0, RELAY_AT_ONCE).map((r) => relayClip(cfg, r, until, opts.drive)));
  }

  // 2. Start imports while there is room, together. A refusal that is about
  //    the org (storage full) puts its clip back in line and starts no more.
  const room = opts.startImports === false ? 0 : STEP_LIMITS.importing - importing.filter((r) => r.status === "importing").length;
  const claimed: WorkRow[] = [];
  const now = new Date().toISOString();
  for (const r of rows) {
    if (claimed.length >= room) break;
    if (r.status !== "waiting" || (r.retry_at && r.retry_at > now)) continue;
    if (await setRow(r.id, { status: "importing", error: null, retry_at: null }, " AND status = 'waiting'")) claimed.push(r);
  }
  await Promise.all(
    claimed.map(async (r) => {
      const started = await startImport(cfg, r, opts.drive);
      if (started === true) return;
      if (started.driveLimit) {
        await waitOnDrive(cfg, r);
        return;
      }
      if (started.orgWide) {
        await setRow(r.id, { status: "waiting" });
        out.importsBlocked = started.detail;
      } else {
        await setRow(r.id, { status: "failed", error: started.detail });
      }
    }),
  );

  // 3. Logs that finished. A row settled here waits for the next step before
  //    anything else is started for it.
  const ready = rows.filter((r) => r.status === "ready" && r.media_uid);
  const running = ready.filter((r) => r.log_status === "running");
  const settled = new Set<string>();
  await Promise.all(
    running.map(async (r) => {
      if (!r.log_job) {
        // Claimed by a step that died before the analysis started.
        if (age(r.updated_at) > STALE_CLAIM_MS && (await setRow(r.id, { log_status: "preparing" }, " AND log_status = 'running'"))) {
          settled.add(r.id);
        }
        return;
      }
      const p = await pollLog(cfg, r.log_job);
      if (p.status === "running") return;
      settled.add(r.id);
      if (p.status === "done") {
        const log = readLog(p.result, r.duration);
        if (log) await setRow(r.id, { log_status: "done", log: JSON.stringify(log), log_error: null });
        else await setRow(r.id, { log_status: "failed", log_error: "the log came back unreadable" });
      } else if (/busy/i.test(p.detail)) {
        // The model was busy: ask again on a later step.
        await setRow(r.id, { log_status: "preparing", log_job: null });
      } else {
        await setRow(r.id, { log_status: "failed", log_error: p.detail });
      }
    }),
  );

  // 4. Clips whose analysis copy is being made: start the ones that are ready.
  let slots = STEP_LIMITS.running - running.filter((r) => !settled.has(r.id)).length;
  const preparing = ready.filter((r) => r.log_status === "preparing");
  for (const r of preparing) {
    const p = await prepareMedia(cfg, r.media_uid!, r.language);
    const analysis = "failure" in p ? null : p.media.analysis;
    if (analysis === "failed") {
      await setRow(r.id, { log_status: "failed", log_error: "this clip couldn't be prepared for logging" });
      continue;
    }
    // Anything else short of ready, "none" included (the copy couldn't start
    // this time), is asked again on the next step, up to the timeout.
    if (analysis !== "ready") {
      if (age(r.updated_at) > PREPARE_TIMEOUT_MS) {
        await setRow(r.id, { log_status: "failed", log_error: "this clip couldn't be prepared for logging" });
      }
      continue;
    }
    if (slots <= 0 || out.logsBlocked) continue;
    if (!(await setRow(r.id, { log_status: "running", log_job: null }, " AND log_status = 'preparing'"))) continue;
    slots--;
    const started = await startLog(cfg, r.media_uid!, r);
    if ("jobId" in started) {
      await setRow(r.id, { log_job: started.jobId });
    } else if (ORG_LIMITS.has(started.failure.error) || started.failure.status === 429 || started.failure.status >= 500 || started.failure.status === 409) {
      await setRow(r.id, { log_status: "preparing" });
      if (ORG_LIMITS.has(started.failure.error)) out.logsBlocked = started.failure.detail;
    } else {
      await setRow(r.id, { log_status: "failed", log_error: started.failure.detail });
    }
  }

  // 5. Start making analysis copies while there is room. Each copy runs in the
  //    org's render container, so only a few at a time.
  let copies = STEP_LIMITS.preparing - preparing.length;
  for (const r of ready) {
    if (r.log_status !== null) continue;
    if (r.duration !== null && r.duration < MIN_LOG_SECONDS) {
      await setRow(r.id, { log_status: "done", log: JSON.stringify(tooShortLog(r.duration)), log_error: null }, " AND log_status IS NULL");
      continue;
    }
    if (copies <= 0 || out.logsBlocked) break;
    if (!(await setRow(r.id, { log_status: "preparing", log_error: null }, " AND log_status IS NULL"))) continue;
    copies--;
    await prepareMedia(cfg, r.media_uid!, r.language);
  }

  const at = new Date().toISOString();
  const left = await get<{
    waiting: number;
    waiting_now: number;
    next_retry: string | null;
    importing: number;
    unlogged: number;
    preparing: number;
    running: number;
  }>(
    `SELECT COALESCE(SUM(status = 'waiting'), 0) AS waiting,
            COALESCE(SUM(status = 'waiting' AND (retry_at IS NULL OR retry_at <= ?)), 0) AS waiting_now,
            MIN(CASE WHEN status = 'waiting' AND retry_at > ? THEN retry_at END) AS next_retry,
            COALESCE(SUM(status = 'importing'), 0) AS importing,
            COALESCE(SUM(status = 'ready' AND log_status IS NULL), 0) AS unlogged,
            COALESCE(SUM(status = 'ready' AND log_status = 'preparing'), 0) AS preparing,
            COALESCE(SUM(status = 'ready' AND log_status = 'running'), 0) AS running
       FROM project_footage WHERE project_id = ?`,
    [at, at, projectId],
  );
  const n = left ?? { waiting: 0, waiting_now: 0, next_retry: null, importing: 0, unlogged: 0, preparing: 0, running: 0 };
  out.pending = n.waiting + n.importing + n.unlogged + n.preparing + n.running;
  // Clips a limit holds are not moving: a step would only be refused again.
  // The next read tries once more, and starts the chain again if it can.
  out.moving =
    n.importing > 0 ||
    n.running > 0 ||
    (n.waiting_now > 0 && !out.importsBlocked) ||
    (n.unlogged + n.preparing > 0 && !out.logsBlocked);
  // Clips waiting on Google Drive: nothing to do until the first is due, so
  // the next step is booked for then rather than every minute.
  if (!out.moving && n.next_retry) out.nextAt = n.next_retry;
  if (!out.importsBlocked && n.waiting_now === 0 && n.next_retry) out.importsBlocked = DRIVE_WAIT_ALL;
  return out;
}

const DRIVE_QUOTA =
  "Google Drive's download limit for this file is used up for today: it resets within a day, so retry it then. A copy of the file in Drive has its own limit";
const DRIVE_WAIT = "Waiting for Google Drive, which is limiting downloads of this file for now";
const DRIVE_WAIT_ALL =
  "Google Drive is limiting downloads of these files for now. Importing carries on by itself as it lifts, usually within a day. A copy of the folder in another Drive account has its own limit";
/** How long a clip Drive refused waits before each new try: about a day in all. */
const DRIVE_RETRY_MS = [30, 60, 120, 240, 240, 240, 240, 240].map((m) => m * 60_000);

/** Why a file over the video host's limit can't come in, in the size people see. */
const overHostLimit = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB is over the video host's 30 GB limit`;

/**
 * Drive refused the clip. It lifts its limit within a day, so the clip waits
 * and is tried again by itself, further apart each time, then gives up. A clip
 * coming in a piece at a time keeps its upload while it waits, and carries on
 * from there.
 */
async function waitOnDrive(cfg: MediaConfig, r: WorkRow): Promise<void> {
  const tries = r.drive_tries + 1;
  if (tries > DRIVE_RETRY_MS.length) {
    // An upload that can't be deleted now stays on the row: retrying the clip
    // or deleting the project deletes it.
    await dropUpload(cfg, r);
    await setRow(r.id, { status: "failed", error: DRIVE_QUOTA, drive_tries: tries });
    r.status = "failed";
  } else {
    const at = new Date(Date.now() + DRIVE_RETRY_MS[tries - 1]).toISOString();
    await setRow(r.id, { status: "waiting", error: DRIVE_WAIT, drive_tries: tries, retry_at: at });
    Object.assign(r, { status: "waiting", drive_tries: tries, retry_at: at });
  }
}

const NO_UPLOAD = { upload_uid: null, upload_url: null, upload_expires: null, upload_size: null, upload_done: null };

/**
 * Delete a clip's open upload on the media service, then forget it. False
 * when the service wouldn't: it stays on the row, to be deleted later, rather
 * than forgotten while it still holds storage.
 */
async function dropUpload(cfg: MediaConfig, r: WorkRow): Promise<boolean> {
  if (!r.upload_uid) return true;
  try {
    await deleteMedia(cfg, r.upload_uid);
  } catch {
    return false;
  }
  await setRow(r.id, NO_UPLOAD);
  Object.assign(r, NO_UPLOAD);
  return true;
}

/**
 * Drive won't hand the file over whole: open an upload for it to come in a
 * piece at a time instead. A file over the video host's limit fails with that
 * reason instead: waiting on Drive can't get it in. Null when pieces can't
 * help, so the clip waits on Drive: it won't serve even a piece, or the clip
 * is marked for a re-encode, which reads the whole file.
 */
async function openRelay(cfg: MediaConfig, r: WorkRow): Promise<true | { orgWide: boolean; detail: string } | null> {
  const size = await rangedSize(r.drive_file_id);
  if (!size) return null;
  if (size > MAX_RELAY_BYTES) return { orgWide: false, detail: overHostLimit(size) };
  if (r.transcode) return null;
  await dropFailedCopy(cfg, r);
  const opened = await openMediaUpload(cfg, size, r.name);
  if ("failure" in opened) return ORG_LIMITS.has(opened.failure.error) ? { orgWide: true, detail: opened.failure.detail } : null;
  await setRow(r.id, {
    upload_uid: opened.id,
    upload_url: opened.uploadUrl,
    upload_expires: opened.expiresAt,
    upload_size: size,
    upload_done: 0,
  });
  return true;
}

/**
 * Move a clip coming in a piece at a time on, and settle it once it is all in.
 * Pieces come from the shared link, or, where Drive refuses those, through the
 * org's Drive connection when it has one.
 */
async function relayClip(cfg: MediaConfig, r: WorkRow, until: number, drive?: DriveSource): Promise<void> {
  const uid = r.upload_uid!;
  const expiring = r.upload_expires !== null && Date.parse(r.upload_expires) - Date.now() < RELAY_EXPIRY_MARGIN_MS;
  const readers: PieceReader[] = [sharedLinkReader(r.drive_file_id)];
  if (drive?.piece) readers.push((start, end, signal) => drive.piece!(r.drive_file_id, start, end, signal));
  const result = expiring
    ? ({ state: "gone" } as const)
    : await relayPieces({ url: r.upload_url!, size: r.upload_size! }, readers, until, async (received) => {
        await setRow(r.id, { upload_done: received });
      });
  if (result.state === "moving") return;
  if (result.state === "done") return finishRelay(r, uid, result.contentType);
  if (result.state === "drive") return waitOnDrive(cfg, r);
  if (result.state === "refused") {
    // Sending it again would be refused again: the clip fails, saying why.
    await dropUpload(cfg, r);
    await setRow(r.id, { status: "failed", error: `the video host refused a piece of this file (${result.detail})` });
    r.status = "failed";
    return;
  }
  // The upload can't take more. One whose last piece landed without being
  // recorded (the step ended first) is the video: it is recorded now.
  const s = await mediaState(cfg, uid);
  if (!("failure" in s) && s.media.state !== "pendingupload") return finishRelay(r, uid, "video/mp4");
  // Otherwise it starts again with a new upload, counted like a refusal so a
  // file that never gets in gives up in the end.
  if (!(await dropUpload(cfg, r))) return;
  const tries = r.drive_tries + 1;
  if (tries > DRIVE_RETRY_MS.length) {
    await setRow(r.id, { status: "failed", error: "the import did not finish", drive_tries: tries });
    r.status = "failed";
  } else {
    await setRow(r.id, { status: "waiting", drive_tries: tries });
    Object.assign(r, { status: "waiting", drive_tries: tries });
  }
}

/** The last piece is in: the upload is the clip's video, imported like any other. */
async function finishRelay(r: WorkRow, uid: string, contentType: string): Promise<void> {
  const key = `media/${uid}`;
  // Two steps that overlap can both get here: the key is unique, so one asset.
  await run("INSERT INTO assets (key, name, content_type, size, media_uid) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING", [
    key,
    r.name,
    contentType,
    r.upload_size ?? 0,
    uid,
  ]);
  const asset = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
  await setRow(r.id, { asset_id: asset!.id, ...NO_UPLOAD });
}

/**
 * Check the Drive file serves video, then have the media service pull it.
 *
 * The check asks exactly as the media service will: the whole file, no Range
 * header, closed once the headers are in. A file over Drive's daily download
 * limit still answers a ranged request with video, but the whole file with
 * its "Quota exceeded" page, so a ranged check passes a file the import then
 * fails on, and that failed import still counts against the plan.
 */
async function startImport(
  cfg: MediaConfig,
  r: WorkRow,
  drive?: DriveSource,
): Promise<true | { orgWide: boolean; detail: string; driveLimit?: true }> {
  // Already coming in a piece at a time, back from a wait on Drive: it
  // carries on from where its upload got to, on the next delivery.
  if (r.upload_uid) return true;
  // Through the org's connection first. A file it can't hand over (over the
  // 250 MB one answer through it carries) comes by the original's shared link,
  // with its waits. Not by a copy in the connected account: Drive answers a
  // header check on a fresh copy of a big file with an empty page while the
  // file itself downloads, and the video host, which checks first, refuses
  // the download as inconsistent.
  if (drive && !r.link_only) {
    const got = await drive.download(r.drive_file_id).catch((e: unknown) => ({ error: String(e) }));
    if ("url" in got) return importFrom(cfg, r, got.url, got.mimeType.startsWith("video/") ? got.mimeType : "video/mp4", 0);
    await setRow(r.id, { link_only: 2 });
  }
  const url = directDownloadUrl(r.drive_file_id);
  const probe = await fetch(url, { redirect: "follow" }).catch(() => null);
  if (!probe) return { orgWide: true, detail: "Google Drive could not be reached" };
  const served = probe.headers.get("content-type");
  // A page is a few KB, and its title says which page it is.
  const page = served?.startsWith("text/") ? (await probe.text().catch(() => "")).slice(0, 8000) : "";
  if (!page) await probe.body?.cancel();
  const verdict = judgeLinkResponse(probe.status, served, probe.headers.get("content-range"), probe.headers.get("content-length"));
  if (!verdict.ok) {
    // Drive's limit refuses the whole file but still serves pieces of it.
    if (/<title>[^<]*quota exceeded/i.test(page)) {
      return (await openRelay(cfg, r)) ?? { orgWide: false, detail: DRIVE_QUOTA, driveLimit: true };
    }
    return { orgWide: false, detail: verdict.reason ?? "that file isn't a video" };
  }
  // The video host would refuse it after pulling it ("MaxFileSizeError"): say so first.
  if (verdict.size && verdict.size > MAX_RELAY_BYTES) return { orgWide: false, detail: overHostLimit(verdict.size) };

  return importFrom(cfg, r, url, verdict.contentType?.startsWith("video/") ? verdict.contentType : "video/mp4", verdict.size ?? 0);
}

/** The video host's refusal of a source over its bitrate cap. */
const BITRATE_REFUSED = /bitrate exceeded/i;

/**
 * A copy from an attempt that failed is of no use and still counts against
 * the org's storage: it goes before the clip is imported again.
 */
async function dropFailedCopy(cfg: MediaConfig, r: WorkRow): Promise<void> {
  if (!r.asset_id) return;
  if (r.media_uid) await deleteMedia(cfg, r.media_uid).catch(() => {});
  await run("DELETE FROM assets WHERE id = ?", [r.asset_id]);
  await setRow(r.id, { asset_id: null });
}

/** Have the media service pull the clip from `url`, and record it as an asset. */
async function importFrom(
  cfg: MediaConfig,
  r: WorkRow,
  url: string,
  type: string,
  size: number,
): Promise<true | { orgWide: boolean; detail: string }> {
  await dropFailedCopy(cfg, r);
  // Marked for re-encoding: the media id comes later, from the re-encode.
  if (r.transcode) {
    const started = await startTranscode(cfg, url, r.name);
    if ("failure" in started) return { orgWide: ORG_LIMITS.has(started.failure.error), detail: started.failure.detail };
    await setRow(r.id, { transcode_job: started.jobId });
    return true;
  }
  const imported = await importMedia(cfg, url, r.name);
  if ("failure" in imported) {
    return { orgWide: ORG_LIMITS.has(imported.failure.error), detail: imported.failure.detail };
  }
  const uid = imported.media.id;
  const res = await run(
    "INSERT INTO assets (key, name, content_type, size, media_uid) VALUES (?, ?, ?, ?, ?)",
    [`media/${uid}`, r.name, type, size, uid],
  );
  const asset = await get<{ id: string }>("SELECT id FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
  await setRow(r.id, { asset_id: asset!.id });
  return true;
}

// ── the background chain ────────────────────────────────────────────────────

/** When a booked step counts as lost: its minute plus the queue's own slack. */
const STEP_GRACE_MS = 3 * 60_000;

/**
 * Book the project's next step on the platform queue, a minute from now. The
 * queue calls POST /api/footage/step. A delivery always books its successor;
 * a read books one only when none is booked, the booked one is overdue
 * (meaning the chain broke), or it is booked later than this one would be
 * (for clips waiting on Drive, say, when a person asks to try now). Without a
 * queue (local dev) nothing is booked and reads alone move the footage on.
 */
export async function bookStep(
  env: QueueEnv,
  origin: string,
  projectId: string,
  opts: { after: "delivery" | "read"; bookedAt: string | null; at?: string | null },
): Promise<string | null> {
  // A minute from now, or later when nothing can move before then.
  const earliest = Math.max(Date.now() + 60_000, opts.at ? Date.parse(opts.at) : 0);
  const runAt = new Date(Math.ceil(earliest / 60_000) * 60_000);
  if (opts.after === "read" && opts.bookedAt) {
    const booked = Date.parse(opts.bookedAt);
    if (booked > Date.now() - STEP_GRACE_MS && booked <= runAt.getTime()) return opts.bookedAt;
  }
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/footage/step`,
      payload: { project_id: projectId },
      runAt,
      // The host is in the key because the queue dedupes per org, and two
      // copies of this app in one org must not share a booking. The minute
      // makes each booking new while two readers in the same minute share one.
      idempotencyKey: `footage-${new URL(origin).host}-${projectId}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
  } catch {
    return null;
  }
  await run("UPDATE edit_projects SET footage_step_at = ? WHERE id = ?", [runAt.toISOString(), projectId]);
  return runAt.toISOString();
}
