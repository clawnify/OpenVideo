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
import { FORMAT_PRESETS, reshape, sizeFor } from "../shared/format";
import { MAX_SPEED, MIN_SPEED, cleanSpeed, speedLabel, speedOf } from "../shared/speed";

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

export interface InstructFailure {
  error: string;
  detail: string;
}

/** One applied operation, in the words the editor shows the user. */
export type AppliedOp = string;

interface Clip {
  type: "video" | "image";
  fadeIn?: number;
  fadeOut?: number;
  transition?: Transition;
  duration?: number;
  trimStart?: number;
  volume?: number;
  sourceAudio?: boolean;
  speed?: number;
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
    name: "set_speed",
    description:
      "Play a main-track video clip faster or slower: 2 is twice as fast (the clip lasts half as long), 0.5 is slow motion, 1 is normal. The clip keeps the same footage and its sound keeps its pitch.",
    parameters: {
      type: "object",
      properties: {
        clip: { type: "integer" },
        speed: { type: "number", description: `${MIN_SPEED} to ${MAX_SPEED}` },
      },
      required: ["clip", "speed"],
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
    name: "set_format",
    description: `Change the shape of the finished video. ${FORMAT_PRESETS.map((p) => `${p.ratio} is ${p.name.toLowerCase()} (${p.hint})`).join("; ")}.`,
    parameters: {
      type: "object",
      properties: { format: { type: "string", enum: FORMAT_PRESETS.map((p) => p.ratio) } },
      required: ["format"],
    },
  },
] as const;

const rid = () => Math.random().toString(36).slice(2, 10);

/** Apply one operation to a draft. Returns what to tell the user, or an error. */
export function apply(draft: Edl, name: string, args: Record<string, unknown>): { said: string } | { error: string } {
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
      // `at` is time as the clip plays; the halves are cut in its source.
      const halves = splitClip(clip, at * speedOf(clip), clip.duration, rid());
      if (!halves) return { error: "split at a point inside the clip, after its start and before its end" };
      main.splice(i, 1, ...halves);
      return { said: `Split clip ${i} at ${at.toFixed(1)}s` };
    }
    case "set_speed": {
      const clip = clipAt(args.clip);
      if (!clip) return { error: `there is no clip ${args.clip}` };
      if (clip.type !== "video") return { error: "only a video clip has a speed" };
      if (typeof args.speed !== "number" || !(args.speed > 0)) return { error: `give a speed from ${MIN_SPEED} to ${MAX_SPEED}` };
      const speed = cleanSpeed(args.speed);
      if (speed === undefined) delete clip.speed;
      else clip.speed = speed;
      return { said: speed === undefined ? `Set clip ${args.clip} back to normal speed` : `Set clip ${args.clip} to ${speedLabel(speed)}` };
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
    case "set_format": {
      // The same sizing and the same rescaling as the editor's Format picker.
      const preset = FORMAT_PRESETS.find((p) => p.ratio === args.format);
      if (!preset) return { error: `format must be one of ${FORMAT_PRESETS.map((p) => p.ratio).join(", ")}` };
      const size = sizeFor(preset.ratio, Math.max(draft.output.width, draft.output.height))!;
      Object.assign(draft, reshape(draft, size.width, size.height));
      return { said: `Set the video to ${preset.ratio} ${preset.name.toLowerCase()}` };
    }
    default:
      return { error: `no such operation "${name}"` };
  }
}

/** Run the clip analysis on one clip's window and keep only what it keeps. */
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

function fades(el: { fadeIn?: number; fadeOut?: number }): string {
  const parts = [el.fadeIn && `fades in ${el.fadeIn.toFixed(1)}s`, el.fadeOut && `fades out ${el.fadeOut.toFixed(1)}s`].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
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
    const speed = speedOf(el) !== 1 ? ` at ${speedLabel(speedOf(el))}` : "";
    return `  clip ${i}: "${name}" from ${from.toFixed(1)}s, plays ${playing}${speed}${audio}${fades(el)}${joined(el, i)}`;
  });
  const texts = (edl.overlays ?? []).flatMap((track, ti) =>
    track.elements.map((el, i) =>
      el.type === "text"
        ? `  text ${ti}.${i}: "${el.text}" at ${el.startTime.toFixed(1)}s for ${el.duration.toFixed(1)}s${fades(el)}`
        : `  overlay ${ti}.${i}: ${el.type}${fades(el)}`,
    ),
  );
  return [
    `Canvas ${edl.output.width}x${edl.output.height} at ${edl.output.fps}fps.`,
    clips.length ? `Main track, in play order:\n${clips.join("\n")}` : "The main track is empty.",
    texts.length ? `On-screen text:\n${texts.join("\n")}` : "No on-screen text.",
  ].join("\n");
}

const SYSTEM = [
  "You edit a video by calling the operations you are given. You never write the document yourself.",
  "You cannot see or hear the footage. For anything that depends on its content (pauses, dead air, filler, 'cut where needed'), call clean_up_clip on each clip concerned.",
  "Clip times (start, seconds) are measured inside the source footage, at any speed: a clip that plays 10s of footage at 2x lasts 5s on the finished video. Text times are measured on the finished video.",
  "Positions on the main track are the order the clips play in.",
  "Make the smallest set of changes that does what was asked, then stop and say in one sentence what you changed.",
  "If the request cannot be done with these operations, say so plainly instead of guessing.",
].join(" ");

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
): Promise<{ edl: Edl; said: string; applied: AppliedOp[] } | { failure: InstructFailure | EdlInvalid }> {
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
    { role: "user", content: `The cut right now:\n${describeEdl(draft, assetNames)}\n\nWhat to change: ${instruction}` },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.1,
        tools: OPS.map((op) => ({ type: "function", function: op })),
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
        name === "clean_up_clip" ? await cleanUp(draft, args, sourceSeconds, analyze) : apply(draft, name, args);
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
