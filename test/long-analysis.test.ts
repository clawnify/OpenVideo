import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDB } from "../src/server/db";
import { analyzeAsset, autocutAssets } from "../src/server/export";
import { shiftToSource } from "../src/server/long-analysis";
import { getVideoAnalysis, startVideoAnalysis } from "@clawnify/services";
import { mediaState, prepareMedia } from "../src/server/media";

vi.mock("@clawnify/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clawnify/services")>()),
  startVideoAnalysis: vi.fn(),
  getVideoAnalysis: vi.fn(),
}));
vi.mock("../src/server/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/media")>()),
  mediaState: vi.fn(),
  prepareMedia: vi.fn(),
}));

const cfg = { token: "test" };
const ready = (analysis = "ready") =>
  ({ media: { id: "u", state: "ready", ready: true, analysis, duration: 1506, width: 1920, height: 1080, progress: 100, error: null } }) as never;
let db: DatabaseSync;

/** Run `work` while the analysis polls, moving the clock on until it settles. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const out = work.finally(() => (done = true));
  while (!done) await vi.advanceTimersByTimeAsync(5000);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO assets(id,key,name,content_type,size,duration,media_uid) VALUES ('talk','media/talk','talk.mp4','video/mp4',9e9,1506.16,?)").run("a".repeat(32));
  db.prepare("INSERT INTO assets(id,key,name,content_type,size,duration,media_uid) VALUES ('short','media/short','short.mp4','video/mp4',1e6,40,?)").run("b".repeat(32));
  initDB({
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const s = db.prepare(sql);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { rows: s.all(...(params as never[])) };
        const r = s.run(...(params as never[]));
        return { rows: [], meta: { changes: Number(r.changes) } };
      },
    },
  } as never);
  vi.resetAllMocks();
  vi.mocked(mediaState).mockResolvedValue(ready());
  vi.mocked(startVideoAnalysis).mockResolvedValue({ job_id: "job", status: "running" });
});
afterEach(() => vi.useRealTimers());

describe("reading clips longer than five minutes", () => {
  it("moves an answer counted from the start of the stretch onto the video's clock", () => {
    expect(shiftToSource([0, 4000, 9000], { start: 510, end: 1110 })).toBe(510_000);
    expect(shiftToSource([515_000, 520_000], { start: 510, end: 1110 })).toBe(0);
    // Mixed answers, and stretches starting at the beginning, are left alone.
    expect(shiftToSource([0, 515_000], { start: 510, end: 1110 })).toBe(0);
    expect(shiftToSource([0, 4000], { start: 0, end: 600 })).toBe(0);
  });

  it("cleans up a ten-minute stretch of the talk on the media service", async () => {
    vi.mocked(getVideoAnalysis)
      .mockResolvedValueOnce({ job_id: "job", status: "running" } as never)
      .mockResolvedValueOnce({
        job_id: "job",
        status: "done",
        result: { cuts: [{ start_ms: 2000, end_ms: 9000, label: "answer", keep: true }], captions: [], notes: "tight" },
      } as never);
    const out = await settled(analyzeAsset("talk", { mode: "cuts", window: { start: 510, end: 1110 } }, cfg));
    const call = vi.mocked(startVideoAnalysis).mock.calls[0][1];
    expect(call.window).toEqual({ start: 510, end: 1110 });
    expect(call.source).toBe(`media:${"a".repeat(32)}`);
    expect(out).toMatchObject({ result: { cuts: [{ start_ms: 512_000, end_ms: 519_000, keep: true }], model: "clawnify-video-analysis" } });
  });

  it("collects the same analysis again instead of paying for another", async () => {
    vi.mocked(getVideoAnalysis).mockResolvedValue({
      job_id: "job",
      status: "done",
      result: { cuts: [{ start_ms: 512_000, end_ms: 519_000, label: "answer", keep: true }], captions: [], notes: "" },
    } as never);
    const ask = () => settled(analyzeAsset("talk", { mode: "cuts", window: { start: 510, end: 1110 } }, cfg));
    const first = await ask();
    const again = await ask();
    expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
  });

  it("resumes a job a dropped request left running", async () => {
    // The first request gives up while the job still runs (a phone locks, say).
    vi.mocked(getVideoAnalysis).mockResolvedValue({ job_id: "job", status: "running" } as never);
    const lost = await settled(analyzeAsset("talk", { mode: "cuts", window: { start: 510, end: 1110 } }, cfg));
    expect(lost).toMatchObject({ failure: { detail: expect.stringMatching(/ask again/) } });
    vi.mocked(getVideoAnalysis).mockResolvedValue({
      job_id: "job",
      status: "done",
      result: { cuts: [{ start_ms: 512_000, end_ms: 519_000, label: "answer", keep: true }], captions: [], notes: "" },
    } as never);
    const collected = await settled(analyzeAsset("talk", { mode: "cuts", window: { start: 510, end: 1110 } }, cfg));
    expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
    expect(collected).toMatchObject({ result: { cuts: [{ start_ms: 512_000 }] } });
  });

  it("keeps short clips on the short path", async () => {
    const out = await analyzeAsset("short", { mode: "cuts" }, cfg);
    expect(startVideoAnalysis).not.toHaveBeenCalled();
    // No OpenRouter key here: the short path answers as it always has.
    expect(out).toMatchObject({ failure: { error: "analysis_unavailable" } });
  });

  it("asks for a video to be prepared, and says to come back", async () => {
    vi.mocked(mediaState).mockResolvedValue(ready("none"));
    const out = await analyzeAsset("talk", { mode: "cuts" }, cfg);
    expect(prepareMedia).toHaveBeenCalled();
    expect(startVideoAnalysis).not.toHaveBeenCalled();
    expect(out).toMatchObject({ failure: { error: "analysis_preparing" } });
  });

  it("auto-cuts a long clip and a short one, each read on its own, in their order", async () => {
    vi.mocked(getVideoAnalysis).mockImplementation(async () =>
      ({
        job_id: "job",
        status: "done",
        result: { segments: [{ start_ms: 1000, end_ms: 6000, label: "hook", caption: "" }], notes: "" },
      }) as never,
    );
    const out = await settled(autocutAssets([{ id: "talk", name: "talk" }, { id: "short", name: "short" }], "", cfg));
    expect(startVideoAnalysis).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      result: { sequence: [{ clip_index: 0, start_ms: 1000 }, { clip_index: 1, start_ms: 1000 }] },
    });
    expect("result" in out && out.result.notes).toMatch(/read one at a time/);
  });
});
