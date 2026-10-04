import { describe, expect, it } from "vitest";
import { fadeGain, heardFor } from "../src/shared/fade";

describe("heardFor", () => {
  it("is the clip's length when it ends inside the cut", () => {
    expect(heardFor(2, 6, 13)).toBe(6);
  });
  it("stops at the end of the cut when the clip runs past it", () => {
    // A 60 s song from 5 s under a 13 s cut is heard for 8 s.
    expect(heardFor(5, 60, 13)).toBe(8);
  });
  it("is zero for a clip after the end", () => {
    expect(heardFor(20, 5, 13)).toBe(0);
  });
});

describe("fadeGain", () => {
  it("ramps in from silence and out to silence", () => {
    const f = { fadeIn: 2, fadeOut: 2 };
    expect(fadeGain(f, 10, 0)).toBe(0);
    expect(fadeGain(f, 10, 1)).toBe(0.5);
    expect(fadeGain(f, 10, 5)).toBe(1);
    expect(fadeGain(f, 10, 9)).toBe(0.5);
    expect(fadeGain(f, 10, 10)).toBe(0);
  });
  it("is full gain with no fades", () => {
    expect(fadeGain({}, 10, 0)).toBe(1);
    expect(fadeGain({ fadeIn: 0, fadeOut: 0 }, 10, 10)).toBe(1);
  });
  it("shortens a fade longer than the clip is heard, as the export does", () => {
    // fadeIn 5 on 2 s heard becomes a 2 s fade.
    expect(fadeGain({ fadeIn: 5 }, 2, 1)).toBe(0.5);
  });
  it("multiplies an in and an out that overlap", () => {
    expect(fadeGain({ fadeIn: 2, fadeOut: 2 }, 2, 1)).toBe(0.25);
  });
});
