// End-to-end check of OpenVideo's footage-from-Drive routes: the real Hono
// server over node:sqlite, with Drive, the media/analysis services and the
// queue stubbed at fetch. Run it with `pnpm test:e2e`, which bundles the
// server first. By hand: node run.mjs <bundle.mjs> <schema.sql>, the bundle
// path relative to this file and the schema path to the working directory.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [bundlePath, schemaPath] = process.argv.slice(2);
let n = 0;
const fresh = async () => (await import(`${bundlePath}?${n++}`)).default;

function storage() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    db,
    binding: {
      async query(sql, params = []) {
        const st = db.prepare(sql);
        const p = params.map((v) => (typeof v === "boolean" ? Number(v) : v === undefined ? null : v));
        if (/^\s*(select|pragma|with)/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...p) };
        const r = st.run(...p);
        return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    },
  };
}

// ── the outside world ─────────────────────────────────────────────────────
const folderEntry = (id, name) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/drive/folders/${id}" target="_blank"><div class="flip-entry-list-icon"><div aria-label="Folder" class="drive-sprite-folder-list-shared-icon"></div></div><div class="flip-entry-title">${name}</div></a></div></div>`;
const fileEntry = (id, name, type = "video/mp4") =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/${id}/view?usp=drive_web" target="_blank"><div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${type}" alt=""/></div><div class="flip-entry-title">${name}</div></a></div></div>`;
const page = (title, entries) => `<html><head><title>${title}</title></head><body>${entries.join("")}</body></html>`;
const fid = (s) => (s + "_".repeat(28)).slice(0, 28);

const world = {
  drive: {},
  media: new Map(), // uid → { polls, name, deleted }
  jobs: new Map(),
  calls: [],
  importRefusal: null,
  analyzeRefusal: null,
  prompts: [],
  modelRefusal: null,
  vtt: "WEBVTT\n\n1\n00:00:04.800 --> 00:00:09.600\nWe made it.\n",
};
// The platform's delivery signature, with a key of our own served as its JWKS.
const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
world.jwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
async function signed(body) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing.privateKey, new TextEncoder().encode(`${ts}.${body}`)));
  return { "X-Queue-Signature": btoa(String.fromCharCode(...sig)), "X-Queue-Timestamp": String(ts), "X-Queue-Key-Id": "test" };
}
function setDrive(extra = []) {
  world.drive = {
    [fid("day1")]: page("Day 1", [folderEntry(fid("camb"), "Cam B"), folderEntry(fid("testi"), "Testimonials"), folderEntry(fid("photos"), "Photos")]),
    [fid("camb")]: page("Cam B", [fileEntry(fid("b1"), "B_0001.MP4"), fileEntry(fid("b2"), "B_0002.MP4"), ...extra]),
    [fid("testi")]: page("Testimonials", [folderEntry(fid("t1"), "Testimonial 1")]),
    [fid("t1")]: page("Testimonial 1", [fileEntry(fid("c1"), "C_9193.MP4"), fileEntry(fid("d1"), "D_7423.MP4")]),
    [fid("photos")]: page("Photos", [fileEntry(fid("p1"), "P_0001.JPG", "image/jpeg")]),
  };
}
setDrive();

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let uidN = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init.method ?? "GET";
  world.calls.push(`${method} ${url}`);
  const u = new URL(url);
  if (u.hostname === "drive.google.com" && u.pathname === "/embeddedfolderview") {
    const html = world.drive[u.searchParams.get("id")];
    return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 });
  }
  if (u.hostname === "drive.usercontent.google.com") {
    const ranged = new Headers(init.headers ?? {}).has("range");
    if ((u.searchParams.get("id") === fid("q1") && !world.quotaLifted || u.searchParams.get("id").startsWith("conn")) && !ranged) {
      // Over Drive's daily download limit: ranged reads still work, the whole file doesn't.
      return new Response("<html><head><title>Google Drive - Quota exceeded</title></head><body>Too many users have viewed or downloaded this file recently.</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return ranged
      ? new Response("xx", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-1/123456789" } })
      : new Response("x".repeat(64), { status: 200, headers: { "content-type": "video/mp4", "content-length": "123456789" } });
  }
  if (u.hostname === "svc.test") {
    if (u.pathname === "/media/import") {
      if (world.importRefusal) return json(409, world.importRefusal);
      const id = (++uidN).toString(16).padStart(32, "0");
      world.media.set(id, { polls: 0, name: JSON.parse(init.body).name });
      (world.importUrls ??= []).push(JSON.parse(init.body).url);
      return json(201, { id, state: "downloading", ready: false });
    }
    if (u.pathname === "/media/transcode" && method === "POST") {
      world.transcodes = (world.transcodes ?? 0) + 1;
      (world.transcodeUrls ??= []).push(JSON.parse(init.body).url);
      return json(202, { job_id: `00000000-0000-0000-0000-00000000000${world.transcodes}` });
    }
    const tj = /^\/media\/transcode\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (tj) {
      world.tpolls = (world.tpolls ?? 0) + 1;
      if (world.tpolls < 2) return json(200, { status: "running" });
      const id = (++uidN).toString(16).padStart(32, "0");
      world.media.set(id, { polls: 0, name: "re-encoded" });
      return json(200, { status: "done", id });
    }
    let m = /^\/media\/([0-9a-f]{32})$/.exec(u.pathname);
    if (m && method === "DELETE") {
      if (world.refuseMediaDeletes > 0) {
        world.refuseMediaDeletes--;
        (world.refusedDeletes ??= []).push(m[1]);
        return json(503, { error: "media_failed", detail: "storage is busy" });
      }
      const v = world.media.get(m[1]);
      if (!v || v.deleted) return json(404, { error: "not_found" });
      v.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (m) {
      const v = world.media.get(m[1]);
      if (!v || v.deleted) return json(404, { error: "not_found" });
      v.polls++;
      if (v.name === "HIGH.MP4") return json(200, { id: m[1], state: "error", ready: false, duration: null, error: "The video bitrate exceeded the maximum acceptable value of 200 Mbps." });
      const ready = v.polls >= 2;
      return json(200, { id: m[1], state: ready ? "ready" : "inprogress", ready, duration: ready ? 60 : null, error: null });
    }
    m = /^\/media\/([0-9a-f]{32})\/prepare$/.exec(u.pathname);
    if (m) {
      const v = world.media.get(m[1]);
      v.prepares = (v.prepares ?? 0) + 1;
      return json(200, { id: m[1], state: "ready", ready: true, duration: 60, download: { status: "ready", percent: 100 }, analysis: v.prepares >= 2 ? "ready" : "preparing" });
    }
    if (u.pathname === "/video/edit" && method === "POST") {
      if (world.editRefusal) return json(422, world.editRefusal);
      world.renders = (world.renders ?? 0) + 1;
      return json(202, { job_id: `render${world.renders}`, status: "running" });
    }
    if (u.pathname === "/video/analyze") {
      if (world.analyzeRefusal) return json(world.analyzeRefusal.status, world.analyzeRefusal.body);
      const body = JSON.parse(init.body);
      const job = `job${world.jobs.size + 1}`;
      world.jobs.set(job, { polls: 0, source: body.source });
      return json(202, { job_id: job, status: "running" });
    }
    m = /^\/video\/analyze\/(job\d+)$/.exec(u.pathname);
    if (m) {
      const j = world.jobs.get(m[1]);
      j.polls++;
      if (j.polls < 2) return json(200, { status: "running" });
      return json(200, {
        status: "done",
        result: {
          summary: `Log of ${j.source}`,
          kind: j.source.endsWith("1") ? "interview" : "b-roll",
          quality: "good",
          issues: "",
          quotes: [{ start: "0:05", end: "0:09.5", text: "We made it.", speaker: "woman in a red jacket" }],
          moments: [{ start: "0:20", end: "0:26", description: "Crowd at the booth" }],
          visible_text: ["Northwind"],
        },
      });
    }
  }
  if (u.hostname === "services.clawnify.com" && u.pathname === "/.well-known/jwks.json") {
    return json(200, { keys: [{ ...world.jwk, kid: "test" }] });
  }
  if (u.hostname === "svc.test" && /^\/media\/[0-9a-f]{32}\/captions\/en$/.test(u.pathname)) {
    return new Response(world.vtt, { status: 200, headers: { "content-type": "text/vtt" } });
  }
  if (u.hostname === "openrouter.ai") {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    world.prompts.push(prompt);
    if (world.modelRefusal) return new Response(world.modelRefusal.body, { status: world.modelRefusal.status });
    // One answer per clip in the prompt: a soundbite where there is speech,
    // a shot everywhere, and B_0003 set aside.
    const clips = [...prompt.matchAll(/^CLIP (\d+): "([^"]+)"/gm)].map((m) => ({ n: Number(m[1]), name: m[2] }));
    const content = JSON.stringify({
      clips: clips.map(({ n, name }) =>
        name === "B_0003.MP4"
          ? { clip: n, use: false, skip_reason: "camera pointed at the floor", highlights: [] }
          : {
              clip: n,
              use: true,
              skip_reason: "",
              highlights: [
                { kind: "broll", start: "0:20", end: "0:26", text: `Crowd at the booth (${name})`, speaker: "", score: 3, reason: "energy" },
                ...(prompt.includes("Transcript:") ? [{ kind: "soundbite", start: "0:05.2", end: "0:09", text: "We made it.", speaker: "woman in a red jacket", score: 5, reason: "the day in three words" }] : []),
              ],
            },
      ),
    });
    return json(200, { choices: [{ message: { content } }] });
  }
  if (u.hostname === "queue.test") {
    const body = JSON.parse(init.body);
    world.lastEnqueue = body;
    return json(201, { id: `qjob_${world.calls.length}`, job_id: `qjob_${world.calls.length}`, status: "pending", run_at: body.run_at });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

// ── the scenario ──────────────────────────────────────────────────────────
const { db, binding } = storage();
const app = await fresh();
const env = { STORAGE: binding, UPLOADS: {}, CLAWNIFY_TOKEN: "clw_test", SERVICES_URL: "https://svc.test", CLAWNIFY_QUEUE_URL: "https://queue.test/queue" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = async (method, path, body) => {
  const res = await app.request(`https://open-video.apps.clawnify.com${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }, env, ctx);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

