import { describe, expect, it } from "vitest";
import { parseVtt } from "../src/shared/transcript";
import { DEFAULT_CAPTION_STYLE, captionText, captionTimeline } from "../src/shared/captions";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
we try to support an environment

00:00:05.000 --> 00:00:08.000
where people feel comfortable and safe

00:00:20.000 --> 00:00:23.000
and that is the whole idea`;

describe("captionTimeline", () => {
  const cues = new Map([["asset:a", parseVtt(VTT)]]);

  it("places a clip's captions at the clip's position on the finished video", () => {
    // The clip plays the source from 4s to 10s, starting 30s into the video.
    const lines = captionTimeline([{ src: "asset:a", start: 30, dur: 6, trimStart: 4 }], cues, 40);
    expect(lines[0].from).toBeGreaterThanOrEqual(30);
    expect(lines.every((l) => l.to <= 36)).toBe(true);
    expect(lines.map((l) => l.text).join(" ")).toContain("where people feel comfortable");
  });

  it("drops captions for speech the clip has trimmed away", () => {
    const lines = captionTimeline([{ src: "asset:a", start: 0, dur: 10, trimStart: 0 }], cues, 40);
    expect(lines.map((l) => l.text).join(" ")).not.toContain("whole idea");
  });

  it("follows a reorder: the same speech moves with its clip", () => {
    const first = captionTimeline([{ src: "asset:a", start: 0, dur: 5, trimStart: 0 }], cues, 40)[0];
    const moved = captionTimeline([{ src: "asset:a", start: 12, dur: 5, trimStart: 0 }], cues, 40)[0];
    expect(moved.from - first.from).toBeCloseTo(12, 3);
    expect(moved.text).toBe(first.text);
  });

  it("gives clips without a transcript no captions", () => {
    expect(captionTimeline([{ src: "asset:b", start: 0, dur: 5, trimStart: 0 }], cues, 40)).toEqual([]);
  });
});

describe("captionText", () => {
  const frame = { width: 1280, height: 720 };
  const line = { from: 1, to: 3, text: "we try to support an environment where people feel comfortable" };

  it("keeps a bottom caption inside the frame however it wraps", () => {
    const el = captionText(line, DEFAULT_CAPTION_STYLE, frame, "c1");
    expect(el.y).toBeGreaterThan(0.5);
    expect(el.y).toBeLessThan(1);
    expect(el.fontSize).toBe(Math.round(0.055 * 720));
  });

  it("puts a top caption at the top", () => {
    expect(captionText(line, { ...DEFAULT_CAPTION_STYLE, position: "top" }, frame, "c1").y).toBeCloseTo(0.08, 3);
  });

  it("scales with the frame, so a vertical video gets captions its own size", () => {
    const vertical = captionText(line, DEFAULT_CAPTION_STYLE, { width: 720, height: 1280 }, "c1");
    expect(vertical.fontSize).toBe(Math.round(0.055 * 1280));
  });
});
