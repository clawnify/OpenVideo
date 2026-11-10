import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceTask,
  clipEdl,
  clipsTask,
  frameTargets,
  frameTask,
  readClipPlans,
  TASK_DEADLINE_MS,
  type ClipDeps,
  type ClipsTask,
  type FramingReply,
} from "../src/server/clips";
import { instructStep, startInstruction, type InstructContext, type InstructVideo } from "../src/server/instruct";
import { validateEdl, type Edl } from "../src/server/edl";
import type { Cue } from "../src/shared/transcript";
import type { Shot } from "../src/shared/reframe";

// A 25-minute talk, one line every five seconds.
const cues: Cue[] = Array.from({ length: 300 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: `line ${i}` }));
const DURATION = 1500;
const plan = (start: string, end: string, hookStart: string, hookEnd: string, title = "A point") => ({
  title,
  start,
  end,
  hook_start: hookStart,
  hook_end: hookEnd,
  why: "stands alone",
});

describe("Picking the moments", () => {
  it("snaps to whole lines, keeps a hook from inside the moment, and drops overlaps and slivers", () => {
    const got = readClipPlans(
      {
        clips: [
          plan("1:41.0", "2:31.0", "2:10.2", "2:14.0", "Cold open"),
          plan("2:00.0", "2:40.0", "2:00.0", "2:04.0", "Overlaps the first"),
          plan("10:00.0", "10:04.0", "10:00.0", "10:02.0", "Too short"),
          plan("20:00.0", "20:45.0", "20:00.0", "20:04.0", "Opens on its hook"),
          plan("5:00.0", "5:50.0", "9:00.0", "9:04.0", "Hook from elsewhere"),
        ],
      },
      cues,
      DURATION,
      8,
      45,
    );
    expect(got.map((p) => p.title)).toEqual(["Cold open", "Hook from elsewhere", "Opens on its hook"]);
    // From the start of a line to the end of one.
    expect(got[0].body).toEqual({ start: 99.9, end: 154.8 });
    expect(got[0].hook).toEqual({ start: 129.9, end: 134.8 });
    // The clip already opens on it, and a hook from another part of the talk is not borrowed.
    expect(got[2].hook).toBeNull();
    expect(got[1].hook).toBeNull();
  });

  it("ends a moment that runs too long on the last line that fits, and makes no more than asked", () => {
    const got = readClipPlans({ clips: [plan("1:00.0", "4:00.0", "1:00", "1:03"), plan("8:00", "8:40", "8:00", "8:03"), plan("12:00", "12:40", "12:00", "12:03")] }, cues, DURATION, 2, 30);
    expect(got).toHaveLength(2);
    expect(got[0].body.end - got[0].body.start).toBeLessThanOrEqual(48.5);
    expect(readClipPlans({ nonsense: true }, cues, DURATION, 3, 30)).toEqual([]);
  });

  it("makes each clip a valid 9:16 project: the hook, then the moment, with captions", () => {
    const [p] = readClipPlans({ clips: [plan("1:41.0", "2:31.0", "2:10.2", "2:14.0")] }, cues, DURATION, 1, 45);
    let n = 0;
    const edl = clipEdl("asset:talk", p, "en", () => `e${n++}`);
    expect("edl" in validateEdl(edl)).toBe(true);
    expect(edl.output).toMatchObject({ width: 1080, height: 1920 });
    expect(edl.main.elements.map((e) => [e.trimStart, "duration" in e ? e.duration : null])).toEqual([
      [129.9, 4.9],
      [99.9, 54.9],
    ]);
    expect(edl.captions).toMatchObject({ enabled: true, lang: "en" });
  });
});

const speaker = (from: number, to: number): Shot => ({
  from,
  to,
  layout: "speaker",
  review: false,
  reason: "one person speaking",
  subjects: [{ label: "guest", region: { x: 0.4, y: 0.1, width: 0.2, height: 0.6 } }],
  top: { x: 0.34, y: 0, width: 0.3164, height: 1 },
});

