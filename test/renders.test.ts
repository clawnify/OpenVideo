import { describe, expect, it } from "vitest";
import { posterKeyOf, renderKey } from "../src/shared/renders";

describe("renderKey", () => {
  it("recovers the storage key the export route encodes", () => {
    // What the export route writes: `/api/uploads/${encodeURIComponent(key)}`.
    const key = "renders/edit-42-a1b2c3d4.mp4";
    const url = `/api/uploads/${encodeURIComponent(key)}`;
    expect(renderKey(url)).toBe(key);
  });

  it("round-trips any render key through its encoded url", () => {
    for (const key of ["renders/edit-1-00000000.mp4", "renders/edit-999-ffffffff.mp4"]) {
      expect(renderKey(`/api/uploads/${encodeURIComponent(key)}`)).toBe(key);
    }
  });

  it("ignores a job with no output yet", () => {
    expect(renderKey(null)).toBeNull();
    expect(renderKey(undefined)).toBeNull();
    expect(renderKey("")).toBeNull();
  });

  it("refuses anything that is not a render object, so deletion stays scoped", () => {
    // An uploaded asset lives under the same route but a different prefix.
    expect(renderKey("/api/uploads/my-clip.mp4")).toBeNull();
    expect(renderKey(`/api/uploads/${encodeURIComponent("media/abc.mp4")}`)).toBeNull();
    // Not our route at all.
    expect(renderKey("https://evil.example/renders/x.mp4")).toBeNull();
    expect(renderKey("/renders/edit-1-x.mp4")).toBeNull();
  });

  it("returns null on malformed encoding instead of throwing", () => {
    expect(renderKey("/api/uploads/%E0%A4%A")).toBeNull();
  });
});

describe("posterKeyOf", () => {
  it("keeps the poster beside its render, under the same prefix", () => {
    expect(posterKeyOf("renders/edit-42-a1b2c3d4.mp4")).toBe("renders/edit-42-a1b2c3d4.jpg");
  });
});
