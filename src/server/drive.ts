// Google Drive as a media source, through the org's Google Drive connection
// or, failing that, its Google Workspace one (which includes Drive). Browsing
// is a Drive search; importing copies the file into this app's own storage,
// exactly like an upload, so the editor and the export never read from Drive
// themselves.
//
// The connection's broker never hands this app a raw Google token, so the
// bytes come the one way it allows: the download action parks the file behind
// a short-lived signed link, and the import streams that link into storage.

import { connect, describe, type ConnectionsEnv } from "@clawnify/connections";

// Both toolkits carry the same Drive actions, prefixed with their own name.
// Google Drive comes first: it is the connection a studio makes for its files.
const SERVICES = ["googledrive", "googlesuper"] as const;
type Service = (typeof SERVICES)[number];

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
  if (shared) q += " and sharedWithMe = true";

  const service = await requireDriveService(env);
  const data = (await connect(service, env).run(`${service.toUpperCase()}_FIND_FILE`, {
    q,
    // `folder` sorts folders ahead of files, so the picker needs no re-sort.
    orderBy: "folder,modifiedTime desc",
    pageSize: 50,
    fields:
      "nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis))",
    // Shared items are found by the query, not by a parent folder.
    ...(shared ? {} : { folder_id: opts.folderId || "root" }),
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
  const data = (await connect(service, env).run(`${service.toUpperCase()}_GET_FILE_METADATA`, {
    fileId: id,
    fields: "name,parents",
  })) as { name?: string; parents?: string[] };
  return data.name ? { name: data.name, parents: data.parents ?? [] } : null;
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

/** A signed, short-lived link to one Drive file's original bytes. */
export async function driveDownloadLink(
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
