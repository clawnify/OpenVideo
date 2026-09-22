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

  it("clean up leaves a clip alone when nothing needs cutting", async () => {
    const d = edl();
    const out = await cleanUp(d, { clip: 0 }, new Map(), async () => ({ keeps: [{ start: 5, end: 25 }], notes: "clean" }));
    expect(out).toMatchObject({ said: expect.stringContaining("nothing to cut") });
    expect(d.main.elements).toHaveLength(2);
  });
});
