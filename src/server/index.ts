import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";
import { initUploads, putUpload, getUpload, deleteUpload } from "./uploads.js";
import { compositions } from "./compositions.js";
import { renderVideo } from "./renderer.js";

type Env = {
  Bindings: {
    DB: D1Database;
    UPLOADS: R2Bucket;
    BROWSER: Fetcher;
    LOADER: any;
  };
};

const app = createApp<Env>({
  title: "Open Video API",
  version: "1.0.0",
  description: "Programmatic video creation API. Discover compositions, submit render jobs, upload rendered videos to R2, and serve them. The deployed URL doubles as a Remotion serveUrl for renderMedia().",
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

app.use("*", async (c, next) => {
  initUploads(c.env.UPLOADS);
  await next();
});

// ── Schemas ──────────────────────────────────────────────────────────

const CompositionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  durationInFrames: z.number(),
  inputSchema: z.record(z.object({
    type: z.string(),
    label: z.string(),
    description: z.string().optional(),
    default: z.unknown(),
  })),
  defaultProps: z.record(z.unknown()),
});

const RenderJobSchema = z.object({
  id: z.number(),
  composition_id: z.string(),
  props_json: z.string(),
  status: z.string(),
  output_url: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });

// ── List compositions ────────────────────────────────────────────────

const listCompositions = createRoute({
  method: "get",
  path: "/api/compositions",
  tags: ["Compositions"],
  summary: "List all available video compositions with input schemas",
  responses: {
    200: {
      description: "All compositions",
      content: { "application/json": { schema: z.array(CompositionSchema) } },
    },
  },
});

app.openapi(listCompositions, async (c) => {
  return c.json(compositions, 200);
});

// ── Get composition ──────────────────────────────────────────────────

