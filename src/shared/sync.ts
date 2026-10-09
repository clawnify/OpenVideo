// How an open editor stays in step with the saved project. The project has
// more writers than the editor: an agent over the API, Ask and Auto-cut on
// the server, a teammate, the same person in another tab. Each write adds
// one to the project's revision, and a save names the revision it started
// from, so nothing overwrites a version its writer never saw.

export interface Doc<E> {
  edl: E;
  name: string;
  brief: string;
}

/** By reference: every edit replaces the document, so a new object is a change. */
export function sameDoc<E>(a: Doc<E>, b: Doc<E>): boolean {
  return a.edl === b.edl && a.name === b.name && a.brief === b.brief;
}

/**
 * What to do when the server holds a newer revision than the one the editor
 * last saved or loaded. With nothing unsaved, take it: the editor shows what
 * was saved elsewhere, and undo can walk back over it. With unsaved edits,
 * neither side may silently win, so the person chooses.
 */
export function onRemote<E>(local: Doc<E>, saved: Doc<E> & { revision: number }, remote: number): "ignore" | "adopt" | "conflict" {
  if (remote === saved.revision) return "ignore";
  return sameDoc(local, saved) ? "adopt" : "conflict";
}

/**
 * If-None-Match against one ETag, by weak comparison as HTTP defines it for
 * this header. The edge compresses JSON and turns `"7"` into `W/"7"` on the
 * way out, so a client that echoes what it got back sends the weak form.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}
