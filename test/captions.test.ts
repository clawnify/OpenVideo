import { describe, expect, it } from "vitest";
import { parseVtt, toVtt, transcriptText } from "../src/shared/transcript";
import { wrapLines } from "../src/shared/textLayout";
import { DEFAULT_CAPTION_STYLE, captionChars, captionFontSize, captionText, captionTimeline } from "../src/shared/captions";

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

  it("sits lower with a smaller distance from the edge", () => {
    const at = (margin: number) => captionText({ ...line, text: "we try" }, { ...DEFAULT_CAPTION_STYLE, margin }, { width: 1080, height: 1920 }, "c1").y;
    expect(at(0.03)).toBeGreaterThan(at(0.08));
    expect(at(0.08)).toBeGreaterThan(at(0.2));
  });

  it("sizes by the frame's shorter side, so a vertical video's captions are no larger than a wide one's", () => {
    const vertical = captionText(line, DEFAULT_CAPTION_STYLE, { width: 720, height: 1280 }, "c1");
    expect(vertical.fontSize).toBe(Math.round(0.055 * 720));
  });

  it("outlines a caption only when the style asks, in proportion to its size", () => {
    expect(captionText(line, DEFAULT_CAPTION_STYLE, frame, "c1").stroke).toBeUndefined();
    const outlined = { ...DEFAULT_CAPTION_STYLE, outline: true };
    // 0.055 of 720 is a 40px font: a 3px outline, on a vertical video too.
    expect(captionText(line, outlined, frame, "c1").stroke).toEqual({ color: "#000000", width: 3 });
    expect(captionText(line, outlined, { width: 720, height: 1280 }, "c1").stroke).toEqual({ color: "#000000", width: 3 });
  });
});

describe("captionChars", () => {
  const TALK = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:09.000
as a DJ when you start out and when you are progressing you inevitably collaborate with extraordinarily talented people everywhere

00:00:09.000 --> 00:00:15.000
and internationalisation of the infrastructure is where the opportunity fundamentally is`);

  it("never gives a caption more than two lines, at any size, line length or shape", () => {
    const frames = [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 720, height: 1280 }];
    for (const frame of frames) {
      for (const size of [0.035, 0.045, 0.055, 0.07]) {
        for (const maxChars of [22, 32, 44]) {
          const style = { ...DEFAULT_CAPTION_STYLE, size, maxChars };
          const lines = captionTimeline([{ src: "asset:a", start: 0, dur: 15, trimStart: 0 }], new Map([["asset:a", TALK]]), captionChars(style, frame));
          expect(lines.length).toBeGreaterThan(0);
          for (const l of lines) {
            expect(wrapLines(l.text, captionFontSize(style, frame), frame.width).length, `${JSON.stringify({ frame, size, maxChars })} "${l.text}"`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });

  it("keeps the chosen line length where it fits", () => {
    expect(captionChars({ ...DEFAULT_CAPTION_STYLE, maxChars: 32 }, { width: 1920, height: 1080 })).toBe(32);
  });
});

describe("transcript text", () => {
  const cues = parseVtt(VTT);

  it("writes WebVTT that reads back the same", () => {
    expect(parseVtt(toVtt(cues))).toEqual(cues);
  });

  it("gives one line per cue with the time it is said", () => {
    expect(transcriptText(cues).split("\n")[1]).toBe("[0:05] where people feel comfortable and safe");
    expect(transcriptText([{ start: 3725, end: 3730, text: "late" }])).toBe("[1:02:05] late");
  });
});