const getComposition = createRoute({
  method: "get",
  path: "/api/compositions/{id}",
  tags: ["Compositions"],
  summary: "Get a single composition with its input schema",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: CompositionSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(getComposition, async (c) => {
  const { id } = c.req.valid("param");
  const comp = compositions.find((co) => co.id === id);
  if (!comp) return c.json({ error: `Composition "${id}" not found` }, 404);
  return c.json(comp, 200);
});

// ── Create render job ────────────────────────────────────────────────

const createRender = createRoute({
  method: "post",
  path: "/api/renders",
  tags: ["Renders"],
  summary: "Create a render job for a composition",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            composition_id: z.string(),
            props: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { content: { "application/json": { schema: RenderJobSchema } }, description: "Created" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Composition not found" },
  },
});

app.openapi(createRender, async (c) => {
  const { composition_id, props } = c.req.valid("json");

  const comp = compositions.find((co) => co.id === composition_id);
  if (!comp) return c.json({ error: `Composition "${composition_id}" not found` }, 404);

  const mergedProps = { ...comp.defaultProps, ...(props || {}) };

  const result = await run(
    "INSERT INTO render_jobs (composition_id, props_json, status) VALUES (?, ?, 'rendering')",
    [composition_id, JSON.stringify(mergedProps)],
  );
  const jobId = result.lastInsertRowid;

  try {
    // Render the video using Browser Rendering
    const host = c.req.header("host") || "localhost:8787";
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const appUrl = `${protocol}://${host}`;

    const videoData = await renderVideo({
      browserBinding: c.env.BROWSER,
      appUrl,
      compositionId: composition_id,
      props: mergedProps,
      width: comp.width,
      height: comp.height,
      fps: comp.fps,
      durationInFrames: comp.durationInFrames,
    });

    // Upload to R2
    const filename = `render_${jobId}_${Date.now()}.webm`;
    const url = await putUpload(filename, videoData, "video/webm");

    await run(
      "UPDATE render_jobs SET status = 'completed', output_url = ?, updated_at = datetime('now') WHERE id = ?",
      [url, jobId],
    );

    const job = await get<z.infer<typeof RenderJobSchema>>(
      "SELECT * FROM render_jobs WHERE id = ?",
      [jobId],
    );
    return c.json(job!, 201);
  } catch (err) {
    await run(
      "UPDATE render_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      [String(err), jobId],
    );
    const job = await get<z.infer<typeof RenderJobSchema>>(
      "SELECT * FROM render_jobs WHERE id = ?",
      [jobId],
    );
    return c.json(job!, 201);
  }
});

// ── Get render job ───────────────────────────────────────────────────

const getRender = createRoute({
  method: "get",
  path: "/api/renders/{id}",
  tags: ["Renders"],
  summary: "Get render job status",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: RenderJobSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(getRender, async (c) => {
  const { id } = c.req.valid("param");
  const job = await get<z.infer<typeof RenderJobSchema>>(
    "SELECT * FROM render_jobs WHERE id = ?",
    [id],
  );
  if (!job) return c.json({ error: "Render job not found" }, 404);
  return c.json(job, 200);
});

// ── List render jobs ─────────────────────────────────────────────────

const listRenders = createRoute({
  method: "get",
  path: "/api/renders",
  tags: ["Renders"],
  summary: "List all render jobs",
  responses: {
    200: { content: { "application/json": { schema: z.array(RenderJobSchema) } }, description: "OK" },
  },
});

app.openapi(listRenders, async (c) => {
  const rows = await query<z.infer<typeof RenderJobSchema>>(
    "SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT 50",
  );
  return c.json(rows, 200);
});

// ── Upload rendered video ────────────────────────────────────────────
// After rendering locally via `npx remotion render`, upload the result.
// Updates the render job status to "completed" with the R2 URL.

app.post("/api/renders/:id/upload", async (c) => {
  const id = c.req.param("id");

  const job = await get<{ id: number; composition_id: string; status: string }>(
    "SELECT * FROM render_jobs WHERE id = ?",
    [id],
  );
  if (!job) return c.json({ error: "Render job not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") {
    return c.json({ error: "No file provided" }, 400);
  }

  const ext = file.name?.split(".").pop()?.toLowerCase() || "mp4";
  const allowed = new Set(["mp4", "webm", "mov", "mkv", "gif"]);
  if (!allowed.has(ext)) {
    return c.json({ error: `Unsupported format: ${ext}` }, 400);
  }

  const filename = `render_${id}_${Date.now()}.${ext}`;
  const data = await file.arrayBuffer();
  const mimeMap: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    gif: "image/gif",
  };
  const url = await putUpload(filename, data, mimeMap[ext] || "video/mp4");

  await run(
    `UPDATE render_jobs SET status = 'completed', output_url = ?, updated_at = datetime('now') WHERE id = ?`,
    [url, id],
  );

  const updated = await get("SELECT * FROM render_jobs WHERE id = ?", [id]);
  return c.json(updated, 200);
});

// ── Serve uploaded files from R2 ─────────────────────────────────────

app.get("/api/uploads/:filename", async (c) => {
  const { filename } = c.req.param();
  const result = await getUpload(filename);
  if (!result) return c.json({ error: "Not found" }, 404);

  return new Response(result.data, {
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=31536000",
    },
  });
});

// ── Custom Compositions (saved code in D1) ───────────────────────────

// ── Custom Compositions (saved code in D1) ───────────────────────────

app.get("/api/custom-compositions", async (c) => {
  const rows = await query("SELECT * FROM custom_compositions ORDER BY updated_at DESC");
  return c.json(rows, 200);
});

app.get("/api/custom-compositions/:id", async (c) => {
  const { id } = c.req.param();
  const row = await get("SELECT * FROM custom_compositions WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row, 200);
});

app.post("/api/custom-compositions", async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    code: string;
    default_props_json?: string;
    width?: number;
    height?: number;
    fps?: number;
    duration_frames?: number;
  }>();

  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);
  if (!body.code?.trim()) return c.json({ error: "Code is required" }, 400);

  const result = await run(
    `INSERT INTO custom_compositions (name, description, code, default_props_json, width, height, fps, duration_frames)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.name.trim(),
      body.description || "",
      body.code,
      body.default_props_json || "{}",
      body.width ?? 1920,
      body.height ?? 1080,
      body.fps ?? 30,
      body.duration_frames ?? 150,
    ],
  );

  const row = await get("SELECT * FROM custom_compositions WHERE rowid = ?", [result.lastInsertRowid]);
  return c.json(row, 201);
});

app.put("/api/custom-compositions/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{
    name?: string;
    description?: string;
    code?: string;
    default_props_json?: string;
    width?: number;
    height?: number;
    fps?: number;
    duration_frames?: number;
  }>();

  const existing = await get<Record<string, unknown>>("SELECT * FROM custom_compositions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  await run(
    `UPDATE custom_compositions SET name = ?, description = ?, code = ?, default_props_json = ?,
     width = ?, height = ?, fps = ?, duration_frames = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      body.name ?? existing.name,
      body.description ?? existing.description,
      body.code ?? existing.code,
      body.default_props_json ?? existing.default_props_json,
      body.width ?? existing.width,
      body.height ?? existing.height,
      body.fps ?? existing.fps,
      body.duration_frames ?? existing.duration_frames,
      id,
    ],
  );

  const row = await get("SELECT * FROM custom_compositions WHERE id = ?", [id]);
  return c.json(row, 200);
});

