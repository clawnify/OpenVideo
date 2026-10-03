import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbandonedExport, renderKeyFor } from "../src/shared/renders";
import { pollEdit, startEdit } from "../src/server/export";

const cfg = { servicesUrl: "https://svc.test", token: "clw_x" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("background exports", () => {
  it("names one storage key per export, the same on every settle", () => {
    const id = "3f2a9c1e-77b0-4d1a-9e2f-0123456789ab";
    expect(renderKeyFor(12, id)).toBe("renders/edit-12-3f2a9c1e.mp4");
    expect(renderKeyFor(12, id)).toBe(renderKeyFor(12, id));
  });

  it("gives up on a row that never reached the service only after it is stale", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(isAbandonedExport("2026-10-03 11:50:00", now)).toBe(false);
    expect(isAbandonedExport("2026-10-03 11:40:00", now)).toBe(true);
    expect(isAbandonedExport("not a time", now)).toBe(false);
  });

  it("submits the render as async and keeps the service's job id", async () => {
    const fetch = reply(202, { job_id: "j1", status: "running", duration: 9 });
    vi.stubGlobal("fetch", fetch);
    expect(await startEdit({} as never, { quality: "draft", filename: "a.mp4" }, cfg)).toEqual({ jobId: "j1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://svc.test/video/edit");
    expect(JSON.parse(init.body as string)).toMatchObject({ async: true, quality: "draft", filename: "a.mp4" });
  });

  it("passes a validation refusal through with its pointer", async () => {
    vi.stubGlobal("fetch", reply(422, { error: "edl_invalid", detail: "bad trim", path: "/main/elements/0" }));
    expect(await startEdit({} as never, { quality: "draft", filename: "a.mp4" }, cfg)).toEqual({
      failure: { error: "edl_invalid", detail: "bad trim", path: "/main/elements/0" },
    });
  });

  it("reads the service's job states", async () => {
    vi.stubGlobal("fetch", reply(200, { status: "done", url: "https://r2/x.mp4", size: 10, duration: 4 }));
    expect(await pollEdit("j1", cfg)).toEqual({ status: "done", result: { url: "https://r2/x.mp4", size: 10, duration: 4 } });
    vi.stubGlobal("fetch", reply(200, { status: "failed", detail: "render failed" }));
    expect(await pollEdit("j1", cfg)).toEqual({ status: "failed", detail: "render failed" });
    vi.stubGlobal("fetch", reply(200, { status: "queued" }));
    expect(await pollEdit("j1", cfg)).toEqual({ status: "running" });
    vi.stubGlobal("fetch", reply(404, { error: "not_found" }));
    expect((await pollEdit("j1", cfg)).status).toBe("failed");
  });

  it("treats an outage as still running, never as a failed export", async () => {
    vi.stubGlobal("fetch", reply(503, "upstream unavailable"));
    expect(await pollEdit("j1", cfg)).toEqual({ status: "running" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await pollEdit("j1", cfg)).toEqual({ status: "running" });
  });
});
