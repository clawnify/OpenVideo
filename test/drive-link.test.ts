import { describe, expect, it } from "vitest";
import {
  directDownloadUrl,
  isVideoEntry,
  judgeLinkResponse,
  listFolderVideos,
  parseDriveLink,
  parseFolderListing,
  parseFolderName,
} from "../src/server/drive-link";

// Trimmed from real embeddedfolderview HTML, ids replaced: a folder entry and
// two kinds of file entry, one with a type icon and one without.
const folderEntry = (id: string, name: string) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/drive/folders/${id}" target="_blank"><div class="flip-entry-visual"><div class="flip-entry-visual-card"><div class="flip-entry-icon"><div aria-label="Folder" class="icon-color-1 drive-sprite-folder-grid-shared-icon"></div></div></div></div><div class="flip-entry-list-icon"><div aria-label="Folder" class="icon-color-1 drive-sprite-folder-list-shared-icon"></div></div><div class="flip-entry-title">${name}</div></a></div><div class="flip-entry-last-modified"><div>Oct 6</div></div></div>`;
const fileEntry = (id: string, name: string, type?: string) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/${id}/view?usp=drive_web" target="_blank"><div class="flip-entry-visual"><div class="flip-entry-thumb"><img src="https://lh3.googleusercontent.com/drive-storage/AJQ=s190" alt="Video"/></div></div>${type ? `<div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${type}" alt=""/></div>` : ""}<div class="flip-entry-title">${name}</div></a></div><div class="flip-entry-last-modified"><div>Oct 6</div></div></div>`;
const page = (title: string, entries: string[]) =>
  `<html><head><title>${title}</title></head><body><div class="flip-entries">${entries.join("")}</div></body></html>`;

const ID = (n: number) => `1${String(n).padStart(4, "0")}abcdefghijklmnopqrstuvwxyz0`;

describe("parseDriveLink", () => {
  it("reads folder, file and download links", () => {
    expect(parseDriveLink("https://drive.google.com/drive/folders/11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th?usp=sharing")).toEqual({
      kind: "folder",
      id: "11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th",
    });
    expect(parseDriveLink("https://drive.google.com/drive/u/0/folders/11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th")).toEqual({
      kind: "folder",
      id: "11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th",
    });
    expect(parseDriveLink("https://drive.google.com/file/d/11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j/view?usp=drive_web")).toEqual({
      kind: "file",
      id: "11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j",
    });
  });

  it("ignores links that aren't Drive", () => {
    expect(parseDriveLink("https://example.com/drive/folders/abcdefghijkl")).toBeNull();
    expect(parseDriveLink("not a url")).toBeNull();
  });
});

describe("directDownloadUrl", () => {
  it("keeps confirm=t, which is what skips the virus-scan page on big files", () => {
    expect(directDownloadUrl("abc123def456")).toBe(
      "https://drive.usercontent.google.com/download?id=abc123def456&export=download&confirm=t",
    );
  });
});

describe("parseFolderListing", () => {
  it("tells folders from files and reads each file's type from its icon", () => {
    const html = page("Day 1", [
      folderEntry(ID(1), "Cam B"),
      fileEntry(ID(2), "20261006_Cam_B_0001.MP4", "video/mp4"),
      fileEntry(ID(3), "Landlord &amp; Co.mov"),
      fileEntry(ID(4), "IMG_0042.JPG", "image/jpeg"),
    ]);
    expect(parseFolderListing(html)).toEqual([
      { id: ID(1), name: "Cam B", folder: true, mimeType: null },
      { id: ID(2), name: "20261006_Cam_B_0001.MP4", folder: false, mimeType: "video/mp4" },
      { id: ID(3), name: "Landlord & Co.mov", folder: false, mimeType: null },
      { id: ID(4), name: "IMG_0042.JPG", folder: false, mimeType: "image/jpeg" },
    ]);
    expect(parseFolderName(html)).toBe("Day 1");
  });

  it("knows a video by its type, or by its name when Drive shows none", () => {
    const [cam, mov, still] = parseFolderListing(
      page("x", [fileEntry(ID(2), "A001.MP4", "video/mp4"), fileEntry(ID(3), "clip.mov"), fileEntry(ID(4), "still.jpg", "image/jpeg")]),
    );
    expect([cam, mov, still].map(isVideoEntry)).toEqual([true, true, false]);
    expect(isVideoEntry({ id: ID(1), name: "Cam.mp4", folder: true, mimeType: null })).toBe(false);
  });

  it("returns nothing for a page that isn't a folder listing", () => {
    expect(parseFolderListing("<html><body>Sorry, you need permission</body></html>")).toEqual([]);
  });
});

