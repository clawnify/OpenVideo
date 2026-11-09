import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDB, run, get } from "../src/server/db";
import { createImport, listImports, readImport, importView, cancelImport, retryImport, stepImport } from "../src/server/drive-imports";
import { driveImportSource } from "../src/server/drive";
import { enqueueJob } from "@clawnify/queue";
import { openMediaUpload, mediaState, deleteMedia } from "../src/server/media";
import { relayPieces } from "../src/server/relay";

vi.mock("@clawnify/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("../src/server/drive", () => ({ driveImportSource: vi.fn(), driveFilePiece: vi.fn(), driveDeadline: (p: Promise<unknown>) => p }));
vi.mock("../src/server/media", () => ({ openMediaUpload: vi.fn(), mediaState: vi.fn(), deleteMedia: vi.fn() }));
vi.mock("../src/server/relay", () => ({ relayPieces: vi.fn() }));

const env = { CLAWNIFY_TOKEN: "test", CLAWNIFY_ORG_ID: "org" };
const origin = "https://video.apps.clawnify.com";
const source = { service: "googledrive" as const, account: "account-a", fileId: "private_video_123", version: "16", name: "Talk.mp4", mimeType: "video/mp4", size: 9452386420, duration: 1506.16, canDownload: true };
const uid = "a".repeat(32);
let db: DatabaseSync;
let offset: number;
let afterWrite: ((sql: string) => void) | null = null;

beforeEach(() => {
  db?.close(); db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  initDB({ STORAGE: { async query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { rows: stmt.all(...params) };
    const r = stmt.run(...params);
    afterWrite?.(sql);
    return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  } } });
  vi.resetAllMocks(); offset = 0; afterWrite = null;
  vi.mocked(driveImportSource).mockResolvedValue(source);
  vi.mocked(enqueueJob).mockResolvedValue({ id: "queue-job", status: "pending", run_at: "now" });
  vi.mocked(openMediaUpload).mockResolvedValue({ id: uid, uploadUrl: "https://private-upload.test/capability", expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString() });
  vi.mocked(mediaState).mockResolvedValue({ media: { id: uid, state: "ready", ready: true, progress: 100, duration: 1506.16, width: 1920, height: 1080, error: null } });
  vi.mocked(deleteMedia).mockResolvedValue();
  vi.mocked(relayPieces).mockImplementation(async (_upload, _readers, _until, progress, maxPieces) => {
    expect(maxPieces).toBe(1);
    offset += 209715200;
    await progress(offset);
    return { state: "moving" };
  });
});
const create = async () => createImport(env, origin, source);
const due = async (id: string) => run("UPDATE drive_imports SET next_step_at=0 WHERE id=?", [id]);
const assets = () => db.prepare("SELECT * FROM assets").all();

async function finish(id: string) {
  vi.mocked(relayPieces).mockImplementationOnce(async (_u, _r, _t, progress) => {
    await progress(source.size); return { state: "done", contentType: "video/mp4" };
  });
  await due(id); await stepImport(env, origin, id);
  await due(id); await stepImport(env, origin, id);
}

