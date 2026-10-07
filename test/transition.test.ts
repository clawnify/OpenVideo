import { describe, expect, it } from "vitest";
import { TRANSITION_GROUPS, TRANSITION_TYPES, layOut, transitionLook } from "../src/shared/transition";

const dissolve = (duration: number) => ({ type: "dissolve" as const, duration });

describe("layOut", () => {
  const cut = { before: 0, after: 0 };

  it("lays clips end to end", () => {
    const { placed, total } = layOut([8, 5], [undefined, undefined], 30);
    expect(placed).toEqual([
      { start: 0, dur: 8, ...cut },
      { start: 8, dur: 5, ...cut },
    ]);
    expect(total).toBe(13);
  });

  it("centres a transition on the cut and moves no clip", () => {
    const { placed, total } = layOut([8, 5], [undefined, dissolve(1)], 30);
    expect(placed[1]).toEqual({ start: 8, dur: 5, before: 0.5, after: 0.5 });
    expect(total).toBe(13);
  });

  it("counts in whole output frames, the odd one after the cut, as the service renders", () => {
    // 2.345 s plays 70 frames at 30 fps; a 0.51 s dissolve is 15 frames: 7 + 8
    const { placed, total } = layOut([2.345, 1], [undefined, dissolve(0.51)], 30);
    expect(placed[0].dur).toBeCloseTo(70 / 30, 10);
    expect(placed[1].before).toBeCloseTo(7 / 30, 10);
    expect(placed[1].after).toBeCloseTo(8 / 30, 10);
    expect(total).toBeCloseTo(100 / 30, 10);
  });

  // The next three are the edit service's own cases (compile.test.ts), so the
  // preview's timeline and the export's file cannot disagree.
  it("shortens a transition longer than the clips on either side of its cut", () => {
    const { placed } = layOut([1, 5], [undefined, dissolve(3)], 30);
    expect(placed[1]).toMatchObject({ before: 1, after: 1 });
  });

  it("gives a clip's transition in its room before its transition out", () => {
    const { placed, total } = layOut([8, 1, 10], [undefined, dissolve(1.5), { type: "wipe-left", duration: 1 }], 30);
    expect(placed.map((p) => Math.round((p.before + p.after) * 30))).toEqual([0, 45, 14]);
    expect(total).toBe(19);
  });

  it("cuts hard where a transition has no room left", () => {
    const { placed } = layOut([8, 1, 10], [undefined, dissolve(2), dissolve(0.5)], 30);
    expect(placed.map((p) => p.before + p.after)).toEqual([0, 2, 0]);
  });

  it("gives the first clip no transition, and a clip of unknown length none either", () => {
    expect(layOut([4], [dissolve(1)], 30).placed[0]).toMatchObject(cut);
    const { placed } = layOut([4, 0, 3], [undefined, dissolve(1), dissolve(1)], 30);
    expect(placed.map((p) => p.before + p.after)).toEqual([0, 0, 0]);
  });
});

describe("transitionLook", () => {
  const frame = { width: 1280, height: 720 };

  it("blends a dissolve linearly, sound and picture alike", () => {
    expect(transitionLook("dissolve", 0.25, frame)).toEqual({ from: { opacity: 1 }, to: { opacity: 0.25 }, gains: [0.75, 0.25] });
  });

  it("dips through the colour a fifth of the way in, then brings the next clip up", () => {
    const at = (p: number) => transitionLook("fade-black", p, frame);
    expect(at(0)).toMatchObject({ through: "#000", from: { opacity: 1 }, to: { opacity: 0 } });
    // At a fifth the outgoing clip is gone and the next one barely started.
    expect(at(0.2).from.opacity).toBe(0);
    expect(at(0.2).to.opacity).toBeLessThan(0.04);
    expect(at(1)).toMatchObject({ from: { opacity: 0 }, to: { opacity: 1 } });
    expect(transitionLook("fade-white", 0.5, frame).through).toBe("#fff");
  });

  it("wipes the next clip in from the side the wipe moves away from", () => {
    expect(transitionLook("wipe-left", 0.25, frame).to.clipPath).toBe("inset(0 0 0 75%)");
    expect(transitionLook("wipe-right", 0.25, frame).to.clipPath).toBe("inset(0 75% 0 0)");
    expect(transitionLook("wipe-up", 0.25, frame).to.clipPath).toBe("inset(75% 0 0 0)");
    expect(transitionLook("wipe-down", 0.25, frame).to.clipPath).toBe("inset(0 0 75% 0)");
  });

  it("slides both clips together, a frame apart", () => {
    expect(transitionLook("slide-left", 0.25, frame)).toMatchObject({
      from: { transform: "translateX(-25%)" },
      to: { transform: "translateX(75%)" },
    });
    expect(transitionLook("slide-down", 0.25, frame)).toMatchObject({
      from: { transform: "translateY(25%)" },
      to: { transform: "translateY(-75%)" },
    });
  });

  it("blurs and pixelates hardest at the midpoint, and not at all at the ends", () => {
    expect(transitionLook("blur", 0.5, frame).blurBox).toBe(641);
    expect(transitionLook("blur", 0, frame).blurBox).toBe(1);
    expect(transitionLook("pixelize", 0.5, frame).block).toBe(36);
    expect(transitionLook("pixelize", 1, frame).block).toBe(0);
  });

  it("has a look and a name for every type the document accepts", () => {
    const named = TRANSITION_GROUPS.flatMap((g) => g.items.map((i) => i.type));
    expect([...named].sort()).toEqual([...TRANSITION_TYPES].sort());
    for (const type of TRANSITION_TYPES) expect(transitionLook(type, 0.5, frame).gains).toEqual([0.5, 0.5]);
  });
});