// 1. A project from a folder: every video in every folder inside it, no stills.
let r = await call("POST", "/api/projects", { folder: `https://drive.google.com/drive/folders/${fid("day1")}?usp=sharing` });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.equal(r.data.name, "Day 1");
assert.deepEqual(r.data.footage, { folder: { id: fid("day1"), name: "Day 1" }, found: 4, added: 4, truncated: false });
const pid = r.data.id;
assert.ok(world.lastEnqueue, "a background step was booked");
assert.equal(world.lastEnqueue.target_url ?? world.lastEnqueue.targetUrl, "https://open-video.apps.clawnify.com/api/footage/step");
console.log("1 ok: project from folder, 4 videos, step booked:", world.lastEnqueue.idempotency_key ?? world.lastEnqueue.idempotencyKey);

// A link that isn't a folder, and a folder that isn't public.
r = await call("POST", "/api/projects", { folder: "https://example.com/x" });
assert.equal(r.status, 400);
r = await call("POST", "/api/projects", { folder: `https://drive.google.com/drive/folders/${fid("private")}` });
assert.equal(r.status, 422);
assert.match(r.data.detail, /shared with anyone who has the link/);
console.log("1b ok: bad link 400, private folder 422");

// 2. Reads move it on: import → ready → analysis copy → log.
const statuses = async () => {
  const x = await call("GET", `/api/projects/${pid}/footage?logs=0`);
  assert.equal(x.status, 200, JSON.stringify(x.data));
  return x.data;
};
let f = await statuses();
assert.equal(f.counts.importing, 4, JSON.stringify(f.counts));
assert.deepEqual(f.items.map((i) => i.folder), ["Day 1/Cam B", "Day 1/Cam B", "Day 1/Testimonials/Testimonial 1", "Day 1/Testimonials/Testimonial 1"]);
const enqueuesAfterFirstRead = world.calls.filter((c) => c.includes("queue.test")).length;
f = await statuses();
assert.equal(world.calls.filter((c) => c.includes("queue.test")).length, enqueuesAfterFirstRead, "a read within the booked minute books nothing more");
for (let i = 0; i < 6 && f.counts.logged < 4; i++) f = await statuses();
assert.equal(f.counts.ready, 4, JSON.stringify(f.counts));
assert.equal(f.counts.logged, 4, JSON.stringify(f.counts));
assert.equal(f.next_step_at, null, "nothing left: no step booked");
assert.deepEqual(f.items[0].log, { summary: f.items[0].log.summary, kind: f.items[0].log.kind, quality: "good" }, "logs=0 gives the short log");
assert.equal(f.items[0].asset.duration, 60);
console.log("2 ok: imported and logged in", world.jobs.size, "analysis jobs");

