// A file Google Drive won't hand over whole still comes in, a piece at a time.
//
// Drive's per-file download limit ("Too many users have viewed or downloaded
// this file recently") answers a request for the whole file with its "Quota
// exceeded" page, yet still serves byte ranges of that same file. The media
// service only pulls whole files, so for such a file this app reads it in
// ranges from the shared link and appends each one to a resumable (tus) upload
// on the media service, a few pieces per background step.
//
// The upload's own offset is the cursor. It is read from the upload at the
// start of every step and never trusted from a row of ours, so a step that
// dies mid-piece, or two steps that overlap, can't leave a gap or send a piece
// twice: tus refuses a piece sent at any offset but the current one.

import { directDownloadUrl, judgeLinkResponse } from "./drive-link";

/**
 * Bytes per piece. The media service's video host takes chunks of at most
 * 200 MiB, each but the last a multiple of 256 KiB.
 */
export const PIECE_BYTES = 200 * 1024 * 1024;

/** The largest file the video host takes. A larger one waits on Drive, as before. */
export const MAX_RELAY_BYTES = 30 * 1024 ** 3;

/**
 * Start no new piece once a step has relayed this long. The platform's queue
 * delivers a batch of jobs one after another, so a long step holds up other
 * apps' deliveries. At Drive's pace (about 10 MB/s a range) a piece takes some
 * 20 s, so a step relays for under a minute.
 */
export const RELAY_BUDGET_MS = 30_000;

/** Clips moved on at once in a step: each holds two connections while a piece is on its way. */
export const RELAY_AT_ONCE = 2;

/** An upload whose link expires sooner than this is opened again: a piece started on it might not land. */
export const RELAY_EXPIRY_MARGIN_MS = 10 * 60_000;

/**
 * A piece still on its way after this long is given up (both ends are cut),
 * so a stalled read can't hold a step open: 200 MiB at under 2 MB/s.
 */
const PIECE_TIMEOUT_MS = 120_000;

// The video host's upload endpoint turned away a request with Python's
// default user agent ("error code: 1010"); it takes a named one.
const TUS = { "Tus-Resumable": "1.0.0", "User-Agent": "OpenVideo/1.0" };

/** The bytes of the next piece from `offset`, inclusive, as a Range header names them. Null once the file is all in. */
export function nextPiece(offset: number, size: number): { start: number; end: number } | null {
  if (offset >= size) return null;
  return { start: offset, end: Math.min(offset + PIECE_BYTES, size) - 1 };
}

/**
 * What Drive's answer to a ranged read means.
 * - "ok": exactly the bytes asked for, of a video.
 * - "refused": Drive won't serve them (its quota page, no access, no file, or
 *   other bytes than asked for), so the clip waits on Drive.
 * - "retry": a hiccup (rate limited, an outage, the whole file instead of a
 *   piece), asked again on the next step.
 */
export function pieceVerdict(
  status: number,
  contentType: string | null,
  contentRange: string | null,
  piece: { start: number; end: number },
  size: number,
): "ok" | "refused" | "retry" {
  if (status === 429 || status >= 500) return "retry";
  if (!judgeLinkResponse(status, contentType, contentRange, null).ok) return "refused";
  if (status !== 206) return "retry";
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((contentRange ?? "").trim());
  return m && Number(m[1]) === piece.start && Number(m[2]) === piece.end && Number(m[3]) === size ? "ok" : "refused";
}

/**
 * The file's length, read off a one-byte range, which Drive serves even for a
 * file it won't hand over whole. Null when it won't serve even that.
 */
