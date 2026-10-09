import { describe, expect, it, vi } from "vitest";

// The export reads asset rows; give it a talking-head clip with a transcript
// and a song, both already staged so nothing is uploaded.
const VTT = "WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nHello there\n\n00:00:09.000 --> 00:00:11.000\nAnd one more thing\n";
const ROWS: Record<string, Record<string, unknown>> = {
  talk: { id: "talk", duration: 20, transcript: VTT, transcript_lang: "en" },
  song: { id: "song", duration: 180, transcript: null, transcript_lang: null },
};
const fresh = new Date(Date.now() + 7 * 864e5).toISOString();
vi.mock("../src/server/db", () => ({
  get: vi.fn(async (sql: string, [id]: [string]) => {
    const row = ROWS[id];
    if (!row) return null;
    if (sql.startsWith("SELECT *")) return { ...row, key: `k/${id}`, name: id, service_key: `stage/${id}`, service_key_expires_at: fresh };
    return row;
  }),
  run: vi.fn(),
  query: vi.fn(),
}));

const { resolveEdlSources } = await import("../src/server/export");

const edl = (talk: Record<string, unknown>, song: Record<string, unknown>) =>
  ({
    version: 1,
    output: { width: 1280, height: 720, fps: 30 },
    // Plays source 1..15, so the cues land at 1..4 and 8..10 on the cut.
    main: { elements: [{ id: "c1", type: "video", src: "asset:talk", trimStart: 1, duration: 14, ...talk }] },
    audio: [{ id: "music", elements: [{ id: "m1", type: "audio", src: "asset:song", startTime: 0, ...song }] }],
  }) as never;

const music = (out: unknown) => (out as { edl: { audio: { elements: Record<string, unknown>[] }[] } }).edl.audio[0].elements[0];

describe("export: ducking", () => {
  it("swaps duck for an envelope that dips under the clip's speech", async () => {
    const m = music(await resolveEdlSources(edl({}, { duck: 12 }), { token: "t" }));
    expect(m.duck).toBeUndefined();
    expect(m.src).toBe("file:stage/song");
    expect(m.envelope).toEqual([
      { time: 0.85, gain: 1 },
      { time: 1, gain: 0.251 },
      { time: 4, gain: 0.251 },
      { time: 4.5, gain: 1 },
      { time: 7.85, gain: 1 },
      { time: 8, gain: 0.251 },
      { time: 10, gain: 0.251 },
      { time: 10.5, gain: 1 },
    ]);
  });

  it("ignores speech the mix does not play, and drops duck with nothing to dip under", async () => {
    const m = music(await resolveEdlSources(edl({ sourceAudio: false }, { duck: 12 }), { token: "t" }));
    expect(m.duck).toBeUndefined();
    expect(m.envelope).toBeUndefined();
  });

  it("leaves a clip without duck alone", async () => {
    const m = music(await resolveEdlSources(edl({}, { volume: 0.4 }), { token: "t" }));
    expect(m).toEqual({ id: "m1", type: "audio", src: "file:stage/song", startTime: 0, volume: 0.4 });
  });
});
