import { describe, expect, it } from "vitest";
import { drawnStroke, maxStrokeWidth, outlineOffsets, outlineShadow } from "../src/shared/outline";

/** Farthest any point of the disc is from its nearest copy, counting the
 *  letters themselves (drawn on top, at no offset). */
function worstGap(r: number): number {
  const offsets: [number, number][] = [[0, 0], ...outlineOffsets(r)];
  let worst = 0;
  for (let y = -r; y <= r; y += r / 40) {
    for (let x = -r; x <= r; x += r / 40) {
      if (x * x + y * y > r * r) continue;
      let near = Infinity;
      for (const [dx, dy] of offsets) near = Math.min(near, Math.hypot(x - dx, y - dy));
      worst = Math.max(worst, near);
    }
  }
  return worst;
}

describe("outlineOffsets", () => {
  it("reaches the full radius in every direction, so the outline is round", () => {
    for (const r of [1.5, 4, 12]) {
      const reach = outlineOffsets(r).map(([x, y]) => Math.hypot(x, y));
      expect(Math.max(...reach)).toBeCloseTo(r, 1);
    }
  });

  it("leaves no point of the disc more than about 2px from a copy, so letters 4px thick leave no holes", () => {
    // Measured: 1.1px at r=2, 2.0px at r=6..18 (136 copies).
    for (const r of [2, 6, 12, 18]) expect(worstGap(r)).toBeLessThan(2.1);
  });

  it("stays cheap for the heaviest outline", () => {
    expect(outlineOffsets(75).length).toBeLessThanOrEqual(400);
  });

  it("draws nothing for no outline", () => {
    expect(outlineOffsets(0)).toEqual([]);
    expect(outlineShadow(0, "#000")).toBeUndefined();
  });
});

describe("drawnStroke", () => {
  it("allows a fifth of the font size, the widest the export draws without holes", () => {
    expect(maxStrokeWidth(60)).toBe(12);
    expect(maxStrokeWidth(8)).toBe(1);
  });

  it("draws an outline the text has outgrown at the most its size allows, and keeps the colour", () => {
    expect(drawnStroke({ color: "#ff0000", width: 10 }, 30)).toEqual({ color: "#ff0000", width: 6 });
    expect(drawnStroke({ color: "#000000", width: 4 }, 60)).toEqual({ color: "#000000", width: 4 });
    expect(drawnStroke(undefined, 60)).toBeUndefined();
  });
});