// 3. The full log, paged and narrowed.
r = await call("GET", `/api/projects/${pid}/footage?limit=1`);
assert.equal(r.data.items.length, 1);
assert.equal(r.data.next_offset, 1);
assert.deepEqual(r.data.items[0].log.quotes, [{ start: 5, end: 9.5, text: "We made it.", speaker: "woman in a red jacket" }]);
r = await call("GET", `/api/projects/${pid}/footage?folder=Day 1/Testimonials`);
assert.equal(r.data.items.length, 2);
r = await call("GET", `/api/projects/${pid}/footage?folder=Day 1/Test`);
assert.equal(r.data.items.length, 0, "a folder prefix matches whole folder names only");
r = await call("GET", `/api/projects/${pid}/footage?kind=interview`);
assert.ok(r.data.items.length >= 1 && r.data.items.every((i) => i.log.kind === "interview"));
const one = await call("GET", `/api/projects/${pid}/footage/${r.data.items[0].id}`);
assert.equal(one.status, 200);
assert.equal(one.data.log.moments[0].description, "Crowd at the booth");
console.log("3 ok: paging, folder and kind filters, one clip");

// 4. The library: a project's footage is its own.
r = await call("GET", "/api/assets");
assert.equal(r.data.length, 0, JSON.stringify(r.data));
r = await call("GET", `/api/assets?project=${pid}`);
assert.equal(r.data.length, 4);
console.log("4 ok: footage listed with its project only");

// 5. New files in Drive; a removed clip stays removed.
setDrive([fileEntry(fid("b3"), "B_0003.MP4")]);
r = await call("POST", `/api/projects/${pid}/footage/sync`);
assert.equal(r.data.added, 1, JSON.stringify(r.data));
const firstAsset = f.items[0].asset.id;
world.refuseMediaDeletes = 1;
r = await call("DELETE", `/api/assets/${firstAsset}`);
assert.equal(r.status, 502, "a copy the service would not delete is not reported deleted");
assert.match(r.data.detail, /could not be deleted/);
assert.ok(db.prepare("SELECT 1 FROM assets WHERE id = ?").get(firstAsset), "the asset stays, to be deleted again");
r = await call("DELETE", `/api/assets/${firstAsset}`);
assert.equal(r.status, 200);
r = await call("POST", `/api/projects/${pid}/footage/sync`);
assert.equal(r.data.added, 0, "a removed clip is not brought back");
f = await statuses();
assert.equal(f.counts.total, 4, "the removed clip is not listed");
console.log("5 ok: sync adds new files, removed clips stay out; a refused copy delete keeps the asset");

// 6. An org-wide refusal pauses imports and leaves the clip in line.
for (let i = 0; i < 8 && f.counts.logged < 4; i++) f = await statuses();
setDrive([fileEntry(fid("b3"), "B_0003.MP4"), fileEntry(fid("b5"), "B_0005.MP4")]);
r = await call("POST", `/api/projects/${pid}/footage/sync`);
assert.equal(r.data.added, 1);
world.importRefusal = { error: "storage_full", detail: "Your workspace's video storage is full" };
f = await statuses();
assert.equal(f.imports_paused, "Your workspace's video storage is full");
assert.equal(f.counts.waiting, 1, JSON.stringify(f.counts));
assert.equal(f.counts.failed, 0);
world.importRefusal = null;
for (let i = 0; i < 8 && f.counts.logged < 5; i++) f = await statuses();
assert.equal(f.counts.logged, 5, JSON.stringify(f.counts));
console.log("6 ok: storage full pauses imports, they resume after");

