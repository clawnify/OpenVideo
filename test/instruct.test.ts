import { afterEach, describe, expect, it, vi } from "vitest";
import { addClip, apply, cleanUp, instructEdit, type InstructHighlight, type InstructVideo } from "../src/server/instruct";
import type { Edl } from "../src/server/edl";

const edl = (): Edl => ({
  version: 1,
  output: { width: 1280, height: 720, fps: 30 },
  main: {
    elements: [
      { id: "a", type: "video", src: "asset:one", trimStart: 5, duration: 20 },
      { id: "b", type: "video", src: "asset:two" },
    ],
  },
  overlays: [],
  audio: [],
});

describe("Ask operations", () => {
  it("splits without changing the total length", () => {
    const d = edl();
    expect(apply(d, "split_clip", { clip: 0, at: 8 })).toHaveProperty("said");
    const lengths = d.main.elements.slice(0, 2).map((e) => ("duration" in e ? e.duration : undefined));
    expect(lengths).toEqual([8, 12]);
  });

  it("refuses a clip that does not exist", () => {
    expect(apply(edl(), "delete_clip", { clip: 5 })).toHaveProperty("error");
  });

  it("changes the format the same way the Format picker does", () => {
    const d = edl();
    d.overlays = [
      { id: "t", elements: [{ id: "x", type: "text", text: "Hi", fontSize: 40, startTime: 0, duration: 2, x: 0.5, y: 0.5 }] },
    ];
    expect(apply(d, "set_format", { format: "4:5" })).toHaveProperty("said");
    expect(d.output).toEqual({ width: 1024, height: 1280, fps: 30 });
    expect(d.overlays[0].elements[0]).toMatchObject({ fontSize: 57 });
    expect(apply(d, "set_format", { format: "vertical" })).toHaveProperty("error");
  });

  it("adds another format of the same cut, and keeps the main one off its shape", () => {
    const d = edl();
    expect(apply(d, "add_format", { format: "9:16" })).toHaveProperty("said");
    expect(d.output).toMatchObject({ width: 1280, height: 720 });
    expect(d.formats).toEqual([{ id: "9:16", width: 720, height: 1280 }]);
    expect(apply(d, "add_format", { format: "9:16" })).toHaveProperty("error");
    expect(apply(d, "add_format", { format: "16:9" })).toHaveProperty("error");
    expect(apply(d, "set_format", { format: "9:16" })).toHaveProperty("error");
    expect(d.output).toMatchObject({ width: 1280, height: 720 });
  });

  it("clean up replaces a clip with the parts the analysis keeps", async () => {
    const d = edl();
    const out = await cleanUp(d, { clip: 0 }, new Map(), async (_asset, window) => {
      expect(window).toEqual({ start: 5, end: 25 });
      return { keeps: [{ start: 5, end: 12 }, { start: 16, end: 25 }], notes: "" };
    });
    expect(out).toHaveProperty("said");
    expect(d.main.elements.slice(0, 2).map((e) => [e.trimStart, "duration" in e ? e.duration : null])).toEqual([
      [5, 7],
      [16, 9],
    ]);
  });

  it("clean up keeps a clip's fade-in on its first part and its fade-out on its last", async () => {
    const d = edl();
    Object.assign(d.main.elements[0], { fadeIn: 1, fadeOut: 2 });
    await cleanUp(d, { clip: 0 }, new Map(), async () => ({
      keeps: [{ start: 5, end: 9 }, { start: 11, end: 15 }, { start: 18, end: 25 }],
      notes: "",
    }));
    expect(d.main.elements.slice(0, 3).map((e) => [e.fadeIn, e.fadeOut])).toEqual([
      [1, undefined],
      [undefined, undefined],
      [undefined, 2],
    ]);
  });

  it("fades a clip, a text, and removes a fade at 0", () => {
    const d = edl();
    d.overlays = [
      { id: "t", elements: [{ id: "x", type: "text", text: "Hi", fontSize: 40, startTime: 0, duration: 2, x: 0.5, y: 0.5 }] },
    ];
    expect(apply(d, "fade", { clip: 1, out: 1.5 })).toMatchObject({ said: "Set the fades on clip 1" });
    expect(d.main.elements[1]).toMatchObject({ fadeOut: 1.5 });
    expect(apply(d, "fade", { track: 0, index: 0, in: 0.5, out: 99 })).toHaveProperty("said");
    expect(d.overlays[0].elements[0]).toMatchObject({ fadeIn: 0.5, fadeOut: 30 });
    expect(apply(d, "fade", { clip: 1, out: 0 })).toMatchObject({ said: "Removed the fades on clip 1" });
    expect(d.main.elements[1].fadeOut).toBeUndefined();
    expect(apply(d, "fade", { clip: 7, in: 1 })).toHaveProperty("error");
    expect(apply(d, "fade", { clip: 0 })).toHaveProperty("error");
  });

  it("adjusts the colour of a clip, of every clip, and of an overlay", () => {
    const d = edl();
    d.overlays = [
      {
        id: "o",
        elements: [
          { id: "t", type: "text", text: "Hi", fontSize: 40, startTime: 0, duration: 2, x: 0.5, y: 0.5 },
          { id: "l", type: "image", src: "asset:logo", startTime: 0, duration: 2, x: 0, y: 0, width: 0.2 },
        ],
      },
    ];
    expect(apply(d, "adjust_color", { clip: 0, contrast: 30, saturation: 250 })).toMatchObject({
      said: "Set the colour of clip 0: contrast +30, saturation +100",
    });
    expect(d.main.elements[0].adjust).toEqual({ contrast: 0.3, saturation: 1 });
    // Values left out stay; every clip gets the ones given.
    expect(apply(d, "adjust_color", { every: true, temperature: -20 })).toHaveProperty("said");
    expect(d.main.elements.map((e) => e.adjust)).toEqual([
      { contrast: 0.3, saturation: 1, temperature: -0.2 },
      { temperature: -0.2 },
    ]);
    // Back to 0 is back as shot: the field goes.
    expect(apply(d, "adjust_color", { clip: 1, temperature: 0 })).toMatchObject({ said: "Put the colour of clip 1 back as shot" });
    expect("adjust" in d.main.elements[1]).toBe(false);
    expect(apply(d, "adjust_color", { track: 0, index: 1, brightness: -10 })).toHaveProperty("said");
    expect(d.overlays[0].elements[1]).toMatchObject({ adjust: { brightness: -0.1 } });
    expect(apply(d, "adjust_color", { track: 0, index: 0, brightness: 10 })).toHaveProperty("error");
    expect(apply(d, "adjust_color", { clip: 0 })).toHaveProperty("error");
    expect(apply(d, "adjust_color", { clip: 9, contrast: 10 })).toHaveProperty("error");
  });

  it("joins one cut, or every cut, with a transition, and removes it with none", () => {
    const d = edl();
    d.main.elements.push({ id: "c", type: "image", src: "asset:three", duration: 3 });
    expect(apply(d, "transition", { clip: 1, type: "dissolve" })).toMatchObject({ said: "Joined clip 1 with a 0.5s dissolve" });
    expect(d.main.elements[1].transition).toEqual({ type: "dissolve", duration: 0.5 });
    expect(apply(d, "transition", { every: true, type: "fade-black", seconds: 9 })).toMatchObject({
      said: "Joined every cut with a 5.0s fade through black",
    });
    expect(d.main.elements.map((e) => e.transition?.type)).toEqual([undefined, "fade-black", "fade-black"]);
    expect(apply(d, "transition", { clip: 2, type: "none" })).toMatchObject({ said: "Removed the transition into clip 2" });
    expect(d.main.elements[2].transition).toBeUndefined();
    expect(apply(d, "transition", { clip: 0, type: "dissolve" })).toHaveProperty("error");
    expect(apply(d, "transition", { clip: 1, type: "spin" })).toHaveProperty("error");
    expect(apply(d, "transition", { clip: 7, type: "dissolve" })).toHaveProperty("error");
  });

  it("clean up keeps a clip's transition on its first part, where it comes in", async () => {
    const d = edl();
    d.main.elements[1] = { ...d.main.elements[1], duration: 25, transition: { type: "wipe-left", duration: 1 } };
    await cleanUp(d, { clip: 1 }, new Map(), async () => ({
      keeps: [{ start: 2, end: 9 }, { start: 11, end: 15 }],
      notes: "",
    }));
    expect(d.main.elements.slice(1).map((e) => e.transition?.type)).toEqual(["wipe-left", undefined]);
  });

  it("clean up leaves a clip alone when nothing needs cutting", async () => {
    const d = edl();
    const out = await cleanUp(d, { clip: 0 }, new Map(), async () => ({ keeps: [{ start: 5, end: 25 }], notes: "clean" }));
    expect(out).toMatchObject({ said: expect.stringContaining("nothing to cut") });
    expect(d.main.elements).toHaveLength(2);
  });
});

