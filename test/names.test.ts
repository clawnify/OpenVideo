import { describe, expect, it } from "vitest";
import { sharedPrefix } from "../src/shared/names";

describe("sharedPrefix", () => {
  it("drops what a camera folder's names share, up to a separator", () => {
    expect(sharedPrefix(["20261006_Cam_B_0001.MP4", "20261006_Cam_B_0002.MP4", "20261006_Cam_B_0138.MP4"])).toBe("20261006_Cam_B_");
    expect(sharedPrefix(["DJI_20261006101500_0001_D.MP4", "DJI_20261006101912_0002_D.MP4"])).toBe("DJI_");
  });

  it("keeps whole names when they share nothing worth dropping, or there is one", () => {
    expect(sharedPrefix(["Opening.mp4", "Closing.mp4"])).toBe("");
    expect(sharedPrefix(["A001.MP4"])).toBe("");
    expect(sharedPrefix(["Cam.MP4", "Cam.MOV"])).toBe("");
  });
});
