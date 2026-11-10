// Editing the cut by asking for it.
//
// The model never writes the document. It calls a fixed set of operations,
// each one checked here, and the result is validated as a whole before it
// reaches the project. A model that free-writes an EDL produces documents
// that are subtly wrong (a trim past the end of a clip, an overlay with no
// track) and fail at export instead of at the edit.
//
// One instruction is one batch, so the editor can put the whole thing back
// with a single undo.

import { MAX_TEXT_CHARS, validateEdl, type Edl, type EdlInvalid } from "./edl";
import { keepEdgeFades, splitClip } from "../shared/split";
import { MAX_FADE_SECONDS } from "../shared/fade";
import {
  DEFAULT_TRANSITION_SECONDS,
  MAX_TRANSITION_SECONDS,
  TRANSITION_TYPES,
  transitionName,
  type Transition,
  type TransitionType,
} from "../shared/transition";
import { FORMAT_PRESETS, reshape, sameShape, sizeFor } from "../shared/format";
import { addFormat, MAX_FORMATS } from "../shared/formats";
import { ADJUST_KEYS, cleanAdjust, describeAdjust, type Adjust } from "../shared/adjust";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";
const MODEL = "google/gemini-3.7-flash";
const MAX_ROUNDS = 6;

export interface InstructConfig {
  openrouterKey?: string;
  servicesUrl?: string;
}

/** Watches a clip's window and says which parts of the source to keep. */
export type ClipAnalyzer = (
  assetId: string,
  window: { start: number; end: number } | undefined,
  focus: string | undefined,
) => Promise<{ keeps: { start: number; end: number }[]; notes: string } | { error: string }>;

/** One of the project's highlights, as the model reads it and add_highlight places it. */
export interface InstructHighlight {
  id: string;
  /** `asset:<id>` of its clip. */
  src: string;
  kind: "soundbite" | "broll";
  /** Seconds into the clip. */
  start: number;
  end: number;
  text: string;
  speaker: string;
  score: number;
  kept: boolean;
  /** One of the best the project asked for a number of (src/server/highlights.ts). */
  best?: boolean;
}

export interface InstructFailure {
  error: string;
  detail: string;
}

/** One applied operation, in the words the editor shows the user. */
export type AppliedOp = string;

interface Clip {
  type: "video" | "image";
  adjust?: Adjust;
  fadeIn?: number;
  fadeOut?: number;
  transition?: Transition;
  duration?: number;
  trimStart?: number;
  volume?: number;
  sourceAudio?: boolean;
  src: string;
  id: string;
}

