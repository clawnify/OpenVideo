import { Hono } from "hono";
import { initDB, query, get, run } from "./db";
import {
  initUploads,
  putUpload,
  getUpload,
  getUploadRange,
  deleteUpload,
  makeKey,
} from "./uploads";
import { renderComposition } from "./render";
import { starterEdl, validateEdl, type Edl } from "./edl";
import { analyzeAsset, autocutAssets, copyOutput, resolveEdlSources, runEdit } from "./export";

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
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", async (c, next) => {
  initDB(c.env);
  initUploads(c.env.UPLOADS);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// ── Compositions ─────────────────────────────────────────────────────

interface Composition {
  id: string;
  name: string;
  description: string;
  html: string;
  fps: number;
  created_at: string;
  updated_at: string;
}

app.get("/api/compositions", async (c) => {
  const rows = await query<Composition>("SELECT * FROM compositions ORDER BY updated_at DESC");
  return c.json(rows);
});

app.get("/api/compositions/:id", async (c) => {
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.post("/api/compositions", async (c) => {
  const b = await c.req.json<Partial<Composition>>();
  if (!b.name?.trim()) return c.json({ error: "name is required" }, 400);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO compositions (id, name, description, html, fps) VALUES (?, ?, ?, ?, ?)",
    [id, b.name.trim(), b.description ?? "", b.html ?? "", b.fps ?? 30],
  );
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json(row, 201);
});

app.put("/api/compositions/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<Composition>>();
  await run(
    `UPDATE compositions SET name = ?, description = ?, html = ?, fps = ?, updated_at = datetime('now') WHERE id = ?`,
    [b.name ?? existing.name, b.description ?? existing.description, b.html ?? existing.html, b.fps ?? existing.fps, id],
  );
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json(row);
});

app.delete("/api/compositions/:id", async (c) => {
  await run("DELETE FROM compositions WHERE id = ?", [c.req.param("id")]);
  return c.json({ ok: true });
});

// Serve the composition wrapped in a full HTML doc with a preview harness that
// scales it to fit and loops its GSAP timelines. Loaded by the editor iframe.
app.get("/api/compositions/:id/preview", async (c) => {
  const row = await get<Composition>("SELECT html FROM compositions WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.text("Not found", 404);
  return c.html(previewDoc(row.html));
});

// ── Assets (media library) ───────────────────────────────────────────

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
}

app.get("/api/assets", async (c) => {
  const rows = await query<Asset>("SELECT * FROM assets ORDER BY created_at DESC");
  return c.json(rows);
});

app.post("/api/assets", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return c.json({ error: "No file provided" }, 400);

  // Unique R2 key from the original name; suffix on collision.
  let key = makeKey(file.name || "file");
  const clash = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
  if (clash) {
    const dot = key.lastIndexOf(".");
    const suffix = lower8();
    key = dot > 0 ? `${key.slice(0, dot)}-${suffix}${key.slice(dot)}` : `${key}-${suffix}`;
  }

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
    await deleteUpload(row.key);
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
  const b = (await c.req.json<{ mode?: string; prompt?: string }>().catch(() => ({}))) as {
    mode?: string;
    prompt?: string;
  };
  const res = await analyzeAsset(
    c.req.param("id"),
    { mode: b.mode, prompt: b.prompt },
    {
      servicesUrl: c.env.SERVICES_URL,
      token: c.env.CLAWNIFY_TOKEN,
      openrouterKey: c.env.OPENROUTER_API_KEY,
    },
  );
  if ("failure" in res) return c.json(res.failure, 422);
  return c.json(res.result);
});

