import { describe, expect, it, vi } from "vitest";

// Each asset: 10 s long, with one transcript cue half a second in.
vi.mock("../src/server/db", () => ({
  get: vi.fn(async () => ({
    duration: 10,
    transcript: "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nhello\n",
    transcript_lang: "en",
  })),
  run: vi.fn(),
  query: vi.fn(async () => []),
}));

import { DEFAULT_CAPTION_STYLE, captionTimeline } from "../src/shared/captions";
import { parseVtt } from "../src/shared/transcript";
import { cleanSpeed, speedLabel, speedOf } from "../src/shared/speed";
import { expandCaptions } from "../src/server/export";
import { apply } from "../src/server/instruct";
import { validateEdl, type Edl } from "../src/server/edl";

const doc = (): Edl => ({
  version: 1,
  output: { width: 1280, height: 720, fps: 30 },
  main: {
    elements: [
      { id: "a", type: "video", src: "asset:one", trimStart: 5, duration: 20 },
      { id: "b", type: "image", src: "asset:pic", duration: 3 },
    ],
  },
});

describe("speed", () => {
  it("reads a clip's speed, 1 for images and unset clips", () => {
    expect(speedOf({ type: "video", speed: 2 })).toBe(2);
    expect(speedOf({ type: "video" })).toBe(1);
    expect(speedOf({ type: "image", speed: 2 })).toBe(1);
    expect(speedLabel(0.25)).toBe("0.25x");
    expect(cleanSpeed(25)).toBe(10);
    expect(cleanSpeed(1)).toBeUndefined();
  });

  it("is accepted from 0.1x to 10x on a video clip, and nowhere else", () => {
    const ok = doc();
    Object.assign(ok.main.elements[0], { speed: 2 });
    expect(validateEdl(ok)).toHaveProperty("edl");
    const fast = doc();
    Object.assign(fast.main.elements[0], { speed: 20 });
    expect(validateEdl(fast)).toMatchObject({ invalid: { path: "/main/elements/0/speed" } });
    const still = doc();
    Object.assign(still.main.elements[1], { speed: 2 });
    expect(validateEdl(still)).toHaveProperty("invalid");
  });

  it("moves a clip's captions with its speed: source cues land at source time / speed", () => {
    const cues = new Map([["asset:a", parseVtt("WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nwhere people feel safe\n")]]);
    // The source from 4 s to 10 s at 2x: 3 s of video starting at 30 s.
    const lines = captionTimeline([{ src: "asset:a", start: 30, dur: 3, trimStart: 4, speed: 2 }], cues, 40);
    expect(lines).toEqual([{ from: 30.5, to: 32, text: "where people feel safe" }]);
  });

  it("places exported captions after a sped-up clip where the preview does", async () => {
    const edl: Edl = {
      version: 1,
      output: { width: 1280, height: 720, fps: 30 },
      main: {
        elements: [
          // 4 s of footage at 2x lasts 2 s, so the next clip starts at 2 s.
          { id: "a", type: "video", src: "asset:one", duration: 4, speed: 2 },
          { id: "b", type: "video", src: "asset:two", duration: 4 },
        ],
      },
      captions: { enabled: true, lang: "en", style: DEFAULT_CAPTION_STYLE },
    };
    const out = await expandCaptions(edl);
    expect(out.overlays!.at(-1)!.elements.map((el) => el.startTime)).toEqual([0.25, 2.5]);
  });

  it("sets a speed by asking, back to normal at 1, and only on video", () => {
    const d = doc();
    expect(apply(d, "set_speed", { clip: 0, speed: 2 })).toEqual({ said: "Set clip 0 to 2x" });
    expect(d.main.elements[0]).toMatchObject({ speed: 2 });
    expect(apply(d, "set_speed", { clip: 0, speed: 1 })).toEqual({ said: "Set clip 0 back to normal speed" });
    expect(d.main.elements[0]).not.toHaveProperty("speed");
    expect(apply(d, "set_speed", { clip: 1, speed: 2 })).toHaveProperty("error");
  });

  it("splits a sped-up clip at a time as it plays, cutting its source", () => {
    const d = doc();
    Object.assign(d.main.elements[0], { speed: 2 });
    // 20 s of footage at 2x plays 10 s; 4 s in is 8 s into the footage.
    expect(apply(d, "split_clip", { clip: 0, at: 4 })).toHaveProperty("said");
    expect(d.main.elements.slice(0, 2)).toMatchObject([
      { trimStart: 5, duration: 8, speed: 2 },
      { trimStart: 13, duration: 12, speed: 2 },
    ]);
  });
});