/** A media service that is slow on purpose: everything waits once before it is ready. */
function fakeDeps(over: Partial<ClipDeps> = {}) {
  const projects = new Map<string, Edl>();
  const analyses = new Map<string, { start: number; end: number; checks: number }>();
  let id = 0;
  let transcriptAsks = 0;
  const deps: ClipDeps = {
    transcript: async () => (transcriptAsks++ === 0 ? { wait: "transcribing" } : { cues, lang: "en" }),
    ask: async () => ({
      json: { clips: [plan("1:41.0", "2:31.0", "2:10.2", "2:14.0", "First"), plan("12:00.0", "12:45.0", "12:00.0", "12:03.0", "Second")] },
    }),
    createProject: vi.fn(async (pid: string, _name: string, edl: Edl) => {
      if (!projects.has(pid)) projects.set(pid, structuredClone(edl));
    }),
    frame: vi.fn(async (_asset: string, start: number, end: number): Promise<FramingReply> => {
      const fid = `f${analyses.size}`;
      analyses.set(fid, { start, end, checks: 0 });
      return { id: fid, status: "running" };
    }),
    check: vi.fn(async (fid: string): Promise<FramingReply> => {
      const a = analyses.get(fid)!;
      return a.checks++ === 0 ? { id: fid, status: "running" } : { id: fid, status: "done", shots: [speaker(a.start, a.end)] };
    }),
    saveFramed: vi.fn(async (pid: string, before: Edl, after: Edl) => {
      if (JSON.stringify(projects.get(pid)) !== JSON.stringify(before)) return false;
      projects.set(pid, after);
      return true;
    }),
    newId: () => `id${id++}`,
    now: () => 0,
    ...over,
  };
  return { deps, projects, analyses };
}

const talk = { src: "asset:talk", name: "talk 1.mp4", seconds: DURATION };
const seconds = new Map([["asset:talk", DURATION]]);
const empty = (): Edl => ({ version: 1, output: { width: 1280, height: 720, fps: 30 }, main: { elements: [] }, overlays: [], audio: [] });

/** Run a task the way deliveries do: state through JSON, waits counted. */
async function runTask(t: ClipsTask, deps: ClipDeps, draft = empty()) {
  let task = t;
  let waits = 0;
  const doing: string[] = [];
  for (let i = 0; i < 50; i++) {
    const out = await advanceTask(JSON.parse(JSON.stringify(task)), deps, draft, seconds);
    if (!("task" in out)) return { out, waits, doing };
    if (out.draft) draft = out.draft;
    task = out.task;
    doing.push(out.doing);
    if (out.wait) waits++;
  }
  throw new Error("never finished");
}

