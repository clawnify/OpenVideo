import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_SCHEMA, logPrompt, parseClock, pollLog, readLog, startLog, tooShortLog } from "../src/server/footage";

const cfg = { servicesUrl: "https://svc.test", token: "clw_x" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("parseClock", () => {
  it("reads clock times and plain seconds", () => {
    expect(parseClock("0:42.5")).toBe(42.5);
    expect(parseClock("1:05")).toBe(65);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("12.5")).toBe(12.5);
    expect(parseClock("soon")).toBeNaN();
  });
});

describe("tooShortLog", () => {
  it("is a log like any other, read back as written", () => {
    const log = tooShortLog(0.28);
    expect(log).toMatchObject({ summary: "A 0.3 s clip, too short to use.", quality: "unusable", issues: "too short to use", quotes: [], moments: [] });
    expect(readLog(log, 0.28)).toEqual(log);
  });
});

describe("readLog", () => {
  const answer = {
    summary: "A speaker on a panel talks about launching a product.",
    kind: "stage",
    quality: "good",
    issues: "",
    quotes: [
      { start: "0:12", end: "0:18.4", text: "Shipping fast is the whole point.", speaker: "man in a grey suit" },
      { start: "0:50", end: "0:40", text: "Backwards.", speaker: "" },
      { start: "0:55", end: "2:00", text: "Runs past the end.", speaker: "" },
      { start: "nope", end: "0:20", text: "Unreadable time.", speaker: "" },
    ],
    moments: [{ start: "0:01", end: "0:06", description: "Wide of the stage and the crowd" }],
    visible_text: ["Northwind", "Northwind", ""],
  };

  it("turns the answer into seconds inside the clip, dropping what can't be read", () => {
    expect(readLog(answer, 60)).toEqual({
      summary: "A speaker on a panel talks about launching a product.",
      kind: "stage",
      quality: "good",
      issues: "",
      quotes: [
        { start: 12, end: 18.4, text: "Shipping fast is the whole point.", speaker: "man in a grey suit" },
        { start: 55, end: 60, text: "Runs past the end.", speaker: "" },
      ],
      moments: [{ start: 1, end: 6, description: "Wide of the stage and the crowd" }],
      visible_text: ["Northwind"],
    });
  });

  it("keeps a log whose kind or quality is off the list, and refuses one with no summary", () => {
    expect(readLog({ ...answer, kind: "drone", quality: "great" }, 60)).toMatchObject({ kind: "other", quality: "usable" });
    expect(readLog({ ...answer, summary: "  " }, 60)).toBeNull();
    expect(readLog("not json", 60)).toBeNull();
  });

  it("asks for every field it reads", () => {
    expect(LOG_SCHEMA.required).toEqual(["summary", "kind", "quality", "issues", "quotes", "moments", "visible_text"]);
  });
});

describe("logPrompt", () => {
  it("names the clip and where it sits, and never asks to identify people", () => {
    const prompt = logPrompt({ name: "B_0001.MP4", folder: "Day 1/Cam B" });
    expect(prompt).toContain('"B_0001.MP4" in the folder "Day 1/Cam B"');
    expect(prompt).toMatch(/Never identify a person from their face or voice/);
  });
});

describe("the analysis service", () => {
  it("asks for a log of the media copy and keeps the job id", async () => {
    const fetch = reply(202, { job_id: "j1", status: "running" });
    vi.stubGlobal("fetch", fetch);
    expect(await startLog(cfg, "a".repeat(32), { name: "B_0001.MP4", folder: "Cam B" })).toEqual({ jobId: "j1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://svc.test/video/analyze");
    expect(JSON.parse(init.body as string)).toMatchObject({ source: `media:${"a".repeat(32)}`, schema: LOG_SCHEMA, thinking: "low" });
  });

  it("passes a refusal through with its status, so a limit on the org can be told from a bad clip", async () => {
    vi.stubGlobal("fetch", reply(402, { error: "insufficient_credits", detail: "out of credits" }));
    expect(await startLog(cfg, "a".repeat(32), { name: "x", folder: "" })).toEqual({
      failure: { status: 402, error: "insufficient_credits", detail: "out of credits" },
    });
  });

  it("reads the job's states, and an outage as still running", async () => {
    vi.stubGlobal("fetch", reply(200, { status: "done", result: { summary: "x" } }));
    expect(await pollLog(cfg, "j1")).toEqual({ status: "done", result: { summary: "x" } });
    vi.stubGlobal("fetch", reply(200, { status: "failed", detail: "video analysis is busy right now" }));
    expect(await pollLog(cfg, "j1")).toEqual({ status: "failed", detail: "video analysis is busy right now" });
    vi.stubGlobal("fetch", reply(503, "upstream unavailable"));
    expect(await pollLog(cfg, "j1")).toEqual({ status: "running" });
    vi.stubGlobal("fetch", reply(404, { error: "not_found" }));
    expect((await pollLog(cfg, "j1")).status).toBe("failed");
  });
});