// 7. Logging that the plan's allowance refuses pauses, without failing clips.
setDrive([fileEntry(fid("b3"), "B_0003.MP4"), fileEntry(fid("b5"), "B_0005.MP4"), fileEntry(fid("b4"), "B_0004.MP4")]);
await call("POST", `/api/projects/${pid}/footage/sync`);
world.analyzeRefusal = { status: 403, body: { error: "quota_exceeded", detail: "monthly allowance used" } };
for (let i = 0; i < 5; i++) f = await statuses();
assert.equal(f.logging_paused, "monthly allowance used", JSON.stringify(f));
assert.equal(f.counts.log_failed, 0);
assert.equal(f.next_step_at, null, "only a limit holds the rest: no step booked");
world.analyzeRefusal = null;
for (let i = 0; i < 6 && f.counts.logged < 6; i++) f = await statuses();
assert.equal(f.counts.logged, 6, JSON.stringify(f.counts));
console.log("7 ok: allowance used pauses logging and books nothing; resumes after");

// 7b. A file over Drive's download limit waits and is tried again by itself:
// no import is attempted, no clip fails, and the next step is booked for when
// it is due, not every minute. A person can ask Drive again now; after about a
// day of refusals the clip gives up with the reason.
const importsBefore = world.calls.filter((c) => c.endsWith("/media/import")).length;
setDrive([fileEntry(fid("b3"), "B_0003.MP4"), fileEntry(fid("b5"), "B_0005.MP4"), fileEntry(fid("b4"), "B_0004.MP4"), fileEntry(fid("q1"), "B_0009.MP4")]);
await call("POST", `/api/projects/${pid}/footage/sync`);
f = await statuses();
let blocked = f.items.find((i) => i.name === "B_0009.MP4");
assert.equal(blocked.status, "waiting", JSON.stringify(blocked));
assert.match(blocked.error, /Waiting for Google Drive/);
const due = Date.parse(blocked.retry_at);
assert.ok(due > Date.now() + 25 * 60_000 && due < Date.now() + 35 * 60_000, "tried again in about half an hour");
assert.equal(f.counts.failed, 0);
assert.equal(f.counts.drive_waiting, 1);
assert.match(f.imports_paused, /limiting downloads of these files/);
assert.equal(world.calls.filter((c) => c.endsWith("/media/import")).length, importsBefore, "no import was attempted");
// The step already booked a minute out runs, finds nothing due, and books
// the next for when the clip is.
{
  const body = JSON.stringify({ project_id: pid });
  const res = await app.request("https://open-video.apps.clawnify.com/api/footage/step", { method: "POST", headers: { "content-type": "application/json", ...(await signed(body)) }, body }, env, ctx);
  assert.equal(res.status, 200);
  const bookedFor = Date.parse(world.lastEnqueue.run_at ?? world.lastEnqueue.runAt);
  assert.ok(bookedFor >= due && bookedFor < due + 61_000, `the next step is booked for when the clip is due (${new Date(bookedFor).toISOString()} vs ${blocked.retry_at})`);
}
// Reads in the meantime don't ask Drive again.
const probes = () => world.calls.filter((c) => c.includes(fid("q1")) && c.includes("drive.usercontent")).length;
const probesBefore = probes();
await statuses();
assert.equal(probes(), probesBefore, "a read before it is due leaves Drive alone");
// "Try Google Drive again now" asks at once.
r = await call("POST", `/api/projects/${pid}/footage/retry`);
assert.equal(r.data.imports, 1);
f = await statuses();
assert.equal(probes(), probesBefore + 1);
// Drive lifts the limit: when it is due, it imports.
world.quotaLifted = true;
db.prepare("UPDATE project_footage SET retry_at = ? WHERE name = 'B_0009.MP4'").run(new Date(Date.now() - 1000).toISOString());
f = await statuses();
blocked = f.items.find((i) => i.name === "B_0009.MP4");
assert.equal(blocked.status, "importing", JSON.stringify(blocked));
assert.equal(world.calls.filter((c) => c.endsWith("/media/import")).length, importsBefore + 1);
// A clip refused for about a day gives up, saying why.
world.quotaLifted = false;
db.prepare("UPDATE project_footage SET status = 'waiting', drive_tries = 8, retry_at = ? WHERE name = 'B_0009.MP4'").run(new Date(Date.now() - 1000).toISOString());
f = await statuses();
blocked = f.items.find((i) => i.name === "B_0009.MP4");
assert.equal(blocked.status, "failed", JSON.stringify(blocked));
assert.match(blocked.error, /download limit for this file is used up/);
console.log("7b ok: a clip Drive refuses waits, is tried again when due (or now on request), imports once Drive lets go, gives up after a day");
db.prepare("DELETE FROM assets WHERE id = (SELECT asset_id FROM project_footage WHERE name = 'B_0009.MP4')").run();
db.prepare("DELETE FROM project_footage WHERE name = 'B_0009.MP4'").run();
world.quotaLifted = true;