const OPS = [
  {
    name: "trim_clip",
    description:
      "Set where a main-track clip starts and how long it plays. `start` is seconds into the source, `seconds` is how long to play from there. Use it to cut dead air off a clip's head or tail.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer", description: "0-based position on the main track" },
        start: { type: "number", description: "seconds into the source" },
        seconds: { type: "number", description: "how long to play, in seconds" },
      },
      required: ["clip"],
    },
  },
  {
    name: "split_clip",
    description: "Cut a main-track clip in two at a point measured in seconds from the clip's own start.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer" },
        at: { type: "number", description: "seconds from the start of the clip as it plays now" },
      },
      required: ["clip", "at"],
    },
  },
  {
    name: "delete_clip",
    description: "Remove a clip from the main track.",
    parameters: { type: "object", properties: { clip: { type: "integer" } }, required: ["clip"] },
  },
  {
    name: "move_clip",
    description: "Move a main-track clip to another position; the sequence is the order they play in.",
    parameters: {
      type: "object",
      properties: { clip: { type: "integer" }, to: { type: "integer", description: "0-based destination" } },
      required: ["clip", "to"],
    },
  },
  {
    name: "set_clip_audio",
    description: "Mute a clip's own sound, or set its volume (1 is the source level).",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer" },
        muted: { type: "boolean" },
        volume: { type: "number", description: "0 to 2" },
      },
      required: ["clip"],
    },
  },
  {
    name: "adjust_color",
    description:
      "Change the colour of a main-track clip, of every main-track clip at once (`every`: footage from one camera usually needs one fix), or of a video or image overlay (`track` and `index`). Each value runs -100 to 100 and 0 is unchanged; temperature above 0 is warmer, below is cooler; saturation -100 is black and white. Values given replace the clip's own; values left out stay as they are. You cannot see the footage: change colour only when asked, and only as far as asked.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer", description: "0-based position on the main track" },
        every: { type: "boolean", description: "every clip on the main track" },
        track: { type: "integer", description: "overlay track of a video or image overlay" },
        index: { type: "integer", description: "its position on that track" },
        brightness: { type: "number" },
        contrast: { type: "number" },
        saturation: { type: "number" },
        temperature: { type: "number" },
      },
    },
  },
  {
    name: "fade",
    description:
      "Fade a main-track clip up from black and down to black (its own sound fades with it), or fade an on-screen text or overlay in and out. To open the video on a fade, fade in clip 0; to end on one, fade out the last clip; a fade out on one clip and a fade in on the next make a fade through black. Give `clip` for a main-track clip, or `track` and `index` for a text or overlay.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer", description: "0-based position on the main track" },
        track: { type: "integer", description: "overlay track of a text or overlay" },
        index: { type: "integer", description: "its position on that track" },
        in: { type: "number", description: `seconds to fade in, 0 to remove, at most ${MAX_FADE_SECONDS}` },
        out: { type: "number", description: `seconds to fade out, 0 to remove, at most ${MAX_FADE_SECONDS}` },
      },
    },
  },
  {
    name: "transition",
    description:
      "Join a main-track clip to the one before it with a transition instead of a hard cut. It is centred on the cut, half before and half after, and moves no clip: the video keeps its length. `none` removes it. Clip 0 has nothing before it. Give `clip` for one cut, or `every: true` for every cut in the video.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer", description: "0-based position on the main track of the clip that comes in, 1 or more" },
        every: { type: "boolean", description: "set it on every clip after the first" },
        type: { type: "string", enum: ["none", ...TRANSITION_TYPES] },
        seconds: { type: "number", description: `how long it plays, centred on the cut, default ${DEFAULT_TRANSITION_SECONDS}, at most ${MAX_TRANSITION_SECONDS}` },
      },
      required: ["type"],
    },
  },
  {
    name: "add_text",
    description:
      "Put a line of text on screen. Times are seconds on the finished video, not inside a clip. Position is a fraction of the frame: x 0.5 is the middle, y 0.85 sits near the bottom.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        start: { type: "number", description: "seconds on the output timeline" },
        seconds: { type: "number" },
        x: { type: "number", description: "0 to 1, default 0.5" },
        y: { type: "number", description: "0 to 1, default 0.85" },
        size: { type: "integer", description: "font size in pixels of the canvas, default 40" },
      },
      required: ["text", "start", "seconds"],
    },
  },
  {
    name: "remove_text",
    description: "Remove an on-screen text element by the number shown in the document.",
    parameters: {
      type: "object",
      properties: { track: { type: "integer" }, index: { type: "integer" } },
      required: ["track", "index"],
    },
  },
  {
    name: "clean_up_clip",
    description:
      "Watch one main-track clip and keep only what should stay: drops dead air, long pauses, false starts, filler and broken moments. You cannot see or hear the footage yourself, so use this for any request about what is said or shown ('cut where needed', 'remove the pauses'). It replaces the clip with the parts worth keeping.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer" },
        focus: { type: "string", description: "optional: what to look for, in the user's words" },
      },
      required: ["clip"],
    },
  },
  {
    name: "add_highlight",
    description:
      "Put one of the footage's highlights into the cut, as a main-track clip trimmed to it. Highlights are listed with the cut; use their id. A soundbite keeps its sound; b-roll plays without its own sound unless `sound` says otherwise.",
    parameters: {
      type: "object",
      properties: {
        highlight: { type: "string", description: "the highlight's id, as listed" },
        at: { type: "integer", description: "0-based position on the main track to put it at; the end when left out" },
        sound: { type: "boolean", description: "whether its own sound plays" },
      },
      required: ["highlight"],
    },
  },
  {
    name: "add_clip",
    description:
      "Put one of the listed videos onto the main track: the whole video, or `seconds` of it from `start`. Use it when the person refers to videos they added that are not in the cut yet.",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: "the video's id as listed, e.g. v2" },
        start: { type: "number", description: "seconds into the video to start from; 0 when left out" },
        seconds: { type: "number", description: "how long to play; to its end when left out" },
        at: { type: "integer", description: "0-based position on the main track to put it at; the end when left out" },
      },
      required: ["video"],
    },
  },
  {
    name: "assemble",
    description:
      "Watch up to 8 of the listed videos together and build the strongest cut from them for a brief: the best moments in order, trimmed, with captions. It REPLACES the main track. Use it for 'make a video/reel/cut from these clips'; you cannot see the footage yourself, so do not pick moments by guessing.",
    parameters: {
      type: "object",
      properties: {
        videos: { type: "array", items: { type: "string" }, description: "ids of the videos to use, as listed" },
        brief: { type: "string", description: "what the cut is for, in the person's words: length, tone, audience" },
      },
      required: ["videos", "brief"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the person before changing anything: a question when the request could mean different things (which clip, which talk, how long), or your plan in a sentence or two when it would watch more than two clips. Call it alone, before any change; their answer comes back as their next message.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "what to ask, or the plan to confirm, in plain words" } },
      required: ["question"],
    },
  },
  {
    name: "set_format",
    description: `Change the shape of the main video. ${FORMAT_PRESETS.map((p) => `${p.ratio} is ${p.name.toLowerCase()} (${p.hint})`).join("; ")}. To deliver the same cut in another shape as well, use add_format instead.`,
    parameters: {
      type: "object",
      properties: { format: { type: "string", enum: FORMAT_PRESETS.map((p) => p.ratio) } },
      required: ["format"],
    },
  },
  {
    name: "add_format",
    description:
      "Deliver the same cut in another shape too, such as a 9:16 version of a 16:9 video. Timing, words and sound stay shared; " +
      "each clip starts there on its whole shot, for the person to frame.",
    parameters: {
      type: "object",
      properties: { format: { type: "string", enum: FORMAT_PRESETS.map((p) => p.ratio) } },
      required: ["format"],
    },
  },
] as const;

