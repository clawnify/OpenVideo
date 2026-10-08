import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HIGHLIGHTS_SCHEMA,
  batchClips,
  findHighlights,
  highlightsPrompt,
  readHighlights,
  snapToCues,
  stamp,
  vetSpeaker,
  type HighlightClip,
} from "../src/server/highlights";
import type { ClipLog } from "../src/server/footage";
import { parseVtt } from "../src/shared/transcript";

afterEach(() => vi.unstubAllGlobals());

const log = (over: Partial<ClipLog> = {}): ClipLog => ({
  summary: "A speaker talks about launching a product.",
  kind: "interview",
  quality: "good",
  issues: "",
  quotes: [],
  moments: [],
  visible_text: [],
  ...over,
});

// Cues as the media service's transcript gives them: short lines with gaps.
const VTT = `WEBVTT

1
00:00:01.200 --> 00:00:03.000
So, um, where do I start.

2
00:00:03.400 --> 00:00:06.100
Shipping fast is the whole point.

3
00:00:06.500 --> 00:00:09.800
That's the whole reason we built it.

4
00:00:10.200 --> 00:00:12.000
Anyway, next question.
`;

const interview: HighlightClip = { id: "c1", name: "A_0012.MP4", folder: "Day 1/Interview", duration: 20, log: log(), transcript: VTT };
const broll: HighlightClip = {
  id: "c2",
  name: "B_0006.MP4",
  folder: "Day 1/Cam B",
  duration: 6.2,
  log: log({ kind: "b-roll", summary: "Two men greet each other.", moments: [{ start: 0, end: 5.5, description: "Two men chatting" }] }),
  transcript: null,
};

describe("stamp", () => {
  it("writes clip positions the way the model reads them", () => {
    expect(stamp(5.25)).toBe("0:05.3");
    expect(stamp(313.8)).toBe("5:13.8");
    expect(stamp(3723.4)).toBe("1:02:03.4");
  });
});

describe("snapToCues", () => {
  it("widens a soundbite to whole transcript lines, with a breath either side", () => {
    // The model's times land inside lines 2 and 3.
    expect(snapToCues(3.9, 8.0, parseVtt(VTT), 20)).toEqual({ start: 3.3, end: 10.1 });
  });

  it("leaves a stretch with no speech in it alone", () => {
    expect(snapToCues(14, 16, [], 20)).toEqual({ start: 14, end: 16 });
  });
});

describe("readHighlights", () => {
  const answer = (clips: unknown[]) => ({ clips });

  it("turns picks into seconds, snaps soundbites to the transcript, and drops what can't be read", () => {
    const out = readHighlights(
      answer([
        {
          clip: 1,
          use: true,
          skip_reason: "",
          highlights: [
            { kind: "soundbite", start: "0:03.9", end: "0:08.0", text: "Shipping fast is the whole point.", speaker: "woman in a green blazer", score: 5, reason: "the thesis in one line" },
            { kind: "soundbite", start: "0:04.0", end: "0:05.0", text: "Overlaps the first.", speaker: "", score: 3, reason: "" },
            { kind: "broll", start: "soon", end: "0:02", text: "Unreadable", speaker: "", score: 3, reason: "" },
            { kind: "drone", start: "0:01", end: "0:02", text: "Unknown kind", speaker: "", score: 3, reason: "" },
          ],
        },
        { clip: 2, use: true, skip_reason: "", highlights: [{ kind: "broll", start: "0:00", end: "0:09", text: "Two men chatting", speaker: "ignored", score: 9, reason: "warm" }] },
        { clip: 7, use: true, skip_reason: "", highlights: [] },
      ]),
      [interview, broll],
    );
    expect(out).toEqual([
      {
        id: "c1",
        skip: null,
        highlights: [{ kind: "soundbite", start: 3.3, end: 10.1, text: "Shipping fast is the whole point.", speaker: "woman in a green blazer", score: 5, reason: "the thesis in one line" }],
      },
      // Clamped to the clip, score held to 1-5, no speaker on b-roll.
      { id: "c2", skip: null, highlights: [{ kind: "broll", start: 0, end: 6.2, text: "Two men chatting", speaker: "", score: 5, reason: "warm" }] },
    ]);
  });

  it("keeps a skipped clip's reason, and calls a clip with nothing left in it skipped", () => {
    const out = readHighlights(
      answer([
        { clip: 1, use: false, skip_reason: "camera pointed at the ceiling", highlights: [] },
        { clip: 2, use: true, skip_reason: "", highlights: [{ kind: "broll", start: "0:01.0", end: "0:01.4", text: "too short", speaker: "", score: 3, reason: "" }] },
      ]),
      [interview, broll],
    );
    expect(out.map((v) => v.skip)).toEqual(["camera pointed at the ceiling", "nothing worth picking"]);
    expect(out.every((v) => v.highlights.length === 0)).toBe(true);
  });

  it("never picks again over what a person already reviewed", () => {
    const reviewed = { ...interview, taken: [{ start: 3.3, end: 10.1, text: "Shipping" }] };
    const out = readHighlights(
      answer([{ clip: 1, use: true, skip_reason: "", highlights: [{ kind: "soundbite", start: "0:03.4", end: "0:06.1", text: "Shipping…", speaker: "", score: 5, reason: "" }] }]),
      [reviewed],
    );
    expect(out[0].highlights).toEqual([]);
  });
});

