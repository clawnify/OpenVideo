// A library import owns its lifecycle independently of its resumable upload.
// Queue deliveries move one bounded piece. The browser only starts, observes or
// cancels; it never keeps the transfer alive. One app has its own database.
import type { ConnectionsEnv } from "@clawnify/connections";
import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import { get, query, run } from "./db";
import { driveImportSource, driveFilePiece, driveDeadline, type DriveImportSource, type DriveService } from "./drive";
import { deleteMedia, mediaState, openMediaUpload, type MediaConfig } from "./media";
import { relayPieces } from "./relay";

export type ImportEnv = ConnectionsEnv & QueueEnv & { SERVICES_URL?: string };
type State = "queued" | "uploading" | "processing" | "ready" | "failed" | "cancelling" | "cancelled";
export interface ImportRow {
  id: string; file_id: string; service: DriveService; account: string | null; source_version: string;
  name: string; content_type: string; size: number; duration: number | null;
  state: State; received: number; upload_uid: string | null; upload_url: string | null;
  upload_expires_at: string | null; attempts: number; failures: number; cancel_requested: number;
  cleanup_pending: number;
  error_code: string | null; asset_id: string | null; next_step_at: number;
  lease_token: string | null; lease_until: number; created_at: string; updated_at: string;
}

const MAX_BYTES = 30_000_000_000; // Conservative documented 30 GB host limit.
const LEASE_MS = 300_000;
const MAX_FAILURES = 8;
const MAX_ATTEMPTS = 3;
const ACTIVE = "'queued','uploading','processing','cancelling'";
const ERROR_TEXT: Record<string, string> = {
  source_changed: "This file changed in Google Drive. Start a new import of the updated file.",
  drive_unavailable: "Google Drive could not deliver the file. Check the connection and download access, then retry.",
  download_disabled: "The owner has disabled downloads for this file.",
  invalid_source: "This video needs a known size and version before it can be imported.",
  too_large: "This video exceeds the 30 GB import limit.",
  too_long: "This video exceeds the four-hour import limit.",
  storage_full: "Your workspace's video storage is full. Remove unused videos, then retry.",
  upload_expired: "The upload expired repeatedly. Retry to start a fresh transfer.",
  media_failed: "The video host could not process this video. Check the original file, then retry.",
  transfer_failed: "The transfer could not finish after repeated attempts. Retry to resume it.",
  too_many_imports: "Four video imports are already running. Wait for one to finish or cancel it.",
  queue_unavailable: "Background imports are temporarily unavailable. Retry in a moment.",
};
export class ImportError extends Error {
  constructor(public code: string) { super(ERROR_TEXT[code] ?? ERROR_TEXT.transfer_failed); }
}
export function importView(row: ImportRow) {
  // Explicit allowlist: no upload capability, account, lease or raw provider error.
  return { id: row.id, file_id: row.file_id, name: row.name, state: row.state,
    received: row.received, size: row.size, asset_id: row.asset_id,
    error: row.error_code ? { code: row.error_code, message: ERROR_TEXT[row.error_code] ?? ERROR_TEXT.transfer_failed } : null,
    created_at: row.created_at, updated_at: row.updated_at };
}
export const readImport = (id: string) => get<ImportRow>("SELECT * FROM drive_imports WHERE id = ?", [id]);
const bounded = <T>(work: Promise<T>) => driveDeadline(work, AbortSignal.timeout(20_000));
const cfg = (env: ImportEnv): MediaConfig => ({ token: env.CLAWNIFY_TOKEN, servicesUrl: env.SERVICES_URL, timeoutMs: 20_000 });
const pending = (row: ImportRow) => !["ready", "cancelled"].includes(row.state) && (row.state !== "failed" || !!row.upload_uid);

function validate(source: DriveImportSource) {
  if (!source.canDownload) throw new ImportError("download_disabled");
  if (!Number.isSafeInteger(source.size) || source.size <= 0 || !source.version) throw new ImportError("invalid_source");
  if (source.size > MAX_BYTES) throw new ImportError("too_large");
  if (source.duration && source.duration > 4 * 3600) throw new ImportError("too_long");
}

/** Queue dedupes by durable due time. A retry after enqueue/write failure books
 * the same delivery, rather than advancing the job or creating another upload. */
