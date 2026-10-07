// The storage key of an exported render, recovered from the `output_url` the
// export route writes ("/api/uploads/<encoded key>", key = "renders/…mp4").
//
// Used when a project is deleted: each of its exports' render objects must be
// removed from storage too, or they outlive the rows that point to them and are
// orphaned. The guard to the `renders/` prefix means this can only ever name an
// export's own output, never an uploaded asset that happens to share the route.

const UPLOADS_PREFIX = "/api/uploads/";
const RENDER_PREFIX = "renders/";

export function renderKey(outputUrl: string | null | undefined): string | null {
  if (!outputUrl || !outputUrl.startsWith(UPLOADS_PREFIX)) return null;
  let key: string;
  try {
    key = decodeURIComponent(outputUrl.slice(UPLOADS_PREFIX.length));
  } catch {
    return null; // malformed percent-encoding
  }
  return key.startsWith(RENDER_PREFIX) ? key : null;
}

/**
 * The storage key a finished export is copied to. It comes from the two job
 * ids rather than a fresh random suffix, so two reads that settle the same
 * export at once write one object instead of orphaning a second. The service
 * job id is a random UUID, so the key stays as unguessable as before.
 */
export function renderKeyFor(exportId: number, serviceJobId: string): string {
  return `${RENDER_PREFIX}edit-${exportId}-${serviceJobId.replace(/-/g, "").slice(0, 8)}.mp4`;
}

/** Where an export's poster frame (a JPEG of the output) is kept: beside its
 *  render, same name. Older exports, and renders the service made without
 *  one, have no object there. */
export function posterKeyOf(renderKey: string): string {
  return renderKey.replace(/\.mp4$/, ".jpg");
}

// An export row is written before its sources are staged and the render is
// submitted, and that part runs inside the request. A row still without a
// service job past this age was cut off (the tab closed or the request died)
// and will never finish. Staging waits at most about half a minute for
// footage on the media service, and a 500 MB upload takes a few minutes.
const ABANDONED_AFTER_MS = 15 * 60 * 1000;

/** SQLite's datetime('now') is UTC without a zone ("2026-10-03 11:52:25"). */
function sqliteTime(s: string): number {
  return Date.parse(`${s.replace(" ", "T")}Z`);
}

export function isAbandonedExport(createdAt: string, now: number): boolean {
  const t = sqliteTime(createdAt);
  return Number.isFinite(t) && now - t > ABANDONED_AFTER_MS;
}
