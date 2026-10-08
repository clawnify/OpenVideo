// Google Drive links that anyone can open: the common case when a client
// sends footage. They share a folder "with the link" instead of connecting an
// account. Nothing here is authenticated, because those URLs aren't: Drive
// serves a public folder's listing and each file's bytes to any caller, and
// the bytes come with range support, which is what the media service needs
// to pull a multi-gigabyte file itself.
//
// The listing is Drive's embeddable folder view, plain HTML. A folder links to
// /drive/folders/<id>, a file to /file/d/<id>, and a file carries an icon
// named after its type (…/type/video/mp4).
//
// Pure string/HTML work and a walk over an injected fetch; unit-tested.

export type DriveLink = { kind: "file" | "folder"; id: string };

const ID = "[A-Za-z0-9_-]{10,200}";
const PATTERNS: [RegExp, DriveLink["kind"]][] = [
  [new RegExp(`/folders/(${ID})`), "folder"],
  [new RegExp(`/file/d/(${ID})`), "file"],
  [new RegExp(`[?&]id=(${ID})`), "file"],
  [new RegExp(`/d/(${ID})`), "file"],
];

/** A Drive URL → what it points at. Null for anything that isn't Drive. */
export function parseDriveLink(input: string): DriveLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname) && !/(^|\.)googleusercontent\.com$/.test(url.hostname)) return null;
  const path = url.pathname + url.search;
  for (const [re, kind] of PATTERNS) {
    const m = path.match(re);
    if (m) return { kind, id: m[1] };
  }
  return null;
}

/**
 * The URL that serves a public file's own bytes. `confirm=t` is what skips
 * the virus-scan interstitial Drive shows for large files: without it, a big
 * video downloads as a few KB of HTML.
 */
export function directDownloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
}

/** Drive's embeddable folder view, which is public HTML for a public folder. */
export function folderListingUrl(folderId: string): string {
  return `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
}

export interface DriveFolderEntry {
  id: string;
  name: string;
  folder: boolean;
  /** From the entry's type icon, e.g. "video/mp4". Null when it has none. */
  mimeType: string | null;
}

/** The folder's own name: the listing's page title. */
export function parseFolderName(html: string): string | null {
  const name = decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "").trim();
  return name || null;
}

export function parseFolderListing(html: string): DriveFolderEntry[] {
  const out: DriveFolderEntry[] = [];
  const seen = new Set<string>();
  // Each entry runs from its id to the next one's.
  for (const chunk of html.split('id="entry-').slice(1)) {
    const id = new RegExp(`^(${ID})"`).exec(chunk)?.[1];
    const rawName = /flip-entry-title">([^<]+)</.exec(chunk)?.[1];
    if (!id || !rawName || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: decodeEntities(rawName).trim(),
      folder: /href="[^"]*\/folders\//.test(chunk),
      mimeType: /\/type\/([a-z0-9.+-]+\/[a-z0-9.+-]+)/i.exec(chunk)?.[1]?.toLowerCase() ?? null,
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|mxf|mts|m2ts|flv|3gp)$/i;

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** A video by the type Drive shows for it, or by its name. */
export function isVideoEntry(e: DriveFolderEntry): boolean {
  return !e.folder && (e.mimeType?.startsWith("video/") || isVideoName(e.name));
}

export interface FolderVideo {
  id: string;
  name: string;
  /** The folders it sits in below the one shared, joined by "/": "Cam B", "Testimonials/Testimonial 1". "" at the top. */
  folder: string;
}

/**
 * Bounds on one walk. A day of an event shoot measured 6 folders holding
 * about 260 videos (plus a dozen subfolders), so these leave a lot of room
 * and still stop a link to someone's whole Drive.
 */
export const WALK_LIMITS = { folders: 300, depth: 8, videos: 3000 };

/**
 * Every video in a folder and every folder inside it. `listing` returns one
 * folder's listing HTML; the folders at each depth are read together.
 * `truncated` says a limit was reached and some were left out.
 */
export async function listFolderVideos(
  listing: (folderId: string) => Promise<string>,
  rootId: string,
  limits = WALK_LIMITS,
): Promise<{ name: string | null; videos: FolderVideo[]; folders: number; truncated: boolean }> {
  const rootHtml = await listing(rootId);
  const videos: FolderVideo[] = [];
  let folders = 1;
  let truncated = false;
  let level = [{ html: rootHtml, path: "" }];
  for (let depth = 1; level.length > 0; depth++) {
    const next: { id: string; path: string }[] = [];
    for (const { html, path } of level) {
      for (const e of parseFolderListing(html)) {
        if (e.folder) {
          if (depth > limits.depth || folders + next.length >= limits.folders) truncated = true;
          else next.push({ id: e.id, path: path ? `${path}/${e.name}` : e.name });
        } else if (isVideoEntry(e)) {
          if (videos.length >= limits.videos) truncated = true;
          else videos.push({ id: e.id, name: e.name, folder: path });
        }
      }
    }
    folders += next.length;
    level = await Promise.all(next.map(async (f) => ({ html: await listing(f.id), path: f.path })));
  }
  return { name: parseFolderName(rootHtml), videos, folders, truncated };
}

export interface LinkCheck {
  ok: boolean;
  /** Why not, in words a person can act on. */
  reason?: string;
  contentType?: string;
  size?: number;
}

/**
 * Confirm a link really serves video bytes before handing it to the media
 * service, which fetches it out of our sight. Two failures look identical
 * from the outside and both arrive as a "video" otherwise: a Drive quota page
 * ("too many users have viewed this file") and a sharing-permission page.
 * Both are HTML with a 200.
 */
export function judgeLinkResponse(
  status: number,
  contentType: string | null,
  contentRange: string | null,
  contentLength: string | null,
): LinkCheck {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (status === 403 || status === 401) {
    return { ok: false, reason: "that file isn't public: set it to “Anyone with the link”" };
  }
  if (status === 404) return { ok: false, reason: "there's no file at that link any more" };
  if (status >= 400) return { ok: false, reason: `the link answered ${status}` };
  if (type.startsWith("text/") || type === "application/json") {
    return {
      ok: false,
      reason:
        "Drive returned a web page instead of the video. It does this when a file has been downloaded too many times today, or when it isn't shared publicly. Try again later",
    };
  }
  if (type && !type.startsWith("video/") && type !== "application/octet-stream" && type !== "binary/octet-stream") {
    return { ok: false, reason: `that link serves ${type}, not a video` };
  }
  // "bytes 0-1/7498432963" → the real length, which a ranged reply's own
  // Content-Length (2) never is.
  const total = contentRange?.match(/\/(\d+)\s*$/)?.[1];
  const size = total ? Number(total) : contentLength ? Number(contentLength) : undefined;
  return { ok: true, contentType: type || undefined, size };
}