describe("highlights in Ask", () => {
  afterEach(() => vi.unstubAllGlobals());
  const picks: InstructHighlight[] = [
    { id: "h1", src: "asset:interview", kind: "soundbite", start: 313.3, end: 317.9, text: "Shipping fast is the whole point.", speaker: "woman in a green blazer", score: 5, kept: true },
    { id: "h2", src: "asset:camb", kind: "broll", start: 0, end: 5.5, text: "Crowd at the booth", speaker: "", score: 4, kept: false },
  ];
  const byId = new Map(picks.map((h) => [h.id, h]));

  it("places a highlight as a clip trimmed to it: a soundbite with its sound, b-roll without", () => {
    const d = edl();
    expect(apply(d, "add_highlight", { highlight: "h1", at: 0 }, byId)).toEqual({ said: 'Added the soundbite "Shipping fast is the whole point." at position 0' });
    expect(apply(d, "add_highlight", { highlight: "h2" }, byId)).toHaveProperty("said");
    const [first, , , last] = d.main.elements;
    expect(first).toMatchObject({ type: "video", src: "asset:interview", trimStart: 313.3, duration: 4.6 });
    expect(first).not.toHaveProperty("sourceAudio");
    expect(last).toMatchObject({ src: "asset:camb", trimStart: 0, duration: 5.5, sourceAudio: false });
    expect(apply(d, "add_highlight", { highlight: "h2", sound: true }, byId)).toHaveProperty("said");
    expect(d.main.elements.at(-1)).not.toHaveProperty("sourceAudio");
  });

  it("refuses a highlight it was not given, and a place off the track", () => {
    expect(apply(edl(), "add_highlight", { highlight: "nope" }, byId)).toEqual({ error: 'there is no highlight "nope"' });
    expect(apply(edl(), "add_highlight", { highlight: "h1", at: 9 }, byId)).toHaveProperty("error");
  });

  it("lists the highlights with the cut, and offers add_highlight only when there are some", async () => {
    const bodies: { messages: { content: string }[]; tools: { function: { name: string } }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ choices: [{ message: { content: "Nothing to do." } }] }));
      }),
    );
    await instructEdit(edl(), "make a 30s cut", new Map(), { openrouterKey: "k" }, new Map(), undefined, picks);
    await instructEdit(edl(), "make a 30s cut", new Map(), { openrouterKey: "k" });
    expect(bodies[0].messages[1].content).toContain('h1: soundbite, score 5, kept, 4.6s, woman in a green blazer: "Shipping fast is the whole point."');
    expect(bodies[0].messages[1].content).toContain("h2: broll, score 4, 5.5s, Crowd at the booth");
    expect(bodies[0].tools.map((t) => t.function.name)).toContain("add_highlight");
    expect(bodies[1].tools.map((t) => t.function.name)).not.toContain("add_highlight");
    expect(bodies[1].messages[1].content).not.toContain("Highlights from the footage");
    expect(bodies[0].messages[1].content).not.toContain("best means");
  });

  it("marks the best the project asked for a number of, and says what that means", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ choices: [{ message: { content: "Nothing to do." } }] }));
      }),
    );
    const best = [{ ...picks[1], best: true }, { ...picks[0], kept: false }];
    await instructEdit(edl(), "make a 30s cut", new Map(), { openrouterKey: "k" }, new Map(), undefined, best);
    const said = bodies[0].messages[1].content;
    expect(said).toContain("h2: broll, score 4, best, 5.5s, Crowd at the booth");
    expect(said).toContain('h1: soundbite, score 5, 4.6s, woman in a green blazer: "Shipping fast is the whole point."');
    expect(said).toContain("best means one of the best set the person asked for");
    expect(bodies[0].messages[0].content).toContain("Prefer kept ones, then ones marked best, then higher scores");
  });
});

