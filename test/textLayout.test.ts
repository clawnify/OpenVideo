import { describe, expect, it } from "vitest";
import { blockHeight, fitTop, wrapLines } from "../src/shared/textLayout";

const LONG =
  "we try to support an environment where people feel comfortable and safe, but also challenged to grow in their role";

describe("wrapLines", () => {
  it("keeps a short title on one line", () => {
    expect(wrapLines("Spring Open Day", 40, 1280)).toEqual(["Spring Open Day"]);
  });

  it("breaks a long caption into lines of even length, with no orphan", () => {
    const lines = wrapLines(LONG, 40, 1280);
    expect(lines).toHaveLength(3);
    const lengths = lines.map((l) => l.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(8);
  });

  it("keeps every word, in order", () => {
    expect(wrapLines(LONG, 40, 1280).join(" ")).toBe(LONG);
  });

  it("keeps explicit line breaks", () => {
    expect(wrapLines("first\nsecond", 40, 1280)).toEqual(["first", "second"]);
  });

  it("uses more lines on a narrow vertical frame", () => {
    expect(wrapLines(LONG, 40, 720).length).toBeGreaterThan(wrapLines(LONG, 40, 1280).length);
  });
});

describe("fitTop", () => {
  it("leaves a block that already fits where it is", () => {
    expect(fitTop(0.1, 50, 720)).toBe(0.1);
  });

  it("lifts a low block so its last line stays in frame", () => {
    const h = blockHeight(LONG, 40, 1280, "sans", true);
    const top = fitTop(0.82, h, 720);
    expect(top).toBeLessThan(0.82);
    expect(top * 720 + h).toBeLessThanOrEqual(720);
  });
});
