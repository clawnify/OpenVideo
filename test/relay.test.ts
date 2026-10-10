import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RELAY_BYTES, PIECE_BYTES, nextPiece, pieceVerdict, rangedSize, relayPieces } from "../src/server/relay";

afterEach(() => vi.unstubAllGlobals());

const MiB = 1024 * 1024;
const UPLOAD = "https://upload.test/tus/abc";

/** `n` bytes, made as they are read. */
const ZEROS = new Uint8Array(MiB);
function bytes(n: number): ReadableStream<Uint8Array> {
  let left = n;
  return new ReadableStream({
    pull(c) {
      if (left <= 0) return c.close();
      const k = Math.min(left, ZEROS.length);
      c.enqueue(ZEROS.subarray(0, k));
      left -= k;
    },
  });
}

async function count(body: unknown): Promise<number> {
  let n = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) n += chunk.byteLength;
  return n;
}

/**
 * A Drive file of `size` bytes behind its shared link, and an open upload for
 * it that holds `at` bytes. The upload counts what it is sent, like the real
 * one, and refuses a piece sent anywhere but where it stands.
 */
function fakeUpload(size: number, at = 0) {
  const state = {
    at,
    /** Where each piece that landed started. */
    patches: [] as number[],
    headers: [] as Headers[],
    refuseRange: (_start: number): "quota" | number | null => null,
    patchFails: (_at: number): number | "throw" | null => null,
    headStatus: 200,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const h = new Headers(init.headers);
      if (url.hostname === "drive.usercontent.google.com") {
        const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(h.get("range") ?? "")!;
        const start = Number(a);
        const end = Number(b);
        const refusal = state.refuseRange(start);
        if (refusal === "quota") {
          return new Response("<html><head><title>Google Drive - Quota exceeded</title></head></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (typeof refusal === "number") return new Response("busy", { status: refusal });
        return new Response(bytes(end - start + 1), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}` },
        });
      }
      if (url.href === UPLOAD && init.method === "HEAD") {
        if (state.headStatus !== 200) return new Response(null, { status: state.headStatus });
        return new Response(null, { status: 200, headers: { "Upload-Offset": String(state.at), "Upload-Length": String(size) } });
      }
      if (url.href === UPLOAD && init.method === "PATCH") {
        state.headers.push(h);
        const fail = state.patchFails(state.at);
        if (fail === "throw") throw new TypeError("network connection lost");
        if (typeof fail === "number") return new Response(fail === 400 ? "Decoding Error" : null, { status: fail });
        if (Number(h.get("upload-offset")) !== state.at) return new Response(null, { status: 409 });
        state.patches.push(state.at);
        state.at += await count(init.body);
        return new Response(null, { status: 204, headers: { "Upload-Offset": String(state.at) } });
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${input}`);
    }),
  );
  return state;
}

describe("the video host's limits", () => {
  it("a piece is its largest chunk, a multiple of 256 KiB, and a file at most its largest upload", () => {
    expect(PIECE_BYTES).toBe(209_715_200);
    expect(PIECE_BYTES % (256 * 1024)).toBe(0);
    expect(MAX_RELAY_BYTES).toBe(30 * 1024 ** 3);
  });
});

describe("nextPiece", () => {
  it("cuts a file into 200 MiB pieces, the last one shorter", () => {
    const size = 2 * PIECE_BYTES + 3 * MiB;
    expect(nextPiece(0, size)).toEqual({ start: 0, end: PIECE_BYTES - 1 });
    expect(nextPiece(PIECE_BYTES, size)).toEqual({ start: PIECE_BYTES, end: 2 * PIECE_BYTES - 1 });
    expect(nextPiece(2 * PIECE_BYTES, size)).toEqual({ start: 2 * PIECE_BYTES, end: size - 1 });
    expect(nextPiece(size, size)).toBeNull();
  });

  it("sends a small file in one piece", () => {
    expect(nextPiece(0, 4 * MiB)).toEqual({ start: 0, end: 4 * MiB - 1 });
  });

  it("carries on from any offset, every piece but the last a multiple of 256 KiB", () => {
    const size = 3 * PIECE_BYTES + 12_345;
    let at = 7; // a piece that half landed
    const lengths: number[] = [];
    for (let p = nextPiece(at, size); p; p = nextPiece(at, size)) {
      lengths.push(p.end - p.start + 1);
      at = p.end + 1;
    }
    expect(at).toBe(size);
    for (const n of lengths.slice(0, -1)) expect(n % (256 * 1024)).toBe(0);
  });
});