// 8. Retry puts failures back in line.
db.prepare("UPDATE project_footage SET status = 'failed', error = 'x' WHERE project_id = ? AND name = 'B_0002.MP4'").run(pid);
r = await call("POST", `/api/projects/${pid}/footage/retry`);
assert.deepEqual(r.data, { imports: 1, logs: 0 });
console.log("8 ok: retry");

// 8b. Export: the handover runs under the request's waitUntil, so a caller
// going away mid-request cannot cut it off, and it records the render's job.
const clipAsset = f.items.find((i) => i.status === "ready").asset.id;
const doc = (els) => ({ version: 1, output: { width: 1280, height: 720, fps: 30, background: "#000000" }, main: { elements: els }, overlays: [], audio: [] });
r = await call("PUT", `/api/projects/${pid}`, { edl: doc([{ id: "a", type: "video", src: `asset:${clipAsset}`, duration: 2 }, { id: "b", type: "video", src: `asset:${clipAsset}`, trimStart: 3, duration: 2 }]) });
assert.equal(r.status, 200, JSON.stringify(r.data));
const held = [];
ctx.waitUntil = (p) => held.push(p);
r = await call("POST", `/api/projects/${pid}/export`, { quality: "draft" });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.ok(held.length >= 1, "the handover is held past the response");
assert.equal(db.prepare("SELECT service_job_id FROM export_jobs WHERE id = ?").get(r.data.id).service_job_id, "render1");
world.editRefusal = { error: "edl_invalid", detail: "bad trim", path: "/main/elements/1/trimStart" };
r = await call("POST", `/api/projects/${pid}/export`, { quality: "draft" });
assert.equal(r.data.status, "failed");
assert.deepEqual(r.data.failure, { error: "edl_invalid", detail: "bad trim", path: "/main/elements/1/trimStart" });
assert.match(db.prepare("SELECT error FROM export_jobs WHERE id = ?").get(r.data.id).error, /bad trim \(at \/main\/elements\/1\/trimStart\)/);
world.editRefusal = null;
ctx.waitUntil = () => {};
console.log("8b ok: export handover held past the response; refusals recorded with their pointer");

// 9. The queue's call must be signed.
r = await call("POST", "/api/footage/step", { project_id: pid });
assert.equal(r.status, 401);
console.log("9 ok: unsigned step refused");

// 11. Highlights: asked for, read on the queue's delivery (never on a read),
// reviewed, exported, found again without losing a person's calls.
const deliver = async () => {
  const body = JSON.stringify({ project_id: pid });
  const res = await app.request("https://open-video.apps.clawnify.com/api/footage/step", { method: "POST", headers: { "content-type": "application/json", ...(await signed(body)) }, body }, env, ctx);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
};
const logged = db.prepare("SELECT COUNT(*) AS n FROM project_footage WHERE project_id = ? AND status = 'ready' AND log_status = 'done'").get(pid).n;
r = await call("GET", `/api/projects/${pid}/highlights`);
assert.equal(r.data.asked, false);
r = await call("POST", `/api/projects/${pid}/highlights`, { brief: "A 60 s sizzle of the booth" });
assert.equal(r.status, 202, JSON.stringify(r.data));
assert.equal(r.data.paused, "finding highlights needs an OpenRouter key: add one in the dashboard's API Keys settings", "no key: says so");
env.OPENROUTER_API_KEY = "or_test";
r = await call("POST", `/api/projects/${pid}/highlights`, {});
assert.equal(r.data.pending, logged, JSON.stringify(r.data));
assert.equal(r.data.paused, null);
assert.equal(db.prepare("SELECT brief FROM edit_projects WHERE id = ?").get(pid).brief, "A 60 s sizzle of the booth", "the brief was kept");
r = await call("GET", `/api/projects/${pid}/highlights`);
assert.equal(world.prompts.length, 0, "a read never calls the model");
assert.equal(r.data.clips.pending, logged);
let d = await deliver();
assert.ok(world.prompts.length >= 1, "the delivery read the clips");
assert.match(world.prompts[0], /A 60 s sizzle of the booth/);
r = await call("GET", `/api/projects/${pid}/highlights?skipped=1`);
assert.equal(r.data.clips.pending, 0, JSON.stringify(r.data.clips));
assert.equal(r.data.clips.done, logged);
assert.equal(r.data.clips.skipped, 1);
assert.deepEqual(r.data.skipped.map((s) => [s.name, s.reason]), [["B_0003.MP4", "camera pointed at the floor"]]);
const soundbites = r.data.highlights.filter((h) => h.kind === "soundbite");
assert.ok(soundbites.length >= 1, JSON.stringify(r.data.highlights));
assert.equal(r.data.highlights[0].score, 5, "best first");
assert.deepEqual([soundbites[0].start, soundbites[0].end], [4.6, 9.9], "the soundbite is snapped to its transcript line, with a breath");
assert.equal(r.data.counts.total, r.data.highlights.length);
assert.equal(r.data.highlights[0].clip.asset_id !== null, true);
console.log(`11 ok: ${logged} clips read in one delivery (${world.prompts.length} model calls), ${r.data.counts.total} picks, 1 set aside`);

