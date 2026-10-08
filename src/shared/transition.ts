// Transitions between main-track clips, as the edit service renders them:
// ffmpeg's xfade on the picture and acrossfade on the sound. A transition
// sits on the cut, centred, the way editors place one: half plays before the
// cut and half after. Through it the outgoing clip runs on past its out-point
// and the incoming one starts before its in-point, into the footage beyond
// their trims (an edge frame holds where there is none). No clip moves, so
// the video keeps its length and everything timed on it stays put.
//
// Three things live here so the editor, the export and Ask agree:
//   - the names the document uses (the service maps them to xfade's own);
//   - where each clip sits and how each transition spans its cut, in whole
//     output frames and with the service's rule for a transition that doesn't
//     fit, so the preview's timeline is the file's;
//   - each style's look partway through, taken from xfade's own formulas
//     (vf_xfade.c in ffmpeg 4.4.2, the render container's), so the preview
//     draws the frame the export renders.

export const TRANSITION_TYPES = [
  "dissolve",
  "fade-black",
  "fade-white",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "blur",
  "pixelize",
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

export interface Transition {
  type: TransitionType;
  /** Seconds it plays, centred on the cut. */
  duration: number;
}

/** The longest transition the edit service accepts. */
export const MAX_TRANSITION_SECONDS = 5;

/** A new transition's length: long enough to read, short enough for a quick cut. */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** The editor's names for each style, in the groups its picker shows. */
export const TRANSITION_GROUPS: { label: string; items: { type: TransitionType; name: string }[] }[] = [
  {
    label: "Blend",
    items: [
      { type: "dissolve", name: "Dissolve" },
      { type: "fade-black", name: "Fade through black" },
      { type: "fade-white", name: "Fade through white" },
    ],
  },
  {
    label: "Wipe",
    items: [
      { type: "wipe-left", name: "Wipe left" },
      { type: "wipe-right", name: "Wipe right" },
      { type: "wipe-up", name: "Wipe up" },
      { type: "wipe-down", name: "Wipe down" },
    ],
  },
  {
    label: "Slide",
    items: [
      { type: "slide-left", name: "Slide left" },
      { type: "slide-right", name: "Slide right" },
      { type: "slide-up", name: "Slide up" },
      { type: "slide-down", name: "Slide down" },
    ],
  },
  {
    label: "Effect",
    items: [
      { type: "blur", name: "Blur" },
      { type: "pixelize", name: "Pixelate" },
    ],
  },
];

export function transitionName(type: TransitionType): string {
  for (const group of TRANSITION_GROUPS) {
    const item = group.items.find((i) => i.type === type);
    if (item) return item.name;
  }
  return type;
}

/** A main-track clip on the output timeline. All are seconds. */
export interface Placed {
  start: number;
  /** What the clip plays. */
  dur: number;
  /** The transition into it, around its start: what plays before the cut and after it. 0 for a cut. */
  before: number;
  after: number;
}

/**
 * Where each main-track clip sits: end to end, in whole output frames as the
 * service renders them, so a transition moves nothing. `lengths` is what each
 * clip plays, 0 while that is not known yet. A transition that doesn't fit is
 * shortened, left to right: its half before the cut takes at most what the
 * clip before has left after its own transition in, its half after at most
 * the clip it comes into. Odd frames put the extra one after the cut. The
 * first clip has none, and one with no room is a hard cut.
 */
export function layOut(
  lengths: number[],
  transitions: (Transition | undefined)[],
  fps: number,
): { placed: Placed[]; total: number } {
  const frames = lengths.map((l) => (l > 0 ? Math.max(1, Math.round(l * fps)) : 0));
  const before: number[] = [];
  const after: number[] = [];
  frames.forEach((f, k) => {
    const t = transitions[k];
    const want = k > 0 && t ? Math.max(1, Math.round(t.duration * fps)) : 0;
    const d = k === 0 ? 0 : Math.max(0, Math.min(want, 2 * (frames[k - 1] - after[k - 1]), 2 * f));
    before.push(Math.floor(d / 2));
    after.push(d - Math.floor(d / 2));
  });
  let end = 0;
  const placed = frames.map((f, k) => {
    const start = end;
    end += f;
    return { start: start / fps, dur: f / fps, before: before[k] / fps, after: after[k] / fps };
  });
  return { placed, total: end / fps };
}

/** How one clip's layer is drawn partway through a transition. */
export interface LayerLook {
  opacity: number;
  transform?: string;
  clipPath?: string;
}

export interface TransitionLook {
  /** The colour a fade passes through, laid under both clips. */
  through?: string;
  /** The clip going out, and the one coming in (drawn on top). */
  from: LayerLook;
  to: LayerLook;
  /** blur: the width in output pixels of the box each row is averaged over. */
  blurBox?: number;
  /** pixelize: the size in output pixels of the blocks the picture is sampled in. */
  block?: number;
  /** Each clip's sound, as acrossfade's default (linear) curves. */
  gains: [number, number];
}

/**
 * Each style at `p`, the share of the transition gone by (0 to 1), on a frame
 * of `frame` pixels. xfade's own progress runs the other way (1 to 0); it is
 * `q` below, so each formula can be read against the source.
 */
export function transitionLook(type: TransitionType, p: number, frame: { width: number; height: number }): TransitionLook {
  const q = 1 - Math.max(0, Math.min(1, p));
  const gains: [number, number] = [q, 1 - q];
  // xfade's `fade`: mix(a, b, q) = a·q + b·(1−q). The incoming clip on top at
  // 1−q over the outgoing one gives exactly that.
  const blend: TransitionLook = { from: { opacity: 1 }, to: { opacity: 1 - q }, gains };
  const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

  switch (type) {
    case "dissolve":
      return blend;
    case "fade-black":
    case "fade-white": {
      // mix(mix(a, c, smoothstep(0.8, 1, q)), mix(c, b, smoothstep(0.2, 1, q)), q):
      // the outgoing clip is gone a fifth of the way in, then the incoming
      // one comes up. Its weights, laid over the colour as two layers.
      const wFrom = smoothstep(0.8, 1, q) * q;
      const wTo = (1 - smoothstep(0.2, 1, q)) * (1 - q);
      return {
        through: type === "fade-black" ? "#000" : "#fff",
        from: { opacity: wTo < 1 ? wFrom / (1 - wTo) : 0 },
        to: { opacity: wTo },
        gains,
      };
    }
    // Wipes: the incoming clip shows where x > W·q (left), x ≤ W·(1−q) (right),
    // y > H·q (up), y ≤ H·(1−q) (down).
    case "wipe-left":
      return { from: { opacity: 1 }, to: { opacity: 1, clipPath: `inset(0 0 0 ${pct(q)})` }, gains };
    case "wipe-right":
      return { from: { opacity: 1 }, to: { opacity: 1, clipPath: `inset(0 ${pct(q)} 0 0)` }, gains };
    case "wipe-up":
      return { from: { opacity: 1 }, to: { opacity: 1, clipPath: `inset(${pct(q)} 0 0 0)` }, gains };
    case "wipe-down":
      return { from: { opacity: 1 }, to: { opacity: 1, clipPath: `inset(0 0 ${pct(q)} 0)` }, gains };
    // Slides: both clips move together, the incoming one entering from the
    // far side, a full frame behind the outgoing one.
    case "slide-left":
      return { from: { opacity: 1, transform: `translateX(-${pct(1 - q)})` }, to: { opacity: 1, transform: `translateX(${pct(q)})` }, gains };
    case "slide-right":
      return { from: { opacity: 1, transform: `translateX(${pct(1 - q)})` }, to: { opacity: 1, transform: `translateX(-${pct(q)})` }, gains };
    case "slide-up":
      return { from: { opacity: 1, transform: `translateY(-${pct(1 - q)})` }, to: { opacity: 1, transform: `translateY(${pct(q)})` }, gains };
    case "slide-down":
      return { from: { opacity: 1, transform: `translateY(${pct(1 - q)})` }, to: { opacity: 1, transform: `translateY(-${pct(q)})` }, gains };
    case "blur": {
      // A blend, each row averaged over a box that widens to half the frame at
      // the midpoint and narrows again: size = 1 + (W/2)·prog.
      const prog = q <= 0.5 ? q * 2 : (1 - q) * 2;
      return { ...blend, blurBox: 1 + Math.trunc(Math.trunc(frame.width / 2) * prog) };
    }
    case "pixelize": {
      // A blend sampled at the centre of square blocks, largest (a twentieth
      // of the frame's short side) at the midpoint, in steps of a fiftieth.
      const dist = Math.ceil(Math.min(q, 1 - q) * 50) / 50;
      return { ...blend, block: (2 * dist * Math.min(frame.width, frame.height)) / 20 };
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
