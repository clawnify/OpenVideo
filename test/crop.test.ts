import { describe, expect, it } from "vitest";
import { MIN_CROP, cropRatio, cropToRatio, croppedShape, isFull, moveCrop, placeClip, resizeCrop, tidyCrop } from "../src/shared/crop";

const HD = { width: 1920, height: 1080 };
const FRAME = { width: 1280, height: 720 };
const VERTICAL = { width: 720, height: 1280 };

const close = (got: Record<string, number>, want: Record<string, number>) => {
  for (const k of Object.keys(want)) expect(got[k], k).toBeCloseTo(want[k], 4);
};

describe("placeClip", () => {
  it("without a crop, a contained clip of the frame's shape fills it", () => {
    const { box, source } = placeClip(HD, undefined, FRAME, "contain");
    close(box, { left: 0, top: 0, width: 1, height: 1 });
    close(source, { left: 0, top: 0, width: 1, height: 1 });
  });

  it("crops before fitting, so the kept half is scaled up like footage shot at that size", () => {
    // The right half of a 1920x1080 source is 960x1080; fitted into 1280x720 it is 640x720, centred.
    const { box, source } = placeClip(HD, { x: 0.5, y: 0, width: 0.5, height: 1 }, FRAME, "contain");
    close(box, { left: 0.25, top: 0, width: 0.5, height: 1 });
    // The whole source is twice the box, starting one box-width to its left.
    close(source, { left: -1, top: 0, width: 2, height: 1 });
  });

  it("a filled crop slides by its anchor on the axis that spills over, as the service's crop offset does", () => {
    // 960x1080 filling 1280x720 is 1280x1440: twice the frame's height.
    const top = placeClip(HD, { x: 0.5, y: 0, width: 0.5, height: 1 }, FRAME, "cover", { x: 0.5, y: 0 });
    close(top.box, { left: 0, top: 0, width: 1, height: 2 });
    const bottom = placeClip(HD, { x: 0.5, y: 0, width: 0.5, height: 1 }, FRAME, "cover", { x: 0.5, y: 1 });
    close(bottom.box, { left: 0, top: -1, width: 1, height: 2 });
  });

  it("ignores the anchor on a contained clip", () => {
    const { box } = placeClip(HD, undefined, VERTICAL, "contain", { x: 0, y: 0 });
    expect(box.top).toBeCloseTo((1 - box.height) / 2, 6);
  });

  it("a crop of the frame's own shape, filled, shows exactly the crop", () => {
    const crop = cropToRatio(HD, VERTICAL.width / VERTICAL.height, { x: 0.3, y: 0.5 });
    const { box } = placeClip(HD, crop, VERTICAL, "cover");
    close(box, { left: 0, top: 0, width: 1, height: 1 });
  });
});

describe("cropToRatio", () => {
  it("takes the biggest box of that shape, centred where asked", () => {
    const square = cropToRatio(HD, 1);
    expect(cropRatio(square, HD)).toBeCloseTo(1, 6);
    close(square, { height: 1, width: 1080 / 1920, x: (1 - 1080 / 1920) / 2, y: 0 });
  });

  it("moves only as far as it must to stay inside the source", () => {
    const left = cropToRatio(HD, 9 / 16, { x: 0, y: 0.5 });
    expect(left.x).toBe(0);
    expect(cropRatio(left, HD)).toBeCloseTo(9 / 16, 6);
  });

  it("a wider shape than the source keeps the full width", () => {
    const wide = cropToRatio(HD, 21 / 9);
    expect(wide.width).toBe(1);
    expect(cropRatio(wide, HD)).toBeCloseTo(21 / 9, 6);
  });
});

describe("moveCrop", () => {
  it("stops at the source's edges", () => {
    expect(moveCrop({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, 0.9, -0.9)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });
});

describe("resizeCrop", () => {
  const c = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };

  it("free: a corner moves its two sides and the opposite corner stays", () => {
    const out = resizeCrop(c, "se", 0.1, 0.1, HD);
    close(out, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 });
  });

  it("free: never leaves the source and never shrinks under the floor", () => {
    close(resizeCrop(c, "nw", -1, -1, HD), { x: 0, y: 0, width: 0.7, height: 0.7 });
    const tiny = resizeCrop(c, "e", -1, 0, HD);
    expect(tiny.width).toBeCloseTo(MIN_CROP, 6);
    expect(tiny.x).toBeCloseTo(0.2, 6);
  });

  it("with a ratio, an edge keeps the shape and grows around the middle of the other axis", () => {
    const square = cropToRatio(HD, 1);
    const out = resizeCrop({ ...square, height: 0.5, width: square.width / 2, y: 0.25 }, "e", 0.05, 0, HD, 1);
    expect(cropRatio(out, HD)).toBeCloseTo(1, 4);
    // The vertical centre stays at 0.5.
    expect(out.y + out.height / 2).toBeCloseTo(0.5, 4);
  });

  it("with a ratio, a corner dragged past the edge shrinks to fit instead of breaking the shape", () => {
    const square = { ...cropToRatio(HD, 1), height: 0.6, width: 0.6 * (1080 / 1920), y: 0.2, x: 0.4 };
    const out = resizeCrop(square, "se", 1, 1, HD, 1);
    expect(cropRatio(out, HD)).toBeCloseTo(1, 4);
    expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9);
    expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9);
    // The opposite corner held.
    expect(out.x).toBeCloseTo(0.4, 6);
    expect(out.y).toBeCloseTo(0.2, 6);
  });
});

describe("tidyCrop", () => {
  it("stores nothing for the whole frame", () => {
    expect(tidyCrop({ x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(isFull(undefined)).toBe(true);
  });

  it("rounds and keeps the rectangle inside, so the service never sees x + width > 1", () => {
    const out = tidyCrop({ x: 0.333333, y: 0.1, width: 0.666667, height: 0.5 })!;
    expect(out.x + out.width).toBeLessThanOrEqual(1);
    expect(out.width).toBe(0.6667);
  });
});

describe("croppedShape", () => {
  it("is the source's pixels inside the crop", () => {
    expect(croppedShape(HD, { x: 0, y: 0, width: 0.5, height: 0.5 })).toEqual({ width: 960, height: 540 });
  });
});
