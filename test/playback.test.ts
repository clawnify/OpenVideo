import { describe, expect, it } from "vitest";
import { playbackVerdict } from "../src/shared/playback";

describe("playbackVerdict", () => {
  it("tells a clip that plays, one on its way, and one the service gave up on", () => {
    expect(playbackVerdict({ ready: true })).toBe("ready");
    expect(playbackVerdict({ ready: false, state: "inprogress" })).toBe("waiting");
    expect(playbackVerdict({ ready: false })).toBe("waiting");
    expect(playbackVerdict({ ready: false, state: "error" })).toBe("failed");
  });

  it("stops asking about a clip that is gone, and asks again after a hiccup", () => {
    // The clip deleted (404), or its video no longer on the media service.
    expect(playbackVerdict({ status: 404, code: "Not found" })).toBe("failed");
    expect(playbackVerdict({ status: 502, code: "not_found" })).toBe("failed");
    expect(playbackVerdict({ status: 502, code: "media_failed" })).toBe("retry");
    expect(playbackVerdict({ status: 500 })).toBe("retry");
    expect(playbackVerdict({})).toBe("retry");
  });
});