// Serve any R2 object (uploaded media + rendered videos). Range-aware: media
// elements seek with byte ranges, and metadata probing of moov-at-end files
// is unusably slow without 206 responses.
app.get("/api/uploads/:key", async (c) => {
  const key = c.req.param("key");
  const range = c.req.header("Range");
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);

  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : undefined;
    const obj = await getUploadRange(key, start, end !== undefined ? end - start + 1 : undefined);
    if (!obj) return c.json({ error: "Not found" }, 404);
    const last = end !== undefined ? Math.min(end, obj.size - 1) : obj.size - 1;
    return new Response(obj.data, {
      status: 206,
      headers: {
        "Content-Type": obj.contentType,
        "Content-Range": `bytes ${start}-${last}/${obj.size}`,
        "Content-Length": String(last - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  }

  const obj = await getUpload(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.data, {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000",
    },
  });
});

// ── Renders ──────────────────────────────────────────────────────────

interface RenderJob {
  id: number;
  composition_id: string;
  status: string;
  output_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

app.get("/api/renders", async (c) => {
  const rows = await query<RenderJob>("SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT 50");
  return c.json(rows);
});

app.get("/api/renders/:id", async (c) => {
  const row = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.post("/api/renders", async (c) => {
  const { composition_id } = await c.req.json<{ composition_id: string }>();
  const comp = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [composition_id]);
  if (!comp) return c.json({ error: "Composition not found" }, 404);

  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json(
      { error: "Render service not configured (missing CLAWNIFY_TOKEN). Renders run on deployed apps." },
      503,
    );
  }

  const res = await run(
    "INSERT INTO render_jobs (composition_id, status) VALUES (?, 'rendering')",
    [composition_id],
  );
  const jobId = res.lastInsertRowid as number;

  try {
    const assets = await query<Asset>("SELECT key FROM assets");
    const mp4 = await renderComposition({
      html: comp.html,
      fps: comp.fps,
      assets,
      filename: `${makeKey(comp.name)}.mp4`,
      servicesUrl: c.env.SERVICES_URL,
      token: c.env.CLAWNIFY_TOKEN,
    });

    const key = `renders/render-${jobId}-${lower8()}.mp4`;
    await putUpload(key, mp4, "video/mp4");
    const url = `/api/uploads/${encodeURIComponent(key)}`;
    await run(
      "UPDATE render_jobs SET status = 'completed', output_url = ?, updated_at = datetime('now') WHERE id = ?",
      [url, jobId],
    );
  } catch (err) {
    await run(
      "UPDATE render_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      [String(err).slice(0, 1000), jobId],
    );
  }

  const job = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [jobId]);
  return c.json(job, 201);
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
  created_at: string;
  updated_at: string;
}

/** Project row with the EDL parsed for the response. */
function projectOut(row: EditProject) {
  return { ...row, edl: JSON.parse(row.edl) as Edl };
}

app.get("/api/projects", async (c) => {
  const rows = await query<Omit<EditProject, "edl">>(
    "SELECT id, name, created_at, updated_at FROM edit_projects ORDER BY updated_at DESC",
  );
  return c.json(rows);
});

app.get("/api/projects/:id", async (c) => {
  const row = await get<EditProject>("SELECT * FROM edit_projects WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(projectOut(row));
});

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
  await run("DELETE FROM export_jobs WHERE project_id = ?", [id]);
  await run("DELETE FROM edit_projects WHERE id = ?", [id]);
  return c.json({ ok: true });
});

// ── Exports ──────────────────────────────────────────────────────────

app.get("/api/exports", async (c) => {
  const projectId = c.req.query("project_id");
  const rows = projectId
    ? await query<ExportJob>(
        "SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
        [projectId],
      )
    : await query<ExportJob>("SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT 50");
  return c.json(rows);
});

app.get("/api/exports/:id", async (c) => {
  const row = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

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

    const edited = await runEdit(
      resolved.edl,
      { quality, filename: `${makeKey(project.name)}.mp4` },
      cfg,
    );
    if ("failure" in edited) return fail(edited.failure.error, edited.failure.detail, edited.failure.path);

    const key = `renders/edit-${jobId}-${lower8()}.mp4`;
    await copyOutput(edited.result, key);
    await run(
      "UPDATE export_jobs SET status = 'completed', output_url = ?, duration = ?, size = ?, updated_at = datetime('now') WHERE id = ?",
      [`/api/uploads/${encodeURIComponent(key)}`, edited.result.duration, edited.result.size, jobId],
    );
  } catch (err) {
    return fail("export_failed", String(err).slice(0, 500));
  }

  const job = await get<ExportJob>("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
  return c.json(job, 201);
});

// ── helpers ──────────────────────────────────────────────────────────

function lower8(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function previewDoc(html: string): string {
  // Master-clock harness: one playhead drives every GSAP timeline so the editor's
  // timeline view stays in sync. Talks to the parent via postMessage:
  //   parent → iframe: { target:'hf-preview', type:'seek'|'play'|'pause', t }
  //   iframe → parent: { source:'hf-preview', type:'time'|'meta', t, duration }
  const harness = `
    window.__timelines = window.__timelines || {};
    // ?start / ?end define a loop window (a selected clip's span); ?play=1 autoplays.
    // Default (no params) is paused on the whole composition.
    var params = new URLSearchParams(location.search);
    var startAt = parseFloat(params.get('start') || '0') || 0;
    var endParam = parseFloat(params.get('end') || '');
    var seekParam = parseFloat(params.get('seek') || '');
    var loopStart = startAt, loopEnd = isFinite(endParam) ? endParam : Infinity;
    var tls = [], playhead = startAt, playing = params.get('play') === '1', duration = 5, last = 0;
    function clipDuration() {
      var max = 0;
      document.querySelectorAll('.clip').forEach(function (el) {
        var s = parseFloat(el.getAttribute('data-start') || '0');
        var d = parseFloat(el.getAttribute('data-duration') || '0');
        if (s + d > max) max = s + d;
      });
      return max;
    }
    addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.target !== 'hf-preview') return;
      if (m.type === 'seek') { playing = false; playhead = Math.max(0, Math.min(m.t, duration)); }
      else if (m.type === 'play') { playing = true; }
      else if (m.type === 'pause') { playing = false; }
      else if (m.type === 'window') {
        loopStart = Math.max(0, m.start || 0);
        loopEnd = (m.end == null) ? duration : Math.min(m.end, duration);
        if (loopStart >= loopEnd) loopStart = 0;
        // Do NOT move the playhead — selecting a clip you can already see
        // shouldn't jump the time. (Reload restores time via a 'seek' message.)
      }
    });
    addEventListener('load', function () {
      var root = document.querySelector('[data-composition-id]');
      if (root) {
        var w = +(root.dataset.width || 1920), h = +(root.dataset.height || 1080);
        root.style.width = w + 'px'; root.style.height = h + 'px';
        root.style.position = 'relative'; root.style.transformOrigin = 'top left';
        var fit = function () {
          var s = Math.min(innerWidth / w, innerHeight / h);
          var tx = (innerWidth - w * s) / 2, ty = (innerHeight - h * s) / 2;
          root.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
        };
        fit(); addEventListener('resize', fit);
      }
      tls = Object.values(window.__timelines || {});
      tls.forEach(function (tl) { try { tl.pause(0); } catch (e) {} });
      var tlMax = tls.reduce(function (a, tl) { try { return Math.max(a, tl.duration()); } catch (e) { return a; } }, 0);
      duration = Math.max(clipDuration(), tlMax, 0.1);
      if (!isFinite(loopEnd) || loopEnd > duration) loopEnd = duration;
      if (loopStart >= loopEnd) loopStart = 0;
      playhead = isFinite(seekParam) ? Math.max(loopStart, Math.min(seekParam, loopEnd)) : loopStart;
      // Click a clip in the preview to select it for editing.
      document.querySelectorAll('.clip').forEach(function (el, i) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          parent.postMessage({ source: 'hf-preview', type: 'select', index: i }, '*');
        });
      });
      parent.postMessage({ source: 'hf-preview', type: 'meta', duration: duration }, '*');
      last = performance.now();
      requestAnimationFrame(tick);
    });
    function tick(now) {
      requestAnimationFrame(tick);
      var dt = (now - last) / 1000; last = now;
      if (playing) { playhead += dt; if (playhead > loopEnd) playhead = loopStart; }
      tls.forEach(function (tl) { try { tl.time(Math.min(playhead, tl.duration())); } catch (e) {} });
      parent.postMessage({ source: 'hf-preview', type: 'time', t: playhead, duration: duration }, '*');
    }`;
  // Media is referenced as a relative `assets/<key>` path (what the renderer
  // needs, since it writes files into the project's assets/ dir). The preview
  // iframe has no such dir, so rewrite those references to the served R2 URL.
  const rewritten = html.replace(/(["'(])assets\//g, "$1/api/uploads/");
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>
</head><body>
${rewritten}
<script>${harness}</script>
</body></html>`;
}

export default app;