describe("listFolderVideos", () => {
  // A shoot as it arrives: a folder per camera, testimonials one folder deeper,
  // and stills the walk leaves alone.
  const drive: Record<string, string> = {
    root: page("Day 1", [
      folderEntry("cam_b_folder", "Cam B"),
      folderEntry("testimonials", "Testimonials"),
      folderEntry("photos_folder", "Photos"),
      fileEntry("root_video_1", "Opening.mp4", "video/mp4"),
    ]),
    cam_b_folder: page("Cam B", [
      fileEntry("cam_b_clip_1", "B_0001.MP4", "video/mp4"),
      fileEntry("cam_b_clip_2", "B_0002.MP4", "video/mp4"),
    ]),
    testimonials: page("Testimonials", [folderEntry("testimonial_1", "Testimonial 1")]),
    testimonial_1: page("Testimonial 1", [
      fileEntry("t1_cam_c_clip", "C_9193.MP4", "video/mp4"),
      fileEntry("t1_cam_d_clip", "D_7423.MP4", "video/mp4"),
    ]),
    photos_folder: page("Photos", [fileEntry("photo_00001", "P_0001.JPG", "image/jpeg")]),
  };
  const listing = async (id: string) => {
    if (!(id in drive)) throw new Error(`no folder ${id}`);
    return drive[id];
  };

  it("takes every video in the folder and every folder inside it, with where each sits", async () => {
    const walk = await listFolderVideos(listing, "root");
    expect(walk.name).toBe("Day 1");
    expect(walk.truncated).toBe(false);
    expect(walk.folders).toBe(5);
    expect(walk.videos).toEqual([
      { id: "root_video_1", name: "Opening.mp4", folder: "" },
      { id: "cam_b_clip_1", name: "B_0001.MP4", folder: "Cam B" },
      { id: "cam_b_clip_2", name: "B_0002.MP4", folder: "Cam B" },
      { id: "t1_cam_c_clip", name: "C_9193.MP4", folder: "Testimonials/Testimonial 1" },
      { id: "t1_cam_d_clip", name: "D_7423.MP4", folder: "Testimonials/Testimonial 1" },
    ]);
  });

  it("stops at its limits and says so", async () => {
    const shallow = await listFolderVideos(listing, "root", { folders: 300, depth: 1, videos: 3000 });
    expect(shallow.truncated).toBe(true);
    expect(shallow.videos.map((v) => v.folder)).not.toContain("Testimonials/Testimonial 1");
    const few = await listFolderVideos(listing, "root", { folders: 300, depth: 8, videos: 2 });
    expect(few.truncated).toBe(true);
    expect(few.videos).toHaveLength(2);
  });
});

describe("judgeLinkResponse", () => {
  it("accepts a ranged video reply and reads the real size from Content-Range", () => {
    expect(judgeLinkResponse(206, "video/mp4", "bytes 0-1/7498432963", "2")).toEqual({
      ok: true,
      contentType: "video/mp4",
      size: 7498432963,
    });
  });

  it("rejects the web page Drive serves when a file is over its download quota or private", () => {
    const out = judgeLinkResponse(200, "text/html; charset=utf-8", null, "2043");
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/downloaded too many times|isn't shared publicly/);
    expect(judgeLinkResponse(403, "text/html", null, null).reason).toMatch(/Anyone with the link/);
  });
});
