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

import { DEFAULT_CAPTION_STYLE } from "../src/shared/captions";
import { duckLevel, envelopeGain } from "../src/shared/duck";
import { expandSpeech, resolveEdlSources } from "../src/server/export";
import type { Edl } from "../src/server/edl";

const cfg = { servicesUrl: "https://svc.test", token: "clw_x" };

describe("exporting transitions", () => {
  it("places captions where the preview shows them: a transition moves no clip", async () => {
    const edl: Edl = {
      version: 1,
      output: { width: 1280, height: 720, fps: 30 },
      main: {
        elements: [
          { id: "a", type: "video", src: "asset:one", duration: 4 },
          { id: "b", type: "video", src: "asset:two", duration: 4, transition: { type: "dissolve", duration: 1 } },
        ],
      },
      captions: { enabled: true, lang: "en", style: DEFAULT_CAPTION_STYLE },
    };
    const out = await expandSpeech(edl);
    const starts = out.overlays!.at(-1)!.elements.map((el) => el.startTime);
    // b still starts at 4 s, with the dissolve centred on that cut; its cue 0.5 s in
    expect(starts).toEqual([0.5, 4.5]);
  });

  it("dips music under speech where the preview places it: a transition moves no clip", async () => {
    const edl: Edl = {
      version: 1,
      output: { width: 1280, height: 720, fps: 30 },
      main: {
        elements: [
          { id: "a", type: "video", src: "asset:one", duration: 4 },
          { id: "b", type: "video", src: "asset:two", duration: 4, transition: { type: "dissolve", duration: 1 } },
        ],
      },
      audio: [{ id: "m", elements: [{ id: "song", src: "asset:song", startTime: 0, duck: 12 }] }],
    };
    const out = await expandSpeech(edl);
    const points = out.audio![0].elements[0].envelope!;
    // speech at 0.5-1.5 s (a) and 4.5-5.5 s (b, still at 4 s): low there, full between
    expect(envelopeGain(points, 1)).toBeCloseTo(duckLevel(12));
    expect(envelopeGain(points, 5)).toBeCloseTo(duckLevel(12));
    expect(envelopeGain(points, 3)).toBe(1);
  });

  it("leaves a transition off the first clip, where there is nothing to come in from", async () => {
    const edl: Edl = {
      version: 1,
      output: { width: 1280, height: 720, fps: 30 },
      main: {
        elements: [
          { id: "a", type: "video", src: "https://x.test/a.mp4", transition: { type: "wipe-left", duration: 1 } },
          { id: "b", type: "video", src: "https://x.test/b.mp4", transition: { type: "dissolve", duration: 1 } },
        ],
      },
    };
    const res = await resolveEdlSources(edl, cfg);
    if (!("edl" in res)) throw new Error("expected a resolved document");
    expect(res.edl.main.elements.map((el) => el.transition?.type)).toEqual([undefined, "dissolve"]);
  });
});
