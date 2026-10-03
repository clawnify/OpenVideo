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