describe("Making clips from a long video", () => {
  it("waits for the transcript, makes a project per moment, then frames each on its speaker", async () => {
    const { deps, projects, analyses } = fakeDeps();
    const { out, waits, doing } = await runTask(clipsTask("c1", talk, 2, 45, "for LinkedIn", 0), deps);
    if (!("said" in out)) throw new Error(JSON.stringify(out));
    expect(out.made.map((m) => m.name)).toEqual(["1. First", "2. Second"]);
    expect(out.said).toContain('Made 2 vertical clips from "talk 1.mp4"');
    expect(out.said).toContain("2 framed on the speaker.");
    expect(waits).toBe(3);
    expect(doing[0]).toBe('Reading the transcript of "talk 1.mp4"');
    expect(doing).toContain("Framing 2 clips for 9:16: 0 of 2 stretches read");
    // The hook sits inside its moment, so each clip is one analysis of its own stretch, not of the talk.
    expect([...analyses.values()].map((a) => [a.start, a.end])).toEqual([
      [99.9, 154.8],
      [719.9, 764.8],
    ]);
    const first = projects.get(out.made[0].id)!;
    expect("edl" in validateEdl(first)).toBe(true);
    expect(first.main.elements.every((e) => e.type === "video" && e.fit === "cover" && e.crop)).toBe(true);
  });

  it("leaves a clip a person edited meanwhile as they left it, and says so", async () => {
    const { deps, projects } = fakeDeps();
    const saveFramed = deps.saveFramed;
    deps.saveFramed = async (pid, before, after) => {
      if (pid === [...projects.keys()][0]) projects.set(pid, { ...projects.get(pid)!, captions: undefined });
      return saveFramed(pid, before, after);
    };
    const { out } = await runTask(clipsTask("c1", talk, 2, 45, "", 0), deps);
    if (!("said" in out)) throw new Error("expected a result");
    expect(out.said).toContain("1 was left as you edited it, unframed");
  });

  it("keeps the whole picture where the analysis never answered, past the deadline", async () => {
    let now = 0;
    const { deps } = fakeDeps({ check: async (fid) => ({ id: fid, status: "running" }), now: () => now });
    const t = clipsTask("c1", talk, 2, 45, "", 0);
    let task = t;
    for (let i = 0; i < 6; i++) {
      const out = await advanceTask(task, deps, empty(), seconds);
      if (!("task" in out)) throw new Error("finished early");
      task = out.task;
    }
    now = TASK_DEADLINE_MS + 1;
    const out = await advanceTask(task, deps, empty(), seconds);
    if (!("said" in out)) throw new Error(JSON.stringify(out));
    expect(out.made).toHaveLength(2);
    expect(out.said).toContain("could not be framed (the framing analysis took too long)");
  });

  it("stops with a reason when the video has no speech or no transcript", async () => {
    const silent = fakeDeps({ transcript: async () => ({ cues: [], lang: "en" }) });
    expect(await advanceTask(clipsTask("c", talk, 3, 45, "", 0), silent.deps, empty(), seconds)).toEqual({ error: '"talk 1.mp4" has no speech to pick moments from', made: [] });
  });

  it("makes each project once, even when a delivery stops after making them", async () => {
    const { deps } = fakeDeps({ transcript: async () => ({ cues, lang: "en" }) });
    let t = clipsTask("c", talk, 2, 45, "", 0);
    for (let i = 0; i < 2; i++) {
      const out = await advanceTask(t, deps, empty(), seconds);
      if (!("task" in out)) throw new Error("expected a task");
      t = out.task;
    }
    // The create step runs twice: once lost with its delivery, once again.
    const saved = JSON.stringify(t);
    await advanceTask(JSON.parse(saved), deps, empty(), seconds);
    await advanceTask(JSON.parse(saved), deps, empty(), seconds);
    const ids = vi.mocked(deps.createProject).mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("Framing this cut", () => {
  it("adds a 9:16 version to a wide cut and frames only that", async () => {
    const wide: Edl = { ...empty(), main: { elements: [{ id: "a", type: "video", src: "asset:talk", trimStart: 60, duration: 30 }] } };
    const targets = frameTargets([{ project: "draft", name: "this cut", edl: wide }], seconds);
    if ("error" in targets) throw new Error(targets.error);
    const { deps } = fakeDeps();
    const { out } = await runTask(frameTask("r1", targets, 0), deps, wide);
    if (!("said" in out) || !out.draft) throw new Error(JSON.stringify(out));
    expect(out.said).toBe("Framed the cut for 9:16.");
    expect(out.draft.output).toMatchObject({ width: 1280, height: 720 });
    expect(out.draft.formats).toEqual([{ id: "9:16", width: 720, height: 1280 }]);
    const el = out.draft.main.elements[0] as { crop?: unknown; framing?: Record<string, { crop?: unknown }> };
    expect(el.crop).toBeUndefined();
    expect(el.framing?.["9:16"]?.crop).toBeTruthy();
    expect("edl" in validateEdl(out.draft)).toBe(true);
  });

  it("refuses a cut with no library video, and more footage than it frames at once", () => {
    expect(frameTargets([{ project: "draft", name: "x", edl: empty() }], seconds)).toEqual({ error: "there is no video from the library in the cut to frame" });
    const long: Edl = { ...empty(), main: { elements: [{ id: "a", type: "video", src: "asset:long" }] } };
    expect(frameTargets([{ project: "draft", name: "x", edl: long }], new Map([["asset:long", 5 * 3600]]))).toHaveProperty("error");
  });
});

describe("Clips in the conversation", () => {
  afterEach(() => vi.unstubAllGlobals());
  const videos: InstructVideo[] = [{ id: "v1", src: "asset:talk", name: "talk 1.mp4", seconds: DURATION, inProject: true }];
  const model = (...messages: unknown[]) => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: messages[Math.min(n++, messages.length - 1)] }] }))));
  };
  const call = { tool_calls: [{ id: "1", function: { name: "make_clips", arguments: JSON.stringify({ video: "v1", count: 2, brief: "for LinkedIn" }) } }] };

  it("never makes clips inside a quick answer: it proposes the background with the talk's length", async () => {
    model(call);
    const { deps } = fakeDeps();
    const ctx: InstructContext = { cfg: { openrouterKey: "k" }, assetNames: new Map(), sourceSeconds: seconds, clips: deps, watchBudget: 180 };
    const out = await instructStep(startInstruction(empty(), "5 clips from the talk", new Map(), [], [], videos), ctx);
    expect(out).toEqual({ done: { background: { clips: 1, seconds: DURATION } } });
  });

  it("in the background, waits between deliveries and ends listing the projects, with this cut unchanged", async () => {
    model(call, { content: "Made two clips." });
    const { deps } = fakeDeps();
    const ctx: InstructContext = { cfg: { openrouterKey: "k" }, assetNames: new Map(), sourceSeconds: seconds, clips: deps };
    let state = startInstruction(empty(), "2 clips from the talk", new Map(), [], [], videos);
    let waits = 0;
    for (let i = 0; i < 40; i++) {
      const out = await instructStep(JSON.parse(JSON.stringify(state)), ctx);
      if ("done" in out) {
        if (!("edl" in out.done)) throw new Error(JSON.stringify(out.done));
        expect(out.done.made?.map((m) => m.name)).toEqual(["1. First", "2. Second"]);
        expect(out.done.edl.main.elements).toEqual([]);
        expect(out.done.applied[0]).toContain("Made 2 vertical clips");
        expect(waits).toBe(3);
        return;
      }
      if (out.wait) waits++;
      state = out.state;
    }
    throw new Error("never finished");
  });
});
