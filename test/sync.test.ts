import { describe, expect, it } from "vitest";
import { etagMatches, onRemote, sameDoc } from "../src/shared/sync";

const edl = { main: [] };
const saved = { edl, name: "Teaser", brief: "", revision: 4 };

describe("staying in step with the saved project", () => {
  it("compares documents by reference, names and brief by value", () => {
    expect(sameDoc({ edl, name: "Teaser", brief: "" }, saved)).toBe(true);
    expect(sameDoc({ edl: { main: [] }, name: "Teaser", brief: "" }, saved)).toBe(false);
    expect(sameDoc({ edl, name: "Teaser 2", brief: "" }, saved)).toBe(false);
  });

  it("ignores its own revision", () => {
    expect(onRemote({ edl: { main: [1] }, name: "Teaser", brief: "" }, saved, 4)).toBe("ignore");
  });

  it("takes a newer version when nothing is unsaved", () => {
    expect(onRemote({ edl, name: "Teaser", brief: "" }, saved, 5)).toBe("adopt");
  });

  it("asks when a newer version meets unsaved edits", () => {
    expect(onRemote({ edl: { main: [1] }, name: "Teaser", brief: "" }, saved, 5)).toBe("conflict");
    expect(onRemote({ edl, name: "Teaser", brief: "for Instagram" }, saved, 5)).toBe("conflict");
  });

  it("matches If-None-Match weakly, as the edge hands back W/ tags", () => {
    expect(etagMatches('"4"', '"4"')).toBe(true);
    expect(etagMatches('W/"4"', '"4"')).toBe(true);
    expect(etagMatches('"3", W/"4"', '"4"')).toBe(true);
    expect(etagMatches("*", '"4"')).toBe(true);
    expect(etagMatches('"3"', '"4"')).toBe(false);
    expect(etagMatches('"44"', '"4"')).toBe(false);
    expect(etagMatches(undefined, '"4"')).toBe(false);
  });
});
