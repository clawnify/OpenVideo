import { describe, expect, it } from "vitest";
import {
  DUCK_ATTACK,
  DUCK_RELEASE,
  MAX_ENVELOPE_POINTS,
  duckEnvelope,
  duckLevel,
  envelopeGain,
  speechSpans,
  type Span,
} from "../src/shared/duck";

const cue = (start: number, end: number) => ({ start, end, text: "words" });

describe("speechSpans", () => {
  it("cuts each clip's cues to the part it plays and moves them to its place", () => {
    // Clip A plays source 10..20 from 0 s; clip B plays source 0..5 from 10 s.
    const cues = new Map([
      ["asset:a", [cue(8, 12), cue(15, 16), cue(19, 25)]],
      ["asset:b", [cue(1, 2)]],
    ]);
    const spans = speechSpans(
      [
        { src: "asset:a", start: 0, dur: 10, trimStart: 10 },
        { src: "asset:b", start: 10, dur: 5, trimStart: 0 },
      ],
      cues,
    );
    expect(spans).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 6 },
      // 9..10 from A and 11..12 from B are a second apart: not merged.
      { start: 9, end: 10 },
      { start: 11, end: 12 },
    ]);
  });

  it("keeps the music down across a pause shorter than a second", () => {
    const spans = speechSpans([{ src: "s", start: 0, dur: 30, trimStart: 0 }], new Map([["s", [cue(1, 3), cue(3.6, 5), cue(7, 8)]]]));
    expect(spans).toEqual([
      { start: 1, end: 5 },
      { start: 7, end: 8 },
    ]);
  });

  it("is empty for clips without a transcript", () => {
    expect(speechSpans([{ src: "x", start: 0, dur: 10, trimStart: 0 }], new Map())).toEqual([]);
  });
});

describe("duckEnvelope", () => {
  const L = duckLevel(12);

  it("is -12 dB as 0.251", () => {
    expect(L).toBe(0.251);
    expect(duckLevel(6)).toBe(0.501);
  });

  it("dips before speech and comes back up after it, on the clip's clock", () => {
    // Music from 2 s on the cut, heard 20 s; speech 5..8 on the cut.
    const env = duckEnvelope([{ start: 5, end: 8 }], { startTime: 2, heard: 20 }, 12);
    expect(env).toEqual([
      { time: 3 - DUCK_ATTACK, gain: 1 },
      { time: 3, gain: L },
      { time: 6, gain: L },
      { time: 6 + DUCK_RELEASE, gain: 1 },
    ]);
  });

  it("starts low when the clip begins mid-speech, and ends low when it stops mid-speech", () => {
    const env = duckEnvelope([{ start: 0, end: 30 }], { startTime: 4, heard: 10 }, 12);
    // One point is a constant: down for the whole clip.
    expect(env).toHaveLength(1);
    expect(env[0].gain).toBe(L);
    const midRamp = duckEnvelope([{ start: 5, end: 6 }], { startTime: 0, heard: 4.95 }, 12);
    // Cut 0.1 s into the 0.15 s attack: the last value is two thirds of the way down.
    expect(midRamp[midRamp.length - 1].time).toBe(4.95);
    expect(midRamp[midRamp.length - 1].gain).toBeCloseTo(1 - (1 - L) * (0.1 / DUCK_ATTACK), 3);
  });

  it("is empty when no speech falls inside the clip", () => {
    expect(duckEnvelope([{ start: 40, end: 50 }], { startTime: 0, heard: 20 }, 12)).toEqual([]);
    expect(duckEnvelope([], { startTime: 0, heard: 20 }, 12)).toEqual([]);
  });

  it("stays within the edit service's point cap, closing the shortest pauses first", () => {
    const spans: Span[] = Array.from({ length: 120 }, (_, i) => ({ start: i * 3, end: i * 3 + 1.5 + (i === 7 ? 0.5 : 0) }));
    const env = duckEnvelope(spans, { startTime: 0, heard: 400 }, 12);
    expect(env.length).toBeLessThanOrEqual(MAX_ENVELOPE_POINTS);
    // The pause after span 7 is the shortest (1 s), so the music stays down through it.
    expect(envelopeGain(env, 23.5)).toBe(L);
    for (let i = 1; i < env.length; i++) expect(Math.round(env[i].time * 1000)).toBeGreaterThan(Math.round(env[i - 1].time * 1000));
  });
});

describe("envelopeGain", () => {
  const env = [
    { time: 1, gain: 1 },
    { time: 2, gain: 0.25 },
    { time: 4, gain: 0.25 },
    { time: 5, gain: 1 },
  ];
  it("is linear between points and held outside them", () => {
    expect(envelopeGain(env, 0)).toBe(1);
    expect(envelopeGain(env, 1.5)).toBe(0.625);
    expect(envelopeGain(env, 3)).toBe(0.25);
    expect(envelopeGain(env, 4.5)).toBe(0.625);
    expect(envelopeGain(env, 9)).toBe(1);
  });
  it("is 1 with no points", () => {
    expect(envelopeGain([], 3)).toBe(1);
  });
});
