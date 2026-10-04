import { describe, expect, it } from "vitest";
import { CENTRE, coverOverflow, dragAnchor, presetFor, ratioLabel, ratioOf, reshape, sameShape, sizeFor } from "../src/shared/format";

describe("ratioOf", () => {
  it("names a shape by its reduced ratio, whatever the resolution", () => {
    expect(ratioOf(1920, 1080)).toBe("16:9");
    expect(ratioOf(3840, 2160)).toBe("16:9");
    expect(ratioOf(2150, 2160)).toBe("215:216");
  });
});

describe("sizeFor", () => {
  it("keeps the long side, so a format change keeps the resolution class", () => {
    expect(sizeFor("9:16", 1280)).toEqual({ width: 720, height: 1280 });
    expect(sizeFor("16:9", 1280)).toEqual({ width: 1280, height: 720 });
    expect(sizeFor("1:1", 1280)).toEqual({ width: 1280, height: 1280 });
  });

  it("always gives even sides, which H.264 needs", () => {
    const { width, height } = sizeFor("4:5", 1280)!;
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    const odd = sizeFor("215:216", 1280)!;
    expect(odd.width % 2).toBe(0);
  });

  it("stays within what the render service accepts", () => {
    const tall = sizeFor("9:16", 3840)!;
    expect(tall.height).toBeLessThanOrEqual(2160);
    expect(tall.width).toBeLessThanOrEqual(3840);
  });

  it("rejects something that is not a ratio", () => {
    expect(sizeFor("vertical", 1280)).toBeNull();
  });
});

describe("presetFor", () => {
  it("recognises a preset from the frame's pixels", () => {
    expect(presetFor(720, 1280)?.name).toBe("Vertical");
    expect(presetFor(1000, 700)).toBeUndefined();
  });

  it("still recognises a preset after its sides were rounded to even pixels", () => {
    const { width, height } = sizeFor("16:9", 1080)!;
    expect(ratioOf(width, height)).not.toBe("16:9");
    expect(presetFor(width, height)?.ratio).toBe("16:9");
    expect(sameShape({ width, height }, { width: 1920, height: 1080 })).toBe(true);
  });
});

describe("ratioLabel", () => {
  it("reads as a short ratio when there is one, and as a decimal otherwise", () => {
    expect(ratioLabel(1080, 1920)).toBe("9:16");
    expect(ratioLabel(1918, 1080)).toBe("1.78:1");
    expect(ratioLabel(1080, 1918)).toBe("1:1.78");
  });
});

describe("reshape", () => {
  const edl = {
    output: { width: 1280, height: 720 },
    overlays: [
      {
        elements: [
          { type: "text" as const, text: "Spring Open Day", fontSize: 40, align: "center" as const, x: 0.5, y: 0.8 },
          { type: "image" as const, width: 0.1, x: 0.85, y: 0.05 },
        ],
      },
    ],
  };
  const text = (e: typeof edl) => e.overlays[0].elements[0] as (typeof edl.overlays)[0]["elements"][0];
  const logo = (e: typeof edl) => e.overlays[0].elements[1] as (typeof edl.overlays)[0]["elements"][1];

  it("keeps a title's size between landscape and vertical, where the short side stays 720", () => {
    const vertical = reshape(edl, 720, 1280);
    expect(vertical.output).toEqual({ width: 720, height: 1280 });
    expect(text(vertical)).toMatchObject({ fontSize: 40, x: 0.5, y: 0.8 });
  });

  it("grows a title with the short side, so it fills a square as it filled the landscape frame", () => {
    expect(text(reshape(edl, 1280, 1280)).fontSize).toBe(71);
  });

  it("scales a title's outline with its letters, and adds none to a title without one", () => {
    const outlined = {
      ...edl,
      overlays: [{ elements: [{ ...edl.overlays[0].elements[0], stroke: { color: "#000000", width: 4 } }] }],
    };
    expect(reshape(outlined, 1280, 1280).overlays[0].elements[0]).toMatchObject({ fontSize: 71, stroke: { color: "#000000", width: 7 } });
    expect(reshape(outlined, 720, 1280).overlays[0].elements[0]).toMatchObject({ stroke: { width: 4 } });
    expect("stroke" in text(reshape(edl, 1280, 1280))).toBe(false);
  });

  it("keeps a logo its size on screen, in the corner it was in", () => {
    const vertical = reshape(edl, 720, 1280);
    // 0.1 of 1280 is 128px, which is 128/720 of the narrower frame.
    expect(logo(vertical).width).toBeCloseTo(128 / 720, 3);
    // Its right edge stays 5% from the frame's edge instead of running off it.
    expect(logo(vertical).x + logo(vertical).width).toBeCloseTo(0.95, 2);
    expect(logo(vertical).y).toBe(0.05);
  });

  it("keeps a centred logo centred", () => {
    const centred = { ...edl, overlays: [{ elements: [{ type: "image" as const, width: 0.2, x: 0.4, y: 0.1 }] }] };
    const el = reshape(centred, 720, 1280).overlays[0].elements[0];
    expect(el.x + el.width / 2).toBeCloseTo(0.5, 2);
  });

  it("moves a title dragged towards the edge just enough to stay in the narrower frame", () => {
    const dragged = {
      ...edl,
      overlays: [{ elements: [{ type: "text" as const, text: "Spring Open Day", fontSize: 40, x: 0.6, y: 0.1 }] }],
    };
    const el = reshape(dragged, 720, 1280).overlays[0].elements[0];
    const width = (15 * 40 * 0.52) / 720;
    expect(el.x + width).toBeLessThanOrEqual(1);
    expect(el.x).toBeGreaterThan(0.4);
  });

  it("leaves alone something placed partly outside the frame on purpose", () => {
    const bleeding = { ...edl, overlays: [{ elements: [{ type: "image" as const, width: 0.3, x: 0.9, y: 0.1 }] }] };
    const el = reshape(bleeding, 1280, 1280).overlays[0].elements[0];
    expect(el.x + el.width).toBeGreaterThan(1);
    expect(el.x).toBeLessThanOrEqual(1);
  });
});

describe("reframing a filled clip", () => {
  const landscape = { width: 1920, height: 1080 };
  const vertical = { width: 720, height: 1280 };

  it("knows a landscape clip spills over the sides of a vertical frame, not the top", () => {
    const o = coverOverflow(landscape, vertical);
    // Scaled to 1280 tall it is 2275.6 wide: 1555.6 more than the frame.
    expect(o.x).toBeCloseTo(1555.6 / 720, 2);
    expect(o.y).toBe(0);
  });

  it("dragging right shows more of the left, and stops at the edge", () => {
    const o = coverOverflow(landscape, vertical);
    const moved = dragAnchor(CENTRE, 0.5, 0, o);
    expect(moved.x).toBeLessThan(0.5);
    expect(moved.y).toBe(0.5);
    expect(dragAnchor(CENTRE, 10, 0, o).x).toBe(0);
    expect(dragAnchor(CENTRE, -10, 0, o).x).toBe(1);
  });

  it("an axis with nothing to show does not move", () => {
    const o = coverOverflow(landscape, vertical);
    expect(dragAnchor(CENTRE, 0, 0.3, o)).toEqual(CENTRE);
    expect(dragAnchor(CENTRE, 0.3, 0.3, coverOverflow(landscape, landscape))).toEqual(CENTRE);
  });
});
