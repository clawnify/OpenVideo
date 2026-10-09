import { describe, expect, it } from "vitest";
import { adjustPixel, adjustSteps, cleanAdjust, describeAdjust } from "../src/shared/adjust";
import { splitClip } from "../src/shared/split";

describe("colour adjustment", () => {
  it("leaves the picture alone at 0", () => {
    expect(cleanAdjust({ brightness: 0, contrast: 0 })).toBeUndefined();
    const steps = adjustSteps({});
    expect(steps.matrix).toBeNull();
    expect(steps.warmth).toBeNull();
    expect(adjustPixel({}, [0.2, 0.5, 0.9])).toEqual([0.2, 0.5, 0.9]);
  });

  it("stores each field in -1..1 to two places", () => {
    expect(cleanAdjust({ contrast: 1.7, saturation: -0.333, temperature: Number.NaN })).toEqual({ contrast: 1, saturation: -0.33 });
    expect(describeAdjust({ contrast: 0.3, temperature: -0.25 })).toBe("contrast +30, temperature -25");
  });

  it("follows the edit service's maths", () => {
    // Greyscale keeps luma (BT.709 weights 0.2126 / 0.7152 / 0.0722).
    const [r, g, b] = adjustPixel({ saturation: -1 }, [1, 0, 0]);
    expect([r, g, b].map((x) => +x.toFixed(4))).toEqual([0.2126, 0.2126, 0.2126]);
    // Contrast pivots on mid grey: k = 2 doubles the distance from 0.5.
    expect(adjustPixel({ contrast: 1 }, [0.5, 0.6, 0.3]).map((x) => +x.toFixed(3))).toEqual([0.5, 0.7, 0.1]);
    // Brightness is a gain, clamped; warm lifts red and lowers blue by up to a fifth.
    expect(adjustPixel({ brightness: 1 }, [0.25, 0.5, 0.75])).toEqual([0.5, 1, 1]);
    expect(adjustPixel({ temperature: 1 }, [0.5, 0.5, 0.5]).map((x) => +x.toFixed(3))).toEqual([0.6, 0.5, 0.4]);
    // Step 1 is one map, clamped once: saturation and contrast together.
    // R: 0.5 * (0.2126 + 0.7874 * 2) + 0.25 = 1.144 -> 1; G, B: 0.5 * -0.2126 + 0.25.
    expect(adjustPixel({ saturation: 1, contrast: -1 }, [1, 0, 0]).map((x) => +x.toFixed(4))).toEqual([1, 0.1437, 0.1437]);
    // Temperature comes after step 1 is clamped: a clipped white turns warm.
    expect(adjustPixel({ brightness: 1, temperature: 0.5 }, [0.8, 0.8, 0.8]).map((x) => +x.toFixed(3))).toEqual([1, 1, 0.9]);
  });

  it("goes with both halves of a split clip", () => {
    const halves = splitClip({ trimStart: 0, duration: 10, adjust: { contrast: 0.2 } }, 4, 10, "b");
    expect(halves?.map((h) => h.adjust)).toEqual([{ contrast: 0.2 }, { contrast: 0.2 }]);
  });
});