const rid = () => Math.random().toString(36).slice(2, 10);

/** Apply one operation to a draft. Returns what to tell the user, or an error. */
export function apply(
  draft: Edl,
  name: string,
  args: Record<string, unknown>,
  highlights: Map<string, InstructHighlight> = new Map(),
): { said: string } | { error: string } {
  const main = draft.main.elements as unknown as Clip[];
  const clipAt = (n: unknown): Clip | null => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 0 && i < main.length ? main[i] : null;
  };

  switch (name) {
    case "trim_clip": {
      const clip = clipAt(args.clip);
      if (!clip) return { error: `there is no clip ${args.clip}` };
      if (typeof args.start === "number") clip.trimStart = Math.max(0, args.start);
      if (typeof args.seconds === "number") {
        if (args.seconds < 0.05) return { error: "a clip has to play for at least 0.05 seconds" };
        clip.duration = args.seconds;
      }
      return { said: `Trimmed clip ${args.clip} to ${clip.duration?.toFixed(1) ?? "?"}s from ${(clip.trimStart ?? 0).toFixed(1)}s` };
    }
    case "split_clip": {
      const i = Number(args.clip);
      const clip = clipAt(i);
      const at = Number(args.at);
      if (!clip) return { error: `there is no clip ${args.clip}` };
      const halves = splitClip(clip, at, clip.duration, rid());
      if (!halves) return { error: "split at a point inside the clip, after its start and before its end" };
      main.splice(i, 1, ...halves);
      return { said: `Split clip ${i} at ${at.toFixed(1)}s` };
    }
    case "delete_clip": {
      const i = Number(args.clip);
      if (!clipAt(i)) return { error: `there is no clip ${args.clip}` };
      main.splice(i, 1);
      return { said: `Removed clip ${i}` };
    }
    case "move_clip": {
      const from = Number(args.clip);
      const to = Number(args.to);
      if (!clipAt(from)) return { error: `there is no clip ${args.clip}` };
      if (!Number.isInteger(to) || to < 0 || to >= main.length) return { error: `cannot move to ${args.to}` };
      main.splice(to, 0, main.splice(from, 1)[0]);
      return { said: `Moved clip ${from} to position ${to}` };
    }
    case "set_clip_audio": {
      const clip = clipAt(args.clip);
      if (!clip) return { error: `there is no clip ${args.clip}` };
      if (typeof args.muted === "boolean") clip.sourceAudio = !args.muted;
      if (typeof args.volume === "number") clip.volume = Math.max(0, Math.min(2, args.volume));
      return { said: args.muted ? `Muted clip ${args.clip}` : `Set clip ${args.clip} volume` };
    }
    case "fade": {
      const target: { fadeIn?: number; fadeOut?: number } | null | undefined =
        args.clip !== undefined ? clipAt(args.clip) : draft.overlays?.[Number(args.track)]?.elements[Number(args.index)];
      if (!target) return { error: args.clip !== undefined ? `there is no clip ${args.clip}` : "there is no text or overlay there" };
      if (typeof args.in !== "number" && typeof args.out !== "number") return { error: "give `in` or `out` seconds" };
      const seconds = (n: number) => Math.round(Math.min(MAX_FADE_SECONDS, Math.max(0, n)) * 10) / 10 || undefined;
      if (typeof args.in === "number") target.fadeIn = seconds(args.in);
      if (typeof args.out === "number") target.fadeOut = seconds(args.out);
      const what = args.clip !== undefined ? `clip ${args.clip}` : `${args.track}.${args.index}`;
      return { said: target.fadeIn || target.fadeOut ? `Set the fades on ${what}` : `Removed the fades on ${what}` };
    }
    case "adjust_color": {
      const given = ADJUST_KEYS.filter((k) => typeof args[k] === "number" && Number.isFinite(args[k]));
      if (!given.length) return { error: `give at least one of ${ADJUST_KEYS.join(", ")}, from -100 to 100` };
      let targets: { adjust?: Adjust }[];
      let what: string;
      if (args.every === true) {
        targets = main;
        what = "every clip";
      } else if (args.clip !== undefined) {
        const clip = clipAt(args.clip);
        if (!clip) return { error: `there is no clip ${args.clip}` };
        targets = [clip];
        what = `clip ${args.clip}`;
      } else {
        const el = draft.overlays?.[Number(args.track)]?.elements[Number(args.index)];
        if (!el || el.type === "text") return { error: "there is no video or image overlay there" };
        targets = [el];
        what = `overlay ${args.track}.${args.index}`;
      }
      for (const t of targets) {
        const next: Adjust = { ...t.adjust };
        for (const k of given) next[k] = (args[k] as number) / 100;
        t.adjust = cleanAdjust(next);
        if (!t.adjust) delete t.adjust;
      }
      const now = describeAdjust(targets[0].adjust);
      return { said: now ? `Set the colour of ${what}: ${now}` : `Put the colour of ${what} back as shot` };
    }
    case "transition": {
      const type = String(args.type ?? "");
      if (type !== "none" && !(TRANSITION_TYPES as readonly string[]).includes(type)) {
        return { error: `type must be none or one of ${TRANSITION_TYPES.join(", ")}` };
      }
      const every = args.every === true;
      if (every && main.length < 2) return { error: "there is only one clip, so there is no cut to join" };
      if (!every && Number(args.clip) === 0) return { error: "clip 0 has no clip before it to come in from" };
      const targets = every ? main.slice(1) : [clipAt(args.clip)];
      if (targets.some((c) => !c)) return { error: `there is no clip ${args.clip}` };
      const seconds =
        typeof args.seconds === "number"
          ? Math.round(Math.min(MAX_TRANSITION_SECONDS, Math.max(0.1, args.seconds)) * 10) / 10
          : DEFAULT_TRANSITION_SECONDS;
      for (const clip of targets as Clip[]) {
        if (type === "none") delete clip.transition;
        else clip.transition = { type: type as TransitionType, duration: seconds };
      }
      const what = every ? "every cut" : `clip ${args.clip}`;
      return type === "none"
        ? { said: `Removed the transition into ${what}` }
        : { said: `Joined ${what} with a ${seconds.toFixed(1)}s ${transitionName(type as TransitionType).toLowerCase()}` };
    }
    case "add_text": {
      const text = String(args.text ?? "").slice(0, MAX_TEXT_CHARS);
      if (!text.trim()) return { error: "the text is empty" };
      draft.overlays = draft.overlays ?? [];
      if (draft.overlays.length === 0) draft.overlays.push({ id: rid(), elements: [] });
      draft.overlays[0].elements.push({
        id: rid(),
        type: "text",
        text,
        startTime: Math.max(0, Number(args.start) || 0),
        duration: Math.max(0.05, Number(args.seconds) || 2),
        x: typeof args.x === "number" ? Math.min(1, Math.max(0, args.x)) : 0.5,
        y: typeof args.y === "number" ? Math.min(1, Math.max(0, args.y)) : 0.85,
        fontSize: typeof args.size === "number" ? Math.round(Math.min(400, Math.max(8, args.size))) : 40,
        color: "#ffffff",
        background: "#000000a0",
        align: "center",
      });
      return { said: `Added the text "${text.slice(0, 40)}"` };
    }
    case "remove_text": {
      const track = draft.overlays?.[Number(args.track)];
      const index = Number(args.index);
      if (!track?.elements[index]) return { error: "there is no text there" };
      track.elements.splice(index, 1);
      return { said: "Removed a text element" };
    }
    case "add_highlight": {
      const h = highlights.get(String(args.highlight ?? ""));
      if (!h) return { error: `there is no highlight "${args.highlight}"` };
      const at = args.at === undefined ? main.length : Number(args.at);
      if (!Number.isInteger(at) || at < 0 || at > main.length) return { error: `cannot put it at ${args.at}` };
      const sound = typeof args.sound === "boolean" ? args.sound : h.kind === "soundbite";
      main.splice(at, 0, {
        id: rid(),
        type: "video",
        src: h.src,
        trimStart: h.start,
        duration: Math.round((h.end - h.start) * 100) / 100,
        ...(sound ? {} : { sourceAudio: false }),
      } as Clip);
      const what = h.kind === "soundbite" ? `the soundbite "${h.text.slice(0, 40)}"` : `the shot of ${h.text.slice(0, 40).toLowerCase()}`;
      return { said: `Added ${what} at position ${at}` };
    }
    case "set_format": {
      // The same sizing and the same rescaling as the editor's Format picker.
      const preset = FORMAT_PRESETS.find((p) => p.ratio === args.format);
      if (!preset) return { error: `format must be one of ${FORMAT_PRESETS.map((p) => p.ratio).join(", ")}` };
      const size = sizeFor(preset.ratio, Math.max(draft.output.width, draft.output.height))!;
      if (draft.formats?.some((f) => sameShape(f, size))) {
        return { error: `${preset.ratio} is already one of this project's formats; it is edited and exported as its own version` };
      }
      Object.assign(draft, reshape(draft, size.width, size.height));
      return { said: `Set the video to ${preset.ratio} ${preset.name.toLowerCase()}` };
    }
    case "add_format": {
      const preset = FORMAT_PRESETS.find((p) => p.ratio === args.format);
      if (!preset) return { error: `format must be one of ${FORMAT_PRESETS.map((p) => p.ratio).join(", ")}` };
      const next = addFormat(draft, preset.ratio);
      if (next === draft) {
        return { error: `${preset.ratio} is already this project's shape or one of its formats, or it has ${MAX_FORMATS} already` };
      }
      Object.assign(draft, next);
      return { said: `Added a ${preset.ratio} ${preset.name.toLowerCase()} version; frame its shots in the editor` };
    }
    default:
      return { error: `no such operation "${name}"` };
  }
}