describe("Ask as a conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the last turns before the request, oldest first", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Done." } }] }));
    }));
    const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `turn ${i}` }));
    await instructEdit(edl(), "shorter", new Map(), { openrouterKey: "k" }, new Map(), undefined, [], history);
    const m = bodies[0].messages;
    expect(m[0].role).toBe("system");
    expect(m.slice(1, -1).map((x) => x.content)).toEqual(history.slice(-12).map((t) => t.text));
    expect(m.at(-1)!.content).toContain("What to change: shorter");
  });

  it("stops at a question and changes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
      { id: "1", function: { name: "ask_user", arguments: JSON.stringify({ question: "Which of the two talks?" }) } },
      { id: "2", function: { name: "delete_clip", arguments: JSON.stringify({ clip: 0 }) } },
    ] } }] }))));
    const out = await instructEdit(edl(), "make clips from the talk", new Map(), { openrouterKey: "k" });
    expect(out).toMatchObject({ said: "Which of the two talks?", asked: true, applied: [] });
    if ("edl" in out) expect(out.edl.main.elements).toHaveLength(2);
  });

  it("keeps a change made before the question", async () => {
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: round++ === 0
      ? { tool_calls: [{ id: "1", function: { name: "delete_clip", arguments: JSON.stringify({ clip: 1 }) } }] }
      : { tool_calls: [{ id: "2", function: { name: "ask_user", arguments: "{}" } }] } }] }))));
    const out = await instructEdit(edl(), "drop the second clip, then ask", new Map(), { openrouterKey: "k" });
    expect(out).toMatchObject({ asked: true, said: "Could you say a little more about what you want?" });
    if ("edl" in out) expect(out.edl.main.elements).toHaveLength(1);
  });
});