// Review: keep, drop, bad calls refused; a person's own pick.
const [first, second] = r.data.highlights;
r = await call("PATCH", `/api/projects/${pid}/highlights/${first.id}`, { pick: "keep" });
assert.equal(r.data.pick, "keep");
r = await call("PATCH", `/api/projects/${pid}/highlights/${second.id}`, { pick: "drop" });
assert.equal(r.data.pick, "drop");
r = await call("PATCH", `/api/projects/${pid}/highlights/${second.id}`, { pick: "maybe" });
assert.equal(r.status, 400);
r = await call("PATCH", `/api/projects/${pid}/highlights/${second.id}`, { start: 10, end: 500 });
assert.equal(r.status, 400, "an out past the clip's end is refused");
const skippedClip = db.prepare("SELECT id FROM project_footage WHERE project_id = ? AND name = 'B_0003.MP4'").get(pid).id;
r = await call("POST", `/api/projects/${pid}/highlights/items`, { clip: skippedClip, kind: "broll", text: "Used anyway" });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.deepEqual([r.data.start, r.data.end, r.data.pick, r.data.origin], [0, 60, "keep", "person"]);
r = await call("GET", `/api/projects/${pid}/highlights?pick=keep`);
assert.equal(r.data.highlights.length, 2);
r = await call("GET", `/api/projects/${pid}/highlights?kind=soundbite&min_score=5`);
assert.ok(r.data.highlights.every((h) => h.kind === "soundbite" && h.score === 5));
console.log("11b ok: keep, drop, refusals, a person's own pick, filters");

// Export: a sheet of everything not dropped by default, or only the kept.
let res = await app.request(`https://open-video.apps.clawnify.com/api/projects/${pid}/highlights/export?format=csv`, {}, env, ctx);
assert.equal(res.status, 200);
assert.match(res.headers.get("content-type"), /text\/csv/);
assert.match(res.headers.get("content-disposition"), /attachment; filename="Day 1 highlights.csv"/);
let csv = (await res.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
const total = db.prepare("SELECT COUNT(*) AS n FROM footage_highlights WHERE project_id = ? AND (pick IS NULL OR pick = 'keep')").get(pid).n;
assert.equal(csv.length, total + 1, "a header and every pick not dropped");
res = await app.request(`https://open-video.apps.clawnify.com/api/projects/${pid}/highlights/export?format=csv&pick=keep`, {}, env, ctx);
csv = (await res.text()).trim().split("\r\n");
assert.equal(csv.length, 3);
assert.ok(csv.slice(1).every((l) => l.includes(",Kept,")));
console.log("11c ok: sheet export,", total, "rows by default, 2 kept");

// Find again: unreviewed picks are replaced, a person's calls stay, and the
// model is told what was already reviewed.
const promptsBefore = world.prompts.length;
r = await call("POST", `/api/projects/${pid}/highlights`, { again: true });
assert.equal(r.data.pending, logged);
d = await deliver();
assert.ok(world.prompts.length > promptsBefore);
assert.ok(world.prompts.slice(promptsBefore).some((p) => p.includes("Already reviewed by a person")), "reviewed stretches are passed as taken");
const again = world.prompts.slice(promptsBefore).join("\n");
assert.match(again, /\] kept: /, "each reviewed stretch says whether it was kept");
assert.match(again, /\] dropped: /, "or dropped");
assert.match(again, /Learn their taste from it/, "the reading learns from the calls");
assert.ok(again.includes(`"${first.text.slice(0, 160)}" (scored ${first.score} when proposed)`), "a kept pick is shown as kept, with the score it had");
assert.ok(again.includes(`"${second.text.slice(0, 160)}" (scored`), "a dropped one too");
assert.ok(again.includes('"Used anyway" (added by them)'), "and a person's own pick as theirs");
assert.ok(again.indexOf("Dropped:") > again.indexOf("Kept:"));
assert.equal(db.prepare("SELECT pick FROM footage_highlights WHERE id = ?").get(first.id).pick, "keep", "a kept pick survives finding again");
assert.equal(db.prepare("SELECT pick FROM footage_highlights WHERE id = ?").get(second.id).pick, "drop", "so does a dropped one");
console.log("11d ok: finding again keeps a person's calls, tells the model about them, and passes kept and dropped as the taste to learn");

