// EDL (edit decision list) — the document behind footage edit projects.
//
// Shape: one main track (clips laid end-to-end in array order — the sequence
// IS the order; a clip's transition sits on the cut into it), overlay tracks that composite on top (startTime-positioned),
// and audio tracks that mix under the cut. Times are plain seconds; positions
// and sizes are fractions of the canvas.
//
// This mirrors the managed edit service's contract, with one addition: media
// from this app's library is referenced as "asset:<asset-id>" and resolved to
// a staged source at export time. Drafts are allowed (an empty main track is
// valid here) — the full rules apply when exporting.
//
// Validation errors carry a JSON-pointer `path` into the document, so an
// editing loop can locate exactly what to fix.

import { z } from "zod";
import { MAX_FADE_SECONDS } from "../shared/fade";
import { MAX_DUCK_DB } from "../shared/duck";
import { MAX_TRANSITION_SECONDS, TRANSITION_TYPES } from "../shared/transition";

export const MAX_ELEMENTS = 100;
export const MAX_SOURCES = 20;
export const MAX_OUTPUT_SECONDS = 300; // 5 minutes
export const MAX_TEXT_CHARS = 500;
export const MAX_TRACKS = 10;
export const MAX_STROKE_PX = 80; // a fifth of the largest fontSize; drawn at most a fifth of its own (shared/outline.ts)

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #RGB, #RRGGBB or #RRGGBBAA");

const opaqueColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected #RGB or #RRGGBB");

// "asset:<id>" (this app's media library), staged "file:…", https URL, or an
// inline data: URI. Library assets are the normal case.
const src = z
  .string()
  .min(1)
  .refine(
    (s) =>
      s.startsWith("asset:") ||
      s.startsWith("file:stage/") ||
      s.startsWith("https://") ||
      s.startsWith("data:"),
    "src must be asset:<id>, file:stage/…, https://… or data:…;base64,…",
  );

const id = z.string().min(1).max(120);
const seconds = z.number().finite().min(0);

const clipBase = {
  id,
  src,
  /** Seconds trimmed off the source's head / tail. */
  trimStart: seconds.optional(),
  trimEnd: seconds.optional(),
};

const fit = z.enum(["contain", "cover"]);

/** Which part of a filled (cover) frame is kept, as CSS object-position: 0
 *  keeps the left/top edge, 1 the right/bottom. Ignored on contain. */
const anchor = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();

/** A region of the SOURCE frame, in shares of its width and height, cut out
 *  before the clip is fitted or filled (shared/crop.ts). */
const crop = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.01).max(1),
    height: z.number().finite().min(0.01).max(1),
  })
  .strict()
  .refine((c) => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, "crop must stay inside the frame");

/** How a main-track clip comes in from the one before it: centred on the cut
 *  for `duration`, shortened to fit when the clips are too short, moving no
 *  clip (shared/transition.ts). The first clip has nothing to come in from;
 *  the export leaves it off. */
const transition = z
  .object({
    type: z.enum(TRANSITION_TYPES),
    duration: seconds.min(0.05).max(MAX_TRANSITION_SECONDS),
  })
  .strict();

const mainVideo = z
  .object({
    ...clipBase,
    type: z.literal("video"),
    /** Play this many seconds from trimStart (instead of trimming the tail) —
     *  "10s starting at 0:32" without knowing the source's length. Wins over
     *  trimEnd when both are set. */
    duration: seconds.min(0.05).max(MAX_OUTPUT_SECONDS).optional(),
    /** Mix this clip's own audio into the output. Default true. */
    sourceAudio: z.boolean().optional(),
    volume: z.number().finite().min(0).max(2).optional(),
    fit: fit.optional(),
    anchor: anchor.optional(),
    crop: crop.optional(),
    /** Seconds to fade up from black, and down to black before the clip
     *  ends; a video clip's own sound fades with it. shared/fade.ts */
    fadeIn: seconds.max(MAX_FADE_SECONDS).optional(),
    fadeOut: seconds.max(MAX_FADE_SECONDS).optional(),
    transition: transition.optional(),
  })
  .strict();