export async function rangedSize(fileId: string): Promise<number | null> {
  const res = await fetch(directDownloadUrl(fileId), {
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) return null;
  await res.body?.cancel().catch(() => {});
  if (res.status !== 206) return null;
  const v = judgeLinkResponse(res.status, res.headers.get("content-type"), res.headers.get("content-range"), null);
  return v.ok && v.size ? v.size : null;
}

/** How many bytes the upload holds. "gone": it can't take more. Null: it couldn't be asked. */
async function uploadOffset(url: string): Promise<number | "gone" | null> {
  const res = await fetch(url, { method: "HEAD", headers: TUS, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return null;
  if (res.status === 404 || res.status === 410) return "gone";
  const offset = res.headers.get("Upload-Offset");
  if (!res.ok || offset === null) return null;
  const n = Number(offset);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Append one piece at `offset`, streamed through without holding it. The new
 * offset; "conflict" when the upload stands elsewhere; "gone"; `refused` with
 * the host's reason when it turns the piece away for good; null when it didn't
 * land this time (asked again on the next step).
 */
async function sendPiece(
  url: string,
  offset: number,
  body: ReadableStream,
  length: number,
  signal: AbortSignal,
): Promise<number | "conflict" | "gone" | { refused: string } | null> {
  // The video host refuses a piece sent without its length (400), and a
  // streamed body goes without one unless it has a fixed length. (The test
  // harness runs on Node, which has no FixedLengthStream.)
  let sent: ReadableStream = body;
  if (typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(length);
    body.pipeTo(fixed.writable).catch(() => {});
    sent = fixed.readable;
  }
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...TUS, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
    body: sent,
    signal,
  }).catch(() => null);
  if (!res) return null;
  if (res.status === 409) return "conflict";
  if (res.status === 404 || res.status === 410) return "gone";
  // A malformed piece is refused the same way every time: retrying can't help.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    const said = (await res.text().catch(() => "")).trim().slice(0, 200);
    return { refused: `${res.status}${said ? `: ${said}` : ""}` };
  }
  await res.body?.cancel().catch(() => {});
  const next = Number(res.headers.get("Upload-Offset"));
  return res.ok && Number.isInteger(next) && next > offset ? next : null;
}

export type RelayResult =
  /** Every byte is in. `contentType` is what Drive said the file is. */
  | { state: "done"; contentType: string }
  /** Some or no pieces landed this time; the next step carries on. */
  | { state: "moving" }
  /** Drive refused a piece: the clip waits on Drive, and carries on from here after. */
  | { state: "drive" }
  /** The upload can't take more (gone, or its link expired). */
  | { state: "gone" }
  /** The video host turned a piece away for good, saying why. */
  | { state: "refused"; detail: string };

/**
 * Append pieces of a Drive file to its open upload until the file is all in
 * or `until` (a Date.now() time) passes; a piece already on its way finishes.
 * `progress` hears each new offset.
 */
export async function relayPieces(
  upload: { url: string; fileId: string; size: number },
  until: number,
  progress: (received: number) => Promise<void>,
): Promise<RelayResult> {
  let at = await uploadOffset(upload.url);
  if (at === "gone") return { state: "gone" };
  if (at === null) return { state: "moving" };
  let contentType = "video/mp4";
  while (at < upload.size && Date.now() < until) {
    const piece = nextPiece(at, upload.size)!;
    // One signal cuts both ends of the piece: the read from Drive and the send.
    const cut = new AbortController();
    const timer = setTimeout(() => cut.abort(), PIECE_TIMEOUT_MS);
    let sent: Awaited<ReturnType<typeof sendPiece>>;
    try {
      const res = await fetch(directDownloadUrl(upload.fileId), {
        headers: { Range: `bytes=${piece.start}-${piece.end}` },
        signal: cut.signal,
      }).catch(() => null);
      if (!res) break;
      const verdict = pieceVerdict(res.status, res.headers.get("content-type"), res.headers.get("content-range"), piece, upload.size);
      if (verdict !== "ok" || !res.body) {
        cut.abort();
        if (verdict === "refused") return { state: "drive" };
        break;
      }
      contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim() || contentType;
      sent = await sendPiece(upload.url, at, res.body, piece.end - piece.start + 1, cut.signal);
      if (typeof sent !== "number") cut.abort();
    } finally {
      clearTimeout(timer);
    }
    if (sent === "gone") return { state: "gone" };
    if (sent === null) break;
    if (typeof sent === "object") return { state: "refused", detail: sent.refused };
    if (sent === "conflict") {
      // Someone else's piece landed first: carry on from where the upload stands.
      const now = await uploadOffset(upload.url);
      if (now === "gone") return { state: "gone" };
      if (now === null || now === at) break;
      at = now;
      continue;
    }
    at = sent;
    await progress(at);
  }
  return at >= upload.size ? { state: "done", contentType } : { state: "moving" };
}
