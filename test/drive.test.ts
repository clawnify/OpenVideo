import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_FILE_BYTES,
  SHARED_WITH_ME,
  driveActionLink,
  driveFileLink,
  driveFilePiece,
  driveFolderName,
  driveRemove,
  listDriveFiles,
  withinFolder,
} from "../src/server/drive";

/**
 * OpenVideo reaches Drive through the org's connection with Google's own Drive
 * API, signed by the broker, rather than the broker's action catalogue, so the
 * code is the same whoever holds the credential. These check what each call
 * asks Drive for and how it reads the answer, through the real SDK.
 */

const ORG = "org-1";
type Req = { method: string; endpoint: string; parameters?: { name: string; value: string; in: string }[] };
type Answer = { data: unknown; error: string | null; successful: boolean; status?: number; headers?: Record<string, string>; file?: unknown };

function connection(service: "googledrive" | "googlesuper", answer: (req: Req) => Answer) {
  const sent: Req[] = [];
  const actions: unknown[][] = [];
  const env = {
    CLAWNIFY_ORG_ID: ORG,
    CREDENTIALS: {
      getToken: async () => null,
      listConnected: async () => [service],
      searchActions: async () => [],
      executeTool: async (_s: string, action: string, args: unknown) => {
        actions.push([action, args]);
        return {
          data: { downloaded_file_content: { s3url: "https://temp.test/whole", name: "big.mp4", mimetype: "video/mp4" } },
          error: null,
          successful: true,
        };
      },
      proxyRequest: async (_s: string, _o: string, req: Req) => {
        sent.push(req);
        return answer(req);
      },
    },
  };
  return { env, sent, actions };
}