/** Run the clip analysis on one clip's window and keep only what it keeps. */
/**
 * Seconds of footage clean_up_clip would watch for this call: the clip's
 * window in its source. Infinity when the end is unknown, so it never counts
 * as quick.
 */
export function watchSeconds(draft: Edl, args: Record<string, unknown>, sourceSeconds: Map<string, number>): number {
  const el = draft.main.elements[Number(args.clip)];
  if (!el || el.type !== "video") return 0;
  const start = el.trimStart ?? 0;
  const length = sourceSeconds.get(el.src);
  const end = el.duration !== undefined ? start + el.duration : length !== undefined ? length - (el.trimEnd ?? 0) : undefined;
  return end === undefined ? Infinity : Math.max(0, end - start);
}

/** What a request answered inline may watch; past it, the request runs in the background. */
export const QUICK_WATCH_SECONDS = 180;

/** A request that needs more watching than a quick answer allows: nothing was changed. */
export interface NeedsBackground {
  /** Clips the model asked to watch so far: at least this many. */
  clips: number;
  /** Seconds of footage those clips hold (Infinity when one's length is unknown). */
  seconds: number;
}

export async function cleanUp(
  draft: Edl,
  args: Record<string, unknown>,
  sourceSeconds: Map<string, number>,
  analyze?: ClipAnalyzer,
): Promise<{ said: string } | { error: string }> {
  if (!analyze) return { error: "clip analysis is not available here" };
  const i = Number(args.clip);
  const el = draft.main.elements[i];
  if (!Number.isInteger(i) || !el) return { error: `there is no clip ${args.clip}` };
  if (el.type !== "video" || !el.src.startsWith("asset:")) return { error: "only a video from the library can be cleaned up" };

  const start = el.trimStart ?? 0;
  const length = sourceSeconds.get(el.src);
  const end =
    el.duration !== undefined ? start + el.duration : length !== undefined ? length - (el.trimEnd ?? 0) : undefined;
  const found = await analyze(el.src.slice(6), end !== undefined ? { start, end } : undefined, args.focus as string | undefined);
  if ("error" in found) return { error: found.error };

  const keeps = found.keeps.filter((k) => k.end - k.start >= 0.1);
  if (keeps.length === 0) return { error: "it found nothing worth keeping, so the clip was left alone" };
  const before = end !== undefined ? end - start : null;
  const after = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
  if (keeps.length === 1 && before !== null && before - after < 0.3) {
    return { said: `Watched clip ${i} and found nothing to cut (${found.notes})` };
  }
  const parts = keeps.map((k) => {
    const part = { ...structuredClone(el), id: rid(), trimStart: k.start, duration: k.end - k.start };
    delete (part as { trimEnd?: number }).trimEnd;
    return part;
  });
  keepEdgeFades(parts);
  draft.main.elements.splice(i, 1, ...parts);
  const removed = before !== null ? ` and removed ${(before - after).toFixed(1)}s` : "";
  return { said: `Cleaned up clip ${i}: kept ${keeps.length} part${keeps.length > 1 ? "s" : ""}${removed}` };
}

