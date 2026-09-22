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
}

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
  opts: { kind: "media" | "audio"; search?: string; pageToken?: string },
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const types = opts.kind === "audio" ? ["audio/"] : ["video/", "image/"];
  let q = `trashed = false and (${types.map((t) => `mimeType contains '${t}'`).join(" or ")})`;
  // Quotes and backslashes would end the Drive query string early; a name
  // search does not need them.
  const search = opts.search?.replace(/['\\]/g, " ").trim();
  if (search) q += ` and name contains '${search}'`;

  const service = await requireDriveService(env);
  const data = (await connect(service, env).run(`${service.toUpperCase()}_FIND_FILE`, {
    q,
    orderBy: "modifiedTime desc",
    pageSize: 50,
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,videoMediaMetadata(durationMillis))",
    ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
  })) as {
    files?: {
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
      videoMediaMetadata?: { durationMillis?: string };
    }[];
    nextPageToken?: string;
  };

  return {
    files: (data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? Number(f.size) : null,
      modifiedTime: f.modifiedTime ?? null,
      duration: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
    })),
    nextPageToken: data.nextPageToken ?? null,
  };
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
