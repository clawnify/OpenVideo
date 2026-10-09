import { describe, expect, it } from "vitest";
import { refusalDetail } from "../src/server/refusal";

describe("refusalDetail", () => {
  it("prefers the service's own words", () => {
    expect(refusalDetail({ error: "quota_exceeded", detail: "This workspace's monthly video allowance is used up" }, "x")).toBe(
      "This workspace's monthly video allowance is used up",
    );
  });

  it("spells out a limit given only as numbers, never a bare status", () => {
    expect(refusalDetail({ error: "quota_exceeded", used: 1003, limit: 1000, resets_at: "2026-11-01T00:00:00.000Z" }, "the analysis service answered 403")).toBe(
      "This workspace's monthly allowance for this is used up (1003 of 1000); it resets on 2026-11-01",
    );
    expect(refusalDetail({ error: "insufficient_credits" }, "x")).toMatch(/out of credits/);
  });

  it("falls back to what the caller knows", () => {
    expect(refusalDetail(null, "edit service returned 500")).toBe("edit service returned 500");
    expect(refusalDetail({ error: "weird" }, "fallback")).toBe("fallback");
  });
});