/** Place a listed video on the main track. */
export function addClip(draft: Edl, args: Record<string, unknown>, videos: Map<string, InstructVideo>): { said: string } | { error: string } {
  const v = videos.get(String(args.video ?? ""));
  if (!v) return { error: `there is no video "${args.video}"` };
  const main = draft.main.elements;
  const at = args.at === undefined ? main.length : Number(args.at);
  if (!Number.isInteger(at) || at < 0 || at > main.length) return { error: `cannot put it at ${args.at}` };
  const start = args.start === undefined ? 0 : Number(args.start);
  if (!Number.isFinite(start) || start < 0 || (v.seconds !== null && start >= v.seconds)) return { error: `start ${args.start} is outside the video` };
  let seconds = args.seconds === undefined ? undefined : Number(args.seconds);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0.05)) return { error: `cannot play ${args.seconds} seconds` };
  if (seconds !== undefined && v.seconds !== null) seconds = Math.min(seconds, v.seconds - start);
  main.splice(at, 0, {
    id: rid(),
    type: "video",
    src: v.src,
    ...(start > 0 ? { trimStart: Math.round(start * 100) / 100 } : {}),
    ...(seconds !== undefined ? { duration: Math.round(seconds * 100) / 100 } : {}),
  });
  return { said: `Added "${v.name}" at position ${at}` };
}

