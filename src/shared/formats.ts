// Several formats of one project: the same cut, framed for each shape.
//
// A project has one timeline. `output` is its main format; each entry of
// `formats` is another shape the same cut is delivered in (a 9:16 version of
// a 16:9 talk, say). What is said, when, and how it sounds is shared by every
// format: a trim, a split or a new title changes all of them. What differs
// per format is where things sit in the frame:
//
//   - a main clip's fit, anchor, crop and stacked views, in `framing[<id>]`;
//   - an overlay's position and size, in `placement[<id>]`.
//
// With no entry, a clip shows its whole shot (nothing is guessed), and an
// overlay sits where the format picker would move it (reshape, format.ts).
//
// The editor works on one format at a time through a view: the document as
// that format sees it, so every control edits it the way it edits the main
// format. `liftView` then puts each change where it belongs. Export renders a
// view with these fields removed, so the render service's contract is
// unchanged.

import { parseRatio, reshape, sameShape } from "./format";

export interface Format {
  /** The shape, as a ratio: "9:16". */
  id: string;
  width: number;
  height: number;
}

export const MAX_FORMATS = 4;

/** What a format may change about a main clip. */
export const FRAMING_KEYS = ["fit", "anchor", "crop", "split"] as const;
/** What a format may change about an overlay. */
const PLACEMENT_KEYS = ["x", "y", "width", "fontSize"] as const;

/** Inside a view only: the main format's own values, so a lift can put them back. Never saved. */
const MAIN = "main";

/** Any document with this shape: the server's validated one, or the editor's own types. */
interface Document {
  output: { width: number; height: number };
  formats?: Format[];
  main: { elements: { id: string }[] };
  overlays?: { elements: { id: string }[] }[];
}

// Read loosely inside: framing and placement are copied field by field.
type Values = Record<string, unknown>;
type El = Values & { id: string; type: string; framing?: Record<string, Values>; placement?: Record<string, Values> };
interface Doc {
  output: { width: number; height: number };
  formats?: Format[];
  main: { elements: El[] };
  overlays?: { elements: El[] }[];
}
const loose = (d: Document) => d as unknown as Doc;

const pick = (el: Values, keys: readonly string[]): Values =>
  Object.fromEntries(keys.filter((k) => el[k] !== undefined).map((k) => [k, el[k]]));
const strip = (el: Values, keys: readonly string[]) => keys.forEach((k) => delete el[k]);
/** Two placements are the same when they hold the same keys at (nearly) the same values. */
const samePlace = (a: Values, b: Values) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (k) => typeof a[k] === "number" && typeof b[k] === "number" && Math.abs((a[k] as number) - (b[k] as number)) < 0.0005,
  );

/** A main clip's framing with nothing chosen: the whole shot, letterboxed. */
const isWholeShot = (f: Values) => Object.keys(f).every((k) => k === "fit" && f.fit === "contain");

/** The frame of an added format: the main format's short side, so titles keep their size. */
export function formatSize(ratio: string, main: { width: number; height: number }): { width: number; height: number } | null {
  const r = parseRatio(ratio);
  if (!r) return null;
  const short = Math.min(main.width, main.height);
  let width = r.w >= r.h ? (short * r.w) / r.h : short;
  let height = r.w >= r.h ? short : (short * r.h) / r.w;
  const shrink = Math.min(1, 3840 / width, 2160 / height);
  width *= shrink;
  height *= shrink;
  const even = (n: number) => Math.max(16, 2 * Math.round(n / 2));
  return { width: even(width), height: even(height) };
}

/** The format with this id, or undefined for the main one (null) or an unknown id. */
export function findFormat(edl: { formats?: Format[] }, id: string | null): Format | undefined {
  return id === null ? undefined : edl.formats?.find((f) => f.id === id);
}

/** Add a format for this ratio. Nothing changes if the project already has that shape. */
export function addFormat<E extends Document>(edl: E, ratio: string): E {
  const size = formatSize(ratio, edl.output);
  if (!size || sameShape(size, edl.output)) return edl;
  if ((edl.formats ?? []).some((f) => sameShape(f, size))) return edl;
  if ((edl.formats ?? []).length >= MAX_FORMATS) return edl;
  return { ...edl, formats: [...(edl.formats ?? []), { id: ratio, ...size }] };
}

/** Remove a format and everything framed for it. */
export function removeFormat<E extends Document>(edl: E, id: string): E {
  const out = loose(structuredClone(edl));
  out.formats = (out.formats ?? []).filter((f) => f.id !== id);
  if (!out.formats.length) delete out.formats;
  const drop = (el: El, key: "framing" | "placement") => {
    if (!el[key]) return;
    delete el[key]![id];
    if (!Object.keys(el[key]!).length) delete el[key];
  };
  out.main.elements.forEach((el) => drop(el, "framing"));
  out.overlays?.forEach((t) => t.elements.forEach((el) => drop(el, "placement")));
  return out as unknown as E;
}