describe("durable Drive library imports", () => {
  it("queues a private large video without opening an upload or downloading it in the request", async () => {
    const job = await create();
    expect(job.state).toBe("queued");
    expect(openMediaUpload).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledWith(env, expect.objectContaining({ targetUrl: origin + "/api/drive/imports/step", payload: { import_id: job.id } }));
    expect(JSON.stringify(job)).not.toMatch(/upload_url|account-a|capability|lease/);
  });
  it("reuses the active import on concurrent clicks and caps active jobs at four", async () => {
    const first = await create();
    expect((await create()).id).toBe(first.id);
    for (let i = 1; i < 4; i++) await createImport(env, origin, { ...source, fileId: "video_" + i });
    await expect(createImport(env, origin, { ...source, fileId: "fifth" })).rejects.toThrow("Four video imports");
    expect((await create()).id).toBe(first.id);
  });
  it.each([
    [{ canDownload: false }, "disabled"], [{ size: 30_000_000_001 }, "30 GB"],
    [{ size: NaN }, "known size"], [{ version: "" }, "known size"], [{ duration: 14401 }, "four-hour"],
  ])("refuses unsupported metadata before scheduling: %o", async (override, error) => {
    await expect(createImport(env, origin, { ...source, ...override })).rejects.toThrow(error as string);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it("retains a job when initial enqueue fails, and repairs it on a repeat click", async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("network"));
    await expect(create()).rejects.toThrow("Background imports");
    const saved = db.prepare("SELECT id FROM drive_imports").get()!;
    expect((await create()).id).toBe(saved.id);
  });
  it("resumes from the upload, creates exactly one independent library asset, and survives duplicate delivery", async () => {
    const { id } = await create();
    await stepImport(env, origin, id);
    expect((await readImport(id))?.received).toBe(209715200);
    await finish(id);
    await stepImport(env, origin, id);
    expect(openMediaUpload).toHaveBeenCalledTimes(1);
    expect(assets()).toHaveLength(1);
    expect(assets()[0].size).toBe(source.size);
    expect((await readImport(id))?.state).toBe("ready");
    expect(db.prepare("SELECT count(*) n FROM project_footage").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM media_uploads").get()?.n).toBe(0);
  });
  it("refuses an overlapping delivery and allows recovery after the lease expires", async () => {
    const { id } = await create();
    await run("UPDATE drive_imports SET lease_until=? WHERE id=?", [Date.now() + 60000, id]);
    await expect(stepImport(env, origin, id)).rejects.toThrow("busy");
    expect(openMediaUpload).not.toHaveBeenCalled();
    await run("UPDATE drive_imports SET lease_until=0 WHERE id=?", [id]);
    await stepImport(env, origin, id);
    expect(relayPieces).toHaveBeenCalledTimes(1);
  });
  it("cancels before starting without creating an upload", async () => {
    const { id } = await create(); await cancelImport(env, origin, id); await stepImport(env, origin, id);
    expect((await readImport(id))?.state).toBe("cancelled");
    expect(openMediaUpload).not.toHaveBeenCalled(); expect(assets()).toHaveLength(0);
  });
  it("cancellation during the final piece prevents promotion and cleans up the upload", async () => {
    const { id } = await create();
    vi.mocked(relayPieces).mockImplementationOnce(async () => {
      await cancelImport(env, origin, id); return { state: "done", contentType: "video/mp4" };
    });
    await stepImport(env, origin, id); await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.state).toBe("cancelled");
    expect(deleteMedia).toHaveBeenCalledWith(expect.anything(), uid); expect(assets()).toHaveLength(0);
  });
  it("retains cleanup work when deletion fails, then completes cancellation on a later delivery", async () => {
    const { id } = await create(); await stepImport(env, origin, id); await cancelImport(env, origin, id);
    vi.mocked(deleteMedia).mockRejectedValueOnce(new Error("unavailable"));
    await stepImport(env, origin, id);
    expect((await readImport(id))?.upload_uid).toBe(uid);
    await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.state).toBe("cancelled");
    expect((await readImport(id))?.upload_uid).toBeNull();
  });
  it("completion wins once the asset has been inserted, including crash recovery", async () => {
    const { id } = await create(); await stepImport(env, origin, id);
    await run("INSERT INTO assets (key,name,media_uid) VALUES (?,?,?)", ["media/" + uid, source.name, uid]);
    await cancelImport(env, origin, id); await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.state).toBe("ready"); expect(deleteMedia).not.toHaveBeenCalled();
  });
  it("renews an expired attempt only after its old upload has been deleted", async () => {
    const { id } = await create(); await stepImport(env, origin, id);
    await run("UPDATE drive_imports SET upload_expires_at='2020-01-01T00:00:00Z' WHERE id=?", [id]);
    vi.mocked(openMediaUpload).mockResolvedValueOnce({ id: "b".repeat(32), uploadUrl: "https://upload.test/new", expiresAt: null });
    await due(id); await stepImport(env, origin, id);
    expect(deleteMedia).toHaveBeenCalledWith(expect.anything(), uid);
    expect((await readImport(id))?.attempts).toBe(2);
  });
  it("persists delete intent after a lost response and never resumes that upload", async () => {
    const { id } = await create(); await stepImport(env, origin, id);
    vi.mocked(relayPieces).mockResolvedValueOnce({ state: "gone" });
    vi.mocked(deleteMedia).mockRejectedValueOnce(new Error("delete response lost"));
    await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.cleanup_pending).toBe(1);
    const transfers = vi.mocked(relayPieces).mock.calls.length;
    await due(id); await stepImport(env, origin, id);
    expect(relayPieces).toHaveBeenCalledTimes(transfers);
    expect((await readImport(id))?.upload_uid).toBeNull();
    expect((await readImport(id))?.state).toBe("queued");
  });
  it("rejects source mutation before transferring more bytes", async () => {
    const { id } = await create(); await stepImport(env, origin, id);
    vi.mocked(driveImportSource).mockResolvedValue({ ...source, version: "17" });
    await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.error_code).toBe("source_changed");
    expect(relayPieces).toHaveBeenCalledTimes(1); expect(assets()).toHaveLength(0);
    await due(id); await stepImport(env, origin, id);
    expect((await readImport(id))?.upload_uid).toBeNull();
  });
  it("rejects source mutation during the final piece", async () => {
    const { id } = await create();
    vi.mocked(relayPieces).mockImplementationOnce(async () => {
      vi.mocked(driveImportSource).mockResolvedValue({ ...source, version: "17" });
      return { state: "done", contentType: "video/mp4" };
    });
    await stepImport(env, origin, id);
    expect((await readImport(id))?.error_code).toBe("source_changed"); expect(assets()).toHaveLength(0);
  });
  it("bounds transient failures and retains a stable identity for retry", async () => {
    const { id } = await create(); vi.mocked(relayPieces).mockResolvedValue({ state: "moving" });
    for (let i = 0; i < 8; i++) { await due(id); await stepImport(env, origin, id); }
    expect((await readImport(id))?.state).toBe("failed");
    await due(id); await stepImport(env, origin, id);
    expect((await retryImport(env, origin, id))?.state).toBe("queued");
    expect(db.prepare("SELECT count(*) n FROM drive_imports").get()?.n).toBe(1);
  });
  it("recovers a broken queue chain on reopening, without transferring bytes on reads", async () => {
    const { id } = await create(); await due(id);
    await listImports(env, origin);
    expect((await readImport(id))!.next_step_at).toBeGreaterThan(0);
    expect(relayPieces).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });
  it("keeps status visible when queue recovery fails and clears only the queue error on recovery", async () => {
    const { id } = await create(); await due(id);
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("private provider error"));
    const rows = await listImports(env, origin);
    expect(rows[0].error?.code).toBe("queue_unavailable");
    expect(JSON.stringify(rows)).not.toContain("private provider error");
    await due(id);
    expect((await listImports(env, origin))[0].error).toBeNull();
  });
  it("a stale cleanup cannot erase a newer attempt after lease takeover", async () => {
    const { id } = await create(); await stepImport(env, origin, id); await cancelImport(env, origin, id);
    const replacement = "b".repeat(32);
    vi.mocked(deleteMedia).mockImplementationOnce(async () => {
      // The old callback was suspended; another owner has since opened V.
      db.prepare("UPDATE drive_imports SET lease_token='new-owner', lease_until=?, upload_uid=?, upload_url='https://new.test', state='uploading', cancel_requested=0 WHERE id=?")
        .run(Date.now() + 300000, replacement, id);
      db.prepare("INSERT INTO media_uploads(uid,name,content_type,size) VALUES (?,?,?,?)").run(replacement, source.name, source.mimeType, source.size);
    });
    await stepImport(env, origin, id);
    expect((await readImport(id))?.upload_uid).toBe(replacement);
    expect((await readImport(id))?.lease_token).toBe("new-owner");
    expect(db.prepare("SELECT uid FROM media_uploads WHERE uid=?").get(replacement)).toBeTruthy();
  });
  it("does not delete a committed upload after an ambiguous DB response", async () => {
    const { id } = await create();
    afterWrite = (sql) => {
      if (!sql.startsWith("UPDATE drive_imports SET upload_uid=")) return;
      afterWrite = null;
      // The DB committed, another callback adopted it, then the old response failed.
      db.prepare("INSERT INTO assets(key,name,media_uid) VALUES (?,?,?)").run("media/"+uid, source.name, uid);
      db.prepare("UPDATE drive_imports SET lease_token='new-owner', state='ready' WHERE id=?").run(id);
      throw new Error("Response lost after commit");
    };
    await stepImport(env, origin, id);
    expect(deleteMedia).not.toHaveBeenCalled(); expect(assets()).toHaveLength(1);
    expect((await readImport(id))?.state).toBe("ready");
  });
  it("does not publish a processing or failed video and strips capability URLs from views", async () => {
    const { id } = await create(); await stepImport(env, origin, id);
    await run("UPDATE drive_imports SET state='processing' WHERE id=?", [id]);
    vi.mocked(mediaState).mockResolvedValue({ media: { id: uid, state: "error", ready: false, progress: null, duration: null, width: null, height: null, error: "bad codec" } });
    await due(id); await stepImport(env, origin, id);
    const row = (await readImport(id))!;
    expect(row.state).toBe("failed"); expect(assets()).toHaveLength(0);
    expect(JSON.stringify(importView(row))).not.toMatch(/capability|bad codec|account-a/);
  });
});
