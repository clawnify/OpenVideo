import { describe, expect, it } from "vitest";
import { splitClip } from "../src/shared/split";

describe("splitClip", () => {
  it("divides a play window, the form Auto-cut and Ask write", () => {
    const halves = splitClip({ id: "a", trimStart: 5, duration: 20 }, 8, 20, "b");
    expect(halves).toEqual([
      { id: "a", trimStart: 5, duration: 8 },
      { id: "b", trimStart: 13, duration: 12 },
    ]);
  });

  it("keeps the total length when the clip is stored as trims", () => {
    // 30s source trimmed 2s off each end plays 26s; cut at 10s.
    const [first, second] = splitClip({ id: "a", trimStart: 2, trimEnd: 2 }, 10, 26, "b")!;
    expect(first).toEqual({ id: "a", trimStart: 2, duration: 10 });
    expect(second).toEqual({ id: "b", trimStart: 12, duration: 16 });
  });

  it("lets the second half play on to the clip's own tail when the length is unknown", () => {
    const [first, second] = splitClip({ id: "a", trimEnd: 3 }, 4, undefined, "b")!;
    expect(first).toEqual({ id: "a", duration: 4 });
    expect(second).toEqual({ id: "b", trimStart: 4, trimEnd: 3 });
  });

  it("refuses a point outside the clip", () => {
    expect(splitClip({ id: "a", duration: 10 }, 0, 10, "b")).toBeNull();
    expect(splitClip({ id: "a", duration: 10 }, 10, 10, "b")).toBeNull();
    expect(splitClip({ id: "a", duration: 10 }, -1, 10, "b")).toBeNull();
  });
});
