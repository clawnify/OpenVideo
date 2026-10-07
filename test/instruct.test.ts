import { describe, expect, it } from "vitest";
import { apply, cleanUp } from "../src/server/instruct";
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