/** Build the main track from several listed videos (Auto-cut). */
async function assembleCut(
  draft: Edl,
  args: Record<string, unknown>,
  videos: Map<string, InstructVideo>,
  assemble?: Assembler,
): Promise<{ said: string } | { error: string }> {
  if (!assemble) return { error: "building a cut from several videos is not available here" };
  const ids = Array.isArray(args.videos) ? [...new Set(args.videos.map(String))] : [];
  if (ids.length === 0) return { error: "name the videos to use" };
  if (ids.length > MAX_ASSEMBLE) return { error: `use at most ${MAX_ASSEMBLE} videos at once` };
  const picked = ids.map((id) => videos.get(id));
  const missing = ids.filter((_, i) => !picked[i]);
  if (missing.length) return { error: `there is no video ${missing.map((m) => `"${m}"`).join(", ")}` };
  const out = await assemble(
    picked.map((v) => ({ id: v!.src.slice(6), name: v!.name })),
    String(args.brief ?? ""),
  );
  if ("error" in out) return { error: out.error };
  const next = out.edl(draft);
  draft.main.elements = next.main.elements;
  draft.overlays = next.overlays;
  const n = draft.main.elements.length;
  return { said: `Built the cut from ${ids.length} video${ids.length > 1 ? "s" : ""}: ${n} piece${n === 1 ? "" : "s"}${out.notes ? ` (${out.notes.slice(0, 200)})` : ""}` };
}

