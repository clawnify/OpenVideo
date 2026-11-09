import { describe, expect, it } from "vitest";
import { MAX_COMMENT_CHARS, parseComment } from "../src/server/comments";
import { sharePage } from "../src/server/share";

const ok = (raw: unknown, duration: number | null = 30) => {
  const r = parseComment(raw, duration);
  if (!r.ok) throw new Error(r.detail);
  return r.value;
};
const refused = (raw: unknown, duration: number | null = 30) => {
  const r = parseComment(raw, duration);
  if (r.ok) throw new Error("accepted");
  return r.detail;
};

describe("a viewer's comment", () => {
  it("keeps the moment, rounded, and trims the text and name", () => {
    expect(ok({ v: 3, at: 12.3456, body: "  Logo too small here \n", author: "  Ada   Lovelace " })).toEqual({
      v: 3,
      at: 12.35,
      body: "Logo too small here",
      author: "Ada Lovelace",
    });
  });

  it("takes a comment about the whole video", () => {
    expect(ok({ v: 3, at: null, body: "Love it", author: "Ada" }).at).toBeNull();
    expect(ok({ v: 3, body: "Love it", author: "Ada" }).at).toBeNull();
  });

  it("moves a time a hair past the end to the end, and refuses one well past it", () => {
    expect(ok({ v: 1, at: 30.4, body: "x", author: "A" }).at).toBe(30);
    expect(refused({ v: 1, at: 45, body: "x", author: "A" })).toMatch(/past the end/);
    // Unknown length: any time is taken as sent.
    expect(ok({ v: 1, at: 45, body: "x", author: "A" }, null).at).toBe(45);
  });

  it("refuses what no reviewer sends", () => {
    expect(refused(null)).toMatch(/JSON/);
    expect(refused({ at: 1, body: "x", author: "A" })).toMatch(/^v:/);
    expect(refused({ v: 1, body: "   ", author: "A" })).toMatch(/Write a comment/);
    expect(refused({ v: 1, body: "x", author: "" })).toMatch(/your name/);
    expect(refused({ v: 1, body: "x".repeat(MAX_COMMENT_CHARS + 1), author: "A" })).toMatch(/up to/);
    expect(refused({ v: 1, at: -1, body: "x", author: "A" })).toMatch(/^at:/);
    expect(refused({ v: 1, at: "12", body: "x", author: "A" })).toMatch(/^at:/);
  });

  it("drops control characters but keeps line breaks", () => {
    expect(ok({ v: 1, body: "one\u0000\u001b[31m\ntwo", author: "A\u0007" })).toMatchObject({ body: "one[31m\ntwo", author: "A" });
  });
});

describe("the share page with comments", () => {
  const review = {
    comments: [
      { id: "a", at: 4, body: `</script><script>alert(1)</script>`, author: "<b>Eve</b>", resolved: false, created_at: "2026-10-10 09:00:00" },
    ],
    post: "/s/abc/comments",
    v: 7,
  };

  it("embeds comments as data no text can break out of", () => {
    const html = sharePage("Cut", "/s/abc/video?v=7", review);
    const data = /<script type="application\/json" id="review">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(data).not.toContain("<");
    expect(JSON.parse(data)).toEqual(review);
    expect(html).not.toContain("<b>Eve");
    expect(html).toContain('id="comment-form"');
  });

  it("shows no comments or form while they are off", () => {
    const html = sharePage("Cut", "/s/abc/video?v=7");
    expect(html).not.toContain("comment-form");
    expect(html).not.toContain("<script");
  });
});
