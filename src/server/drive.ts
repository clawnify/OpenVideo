// Google Drive as a media source, through the org's Google Drive connection
// or, failing that, its Google Workspace one (which includes Drive). Browsing
// is a Drive search; importing copies the file into this app's own storage,
// exactly like an upload, so the editor and the export never read from Drive
// themselves.
//
// Every call is Google's own Drive API, sent through the connection's broker,
// which signs it with the org's credential: the app never holds a Google
// token, and the code is the same whoever holds the credential. A file comes
// back as a short-lived link to its bytes, at most 250 MB in one answer.

import { connect, describe, type ConnectionsEnv } from "@clawnify/connections";

// Google Drive comes first: it is the connection a studio makes for its files.
const SERVICES = ["googledrive", "googlesuper"] as const;
export type DriveService = (typeof SERVICES)[number];
type Service = DriveService;

/**
 * Where the Drive API sits under each connection's base URL: Google Drive's
 * already ends in `/drive/v3`, Google Super's is the googleapis.com root.
 */
const DRIVE_API: Record<Service, string> = { googledrive: "", googlesuper: "/drive/v3" };

/** One request to the Drive API through the connection. Query values are sent as given. */
function driveCall(
  env: ConnectionsEnv,
  service: Service,
  method: "GET" | "DELETE",
  path: string,
  query: Record<string, string> = {},
) {
  return connect(service, env).rawRequest({
    method,
    endpoint: `${DRIVE_API[service]}${path}`,
    parameters: Object.entries(query).map(([name, value]) => ({ name, value, in: "query" as const })),
  });
}

/** The broker's words for a provider 404: "<service> 404: …". */
const notFound = (e: unknown) => /^\w+ 404:/.test(e instanceof Error ? e.message : String(e));

/**
 * The most one answer through the connection can carry: the broker refuses a
 * bigger file ("maximum file size limit of 250MB").
 */
export const PROXY_FILE_BYTES = 250_000_000;

/** What the picker lists. `duration` is seconds, for videos Drive has probed. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  duration: number | null;
  /** Drive's own preview image. A short-lived link, no Google login needed. */
  thumbnail: string | null;
}

export interface DriveFolder {
  id: string;
  name: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Files other people shared with this account live outside its own Drive, so
 * the root listing never shows them. They get a folder of their own, the way
 * Drive's own web UI does it.
 */
export const SHARED_WITH_ME = "sharedWithMe";

/** How far up a parent chain we walk before giving up on the folder limit. */
const MAX_ANCESTRY_DEPTH = 25;

/** A Drive file id: letters, digits, `-` and `_`, never a path. */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** The first Google connection the org has that reaches Drive, if any. */
async function driveService(env: ConnectionsEnv): Promise<Service | null> {
  const entries = await describe(
    env,
    undefined,
    SERVICES.map((service) => ({ service, as: "integration" as const })),
  );
  return SERVICES.find((s) => entries.some((e) => e.id === s && e.connected)) ?? null;
}

async function requireDriveService(env: ConnectionsEnv): Promise<Service> {
  const service = await driveService(env);
  if (!service) throw new Error("Google Drive is not connected");
  return service;
}

export async function driveStatus(env: ConnectionsEnv): Promise<{ connected: boolean; service: Service | null }> {
  const service = await driveService(env);
  return { connected: service !== null, service };
}

/**
 * Newest first. `kind` picks the panel's file types: footage and stills for
 * the Media panel, sound for the Audio one.
 */
export async function listDriveFiles(
  env: ConnectionsEnv,
  opts: { kind: "media" | "audio"; search?: string; pageToken?: string; folderId?: string },
): Promise<{ folders: DriveFolder[]; files: DriveFile[]; nextPageToken: string | null }> {
  const types = opts.kind === "audio" ? ["audio/"] : ["video/", "image/"];
  // Folders come along so the picker can walk into them. Drive only ever
  // searches one folder's direct children, never the whole subtree.
  let q = `trashed = false and (mimeType = '${FOLDER_MIME}' or ${types.map((t) => `mimeType contains '${t}'`).join(" or ")})`;
  // Quotes and backslashes would end the Drive query string early; a name
  // search does not need them.
  const search = opts.search?.replace(/['\\]/g, " ").trim();
  if (search) q += ` and name contains '${search}'`;
  const shared = opts.folderId === SHARED_WITH_ME;
  // Shared items are found by the query, not by a parent folder.
  if (shared) q += " and sharedWithMe = true";
  else {
    const parent = opts.folderId || "root";
    if (parent !== "root" && !DRIVE_FILE_ID.test(parent)) throw new Error("not a Drive folder id");
    q += ` and '${parent}' in parents`;
  }

  const service = await requireDriveService(env);
  const data = (await driveCall(env, service, "GET", "/files", {
    q,
    // `folder` sorts folders ahead of files, so the picker needs no re-sort.
    orderBy: "folder,modifiedTime desc",
    pageSize: "50",
    fields:
      "nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis))",
    // Folders on a shared drive, as well as the account's own.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
  })) as {
    files?: {
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
      thumbnailLink?: string;
      videoMediaMetadata?: { durationMillis?: string };
    }[];
    nextPageToken?: string;
  };

  const items = data.files ?? [];
  const atRoot = !opts.folderId || opts.folderId === "root";
  const folders = items.filter((f) => f.mimeType === FOLDER_MIME).map((f) => ({ id: f.id, name: f.name }));
  return {
    folders: atRoot && !opts.search ? [{ id: SHARED_WITH_ME, name: "Shared with me" }, ...folders] : folders,
    files: items
      .filter((f) => f.mimeType !== FOLDER_MIME)
      .map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime ?? null,
        duration: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
        // Ask for a bigger render than Drive's default 220px thumbnail.
        thumbnail: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, "=s400") : null,
      })),
    nextPageToken: data.nextPageToken ?? null,
  };
}