function fades(el: { fadeIn?: number; fadeOut?: number }): string {
  const parts = [el.fadeIn && `fades in ${el.fadeIn.toFixed(1)}s`, el.fadeOut && `fades out ${el.fadeOut.toFixed(1)}s`].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

/** A clip's colour, when it has been changed. */
function colour(el: { adjust?: Adjust }): string {
  const d = describeAdjust(el.adjust);
  return d ? `, colour ${d}` : "";
}

/** How a clip comes in, when it does not simply cut in. */
function joined(el: { transition?: Transition }, i: number): string {
  const t = i > 0 ? el.transition : undefined;
  return t ? `, comes in with a ${t.duration.toFixed(1)}s ${transitionName(t.type).toLowerCase()}` : "";
}

/** What the model is shown: the cut as a short list, not raw JSON. */
function describeEdl(edl: Edl, names: Map<string, string>): string {
  const clips = edl.main.elements.map((el, i) => {
    const name = names.get(el.src) ?? el.src;
    const from = el.trimStart ?? 0;
    const playing = "duration" in el && el.duration !== undefined ? `${el.duration.toFixed(1)}s` : "the rest";
    const audio = el.type === "video" && el.sourceAudio === false ? ", muted" : "";
    return `  clip ${i}: "${name}" from ${from.toFixed(1)}s, plays ${playing}${audio}${colour(el)}${fades(el)}${joined(el, i)}`;
  });
  const texts = (edl.overlays ?? []).flatMap((track, ti) =>
    track.elements.map((el, i) =>
      el.type === "text"
        ? `  text ${ti}.${i}: "${el.text}" at ${el.startTime.toFixed(1)}s for ${el.duration.toFixed(1)}s${fades(el)}`
        : `  overlay ${ti}.${i}: ${el.type}${colour(el)}${fades(el)}`,
    ),
  );
  return [
    `Canvas ${edl.output.width}x${edl.output.height} at ${edl.output.fps}fps.`,
    clips.length ? `Main track, in play order:\n${clips.join("\n")}` : "The main track is empty.",
    texts.length ? `On-screen text:\n${texts.join("\n")}` : "No on-screen text.",
  ].join("\n");
}

/** The highlights the model may use: kept ones first, then the best. */
const MAX_LISTED = 120;

function describeHighlights(list: InstructHighlight[]): string {
  if (!list.length) return "";
  const lines = list.slice(0, MAX_LISTED).map((h) => {
    const what = h.kind === "soundbite" ? `${h.speaker ? `${h.speaker}: ` : ""}"${h.text.slice(0, 160)}"` : h.text.slice(0, 120);
    return `  ${h.id}: ${h.kind}, score ${h.score}${h.kept ? ", kept" : ""}${h.best ? ", best" : ""}, ${(h.end - h.start).toFixed(1)}s, ${what}`;
  });
  const best = list.some((h) => h.best) ? "; best means one of the best set the person asked for" : "";
  return `\n\nHighlights from the footage (picked and scored from every clip; kept means a person chose it${best}):\n${lines.join("\n")}`;
}

function describeVideos(list: InstructVideo[]): string {
  if (!list.length) return "";
  const lines = list.map((v) => `  ${v.id}: "${v.name}"${v.seconds ? `, ${v.seconds.toFixed(1)}s` : ""}${v.inProject ? ", in this project" : ""}`);
  return `\n\nVideos that can be added (this project's first, then the library, newest first):\n${lines.join("\n")}`;
}

const SYSTEM = [
  "You edit a video by calling the operations you are given. You never write the document yourself.",
  "You cannot see or hear the footage. For anything that depends on its content (pauses, dead air, filler, 'cut where needed'), call clean_up_clip on each clip concerned.",
  "Clip times (start, seconds) are measured inside the source footage. Text times are measured on the finished video.",
  "Positions on the main track are the order the clips play in.",
  "Make the smallest set of changes that does what was asked, then stop and say in one sentence what you changed.",
  "If the request cannot be done with these operations, say so plainly instead of guessing.",
  "Earlier messages in this conversation are listed before the request; use them to resolve what 'it', 'that' or 'shorter' means. The cut shown is the current one, which may have been edited since.",
  "Call ask_user instead of guessing when the request is ambiguous, and to confirm your plan first when it would watch more than two clips. Never ask about something the request already says.",
  "When videos are listed that are not in the cut and the person asks to make something from 'these clips' or 'my videos', build it from them: assemble for a cut that needs the best moments, add_clip to place a video as it is. If it is unclear which videos they mean, ask.",
  "When highlights are listed, they are the best parts of the footage: to build or extend a cut from the footage, add them with add_highlight. Soundbites carry what is said; b-roll goes between them. Prefer kept ones, then ones marked best, then higher scores, and keep to the length asked for.",
].join(" ");

/** A video the model may add: in this project's footage or in the library, newest first. */
export interface InstructVideo {
  /** Short id the model uses, e.g. "v1". */
  id: string;
  /** `asset:<id>`. */
  src: string;
  name: string;
  seconds: number | null;
  inProject: boolean;
}

/** Builds a cut from several videos (Auto-cut): their asset ids in, a sequence out. */
export type Assembler = (
  clips: { id: string; name: string }[],
  brief: string,
) => Promise<{ edl: (current: Edl) => Edl; notes: string } | { error: string }>;

/** The most videos assemble watches at once, as Auto-cut. */
export const MAX_ASSEMBLE = 8;

/** One earlier turn of the conversation, as the model reads it. */
export interface InstructTurn {
  role: "user" | "assistant";
  text: string;
}

/** How many earlier turns the model reads: enough for follow-ups, bounded. */
export const HISTORY_TURNS = 12;

/**
 * Run one instruction against the cut. Returns the new document, whatever the
 * model says it did, and the operations that were actually applied.
 */
export async function instructEdit(
  edl: Edl,
  instruction: string,
  assetNames: Map<string, string>,
  cfg: InstructConfig,
  /** Source length in seconds by `asset:<id>`, to know where a clip's window ends. */
  sourceSeconds: Map<string, number> = new Map(),
  analyze?: ClipAnalyzer,
  /** The project's highlights, kept first then best: what add_highlight places. */
  highlights: InstructHighlight[] = [],
  /** The conversation so far, oldest first; only the last HISTORY_TURNS are read. */
  history: InstructTurn[] = [],
  /** Videos it may add, how to build a cut from several of them, and how much
   *  footage this run may watch: past it, it stops with `background` and
   *  changes nothing (omitted in a background job: no limit). */
  more: { videos?: InstructVideo[]; assemble?: Assembler; watchBudget?: number } = {},
): Promise<
  | { edl: Edl; said: string; applied: AppliedOp[]; asked?: true }
  | { background: NeedsBackground }
  | { failure: InstructFailure | EdlInvalid }
> {
  if (!cfg.openrouterKey) {
    return {
      failure: {
        error: "ai_unavailable",
        detail: "no OpenRouter key available to this app — add one in the dashboard's API Keys settings",
      },
    };
  }

  const draft = structuredClone(edl);
  const applied: AppliedOp[] = [];
  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM },
    ...history.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text.slice(0, 2000) })),
    {
      role: "user",
      content: `The cut right now:\n${describeEdl(draft, assetNames)}${describeHighlights(highlights)}${describeVideos(more.videos ?? [])}\n\nWhat to change: ${instruction}`,
    },
  ];
  const byId = new Map(highlights.map((h) => [h.id, h]));
  let watched = 0;
  let watchedClips = 0;
  // Offered only when there are highlights to place.
  const videos = new Map((more.videos ?? []).map((v) => [v.id, v]));
  const ops = OPS.filter(
    (op) =>
      (op.name !== "add_highlight" || highlights.length > 0) &&
      (op.name !== "add_clip" || videos.size > 0) &&
      (op.name !== "assemble" || (videos.size > 0 && !!more.assemble)),
  );

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.1,
        tools: ops.map((op) => ({ type: "function", function: op })),
      }),
    });
    if (!res.ok) {
      return { failure: { error: "ai_failed", detail: `the model call failed (${res.status})` } };
    }
    const body = (await res.json().catch(() => null)) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    } | null;
    const message = body?.choices?.[0]?.message;
    if (!message) return { failure: { error: "ai_failed", detail: "the model returned nothing" } };

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const checked = validateEdl(draft);
      if ("invalid" in checked) return { failure: checked.invalid };
      return { edl: checked.edl, said: message.content?.trim() || "Done.", applied };
    }

    // A question ends the turn: whatever was changed before it stays, and the
    // answer arrives as the next message.
    const question = calls.find((call) => call.function?.name === "ask_user");
    if (question) {
      let text = "";
      try {
        text = String((JSON.parse(question.function?.arguments ?? "{}") as { question?: unknown }).question ?? "").trim();
      } catch {
        /* falls through to the generic question */
      }
      const checked = validateEdl(draft);
      if ("invalid" in checked) return { failure: checked.invalid };
      return { edl: checked.edl, said: text || "Could you say a little more about what you want?", applied, asked: true };
    }

    // Watching footage takes a while. A quick answer may watch a little; past
    // that the whole request moves to the background, starting over there, so
    // nothing half-done reaches the cut.
    if (more.watchBudget !== undefined) {
      const watching = calls.filter((call) => call.function?.name === "clean_up_clip");
      if (watching.length) {
        const seconds = watching.reduce((sum, call) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
          } catch {
            /* counted as nothing; the run reports it */
          }
          return sum + watchSeconds(draft, args, sourceSeconds);
        }, watched);
        if (seconds > more.watchBudget) return { background: { clips: watchedClips + watching.length, seconds } };
        watched = seconds;
        watchedClips += watching.length;
      }
    }

    messages.push(message as Record<string, unknown>);
    // Clip numbers refer to the cut as it was when the model asked. A split or
    // clean-up inserts clips, so resolve each number to the clip itself first
    // and look up where it is now when its turn comes.
    const idsThisRound = draft.main.elements.map((el) => el.id);
    for (const [n, call] of calls.entries()) {
      const name = call.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        /* an unparsable argument is reported back as an error below */
      }
      if (typeof args.clip === "number") {
        const id = idsThisRound[args.clip];
        const now = draft.main.elements.findIndex((el) => el.id === id);
        args = { ...args, clip: id === undefined ? args.clip : now };
      }
      const out =
        name === "clean_up_clip"
          ? await cleanUp(draft, args, sourceSeconds, analyze)
          : name === "assemble"
            ? await assembleCut(draft, args, videos, more.assemble)
            : name === "add_clip"
              ? addClip(draft, args, videos)
              : apply(draft, name, args, byId);
      if ("said" in out) applied.push(out.said);
      // The model plans its next round from this, so the last answer carries
      // the cut as it now stands, positions included.
      const last = n === calls.length - 1;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content:
          ("said" in out ? `done: ${out.said}` : `could not: ${out.error}`) +
          (last ? `\n\nThe cut now:\n${describeEdl(draft, assetNames)}` : ""),
      });
    }
  }

  const checked = validateEdl(draft);
  if ("invalid" in checked) return { failure: checked.invalid };
  return { edl: checked.edl, said: "Stopped after several rounds.", applied };
}