const param = (req: Req, name: string) => req.parameters?.find((p) => p.name === name)?.value;
const ok = (data: unknown): Answer => ({ data, error: null, successful: true, status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("browsing", () => {
  it("lists a folder's children with the Drive API, folders first, across shared drives", async () => {
    const c = connection("googledrive", () =>
      ok({
        files: [
          { id: "f1", name: "Day 1", mimeType: "application/vnd.google-apps.folder" },
          { id: "v1", name: "A.mp4", mimeType: "video/mp4", size: "1000", videoMediaMetadata: { durationMillis: "2500" } },
        ],
        nextPageToken: "p2",
      }),
    );
    const page = await listDriveFiles(c.env, { kind: "media" });
    const req = c.sent[0];
    expect([req.method, req.endpoint]).toEqual(["GET", "/files"]);
    expect(param(req, "q")).toContain("'root' in parents");
    expect(param(req, "q")).toContain("trashed = false");
    expect([param(req, "pageSize"), param(req, "supportsAllDrives"), param(req, "includeItemsFromAllDrives")]).toEqual(["50", "true", "true"]);
    expect(page.folders).toEqual([{ id: SHARED_WITH_ME, name: "Shared with me" }, { id: "f1", name: "Day 1" }]);
    expect(page.files[0]).toMatchObject({ id: "v1", size: 1000, duration: 2.5 });
    expect(page.nextPageToken).toBe("p2");
  });

  it("under a Google Super connection, the same call carries the Drive API's own path", async () => {
    const c = connection("googlesuper", () => ok({ files: [] }));
    await listDriveFiles(c.env, { kind: "audio", folderId: "folder_id_12345" });
    expect(c.sent[0].endpoint).toBe("/drive/v3/files");
    expect(param(c.sent[0], "q")).toContain("'folder_id_12345' in parents");
  });

  it("finds shared-with-me items by the query, not by a folder", async () => {
    const c = connection("googledrive", () => ok({ files: [] }));
    await listDriveFiles(c.env, { kind: "media", folderId: SHARED_WITH_ME });
    expect(param(c.sent[0], "q")).toContain("sharedWithMe = true");
    expect(param(c.sent[0], "q")).not.toContain("in parents");
  });

  it("refuses a folder id that could end the query early", async () => {
    const c = connection("googledrive", () => ok({ files: [] }));
    await expect(listDriveFiles(c.env, { kind: "media", folderId: "x' or name contains '" })).rejects.toThrow("not a Drive folder id");
    expect(c.sent).toEqual([]);
  });

  it("an item Drive won't show is no name, not an error, and the folder limit walks parents", async () => {
    const parents: Record<string, string[]> = { clip_id_0000: ["mid_id_00000"], mid_id_00000: ["limit_id_000"] };
    const c = connection("googledrive", (req) => {
      const id = req.endpoint.split("/").pop()!;
      if (id === "gone_id_0000") return { data: { error: { code: 404 } }, error: "googledrive 404: File not found", successful: false, status: 404 };
      return ok({ name: id, parents: parents[id] ?? [] });
    });
    expect(await driveFolderName(c.env, "gone_id_0000")).toBeNull();
    expect(await withinFolder(c.env, "clip_id_0000", "limit_id_000")).toBe(true);
    expect(await withinFolder(c.env, "mid_id_00000", "other_id_000")).toBe(false);
    expect(param(c.sent[0], "fields")).toBe("name,parents");
  });
});

describe("downloading", () => {
  it("a file of up to 250 MB comes back as a link from one answer", async () => {
    const c = connection("googledrive", (req) =>
      param(req, "alt") === "media"
        ? { data: null, error: null, successful: true, status: 200, headers: {}, file: { url: "https://temp.test/clip", contentType: "video/mp4", size: 1000, expiresAt: null } }
        : ok({ name: "clip.mp4", mimeType: "video/mp4", size: "1000" }),
    );
    expect(await driveFileLink(c.env, "clip_id_0000")).toEqual({ name: "clip.mp4", mimeType: "video/mp4", size: 1000, url: "https://temp.test/clip" });
    expect(c.sent.map((r) => [r.endpoint, param(r, "alt") ?? param(r, "fields")])).toEqual([
      ["/files/clip_id_0000", "name,mimeType,size"],
      ["/files/clip_id_0000", "media"],
    ]);
  });

  it("a bigger file, or one with no size, is never fetched whole through the connection", async () => {
    for (const size of [String(PROXY_FILE_BYTES + 1), undefined]) {
      const c = connection("googledrive", () => ok({ name: "big.mp4", mimeType: "video/mp4", ...(size ? { size } : {}) }));
      const link = await driveFileLink(c.env, "big_id_00000");
      expect(link).toMatchObject({ tooBig: true, name: "big.mp4" });
      expect(c.sent).toHaveLength(1);
    }
  });

  it("the media library's fallback for a big file is the broker's download action", async () => {
    const c = connection("googledrive", () => ok({}));
    expect(await driveActionLink(c.env, "big_id_00000")).toEqual({ url: "https://temp.test/whole", name: "big.mp4", mimeType: "video/mp4" });
    expect(c.actions).toEqual([["GOOGLEDRIVE_DOWNLOAD_FILE", { fileId: "big_id_00000" }]]);
  });

  it("deleting a file is a DELETE on it", async () => {
    const c = connection("googledrive", () => ({ data: null, error: null, successful: true, status: 204 }));
    await driveRemove(c.env, "copy_id_0000");
    expect([c.sent[0].method, c.sent[0].endpoint, param(c.sent[0], "supportsAllDrives")]).toEqual(["DELETE", "/files/copy_id_0000", "true"]);
  });
});

describe("a file's size through the connection", () => {
  it("is Drive's own number, or null when the connection won't say", async () => {
    const { driveFileSize } = await import("../src/server/drive");
    let c = connection("googledrive", () => ok({ size: "32582232228" }));
    expect(await driveFileSize(c.env, "googledrive", "big_id_00000")).toBe(32_582_232_228);
    expect([c.sent[0].endpoint, param(c.sent[0], "fields")]).toEqual(["/files/big_id_00000", "size"]);
    c = connection("googledrive", () => ({ data: null, error: "googledrive 404: gone", successful: false, status: 404 }));
    expect(await driveFileSize(c.env, "googledrive", "gone_id_0000")).toBeNull();
    c = connection("googledrive", () => ok({}));
    expect(await driveFileSize(c.env, "googledrive", "doc_id_00000")).toBeNull();
  });
});

describe("a piece through the connection", () => {
  const signal = new AbortController().signal;

  it("carries Drive's own status and range, and the bytes behind the broker's link", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "https://temp.test/piece" ? new Response("0123456789abcdef") : new Response("no", { status: 404 }),
    );
    const c = connection("googledrive", () => ({
      data: null,
      error: null,
      successful: true,
      status: 206,
      headers: { "content-range": "bytes 0-15/100" },
      file: { url: "https://temp.test/piece", contentType: "video/mp4", size: 16, expiresAt: null },
    }));
    const res = await driveFilePiece(c.env, "googledrive", "clip_id_0000", 0, 15, signal);
    expect(res!.status).toBe(206);
    expect(res!.headers.get("content-range")).toBe("bytes 0-15/100");
    expect(res!.headers.get("content-type")).toBe("video/mp4");
    expect(await res!.text()).toBe("0123456789abcdef");
    const req = c.sent[0];
    expect([req.endpoint, param(req, "alt"), param(req, "Range")]).toEqual(["/files/clip_id_0000", "media", "bytes=0-15"]);
    expect(req.parameters?.find((p) => p.name === "Range")?.in).toBe("header");
  });

  it("a refusal comes back as its status; a broker that can't be reached as nothing", async () => {
    let c = connection("googledrive", () => ({ data: null, error: "googledrive 403: limit", successful: false, status: 403 }));
    expect((await driveFilePiece(c.env, "googledrive", "clip_id_0000", 0, 15, signal))!.status).toBe(403);
    c = connection("googledrive", () => ({ data: null, error: "proxy failed", successful: false }));
    expect(await driveFilePiece(c.env, "googledrive", "clip_id_0000", 0, 15, signal)).toBeNull();
  });
});
