import { Hono } from "hono";
import { get, query, run } from "./db";
import { starterEdl, MAX_OUTPUT_SECONDS } from "./edl";
import { addFormat } from "../shared/formats";

/** Existing installations get their selections once. INSERT is atomic and
 * idempotent; the marker follows it, so interruption is safe to retry. New
 * selections are published by schema triggers, including background jobs. */
export async function backfillHighlights() {
  if (await get("SELECT 1 FROM app_settings WHERE key = 'library_highlights_v1'")) return;
  await run(`INSERT OR IGNORE INTO library_highlights
    (id, asset_id, kind, src_in, src_out, text, speaker, source_project_id, created_at)
    SELECT h.id, a.id, h.kind, h.src_in, h.src_out, h.text, h.speaker, h.project_id, h.created_at
    FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id JOIN assets a ON a.id = f.asset_id
    WHERE f.status = 'ready' AND a.deleting = 0`);
  await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('library_highlights_v1', 'done')");
}

export const libraryHighlights = new Hono();
libraryHighlights.use("*", async (_, next) => { await backfillHighlights(); await next(); });

libraryHighlights.get("/", async (c) => {
  const search = (c.req.query("search") ?? "").trim().slice(0, 200);
  const offset = Math.max(0, Math.min(1000000, Number.parseInt(c.req.query("offset") ?? "0") || 0));
  const rows = await query(`SELECT h.*, a.name, a.key, a.content_type, a.size, a.duration, a.media_uid,
      p.name AS project_name FROM library_highlights h JOIN assets a ON a.id = h.asset_id
      LEFT JOIN edit_projects p ON p.id = h.source_project_id
    WHERE h.deleted_at IS NULL AND a.deleting = 0
      AND (? = '' OR instr(lower(h.text || ' ' || h.speaker || ' ' || a.name), lower(?)) > 0)
    ORDER BY h.created_at DESC, h.id DESC LIMIT 49 OFFSET ?`, [search, search, offset]);
  return c.json({ items: rows.slice(0, 48), next_offset: rows.length > 48 ? offset + 48 : null });
});

libraryHighlights.delete("/:id", async (c) => {
  // Keep a tombstone: regeneration or an interrupted legacy backfill must not
  // resurrect a selection someone explicitly removed. Existing edits are copies.
  await run("UPDATE library_highlights SET deleted_at = datetime('now') WHERE id = ?", [c.req.param("id")]);
  return c.json({ ok: true });
});

libraryHighlights.post("/projects", async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.request_id !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(b.request_id)
      || !Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > 12
      || b.ids.some((id: unknown) => typeof id !== "string" || id.length > 64) || new Set(b.ids).size !== b.ids.length) {
    return c.json({ error: "invalid_request", detail: "Choose 1–12 highlights and supply a unique request_id." }, 400);
  }
  const selection = JSON.stringify([...b.ids].sort());
  await run("INSERT OR IGNORE INTO highlight_creations (request_id, selection) VALUES (?, ?)", [b.request_id, selection]);
  const request = await get<{ selection: string; result: string | null }>("SELECT selection, result FROM highlight_creations WHERE request_id = ?", [b.request_id]);
  if (request!.selection !== selection) return c.json({ error: "request_conflict", detail: "This request was already used for another selection." }, 409);
  if (request!.result) {
    const projects = JSON.parse(request!.result) as { id: string; name: string; highlight_id: string }[];
    const remaining = await get<{ n: number }>("SELECT COUNT(*) AS n FROM edit_projects WHERE creation_batch = ?", [b.request_id]);
    if (remaining!.n !== projects.length) return c.json({ error: "projects_removed", detail: "This request already created clips that were later deleted. Start a new selection to create new clips." }, 410);
    return c.json({ projects });
  }
  const rows = await query<{ id: string; asset_id: string; src_in: number; src_out: number; text: string; name: string; duration: number }>(
    `SELECT h.*, a.name, a.duration FROM library_highlights h JOIN assets a ON a.id = h.asset_id
     WHERE h.id IN (${b.ids.map(() => "?").join(",")}) AND h.deleted_at IS NULL AND a.deleting = 0`, b.ids);
  if (rows.length !== b.ids.length) return c.json({ error: "source_unavailable", detail: "A selected highlight or its video is no longer available." }, 409);
  if (rows.some(h => !Number.isFinite(h.duration) || h.src_in < 0 || h.src_out > h.duration + 0.05 || h.src_out - h.src_in < 0.2 || h.src_out - h.src_in > MAX_OUTPUT_SECONDS)) {
    return c.json({ error: "invalid_range", detail: "Each highlight must be within its video and no longer than five minutes." }, 422);
  }
  const clips = b.ids.map((hid: string) => {
    const h = rows.find(r => r.id === hid)!;
    // One cut, delivered wide and tall: each shot starts whole in 9:16, for a
    // person (or AI reframe) to frame (shared/formats.ts).
    const edl = addFormat({ ...starterEdl(), output: { width: 1920, height: 1080, fps: 30, background: "#000000" } }, "9:16");
    edl.main.elements = [{ id: crypto.randomUUID(), type: "video", src: `asset:${h.asset_id}`,
      trimStart: h.src_in, duration: h.src_out - h.src_in, fit: "contain" }];
    return [crypto.randomUUID(), (h.text.trim() || h.name).slice(0, 100), JSON.stringify(edl), b.request_id, h.id];
  });
  // One statement creates the whole batch. Its final insert completes the
  // durable request via a trigger, so a deletion after commit cannot erase
  // the receipt. Concurrent retries are excluded here (at most 62 D1 binds).
  await run(`WITH clips(id, name, edl, creation_batch, highlight_id) AS (VALUES ${clips.map(() => "(?,?,?,?,?)").join(",")})
    INSERT OR IGNORE INTO edit_projects (id, name, edl, creation_batch, highlight_id)
    SELECT * FROM clips WHERE EXISTS (SELECT 1 FROM highlight_creations WHERE request_id = ? AND result IS NULL)
      AND (SELECT COUNT(*) FROM library_highlights h JOIN assets a ON a.id = h.asset_id
        WHERE h.id IN (SELECT highlight_id FROM clips) AND h.deleted_at IS NULL AND a.deleting = 0) = ?`,
    [...clips.flat(), b.request_id, clips.length]);
  const completed = await get<{ result: string | null }>("SELECT result FROM highlight_creations WHERE request_id = ?", [b.request_id]);
  if (!completed?.result) return c.json({ error: "source_unavailable", detail: "A selected source was removed. Refresh Highlights and try again." }, 409);
  return c.json({ projects: JSON.parse(completed.result) }, 201);
});
