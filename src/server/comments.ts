/**
 * Review comments: people watching a share link leave notes on the video, at a
 * moment in it or about the whole thing, and the team resolves them in the
 * editor. Commenting is off on a link until someone turns it on, because a
 * link is also how a finished video gets passed around, and a page anyone can
 * write to should be a choice.
 *
 * Viewers are not signed in (the share page is a public route), so a comment
 * carries the name its writer typed and nothing more. The link's token is the
 * only capability, the same as for watching.
 */

export const MAX_COMMENT_CHARS = 2000;
export const MAX_NAME_CHARS = 80;
/** Comments a link takes in one minute; more is a script, not a reviewer. */
export const COMMENTS_PER_MINUTE = 20;
/** Comments a project keeps; past this a link takes no more. */
export const MAX_PROJECT_COMMENTS = 1000;

export interface NewComment {
  /** The export the viewer's page was playing. */
  v: number;
  /** Seconds into that export, or null for the whole video. */
  at: number | null;
  body: string;
  author: string;
}

/** A comment as the share page shows it. */
export interface PublicComment {
  id: string;
  at: number | null;
  body: string;
  author: string;
  resolved: boolean;
  created_at: string;
}

// Control characters other than tab and newline: they render as nothing or
// garble the line, and no reviewer types them.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const clean = (s: string) => s.replace(CONTROL, "").trim();

/**
 * A viewer's comment, checked. `duration` is the export's length in seconds
 * when known: a time past it is moved to the end (the player can report a
 * hair more than the file holds), and one well past it is refused.
 */
export function parseComment(
  raw: unknown,
  duration: number | null,
): { ok: true; value: NewComment } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "send the comment as JSON" };
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.v)) return { ok: false, detail: "v: the export the page plays is missing" };
  const body = typeof r.body === "string" ? clean(r.body) : "";
  if (!body) return { ok: false, detail: "Write a comment first." };
  if (body.length > MAX_COMMENT_CHARS) {
    return { ok: false, detail: `A comment can be up to ${MAX_COMMENT_CHARS} characters.` };
  }
  const author = typeof r.author === "string" ? clean(r.author).replace(/\s+/g, " ") : "";
  if (!author) return { ok: false, detail: "Add your name, so the team knows who it's from." };
  if (author.length > MAX_NAME_CHARS) return { ok: false, detail: `A name can be up to ${MAX_NAME_CHARS} characters.` };
  let at: number | null = null;
  if (r.at !== null && r.at !== undefined) {
    if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at < 0) {
      return { ok: false, detail: "at: seconds into the video, or null" };
    }
    if (duration !== null && r.at > duration + 1) return { ok: false, detail: "at: past the end of the video" };
    at = Math.round(Math.min(r.at, duration ?? r.at) * 100) / 100;
  }
  return { ok: true, value: { v: r.v as number, at, body, author } };
}