describe("Videos added but not in the cut", () => {
  afterEach(() => vi.unstubAllGlobals());
  const vids: InstructVideo[] = [
    { id: "v1", src: "asset:new1", name: "Booth.mp4", seconds: 42, inProject: true },
    { id: "v2", src: "asset:new2", name: "Interview.mp4", seconds: 300, inProject: false },
  ];
  const byId = new Map(vids.map((v) => [v.id, v]));
  const empty = (): Edl => ({ version: 1, output: { width: 1080, height: 1920, fps: 30 }, main: { elements: [] }, overlays: [], audio: [] });

  it("places a whole video, or a window of it, and refuses one outside it", () => {
    const d = empty();
    expect(addClip(d, { video: "v1" }, byId)).toEqual({ said: 'Added "Booth.mp4" at position 0' });
    expect(addClip(d, { video: "v2", start: 10, seconds: 999, at: 0 }, byId)).toHaveProperty("said");
    expect(d.main.elements.map((e) => [e.src, e.trimStart, "duration" in e ? e.duration : undefined])).toEqual([
      ["asset:new2", 10, 290],
      ["asset:new1", undefined, undefined],
    ]);
    expect(addClip(d, { video: "v9" }, byId)).toHaveProperty("error");
    expect(addClip(d, { video: "v1", start: 50 }, byId)).toHaveProperty("error");
  });

  it("lists them, and offers add_clip and assemble only when there are some", async () => {
    const bodies: { messages: { content: string }[]; tools: { function: { name: string } }[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Done." } }] }));
    }));
    const assemble = vi.fn();
    await instructEdit(empty(), "make a reel", new Map(), { openrouterKey: "k" }, new Map(), undefined, [], [], { videos: vids, assemble });
    await instructEdit(empty(), "make a reel", new Map(), { openrouterKey: "k" });
    expect(bodies[0].messages.at(-1)!.content).toContain('v1: "Booth.mp4", 42.0s, in this project');
    expect(bodies[0].messages.at(-1)!.content).toContain('v2: "Interview.mp4", 300.0s');
    expect(bodies[0].tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["add_clip", "assemble"]));
    expect(bodies[1].tools.map((t) => t.function.name)).not.toContain("add_clip");
    expect(bodies[1].tools.map((t) => t.function.name)).not.toContain("assemble");
  });

  it("builds the cut from several videos in one step", async () => {
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: round++ === 0
      ? { tool_calls: [{ id: "a", function: { name: "assemble", arguments: JSON.stringify({ videos: ["v1", "v2", "v1"], brief: "30s reel" }) } }] }
      : { content: "Built a 30 second reel." } }] }))));
    const assemble = vi.fn(async (clips: { id: string; name: string }[]) => ({
      edl: (cur: Edl) => ({ ...cur, main: { elements: clips.map((c, i) => ({ id: `p${i}`, type: "video" as const, src: `asset:${c.id}`, duration: 5 })) } }),
      notes: "best moments",
    }));
    const out = await instructEdit(empty(), "make a 30s reel from my clips", new Map(), { openrouterKey: "k" }, new Map(), undefined, [], [], { videos: vids, assemble });
    expect(assemble).toHaveBeenCalledWith([{ id: "new1", name: "Booth.mp4" }, { id: "new2", name: "Interview.mp4" }], "30s reel");
    expect(out).toMatchObject({ said: "Built a 30 second reel.", applied: ["Built the cut from 2 videos: 2 pieces (best moments)"] });
    if ("edl" in out) expect(out.edl.main.elements.map((e) => e.src)).toEqual(["asset:new1", "asset:new2"]);
  });
});