/** One item's name and parents, or null when Drive will not show it to us. */
async function driveItem(
  env: ConnectionsEnv,
  id: string,
): Promise<{ name: string; parents: string[] } | null> {
  const service = await requireDriveService(env);
  try {
    const data = (await driveCall(env, service, "GET", `/files/${encodeURIComponent(id)}`, {
      fields: "name,parents",
      supportsAllDrives: "true",
    })) as { name?: string; parents?: string[] };
    return data.name ? { name: data.name, parents: data.parents ?? [] } : null;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

export async function driveFolderName(env: ConnectionsEnv, id: string): Promise<string | null> {
  return (await driveItem(env, id))?.name ?? null;
}

/**
 * Whether an item sits inside the folder the org limited the picker to, by
 * walking its parents up. The limit is a rule about what this app may read,
 * so it is checked here and not only hidden in the picker.
 */
export async function withinFolder(env: ConnectionsEnv, itemId: string, folderId: string): Promise<boolean> {
  let current = itemId;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (current === folderId) return true;
    const parent = (await driveItem(env, current))?.parents?.[0];
    if (!parent) return false;
    current = parent;
  }
  return false;
}

export interface DriveFileInfo {
  name: string;
  mimeType: string;
  /** Bytes. Null for a file Drive keeps no size for (a Google Doc, say). */
  size: number | null;
}

/**
 * A short-lived link to one Drive file's original bytes, through the
 * connection, or `tooBig` (with what the file is) when it is over what one
 * answer carries. Then it comes by its shared link instead (footage, a piece
 * at a time when need be), or by {@link driveActionLink}.
 */
export async function driveFileLink(
  env: ConnectionsEnv,
  fileId: string,
): Promise<(DriveFileInfo & { url: string }) | (DriveFileInfo & { tooBig: true })> {
  const service = await requireDriveService(env);
  const path = `/files/${encodeURIComponent(fileId)}`;
  const meta = (await driveCall(env, service, "GET", path, { fields: "name,mimeType,size", supportsAllDrives: "true" })) as {
    name?: string;
    mimeType?: string;
    size?: string;
  };
  const info: DriveFileInfo = {
    name: meta.name || fileId,
    mimeType: meta.mimeType || "application/octet-stream",
    size: meta.size ? Number(meta.size) : null,
  };
  // Asked for whole, a bigger file is fetched into the broker's storage before
  // it is refused: ask only for what can come back.
  if (info.size === null || info.size > PROXY_FILE_BYTES) return { ...info, tooBig: true };
  const file = await connect(service, env).rawFile({
    method: "GET",
    endpoint: `${DRIVE_API[service]}${path}`,
    parameters: [
      { name: "alt", value: "media", in: "query" },
      { name: "supportsAllDrives", value: "true", in: "query" },
    ],
  });
  return { ...info, url: file.url };
}

/**
 * A Drive file's size through the connection, or null when the connection
 * won't say. Drive can refuse even one byte of a file on its shared link while
 * its API, asked as the connected account, still answers.
 */
export async function driveFileSize(env: ConnectionsEnv, service: DriveService, fileId: string): Promise<number | null> {
  try {
    const data = (await driveCall(env, service, "GET", `/files/${encodeURIComponent(fileId)}`, {
      fields: "size",
      supportsAllDrives: "true",
    })) as { size?: string };
    const size = Number(data.size);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * One piece of a Drive file through the connection, as a Response carrying
 * Drive's own status and headers and the bytes behind the broker's link. A
 * refusal comes back as its status, so the caller can tell it from a hiccup;
 * null when the broker or its link couldn't be reached.
 *
 * Drive serves these as the connected account even when its limit refuses
 * the shared link's pieces: on 2026-10-10 a 15 GB file's shared link refused
 * ranges past about 4 GB read, while this served the same range.
 */
export async function driveFilePiece(
  env: ConnectionsEnv,
  service: DriveService,
  fileId: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Response | null> {
  let file;
  try {
    file = await connect(service, env).rawFile({
      method: "GET",
      endpoint: `${DRIVE_API[service]}/files/${encodeURIComponent(fileId)}`,
      parameters: [
        { name: "alt", value: "media", in: "query" },
        { name: "supportsAllDrives", value: "true", in: "query" },
        { name: "Range", value: `bytes=${start}-${end}`, in: "header" },
      ],
    });
  } catch (e) {
    const status = /^\w+ (\d{3}):/.exec(e instanceof Error ? e.message : String(e))?.[1];
    return status ? new Response(null, { status: Number(status) }) : null;
  }
  const bytes = await fetch(file.url, { signal }).catch(() => null);
  if (!bytes?.ok || !bytes.body) {
    await bytes?.body?.cancel().catch(() => {});
    return null;
  }
  const range = file.headers["content-range"] ?? file.headers["Content-Range"];
  return new Response(bytes.body, {
    status: file.status ?? 206,
    headers: { "content-type": file.contentType, ...(range ? { "content-range": range } : {}) },
  });
}

/**
 * A whole file of any size up to the broker's own storage (3.4 GB passed, 9 GB
 * did not) through its download action, which parks the file behind a
 * short-lived link. The one Drive call still made as an action: for a file
 * over what one proxy answer carries, where nothing reads it in pieces (an
 * import into the media library). See the platform's
 * docs/internal/connections-architecture.md §19.5 and §23.
 */
export async function driveActionLink(
  env: ConnectionsEnv,
  fileId: string,
): Promise<{ url: string; name: string; mimeType: string }> {
  const service = await requireDriveService(env);
  const data = (await connect(service, env).run(`${service.toUpperCase()}_DOWNLOAD_FILE`, { fileId })) as {
    downloaded_file_content?: { s3url?: string; name?: string; mimetype?: string };
  };
  const file = data.downloaded_file_content;
  if (!file?.s3url) throw new Error("Google Drive returned no file to import");
  return { url: file.s3url, name: file.name || fileId, mimeType: file.mimetype || "application/octet-stream" };
}

/** Delete a file the app made in the connected account (a copy an earlier version made for an import). */
export async function driveRemove(env: ConnectionsEnv, fileId: string): Promise<void> {
  const service = await requireDriveService(env);
  await driveCall(env, service, "DELETE", `/files/${encodeURIComponent(fileId)}`, { supportsAllDrives: "true" });
}