// Stop: a find-again in line is stopped before any delivery reads it. Clips
// read before keep their picks and count as read; a clip never read goes back
// to not asked and doesn't rejoin on a delivery; asking again resumes.
{
  const picksBefore = db.prepare("SELECT COUNT(*) AS n FROM footage_highlights WHERE project_id = ?").get(pid).n;
  r = await call("POST", `/api/projects/${pid}/highlights`, { again: true });
  assert.ok(r.data.pending > 0);
  const fresh = db.prepare("SELECT id FROM project_footage WHERE project_id = ? AND highlights_status = 'waiting' LIMIT 1").get(pid).id;
  db.prepare("DELETE FROM footage_highlights WHERE footage_id = ?").run(fresh);
  db.prepare("UPDATE project_footage SET skip_reason = NULL WHERE id = ?").run(fresh);
  const prompts = world.prompts.length;
  r = await call("POST", `/api/projects/${pid}/highlights/stop`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pending, 0);
  r = await call("GET", `/api/projects/${pid}/highlights`);
  assert.equal(r.data.stopped, true);
  assert.equal(r.data.clips.pending, 0);
  assert.equal(r.data.clips.not_asked, 1, JSON.stringify(r.data.clips));
  assert.equal(r.data.clips.done, logged - 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM footage_highlights WHERE project_id = ?").get(pid).n <= picksBefore, true, "nothing new was found");
  await deliver();
  assert.equal(world.prompts.length, prompts, "stopped: a delivery reads nothing");
  assert.equal(db.prepare("SELECT highlights_status FROM project_footage WHERE id = ?").get(fresh).highlights_status, null, "stopped: the clip doesn't rejoin");
  r = await call("GET", `/api/projects/${pid}/highlights`);
  const waitingNow = r.data.clips.not_asked;
  assert.ok(waitingNow >= 1, "the stopped clip, and any logged since, wait");
  r = await call("POST", `/api/projects/${pid}/highlights`, {});
  assert.equal(r.data.pending, waitingNow, JSON.stringify(r.data));
  r = await call("GET", `/api/projects/${pid}/highlights`);
  assert.equal(r.data.stopped, false);
  const loggedNow = r.data.clips.logged;
  await deliver();
  assert.ok(world.prompts.length > prompts, "asking again resumes");
  r = await call("GET", `/api/projects/${pid}/highlights`);
  assert.equal(r.data.clips.done + r.data.clips.pending, loggedNow, JSON.stringify(r.data.clips));
  assert.equal(r.data.clips.not_asked, 0);
  console.log("11d2 ok: stopping keeps what was found, and later clips wait until asked again");
}

// A busy model puts clips back in line; a refusal fails them with the reason;
// retry puts the failed back in line.
// (B_0001 was deleted from the project in 5: a ready clip is the one to use.)
const target = db.prepare("SELECT name FROM project_footage WHERE project_id = ? AND status = 'ready' AND highlights_status = 'done' ORDER BY name LIMIT 1").get(pid).name;
db.prepare("UPDATE project_footage SET highlights_status = 'waiting' WHERE project_id = ? AND name = ?").run(pid, target);
world.modelRefusal = { status: 429, body: "rate limited" };
d = await deliver();
assert.equal(db.prepare("SELECT highlights_status FROM project_footage WHERE project_id = ? AND name = ?").get(pid, target).highlights_status, "waiting");
assert.ok(d.next_step_at, "another step is booked");
world.modelRefusal = { status: 400, body: "context too long" };
d = await deliver();
const failed = db.prepare("SELECT highlights_status, highlights_error FROM project_footage WHERE project_id = ? AND name = ?").get(pid, target);
assert.equal(failed.highlights_status, "failed");
assert.match(failed.highlights_error, /context too long/);
world.modelRefusal = null;
r = await call("POST", `/api/projects/${pid}/highlights`, {});
const wasFailed = db.prepare("SELECT COUNT(*) AS n FROM project_footage WHERE project_id = ? AND highlights_status = 'waiting'").get(pid).n;
assert.ok(r.data.pending >= 1 && r.data.pending === wasFailed, "retry puts every failed clip of the batch back in line");
d = await deliver();
assert.equal(db.prepare("SELECT highlights_status FROM project_footage WHERE project_id = ? AND name = ?").get(pid, target).highlights_status, "done");
console.log("11e ok: busy model waits, a refusal fails with its reason, retry");

// A clip logged after highlights were asked for joins in by itself.
setDrive([fileEntry(fid("b3"), "B_0003.MP4"), fileEntry(fid("b5"), "B_0005.MP4"), fileEntry(fid("b4"), "B_0004.MP4"), fileEntry(fid("b6"), "B_0006.MP4")]);
await call("POST", `/api/projects/${pid}/footage/sync`);
const b6 = () => db.prepare("SELECT log_status, highlights_status FROM project_footage WHERE project_id = ? AND name = 'B_0006.MP4'").get(pid);
for (let i = 0; i < 10 && b6().log_status !== "done"; i++) f = await statuses();
assert.equal(b6().log_status, "done");
assert.equal(b6().highlights_status, null, "not read until a delivery");
d = await deliver();
assert.equal(db.prepare("SELECT highlights_status FROM project_footage WHERE project_id = ? AND name = 'B_0006.MP4'").get(pid).highlights_status, "done");
console.log("11f ok: a clip logged later is read by itself");

// 10. Deleting the project deletes its footage, a batch at a time.
const stmt = db.prepare("INSERT INTO project_footage (project_id, drive_file_id, name, folder) VALUES (?, ?, ?, 'Bulk')");
for (let i = 0; i < 150; i++) stmt.run(pid, `bulk${i}`, `bulk${i}.mp4`);
world.refuseMediaDeletes = 1;
r = await call("DELETE", `/api/projects/${pid}`);
assert.equal(r.status, 202, JSON.stringify(r.data));
assert.ok(r.data.remaining > 0);
const refusedUid = world.refusedDeletes.at(-1);
const kept = db.prepare("SELECT f.id FROM project_footage f JOIN assets a ON a.id = f.asset_id WHERE a.media_uid = ?").get(refusedUid);
assert.ok(kept, "the clip whose copy the service would not delete is kept for the next call");
r = await call("DELETE", `/api/projects/${pid}`);
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_footage").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edit_projects").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM footage_highlights").get().n, 0, "its highlights went with it");
assert.equal(world.media.get(refusedUid).deleted, true, "the refused copy was deleted on the next call");
const deleted = [...world.media.values()].filter((v) => v.deleted).length;
console.log(`10 ok: project deleted in two calls, ${deleted} media copies deleted, a refused one on the second`);