const mainImage = z
  .object({
    ...clipBase,
    type: z.literal("image"),
    duration: seconds.min(0.05).max(MAX_OUTPUT_SECONDS),
    fit: fit.optional(),
    anchor: anchor.optional(),
    crop: crop.optional(),
    /** Seconds to fade up from black, and down to black before the clip
     *  ends; a video clip's own sound fades with it. shared/fade.ts */
    fadeIn: seconds.max(MAX_FADE_SECONDS).optional(),
    fadeOut: seconds.max(MAX_FADE_SECONDS).optional(),
    transition: transition.optional(),
  })
  .strict();

const overlayBase = {
  id,
  /** Seconds on the OUTPUT timeline. */
  startTime: seconds,
  duration: seconds.min(0.05).max(MAX_OUTPUT_SECONDS),
  /** Position in fractions of the canvas (0..1, top-left anchored). */
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  opacity: z.number().finite().min(0).max(1).optional(),
  /** Seconds to fade in from transparent, and out to transparent where the
   *  element is last seen (its end, or the cut's end if it runs past). */
  fadeIn: seconds.max(MAX_FADE_SECONDS).optional(),
  fadeOut: seconds.max(MAX_FADE_SECONDS).optional(),
};

const overlayMedia = z
  .object({
    ...overlayBase,
    ...clipBase,
    type: z.enum(["video", "image"]),
    /** Fraction of canvas width; height keeps the (cropped) source aspect. */
    width: z.number().finite().min(0.01).max(1),
    crop: crop.optional(),
  })
  .strict();

const overlayText = z
  .object({
    ...overlayBase,
    type: z.literal("text"),
    text: z.string().min(1).max(MAX_TEXT_CHARS),
    fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
    fontSize: z.number().int().min(8).max(400),
    color: hexColor.optional(),
    /** Optional boxed background behind the text, e.g. "#00000080". */
    background: hexColor.optional(),
    /** Optional outline around the letters, `width` px at output resolution.
     *  Drawn at most a fifth of `fontSize` wide (`drawnStroke`), so shrinking
     *  the text never makes the document invalid. Opaque only: the preview
     *  draws it from overlapping copies, which would darken a translucent
     *  colour where they meet. */
    stroke: z
      .object({ color: opaqueColor, width: z.number().int().min(1).max(MAX_STROKE_PX) })
      .strict()
      .optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();

const overlayTrack = z
  .object({
    id,
    hidden: z.boolean().optional(),
    elements: z.array(z.discriminatedUnion("type", [overlayMedia, overlayText])),
  })
  .strict();

const audioElement = z
  .object({
    ...clipBase,
    type: z.literal("audio"),
    startTime: seconds,
    /** Default: source length minus trims. */
    duration: seconds.min(0.05).max(MAX_OUTPUT_SECONDS).optional(),
    volume: z.number().finite().min(0).max(2).optional(),
    /** Seconds to ramp up from silence, and down to silence where the clip is
     *  last heard (its end, or the cut's end if it runs past). shared/fade.ts */
    fadeIn: seconds.max(MAX_FADE_SECONDS).optional(),
    fadeOut: seconds.max(MAX_FADE_SECONDS).optional(),
    /** Dip this many dB while someone on the main track speaks (ducking).
     *  This app's own field: the export turns it into the edit service's
     *  volume `envelope` from the transcripts' timing. shared/duck.ts */
    duck: z.number().finite().min(1).max(MAX_DUCK_DB).optional(),
  })
  .strict();

const audioTrack = z
  .object({
    id,
    muted: z.boolean().optional(),
    elements: z.array(audioElement),
  })
  .strict();

/**
 * Project captions: switched on once and styled once, with the words taken
 * from each clip's transcript. This app's own addition, like `asset:` sources:
 * the export expands it into ordinary text and removes it before the document
 * reaches the render service, whose contract stays as it is.
 */
const captionsSchema = z
  .object({
    enabled: z.boolean(),
    lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "a language code such as en or it"),
    style: z
      .object({
        size: z.number().finite().min(0.02).max(0.2),
        position: z.enum(["bottom", "top"]),
        margin: z.number().finite().min(0).max(0.5),
        background: z.boolean(),
        /** A dark outline around the letters. Absent on projects made before it existed. */
        outline: z.boolean().optional(),
        color: hexColor,
        maxChars: z.number().int().min(8).max(80),
      })
      .strict(),
  })
  .strict();

export const edlSchema = z
  .object({
    version: z.literal(1),
    output: z
      .object({
        width: z.number().int().min(16).max(3840).refine((n) => n % 2 === 0, "must be even"),
        height: z.number().int().min(16).max(2160).refine((n) => n % 2 === 0, "must be even"),
        fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
        background: hexColor.optional(),
      })
      .strict(),
    // Drafts may be empty; export requires at least one main element.
    main: z.object({ elements: z.array(z.discriminatedUnion("type", [mainVideo, mainImage])) }).strict(),
    overlays: z.array(overlayTrack).max(MAX_TRACKS).optional(),
    audio: z.array(audioTrack).max(MAX_TRACKS).optional(),
    captions: captionsSchema.optional(),
  })
  .strict();

export type Edl = z.infer<typeof edlSchema>;

export interface EdlInvalid {
  error: "edl_invalid";
  detail: string;
  /** JSON pointer into the document, e.g. "/main/elements/3/trimStart". */
  path?: string;
}

export function validateEdl(input: unknown): { edl: Edl } | { invalid: EdlInvalid } {
  const parsed = edlSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      invalid: {
        error: "edl_invalid",
        detail: issue.message,
        path: "/" + issue.path.map(String).join("/"),
      },
    };
  }
  const edl = parsed.data;

  const all = allElements(edl);
  if (all.length > MAX_ELEMENTS) {
    return { invalid: { error: "edl_invalid", detail: `too many elements: ${all.length} (max ${MAX_ELEMENTS})` } };
  }
  const sources = new Set(all.map((e) => ("src" in e ? e.src : null)).filter(Boolean));
  if (sources.size > MAX_SOURCES) {
    return { invalid: { error: "edl_invalid", detail: `too many distinct sources: ${sources.size} (max ${MAX_SOURCES})` } };
  }
  const ids = new Set<string>();
  for (const el of all) {
    if (ids.has(el.id)) {
      return { invalid: { error: "edl_invalid", detail: `duplicate element id: ${el.id}` } };
    }
    ids.add(el.id);
  }
  return { edl };
}