describe("batchClips", () => {
  it("keeps a folder's neighbours together and puts a long interview on its own", () => {
    const b = (id: string, folder: string, chars = 100): HighlightClip => ({ ...broll, id, folder, transcript: "x".repeat(chars) });
    const batches = batchClips([b("1", "A"), b("2", "A"), b("3", "B"), b("4", "B", 41_000), b("5", "B")], { clips: 12, chars: 40_000 });
    expect(batches.map((x) => x.map((c) => c.id))).toEqual([["1", "2"], ["3"], ["4"], ["5"]]);
    expect(batchClips(Array.from({ length: 5 }, (_, i) => b(String(i), "A")), { clips: 2, chars: 40_000 }).map((x) => x.length)).toEqual([2, 2, 1]);
  });
});

describe("highlightsPrompt", () => {
  it("gives the brief, every clip's log and transcript, and the rules that matter", () => {
    const p = highlightsPrompt("A 60 s sizzle of the booth", [interview, broll]);
    expect(p).toContain("A 60 s sizzle of the booth");
    expect(p).toContain('CLIP 1: "A_0012.MP4" in "Day 1/Interview", 20.0 s');
    expect(p).toContain("[0:03.4-0:06.1] Shipping fast is the whole point.");
    expect(p).toContain("CLIP 2:");
    expect(p).toContain("No speech.");
    expect(p).toMatch(/Flat or log colour[^.]*neither is a reason to skip/);
    expect(p).toMatch(/so no word is cut/);
  });

  it("asks for every field it reads", () => {
    const item = HIGHLIGHTS_SCHEMA.properties.clips.items;
    expect(item.required).toEqual(["clip", "use", "skip_reason", "highlights"]);
    expect(item.properties.highlights.items.required).toEqual(["kind", "start", "end", "text", "speaker", "score", "reason"]);
  });
});

describe("findHighlights", () => {
  it("says what is missing without a key, and asks again later when the model is busy", async () => {
    expect(await findHighlights(undefined, "", [broll])).toMatchObject({ failure: { error: "highlights_unavailable", retry: false } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    expect(await findHighlights("k", "", [broll])).toMatchObject({ failure: { retry: true } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    expect(await findHighlights("k", "", [broll])).toMatchObject({ failure: { retry: false } });
  });

  it("reads a structured answer", async () => {
    const content = JSON.stringify({ clips: [{ clip: 1, use: true, skip_reason: "", highlights: [{ kind: "broll", start: "0:00", end: "0:05", text: "Two men chatting", speaker: "", score: 3, reason: "warm" }] }] });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));
    vi.stubGlobal("fetch", fetch);
    const r = await findHighlights("k", "brief", [broll]);
    expect(r).toEqual({ verdicts: [{ id: "c2", skip: null, highlights: [{ kind: "broll", start: 0, end: 5, text: "Two men chatting", speaker: "", score: 3, reason: "warm" }] }] });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.response_format.json_schema.strict).toBe(true);
  });
});

describe("vetSpeaker", () => {
  // A talk where nobody is named: the logger describes the speaker as seen.
  const talk: HighlightClip = {
    ...interview,
    log: log({
      summary: "A man in a red patterned shirt addresses colleagues, then draws on a whiteboard.",
      quotes: [{ start: 21.9, end: 25.4, text: "We're actually starting to wake up.", speaker: "man in a red patterned shirt" }],
      visible_text: ["JUST SUCCEED"],
    }),
    transcript: "WEBVTT\n\n1\n00:00:21.900 --> 00:00:25.400\nWe're actually starting to wake up.\n",
  };

  it("takes the logger's description of whoever says those words", () => {
    expect(vetSpeaker("Some Famous Founder", 20.6, 25.9, talk)).toBe("man in a red patterned shirt");
  });

  it("never keeps a name the clip doesn't bear out, and keeps one it does", () => {
    // Outside the logged quote: the model's guess has nothing in the clip behind it.
    expect(vetSpeaker("Some Famous Founder", 40, 45, talk)).toBe("man in a red patterned shirt");
    expect(vetSpeaker("presenter at the whiteboard", 40, 45, talk)).toBe("presenter at the whiteboard");
    const named = { ...talk, log: { ...talk.log, visible_text: ["Ada Lovelace, CTO"] } };
    expect(vetSpeaker("Ada Lovelace", 40, 45, named)).toBe("Ada Lovelace");
  });

  it("falls back to nothing rather than a guess when the log names no speaker", () => {
    expect(vetSpeaker("Famous Founder", 1, 2, { ...talk, log: log({ quotes: [] }), transcript: null })).toBe("");
  });
});
