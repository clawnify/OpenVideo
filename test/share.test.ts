import { describe, expect, it } from "vitest";
import { makeShareToken, notePage, sharePage } from "../src/server/share";

describe("share links", () => {
  it("mints url-safe tokens with 128 bits of randomness", () => {
    const tokens = new Set(Array.from({ length: 200 }, makeShareToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
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
