import { describe, expect, it } from "vitest";
import { exportKey, makeShareToken, notePage, sharePage } from "../src/server/share";

describe("share links", () => {
  it("mints url-safe tokens with 128 bits of randomness", () => {
    const tokens = new Set(Array.from({ length: 200 }, makeShareToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("reads the storage key back from an export's output_url", () => {
    expect(exportKey("/api/uploads/renders%2Fedit-7-ab12cd34.mp4")).toBe("renders/edit-7-ab12cd34.mp4");
    expect(exportKey("https://elsewhere.example/x.mp4")).toBeNull();
    expect(exportKey(null)).toBeNull();
  });

  it("escapes the project name on the public page", () => {
    const html = sharePage(`"><script>alert(1)</script>`, "/s/abc/video?v=3");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('src="/s/abc/video?v=3"');
    expect(html).toContain('href="/s/abc/video?v=3&amp;download"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(notePage("<b>", "x")).not.toContain("<b>");
  });
});