describe("pieceVerdict", () => {
  const piece = { start: 100, end: 199 };

  it("takes exactly the bytes asked for, of a video", () => {
    expect(pieceVerdict(206, "video/mp4", "bytes 100-199/1000", piece, 1000)).toBe("ok");
  });

  it("is refused by Drive's quota page, a closed or missing file, or other bytes than asked for", () => {
    expect(pieceVerdict(200, "text/html; charset=utf-8", null, piece, 1000)).toBe("refused");
    expect(pieceVerdict(403, "text/html", null, piece, 1000)).toBe("refused");
    expect(pieceVerdict(404, null, null, piece, 1000)).toBe("refused");
    expect(pieceVerdict(206, "video/mp4", "bytes 100-150/1000", piece, 1000)).toBe("refused");
    expect(pieceVerdict(206, "video/mp4", "bytes 100-199/999", piece, 1000)).toBe("refused");
  });

  it("asks again after a hiccup, or when the whole file comes instead of a piece", () => {
    expect(pieceVerdict(429, null, null, piece, 1000)).toBe("retry");
    expect(pieceVerdict(503, "text/html", null, piece, 1000)).toBe("retry");
    expect(pieceVerdict(200, "video/mp4", null, piece, 1000)).toBe("retry");
  });
});

describe("rangedSize", () => {
  it("reads the length off a one-byte piece, which Drive serves even when it refuses the whole file", async () => {
    const fetch = vi.fn(async () => new Response("x", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/15000000000" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await rangedSize("file-id")).toBe(15_000_000_000);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://drive.usercontent.google.com/download?id=file-id&export=download&confirm=t");
    expect(new Headers(init.headers).get("range")).toBe("bytes=0-0");
  });

  it("is null when Drive won't serve even that, or can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<title>Google Drive - Quota exceeded</title>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await rangedSize("file-id")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await rangedSize("file-id")).toBeNull();
  });
});

describe("relayPieces", () => {
  const SIZE = 2 * PIECE_BYTES + 3 * MiB;
  const file = { url: UPLOAD, fileId: "file-id", size: SIZE };
  const later = () => Date.now() + 60_000;
  const quiet = async () => {};

  it("sends the file in order, a piece at a time, and says when it is all in", async () => {
    const up = fakeUpload(SIZE);
    const seen: number[] = [];
    const result = await relayPieces(file, later(), async (n) => {
      seen.push(n);
    });
    expect(result).toEqual({ state: "done", contentType: "video/mp4" });
    expect(up.patches).toEqual([0, PIECE_BYTES, 2 * PIECE_BYTES]);
    expect(up.at).toBe(SIZE);
    expect(seen).toEqual([PIECE_BYTES, 2 * PIECE_BYTES, SIZE]);
    const h = up.headers[0];
    expect(h.get("tus-resumable")).toBe("1.0.0");
    expect(h.get("content-type")).toBe("application/offset+octet-stream");
    expect(h.get("user-agent")).toMatch(/^OpenVideo\//);
  });

  it("carries on from where the upload stands, not from a count of its own", async () => {
    const up = fakeUpload(SIZE, PIECE_BYTES + 7);
    expect((await relayPieces(file, later(), quiet)).state).toBe("done");
    expect(up.patches).toEqual([PIECE_BYTES + 7, 2 * PIECE_BYTES + 7]);
    expect(up.at).toBe(SIZE);
  });

  it("starts no piece once its time is up", async () => {
    const up = fakeUpload(SIZE);
    expect(await relayPieces(file, Date.now() - 1, quiet)).toEqual({ state: "moving" });
    expect(up.patches).toEqual([]);
  });

  it("stops for Drive when it refuses a piece, keeping what landed", async () => {
    const up = fakeUpload(SIZE);
    up.refuseRange = (start) => (start >= PIECE_BYTES ? "quota" : null);
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "drive" });
    expect(up.at).toBe(PIECE_BYTES);
  });

  it("leaves a hiccup to the next step: Drive busy, a lost connection, a piece the upload turned away", async () => {
    let up = fakeUpload(SIZE);
    up.refuseRange = () => 503;
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "moving" });

    up = fakeUpload(SIZE);
    up.patchFails = (at) => (at === PIECE_BYTES ? "throw" : null);
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "moving" });
    expect(up.at).toBe(PIECE_BYTES);

    up = fakeUpload(SIZE);
    up.patchFails = () => 500;
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "moving" });
    expect(up.at).toBe(0);
  });

  it("follows the upload when another step's piece landed first", async () => {
    const up = fakeUpload(SIZE);
    let raced = false;
    up.patchFails = (at) => {
      if (raced || at !== 0) return null;
      raced = true;
      up.at = PIECE_BYTES; // someone else's first piece
      return 409;
    };
    expect((await relayPieces(file, later(), quiet)).state).toBe("done");
    expect(up.patches).toEqual([PIECE_BYTES, 2 * PIECE_BYTES]);
  });

  it("gives up on a piece the upload turns away for good, with the host's reason", async () => {
    const up = fakeUpload(SIZE);
    up.patchFails = () => 400;
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "refused", detail: "400: Decoding Error" });
    expect(up.at).toBe(0);
  });

  it("says when the upload can't take more", async () => {
    let up = fakeUpload(SIZE);
    up.headStatus = 404;
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "gone" });
    up = fakeUpload(SIZE);
    up.patchFails = () => 410;
    expect(await relayPieces(file, later(), quiet)).toEqual({ state: "gone" });
  });
});