type AnyElement =
  | Edl["main"]["elements"][number]
  | NonNullable<Edl["overlays"]>[number]["elements"][number]
  | NonNullable<Edl["audio"]>[number]["elements"][number];

function allElements(edl: Edl): AnyElement[] {
  return [
    ...edl.main.elements,
    ...(edl.overlays ?? []).flatMap((t) => t.elements),
    ...(edl.audio ?? []).flatMap((t) => t.elements),
  ];
}

/** Distinct "asset:<id>" refs → the bare asset ids. */
export function collectAssetIds(edl: Edl): string[] {
  const ids = new Set<string>();
  for (const el of allElements(edl)) {
    if ("src" in el && el.src.startsWith("asset:")) ids.add(el.src.slice(6));
  }
  return [...ids];
}

/** Deep-copy the EDL with each "asset:<id>" src replaced via `resolve`. */
export function substituteAssetSrcs(edl: Edl, resolve: (assetId: string) => string): Edl {
  const out = structuredClone(edl);
  const swap = (el: { src?: string }) => {
    if (el.src?.startsWith("asset:")) el.src = resolve(el.src.slice(6));
  };
  out.main.elements.forEach(swap);
  (out.overlays ?? []).forEach((t) => t.elements.forEach((el) => swap(el as { src?: string })));
  (out.audio ?? []).forEach((t) => t.elements.forEach(swap));
  return out;
}

/** A fresh project's document: empty 720p timeline. */
export function starterEdl(): Edl {
  return {
    version: 1,
    output: { width: 1280, height: 720, fps: 30, background: "#000000" },
    main: { elements: [] },
    overlays: [],
    audio: [],
  };
}