app.delete("/api/custom-compositions/:id", async (c) => {
  const { id } = c.req.param();
  await run("DELETE FROM custom_compositions WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Render custom composition by ID ──────────────────────────────────
// Loads saved code from D1, renders via Dynamic Workers + Browser Rendering

app.post("/api/custom-compositions/:id/render", async (c) => {
  const { id } = c.req.param();
  const comp = await get<{
    id: string; name: string; code: string; default_props_json: string;
    width: number; height: number; fps: number; duration_frames: number;
  }>("SELECT * FROM custom_compositions WHERE id = ?", [id]);
  if (!comp) return c.json({ error: "Composition not found" }, 404);

  const body = await c.req.json<{ props?: Record<string, unknown> }>().catch(() => ({ props: undefined }));
  const mergedProps = { ...JSON.parse(comp.default_props_json), ...(body.props || {}) };

  // Forward to the /api/render endpoint logic
  const renderUrl = new URL(c.req.url);
  renderUrl.pathname = "/api/render";

  const renderResponse = await app.fetch(
    new Request(renderUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: comp.code,
        props: mergedProps,
        width: comp.width,
        height: comp.height,
        fps: comp.fps,
        durationInFrames: comp.duration_frames,
      }),
    }),
    c.env,
    {} as ExecutionContext,
  );

  return renderResponse;
});

// ── Render from code (Dynamic Workers) ───────────────────────────────
// Agent sends raw composition code → Dynamic Worker executes it →
// Browser Rendering captures the output → uploads to R2.
// No deploy, no build step. Code in, video out.