/**
 * Where each overlay sits in `format` when nothing was placed for it there:
 * where the format picker would move it from the main frame.
 */
function defaultPlacements(edl: Doc, format: Format): Map<string, Values> {
  const moved = reshape(edl as never, format.width, format.height) as unknown as Doc;
  const out = new Map<string, Values>();
  for (const track of moved.overlays ?? []) {
    for (const el of track.elements) out.set(el.id, pick(el, el.type === "text" ? ["x", "y", "fontSize"] : ["x", "y", "width"]));
  }
  return out;
}

/**
 * The document as `id` sees it: its frame, each clip's framing for it, each
 * overlay where it sits in it. A fresh copy, safe to edit. The main format's
 * view is a copy of the document itself.
 */
export function formatView<E extends Document>(edl: E, id: string | null): E {
  const format = findFormat(edl, id);
  const view = loose(structuredClone(edl));
  if (!format) return view as unknown as E;
  view.output = { ...view.output, width: format.width, height: format.height };
  for (const el of view.main.elements) {
    const base = pick(el, FRAMING_KEYS);
    strip(el, FRAMING_KEYS);
    Object.assign(el, el.framing?.[format.id] ?? { fit: "contain" });
    el.framing = { ...el.framing, [MAIN]: base };
  }
  const defaults = defaultPlacements(loose(edl), format);
  for (const track of view.overlays ?? []) {
    for (const el of track.elements) {
      const base = pick(el, PLACEMENT_KEYS);
      Object.assign(el, defaults.get(el.id), el.placement?.[format.id]);
      el.placement = { ...el.placement, [MAIN]: base };
    }
  }
  return view as unknown as E;
}

/**
 * Put an edited view back into the document. Framing and placement go to the
 * format, only where they differ from its default; everything else (timing,
 * words, sound, clips added, split or removed) goes to the shared cut. A clip
 * or title added in the view takes what it was given there in the main
 * format too.
 */
export function liftView<E extends Document>(doc: E, view: E, id: string | null): E {
  const format = findFormat(doc, id);
  const out = loose(structuredClone(view));
  if (!format) return out as unknown as E;
  out.output = { ...out.output, width: doc.output.width, height: doc.output.height };
  out.formats = structuredClone(doc.formats);

  for (const el of out.main.elements) {
    const here = pick(el, FRAMING_KEYS);
    const maps = { ...el.framing };
    const base = maps[MAIN] ?? here;
    delete maps[MAIN];
    strip(el, FRAMING_KEYS);
    Object.assign(el, base);
    if (isWholeShot(here)) delete maps[format.id];
    else maps[format.id] = here;
    if (Object.keys(maps).length) el.framing = maps;
    else delete el.framing;
  }

  // Placement defaults follow the main format's positions, as they are after the lift.
  const tracks = out.overlays ?? [];
  const placed = new Map<string, Values>();
  for (const track of tracks) {
    for (const el of track.elements) {
      const here = pick(el, PLACEMENT_KEYS);
      const maps = { ...el.placement };
      const base = maps[MAIN] ?? here;
      delete maps[MAIN];
      strip(el, PLACEMENT_KEYS);
      Object.assign(el, base);
      placed.set(el.id, here);
      if (Object.keys(maps).length) el.placement = maps;
      else delete el.placement;
    }
  }
  const defaults = defaultPlacements(out, format);
  for (const track of tracks) {
    for (const el of track.elements) {
      const here = placed.get(el.id)!;
      const maps = { ...el.placement };
      if (samePlace(here, defaults.get(el.id) ?? {})) delete maps[format.id];
      else maps[format.id] = here;
      if (Object.keys(maps).length) el.placement = maps;
      else delete el.placement;
    }
  }
  return out as unknown as E;
}

/** What the render service gets for one format: its view, without this app's format fields. */
export function renderDoc<E extends Document>(edl: E, id: string | null): E {
  const view = loose(formatView(edl, id));
  delete view.formats;
  for (const el of view.main.elements) delete el.framing;
  for (const track of view.overlays ?? []) for (const el of track.elements) delete el.placement;
  return view as unknown as E;
}

/** How many video clips show their whole shot in a format: none was framed for it. */
export function wholeShotClips(edl: Document, id: string | null): number {
  if (!findFormat(edl, id)) return 0;
  return loose(edl).main.elements.filter((el) => el.type === "video" && !el.framing?.[id!]).length;
}