// 12. With the org's Google Drive connection, clips come in through it, not
// the shared link: on deliveries only (a download through it is slow). A file
// the connection can't hand over comes by the shared link from then on.
env.CREDENTIALS = {
  async listConnected() {
    return ["googledrive"];
  },
  async executeTool(service, action, args) {
    (world.connActions ??= []).push(action);
    if (action === "GOOGLEDRIVE_CREATE_FOLDER") return { successful: true, data: { id: "tmpfolder_________________" } };
    if (action === "GOOGLEDRIVE_COPY_FILE_ADVANCED") {
      assert.deepEqual(args.parents, ["tmpfolder_________________"]);
      return { successful: true, data: { id: `copy${args.fileId.slice(4)}` } };
    }
    if (action === "GOOGLEDRIVE_CREATE_PERMISSION") {
      assert.deepEqual([args.type, args.role], ["anyone", "reader"]);
      return { successful: true, data: {} };
    }
    if (action === "GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION") {
      world.removeTries = (world.removeTries ?? 0) + 1;
      if (world.refuseRemoves > 0) {
        world.refuseRemoves--;
        return { successful: false, error: "User rate limit exceeded" };
      }
      (world.removed ??= []).push(args.fileId);
      return { successful: true, data: {} };
    }
    world.connCalls = (world.connCalls ?? 0) + 1;
    if (args.fileId === "conn_big___________________") return { successful: false, error: "Insufficient disk space to download file" };
    return { successful: true, data: { downloaded_file_content: { s3url: `https://temp.r2.test/${args.fileId}`, name: "x.MP4", mimetype: "video/mp4" } } };
  },
};
env.CLAWNIFY_ORG_ID = "org1";
world.drive[fid("day2")] = page("Day 2", [fileEntry("conn_small_________________", "A_0001.MP4"), fileEntry("conn_big___________________", "Interview.MP4")]);
r = await call("POST", "/api/projects", { folder: `https://drive.google.com/drive/folders/${fid("day2")}` });
assert.equal(r.status, 201, JSON.stringify(r.data));
const p2 = r.data.id;
const reads = async () => (await call("GET", `/api/projects/${p2}/footage?logs=0`)).data;
let f2 = await reads();
assert.equal(f2.counts.importing, 0, "a read starts no download through the connection");
assert.equal(world.connCalls ?? 0, 0);
const deliver2 = async () => {
  const body = JSON.stringify({ project_id: p2 });
  const res = await app.request("https://open-video.apps.clawnify.com/api/footage/step", { method: "POST", headers: { "content-type": "application/json", ...(await signed(body)) }, body }, env, ctx);
  assert.equal(res.status, 200);
};
await deliver2();
f2 = await reads();
const small = f2.items.find((i) => i.name === "A_0001.MP4");
const big = f2.items.find((i) => i.name === "Interview.MP4");
assert.equal(small.status, "importing", JSON.stringify(small));
assert.ok(world.importUrls.includes("https://temp.r2.test/conn_small_________________"), "imported from the connection's link");
// Too big for the connection's download: a copy in the connected account, shared with the link.
assert.equal(big.status, "importing", JSON.stringify(big));
const copyId = "copy_big___________________";
assert.ok(world.importUrls.includes(`https://drive.usercontent.google.com/download?id=${copyId}&export=download&confirm=t`), "imported from the copy's link");
assert.equal(db.prepare("SELECT copy_id FROM project_footage WHERE drive_file_id = 'conn_big___________________'").get().copy_id, copyId);
const callsBefore = world.connCalls;
// The imports finish; the next delivery deletes the copy (Drive refuses the
// first try: the copy stays on the clip and goes on the next one), and the
// connection's download isn't tried again for the file it couldn't take.
world.refuseRemoves = 1;
for (let i = 0; i < 6; i++) await deliver2();
assert.equal(world.connCalls, callsBefore);
assert.deepEqual(world.removed, [copyId], "the copy is deleted once imported");
assert.equal(world.removeTries, 2, "a refused delete keeps the copy on the clip and is tried again");
assert.equal(db.prepare("SELECT copy_id FROM project_footage WHERE drive_file_id = 'conn_big___________________'").get().copy_id, null);
console.log("12 ok: imports through the Drive connection on deliveries; a file too big for it comes from a copy, deleted once imported, after a refused delete too");

// 13. A source over the video host's bitrate cap goes back in line marked for
// re-encoding; the re-encode becomes a media id, and the clip is ready.
world.drive[fid("day3")] = page("Day 3", [fileEntry("conn_high__________________", "HIGH.MP4")]);
r = await call("POST", "/api/projects", { folder: `https://drive.google.com/drive/folders/${fid("day3")}` });
const p3 = r.data.id;
const deliver3 = async () => {
  const body = JSON.stringify({ project_id: p3 });
  const res = await app.request("https://open-video.apps.clawnify.com/api/footage/step", { method: "POST", headers: { "content-type": "application/json", ...(await signed(body)) }, body }, env, ctx);
  assert.equal(res.status, 200);
};
const row3 = () => db.prepare("SELECT status, transcode, transcode_job, asset_id, error FROM project_footage WHERE project_id = ?").get(p3);
const refused = () => [...world.media.values()].filter((v) => v.name === "HIGH.MP4");
for (let i = 0; i < 3 && !world.transcodes; i++) await deliver3();
assert.equal(world.transcodes, 1, "a re-encode was started");
assert.equal(row3().transcode, 1);
assert.ok(refused().every((v) => v.deleted), "the refused copy was deleted");
for (let i = 0; i < 5 && row3().status !== "ready"; i++) await deliver3();
assert.equal(row3().status, "ready", JSON.stringify(row3()));
assert.equal(row3().transcode_job, null);
console.log("13 ok: a clip over the bitrate cap is re-encoded on the way in and imports");
console.log("ALL OK");