app.post("/api/render", async (c) => {
  const body = await c.req.json<{
    code: string;
    props?: Record<string, unknown>;
    width?: number;
    height?: number;
    fps?: number;
    durationInFrames?: number;
  }>();

  if (!body.code?.trim()) return c.json({ error: "Code is required" }, 400);

  const width = body.width ?? 1920;
  const height = body.height ?? 1080;
  const fps = body.fps ?? 30;
  const durationInFrames = body.durationInFrames ?? 150;
  const props = body.props ?? {};

  // Create a render job
  const result = await run(
    "INSERT INTO render_jobs (composition_id, props_json, status) VALUES (?, ?, 'rendering')",
    ["custom", JSON.stringify({ code: body.code, props, width, height, fps, durationInFrames })],
  );
  const jobId = result.lastInsertRowid;

  try {
    // The Dynamic Worker wraps the composition code into a minimal Remotion-compatible
    // HTML page that the Browser Rendering session can load and record.
    const renderPageCode = `
      export default {
        async fetch(request) {
          const html = \`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<style>* { margin: 0; padding: 0; } body { width: ${width}px; height: ${height}px; overflow: hidden; }</style>
<script type="importmap">
{ "imports": { "react": "https://esm.sh/react@19", "react-dom": "https://esm.sh/react-dom@19", "remotion": "https://esm.sh/remotion@4.0.448" } }
</script>
</head><body>
<div id="root"></div>
<canvas id="canvas" width="${width}" height="${height}" style="display:none"></canvas>
<script type="module">
import React from "react";
import { createRoot } from "react-dom/client";

// Composition code injected here
const compositionCode = ${JSON.stringify(body.code)};
const inputProps = ${JSON.stringify(props)};
const totalFrames = ${durationInFrames};
const fps = ${fps};
const width = ${width};
const height = ${height};

// Create a module from the code string
const blob = new Blob([compositionCode], { type: "text/javascript" });
const url = URL.createObjectURL(blob);

try {
  const mod = await import(url);
  const Comp = mod.default || mod[Object.keys(mod).find(k => k !== '__esModule') || ''];

  if (!Comp) throw new Error("No default export found in composition code");

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(0);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 5000000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const done = new Promise((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });

  recorder.start();
  window.__renderStatus = "recording";

  const root = document.getElementById("root");

  for (let frame = 0; frame < totalFrames; frame++) {
    // Render the component for this frame
    const frameProps = { ...inputProps, __frame: frame, __fps: fps, __durationInFrames: totalFrames, __width: width, __height: height };

    await new Promise((resolve) => {
      createRoot(root).render(React.createElement(Comp, frameProps));
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    // Capture to canvas via html-to-image approach
    try {
      const svgData = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(root) + '</foreignObject></svg>';
      const img = new Image();
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = svgUrl; });
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(svgUrl);
    } catch {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
    }
    stream.getVideoTracks()[0].requestFrame();
  }

  recorder.stop();
  const blob2 = await done;
  const reader = new FileReader();
  const base64 = await new Promise((res) => { reader.onload = () => res(reader.result); reader.readAsDataURL(blob2); });
  window.__renderResult = base64;
  window.__renderStatus = "done";
} catch (err) {
  window.__renderError = String(err);
  window.__renderStatus = "error";
}
</script>
</body></html>\`;
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        }
      };
    `;

    // Load the Dynamic Worker with the render page
    const worker = c.env.LOADER.load({
      compatibilityDate: "2026-03-01",
      mainModule: "render-server.js",
      modules: { "render-server.js": renderPageCode },
    });

    // Get the render page URL from the Dynamic Worker
    const renderPageResponse = await worker.getEntrypoint().fetch(new Request("https://render/"));
    const renderHtml = await renderPageResponse.text();

    // Open Browser Rendering to load the page and capture the video
    const puppeteer = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.default.launch(c.env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(renderHtml, { waitUntil: "networkidle0", timeout: 30000 });

    // Wait for recording to complete
    await page.waitForFunction("window.__renderStatus === 'recording'", { timeout: 30000 });
    const durationMs = (durationInFrames / fps) * 1000;
    await page.waitForFunction(
      "window.__renderStatus === 'done' || window.__renderStatus === 'error'",
      { timeout: durationMs + 60000 },
    );

    const status = await page.evaluate(() => (window as any).__renderStatus) as string;
    if (status === "error") {
      const error = await page.evaluate(() => (window as any).__renderError) as string;
      await browser.close();
      throw new Error(error);
    }

    const base64Data = await page.evaluate(() => (window as any).__renderResult) as string;
    await browser.close();

    // Decode and upload to R2
    const base64 = base64Data.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const filename = `render_${jobId}_${Date.now()}.webm`;
    const videoUrl = await putUpload(filename, bytes.buffer, "video/webm");

    await run(
      "UPDATE render_jobs SET status = 'completed', output_url = ?, updated_at = datetime('now') WHERE id = ?",
      [videoUrl, jobId],
    );

    const job = await get("SELECT * FROM render_jobs WHERE id = ?", [jobId]);
    return c.json(job, 200);
  } catch (err) {
    await run(
      "UPDATE render_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      [String(err), jobId],
    );
    return c.json({ error: String(err), job_id: jobId }, 500);
  }
});

// ── Serve URL ────────────────────────────────────────────────────────

app.get("/api/serve-url", async (c) => {
  const host = c.req.header("host") || "localhost";
  const protocol = c.req.header("x-forwarded-proto") || "https";
  return c.json({ serveUrl: `${protocol}://${host}` }, 200);
});

export default app;
