import { describe, expect, it } from "vitest";
import { shiftResult, withinWindow, type AnalyzeResult } from "../src/server/export";

const result = (cuts: [number, number, boolean][]): AnalyzeResult => ({
  model: "m",
  notes: "",
  cuts: cuts.map(([start_ms, end_ms, keep]) => ({ start_ms, end_ms, keep, label: "" })),
  captions: [],
});

describe("analysis timing", () => {
  it("moves a window copy's timestamps back into source time", () => {
    // The copy starts at 120s into a long master.
    const shifted = shiftResult(result([[0, 4000, true], [4000, 6000, false]]), 120_000);
    expect(shifted.cuts.map((c) => [c.start_ms, c.end_ms])).toEqual([[120_000, 124_000], [124_000, 126_000]]);
  });

  it("keeps proposals inside the part of the source the clip plays", () => {
    const kept = withinWindow(result([[0, 8000, true], [8000, 30_000, true]]), { start: 5, end: 25 });
    expect(kept.cuts.map((c) => [c.start_ms, c.end_ms])).toEqual([[5000, 8000], [8000, 25_000]]);
  });

  it("drops a proposal that falls entirely outside the window", () => {
    const kept = withinWindow(result([[0, 4000, true], [6000, 9000, true]]), { start: 5, end: 25 });
    expect(kept.cuts).toHaveLength(1);
  });
});