async function schedule(env: ImportEnv, origin: string, row: ImportRow) {
  if (!pending(row)) return;
  try {
    await bounded(enqueueJob(env, {
    targetUrl: `${origin}/api/drive/imports/step`, payload: { import_id: row.id },
    runAt: new Date(row.next_step_at), maxAttempts: 10,
    idempotencyKey: `drive-${new URL(origin).host}-${row.id}-${row.next_step_at}`,
    }));
    await run("UPDATE drive_imports SET error_code=NULL WHERE id=? AND error_code='queue_unavailable'", [row.id]);
    if (row.error_code === "queue_unavailable") row.error_code = null;
  } catch {
    await run("UPDATE drive_imports SET error_code='queue_unavailable' WHERE id=? AND error_code IS NULL", [row.id]);
    if (!row.error_code) row.error_code = "queue_unavailable";
    throw new ImportError("queue_unavailable");
  }
}

export async function createImport(env: ImportEnv, origin: string, source: DriveImportSource) {
  validate(source);
  // At most four active imports per app; an atomic INSERT handles concurrent clicks.
  await run(
    `INSERT INTO drive_imports (id,file_id,service,account,source_version,name,content_type,size,duration,next_step_at)
     SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM drive_imports WHERE state IN (${ACTIVE})) < 4
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), source.fileId, source.service, source.account, source.version, source.name.slice(0, 200),
      source.mimeType, source.size, source.duration, Date.now()],
  );
  const row = await get<ImportRow>(`SELECT * FROM drive_imports WHERE file_id = ? AND state IN (${ACTIVE})`, [source.fileId]);
  if (!row) throw new ImportError("too_many_imports");
  // Keep the row even if enqueue fails. A repeat click or the status view repairs it.
  await schedule(env, origin, row);
  return importView(row);
}

export async function listImports(env: ImportEnv, origin: string) {
  const rows = await query<ImportRow>(
    `SELECT * FROM drive_imports ORDER BY CASE WHEN state IN (${ACTIVE}) THEN 0 ELSE 1 END, created_at DESC LIMIT 40`,
  );
  // Recover a broken delivery chain, without moving bytes on reads. A fresh due
  // time escapes a queue delivery that exhausted its retries. CAS avoids races.
  for (const row of rows.filter(pending)) {
    if (row.lease_until > Date.now() || row.next_step_at > Date.now() - 5 * 60_000) continue;
    const next = Date.now();
    const changed = await run("UPDATE drive_imports SET next_step_at = ? WHERE id = ? AND next_step_at = ? AND lease_until <= ?",
      [next, row.id, row.next_step_at, Date.now()]);
    if (changed.changes) {
      row.next_step_at = next;
      // An unavailable queue must not hide durable status and cancel controls.
      await schedule(env, origin, row).catch(() => {});
    }
  }
  return rows.map(importView);
}

export async function cancelImport(env: ImportEnv, origin: string, id: string) {
  // Asset insertion and this UPDATE serialize in SQLite. Whichever wins decides
  // completion vs cancellation: a cancelled job can never publish an asset.
  await run(
    `UPDATE drive_imports SET cancel_requested=1, state='cancelling', next_step_at=?, updated_at=datetime('now')
     WHERE id=? AND state NOT IN ('ready','cancelled')
     AND NOT EXISTS (SELECT 1 FROM assets WHERE media_uid=drive_imports.upload_uid)`, [Date.now(), id],
  );
  const row = await readImport(id);
  if (!row) return null;
  await schedule(env, origin, row);
  return importView(row);
}

export async function retryImport(env: ImportEnv, origin: string, id: string) {
  const row = await readImport(id);
  if (!row) return null;
  if (row.state !== "failed") return importView(row);
  if (row.upload_uid || row.lease_until > Date.now()) throw new Error("The previous upload is still being cleaned up. Try again shortly.");
  const source = await driveImportSource(env, row.file_id, row);
  validate(source);
  if (source.version !== row.source_version || source.size !== row.size) throw new ImportError("source_changed");
  await run(
    `UPDATE drive_imports SET state='queued', attempts=0, failures=0, error_code=NULL, received=0,
     next_step_at=?, updated_at=datetime('now') WHERE id=? AND state='failed' AND upload_uid IS NULL
     AND (SELECT count(*) FROM drive_imports WHERE state IN (${ACTIVE})) < 4
     AND NOT EXISTS (SELECT 1 FROM drive_imports other WHERE other.file_id=drive_imports.file_id AND other.state IN (${ACTIVE}))`,
    [Date.now(), id],
  );
  const updated = (await readImport(id))!;
  await schedule(env, origin, updated);
  return importView(updated);
}

async function currentSource(env: ImportEnv, row: ImportRow) {
  let source: DriveImportSource;
  try { source = await driveImportSource(env, row.file_id, row); }
  catch { throw new ImportError("drive_unavailable"); }
  if (!source.canDownload) throw new ImportError("download_disabled");
  if (source.version !== row.source_version || source.size !== row.size) throw new ImportError("source_changed");
}

async function assertLease(id: string, lease: string) {
  if (!(await get("SELECT 1 FROM drive_imports WHERE id=? AND lease_token=? AND lease_until>?", [id, lease, Date.now() + 30_000]))) {
    throw new Error("Import lease lost");
  }
}

async function cleanup(env: ImportEnv, row: ImportRow, lease: string) {
  if (row.upload_uid) {
    // Never drop the cleanup pointer until the external delete succeeds.
    await assertLease(row.id, lease);
    if (await get("SELECT 1 FROM assets WHERE media_uid=?", [row.upload_uid])) throw new Error("Upload already promoted");
    // Deletion may finish remotely after a lost response. Persist that intent:
    // a later owner must finish cleanup, never resume this same upload.
    const marked = await run("UPDATE drive_imports SET cleanup_pending=1 WHERE id=? AND lease_token=? AND upload_uid=?", [row.id, lease, row.upload_uid]);
    if (!marked.changes) throw new Error("Import lease lost");
    await bounded(deleteMedia(cfg(env), row.upload_uid));
    await run("DELETE FROM media_uploads WHERE uid=?", [row.upload_uid]);
    await run("UPDATE drive_imports SET upload_uid=NULL, upload_url=NULL, upload_expires_at=NULL, cleanup_pending=0 WHERE id=? AND lease_token=? AND upload_uid=?", [row.id, lease, row.upload_uid]);
  }
}

/** Idempotent promotion uses the same upload ownership record and unique asset
 * key as browser uploads. Its cancellation predicate is part of the INSERT. */
async function promote(row: ImportRow, lease: string) {
  await assertLease(row.id, lease);
  await run(
    `INSERT INTO assets (key,name,content_type,size,duration,media_uid)
     SELECT 'media/' || u.uid,u.name,u.content_type,u.size,u.duration,u.uid
     FROM media_uploads u JOIN drive_imports j ON j.upload_uid=u.uid
     WHERE j.id=? AND j.lease_token=? AND j.cancel_requested=0 AND j.cleanup_pending=0 AND j.state='processing'
     ON CONFLICT(key) DO NOTHING`, [row.id, lease],
  );
  const asset = await get<{ id: string }>("SELECT id FROM assets WHERE media_uid=?", [row.upload_uid]);
  if (!asset) return;
  await run("DELETE FROM media_uploads WHERE uid=?", [row.upload_uid]);
  await run("UPDATE drive_imports SET state='ready', asset_id=?, received=size, error_code=NULL WHERE id=? AND lease_token=?", [asset.id, row.id, lease]);
}

/** Only signed callbacks call this. One piece, two active transfers per app,
 * a five-minute lease, and retry-safe side effects after a lost response. */
export async function stepImport(env: ImportEnv, origin: string, id: string) {
  let row = await readImport(id);
  if (!row || !pending(row)) return;
  if (row.next_step_at > Date.now()) { await schedule(env, origin, row); return; }
  const lease = crypto.randomUUID();
  const claimed = await run(
    `UPDATE drive_imports SET lease_token=?, lease_until=? WHERE id=? AND lease_until<=?
     AND (SELECT count(*) FROM drive_imports WHERE lease_until>?) < 2`,
    [lease, Date.now() + LEASE_MS, id, Date.now(), Date.now()],
  );
  if (!claimed.changes) throw new Error("Import is busy; retry this delivery.");
  let retryAfter = 0;
  try {
    row = (await readImport(id))!;
    // Repair a crash after asset INSERT but before updating the job.
    const asset = row.upload_uid && await get<{ id: string }>("SELECT id FROM assets WHERE media_uid=?", [row.upload_uid]);
    if (asset) {
      await run("DELETE FROM media_uploads WHERE uid=?", [row.upload_uid]);
      await run("UPDATE drive_imports SET state='ready', asset_id=?, received=size, error_code=NULL WHERE id=? AND lease_token=?", [asset.id, id, lease]);
    } else if (row.cancel_requested || row.state === "failed" || row.cleanup_pending) {
      await cleanup(env, row, lease);
      if (row.cancel_requested) await run("UPDATE drive_imports SET state='cancelled', error_code=NULL WHERE id=? AND lease_token=?", [id, lease]);
      else if (row.state !== "failed") await run("UPDATE drive_imports SET state='queued', received=0 WHERE id=? AND lease_token=?", [id, lease]);
    } else {
      await currentSource(env, row);
      if (row.state === "processing") {
        const state = await bounded(mediaState(cfg(env), row.upload_uid!));
        if ("failure" in state) {
          if (state.failure.error === "not_found") throw new ImportError("media_failed");
          throw new ImportError("transfer_failed");
        }
        if (state.media.ready) await promote(row, lease);
        else if (state.media.state === "error" || state.media.error) throw new ImportError("media_failed");
        else if (Date.now() - Date.parse(row.created_at.replace(" ", "T") + "Z") > 24 * 3600_000) throw new ImportError("media_failed");
      } else {
        if (row.upload_uid && row.upload_expires_at && Date.parse(row.upload_expires_at) < Date.now() + 180_000) {
          await cleanup(env, row, lease);
          row.upload_uid = null; row.upload_url = null;
          await run("UPDATE drive_imports SET received=0, state='queued' WHERE id=? AND lease_token=?", [id, lease]);
        }
        if (!row.upload_uid) {
          if (row.attempts >= MAX_ATTEMPTS) throw new ImportError("upload_expired");
          await assertLease(id, lease);
          const opened = await bounded(openMediaUpload(cfg(env), row.size, row.name, row.duration ? Math.ceil(row.duration * 1.1 + 30) : undefined));
          if ("failure" in opened) throw new ImportError(opened.failure.error === "storage_full" ? "storage_full" : "transfer_failed");
          // Persist the cleanup pointer before anything can upload bytes. A host
          // reservation whose response is lost expires automatically in six hours.
          // An ambiguous DB failure may have committed. Never compensate by
          // deleting an upload another delivery could already have adopted.
          const recorded = await run("UPDATE drive_imports SET upload_uid=?, upload_url=?, upload_expires_at=?, attempts=attempts+1, state='uploading' WHERE id=? AND lease_token=?",
            [opened.id, opened.uploadUrl, opened.expiresAt, id, lease]);
          if (!recorded.changes) {
            if (!(await get("SELECT 1 FROM drive_imports WHERE upload_uid=? UNION ALL SELECT 1 FROM assets WHERE media_uid=?", [opened.id, opened.id]))) {
              await bounded(deleteMedia(cfg(env), opened.id));
            }
            throw new Error("Import lease lost");
          }
          row = (await readImport(id))!;
        }
        await assertLease(id, lease);
        // Repair a crash between persisting the attempt and recording ownership.
        await run(`INSERT INTO media_uploads (uid,name,content_type,size,duration)
          SELECT upload_uid,name,content_type,size,duration FROM drive_imports
          WHERE id=? AND lease_token=? AND upload_uid=? AND lease_until>? ON CONFLICT DO NOTHING`,
          [id, lease, row.upload_uid, Date.now()]);
        if (!(await readImport(id))!.cancel_requested) {
          const before = row.received;
          const result = await relayPieces({ url: row.upload_url!, size: row.size }, [
            (start, end, signal) => driveFilePiece(env, row!.service, row!.file_id, start, end, signal, row!.account),
          ], Date.now() + 120_000, async received => {
            await run("UPDATE drive_imports SET received=?, failures=0, error_code=NULL WHERE id=? AND lease_token=?", [received, id, lease]);
          }, 1);
          if (result.state === "done") {
            await currentSource(env, row); // Catch mutation during the last piece too.
            await run("UPDATE drive_imports SET state='processing', received=size, failures=0 WHERE id=? AND cancel_requested=0 AND lease_token=?", [id, lease]);
          } else if (result.state === "gone") {
            await cleanup(env, row, lease);
            await run("UPDATE drive_imports SET received=0, state='queued' WHERE id=? AND cancel_requested=0 AND lease_token=?", [id, lease]);
          } else if (result.state === "refused") throw new ImportError("media_failed");
          else if (result.state === "drive") throw new ImportError("drive_unavailable");
          else if ((await readImport(id))!.received <= before) throw new ImportError("transfer_failed");
        }
      }
    }
  } catch (e) {
    row = (await readImport(id))!;
    const code = e instanceof ImportError ? e.code : "transfer_failed";
    const fatal = ["source_changed", "download_disabled", "storage_full", "upload_expired", "media_failed"].includes(code);
    const failures = row.failures + 1;
    retryAfter = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures, 5));
    await run(
      `UPDATE drive_imports SET failures=?, error_code=?, state=CASE
       WHEN cancel_requested=1 THEN 'cancelling' WHEN ? THEN 'failed' ELSE state END WHERE id=? AND lease_token=?`,
      [failures, code, fatal || failures >= MAX_FAILURES ? 1 : 0, id, lease],
    );
  } finally {
    // Persist the successor before enqueueing it. If enqueue throws, this
    // delivery fails and its retry repairs the booking, without losing progress.
    await run("UPDATE drive_imports SET lease_token=NULL, lease_until=0, next_step_at=?, updated_at=datetime('now') WHERE id=? AND lease_token=?",
      [Date.now() + retryAfter, id, lease]);
  }
  row = (await readImport(id))!;
  await schedule(env, origin, row);
}
