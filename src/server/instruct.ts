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

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";
const MODEL = "google/gemini-3.7-flash";
const MAX_ROUNDS = 6;

export interface InstructConfig {
  openrouterKey?: string;
  servicesUrl?: string;
}

export interface InstructFailure {
  error: string;
  detail: string;
}

/** One applied operation, in the words the editor shows the user. */
export type AppliedOp = string;

interface Clip {
  type: "video" | "image";
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
    name: "set_aspect",
    description:
      "Change the shape of the finished video: 'landscape' (16:9), 'vertical' (9:16) or 'square'.",
    parameters: {
      type: "object",
      properties: { shape: { type: "string", enum: ["landscape", "vertical", "square"] } },
      required: ["shape"],
    },
  },
] as const;

const SHAPES: Record<string, { width: number; height: number }> = {
  landscape: { width: 1280, height: 720 },
  vertical: { width: 720, height: 1280 },
  square: { width: 1080, height: 1080 },
};

const rid = () => Math.random().toString(36).slice(2, 10);

/** Apply one operation to a draft. Returns what to tell the user, or an error. */
function apply(draft: Edl, name: string, args: Record<string, unknown>): { said: string } | { error: string } {
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
      if (!(at > 0)) return { error: "split at a point after the clip starts" };
      const playing = clip.duration;
      if (playing !== undefined && at >= playing) return { error: "that point is past the end of the clip" };
      const second = { ...clip, id: rid(), trimStart: (clip.trimStart ?? 0) + at } as Clip;
      if (playing !== undefined) {
        second.duration = playing - at;
        clip.duration = at;
      }
      main.splice(i + 1, 0, second);
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
    case "set_aspect": {
      const shape = SHAPES[String(args.shape)];
      if (!shape) return { error: "shape must be landscape, vertical or square" };
      draft.output.width = shape.width;
      draft.output.height = shape.height;
      return { said: `Set the video to ${args.shape}` };
    }
    default:
      return { error: `no such operation "${name}"` };
  }
}

/** What the model is shown: the cut as a short list, not raw JSON. */
function describeEdl(edl: Edl, names: Map<string, string>): string {
  const clips = edl.main.elements.map((el, i) => {
    const name = names.get(el.src) ?? el.src;
    const from = el.trimStart ?? 0;
    const playing = "duration" in el && el.duration !== undefined ? `${el.duration.toFixed(1)}s` : "the rest";
    const audio = el.type === "video" && el.sourceAudio === false ? ", muted" : "";
    return `  clip ${i}: "${name}" from ${from.toFixed(1)}s, plays ${playing}${audio}`;
  });
  const texts = (edl.overlays ?? []).flatMap((track, ti) =>
    track.elements.map((el, i) =>
      el.type === "text"
        ? `  text ${ti}.${i}: "${el.text}" at ${el.startTime.toFixed(1)}s for ${el.duration.toFixed(1)}s`
        : `  overlay ${ti}.${i}: ${el.type}`,
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
  "Clip times (start, seconds) are measured inside the source footage. Text times are measured on the finished video.",
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
    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        /* an unparsable argument is reported back as an error below */
      }
      const out = apply(draft, name, args);
      if ("said" in out) applied.push(out.said);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: "said" in out ? `done: ${out.said}` : `could not: ${out.error}`,
      });
    }
  }

  const checked = validateEdl(draft);
  if ("invalid" in checked) return { failure: checked.invalid };
  return { edl: checked.edl, said: "Stopped after several rounds.", applied };
}
