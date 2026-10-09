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

  it("gives a link preview only when the export has a poster frame", () => {
    const url = "https://openvideo.apps.example.com/s/abc/poster.jpg?v=3";
    const html = sharePage("Launch", "/s/abc/video?v=3", url);
    expect(html).toContain(`<meta property="og:image" content="${url}">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta name="twitter:image" content="${url}">`);
    expect(html).toContain(`poster="${url}"`);

    const bare = sharePage("Launch", "/s/abc/video?v=3");
    expect(bare).not.toContain("og:image");
    expect(bare).not.toContain("twitter:card");
    expect(bare).not.toContain("poster=");
  });
});
