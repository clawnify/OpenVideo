// Footage edit projects — the timeline editor over EDL documents.
//
// Layout (the classic four-region editor grid): left rail (Media / Audio /
// Text — exactly what the EDL supports, nothing else), center player, right
// context inspector, full-width timeline below. The preview shows cuts,
// layout and timing via stacked <video>/<img>/DOM elements on one master
// clock; pixel-exact rendering (fonts, encoder) is the export's job.
//
// All edits are pure transforms over the EDL (the main track is an ordered
// array — reordering is a splice, splitting is two trims), saved with a
// debounced PUT; validation errors surface with their JSON pointer.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { blockHeight, fitTop, lineStep, wrapLines } from "../shared/textLayout";
import { keepEdgeFades, splitClip } from "../shared/split";
import { drawnStroke, maxStrokeWidth, outlineShadow } from "../shared/outline";
import {
  DEFAULT_CAPTIONS,
  captionText,
  captionTimeline,
  type CaptionLine,
  type CaptionStyle,
  type ProjectCaptions,
} from "../shared/captions";
import { parseVtt, type Cue } from "../shared/transcript";
import { fadeGain, heardFor } from "../shared/fade";
import { sharedPrefix } from "../shared/names";
import {
  DEFAULT_TRANSITION_SECONDS,
  MAX_TRANSITION_SECONDS,
  TRANSITION_GROUPS,
  layOut,
  transitionLook,
  transitionName,
  type Transition,
  type TransitionType,
} from "../shared/transition";
import {
  FULL,
  cropToRatio,
  croppedShape,
  isFull,
  moveCrop,
  placeClip,
  resizeCrop,
  tidyCrop,
  type Crop,
  type Handle,
} from "../shared/crop";
import {
  CENTRE,
  FORMAT_PRESETS,
  coverOverflow,
  dragAnchor,
  parseRatio,
  presetFor,
  ratioLabel,
  reshape,
  sameShape,
  sizeFor,
  type Anchor,
} from "../shared/format";
import {
  Captions as CaptionsIcon,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Check,
  ChevronRight,
  Crop as CropIcon,
  Cloud,
  Film,
  Folder,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Type as TypeIcon,
  Upload,
  Wand2,
  X,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  EmptyState,
  Kbd,
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectTrigger,
  btnDanger,
  btnGhost,
  btnIcon,
  btnPrimary,
  btnSecondary,
  card,
  stretch,
} from "./ui";
import { cancelUpload, onUploaded, retryUpload, startUpload, useUploads, type UploadItem } from "./uploads";

// ── shared shapes (validated server-side; these are view types) ─────────────

export interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  /** Seconds, probed client-side at upload (null for legacy/images). */
  duration?: number | null;
  /** Set when the footage lives on the media service rather than in storage. */
  media_uid?: string | null;
}

/** A clip from one of the project's Drive folders. The log here is its short form. */
interface FootageItem {
  id: string;
  name: string;
  /** Where it sits, the shared folder's own name first: "Day 1/Cam B". */
  folder: string;
  status: "waiting" | "importing" | "ready" | "failed";
  error: string | null;
  asset: Asset | null;
  log_status: "preparing" | "running" | "done" | "failed" | null;
  log_error: string | null;
  log: { summary: string; kind: "interview" | "stage" | "b-roll" | "other"; quality: "good" | "usable" | "unusable" } | null;
}

interface FootageList {
  sources: { id: string; name: string; url: string }[];
  counts: {
    total: number;
    waiting: number;
    importing: number;
    ready: number;
    failed: number;
    logged: number;
    logging: number;
    log_failed: number;
  };
  /** Why nothing more is starting, when the workspace has hit a limit. */
  imports_paused: string | null;
  logging_paused: string | null;
  items: FootageItem[];
}

/** The clips that can go on the timeline: imported, and so assets. */
const readyFootage = (f: FootageList): Asset[] =>
  f.items.flatMap((i) => (i.status === "ready" && i.asset ? [i.asset] : []));

interface MainVideo {
  id: string;
  type: "video";
  src: string;
  trimStart?: number;
  trimEnd?: number;
  /** Play-window seconds from trimStart; wins over trimEnd. */
  duration?: number;
  sourceAudio?: boolean;
  volume?: number;
  fit?: "contain" | "cover";
  /** Which part of a filled frame is kept (shared/format.ts). */
  anchor?: Anchor;
  /** The part of the source kept, cut out before fitting (shared/crop.ts). */
  crop?: Crop;
  /** Seconds to fade from and to black (shared/fade.ts). */
  fadeIn?: number;
  fadeOut?: number;
  /** How it comes in from the clip before it (shared/transition.ts). */
  transition?: Transition;
}
interface MainImage {
  id: string;
  type: "image";
  src: string;
  duration: number;
  fit?: "contain" | "cover";
  anchor?: Anchor;
  crop?: Crop;
  /** Seconds to fade from and to black (shared/fade.ts). */
  fadeIn?: number;
  fadeOut?: number;
  transition?: Transition;
}
type MainElement = MainVideo | MainImage;

interface OverlayMedia {
  id: string;
  type: "video" | "image";
  src: string;
  startTime: number;
  duration: number;
  x: number;
  y: number;
  width: number;
  opacity?: number;
  trimStart?: number;
  trimEnd?: number;
  crop?: Crop;
  /** Seconds to fade from and to transparent, the out ending where it is last seen. */
  fadeIn?: number;
  fadeOut?: number;
}
interface OverlayText {
  id: string;
  type: "text";
  text: string;
  startTime: number;
  duration: number;
  x: number;
  y: number;
  opacity?: number;
  fontSize: number;
  fontFamily?: "sans" | "serif" | "mono";
  color?: string;
  background?: string;
  /** Outline around the letters, `width` px at output resolution. */
  stroke?: { color: string; width: number };
  align?: "left" | "center" | "right";
  /** Seconds to fade from and to transparent, the out ending where it is last seen. */
  fadeIn?: number;
  fadeOut?: number;
}
type OverlayElement = OverlayMedia | OverlayText;
interface OverlayTrack {
  id: string;
  hidden?: boolean;
  elements: OverlayElement[];
}

interface AudioElement {
  id: string;
  type: "audio";
  src: string;
  startTime: number;
  duration?: number;
  trimStart?: number;
  trimEnd?: number;
  volume?: number;
  /** Seconds of ramp from silence, and to silence where the clip is last heard (shared/fade.ts). */
  fadeIn?: number;
  fadeOut?: number;
}
interface AudioTrack {
  id: string;
  muted?: boolean;
  elements: AudioElement[];
}

export interface Edl {
  version: 1;
  output: { width: number; height: number; fps: 24 | 30 | 60; background?: string };
  main: { elements: MainElement[] };
  overlays?: OverlayTrack[];
  audio?: AudioTrack[];
  /** Project captions, worked out from the clips' transcripts. */
  captions?: ProjectCaptions;
}

type RailTab = "media" | "audio" | "text" | "captions";

export interface EditProject {
  id: string;
  name: string;
  edl: Edl;
  brief: string;
  updated_at: string;
}

interface ExportJob {
  id: number;
  project_id: string;
  status: "exporting" | "completed" | "failed";
  output_url: string | null;
  error: string | null;
  duration: number | null;
  created_at: string;
}

interface AnalyzeResult {
  cuts: { start_ms: number; end_ms: number; label: string; keep: boolean }[];
  captions: { start_ms: number; end_ms: number; text: string }[];
  notes: string;
}

// ── small helpers ───────────────────────────────────────────────────────────

async function errJson(r: Response): Promise<{ error?: string; detail?: string; path?: string }> {
  return (await r.json().catch(() => ({}))) as { error?: string; detail?: string; path?: string };
}

const api = {
  async get<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await errJson(r)).error || r.statusText);
    return r.json();
  },
  async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const e = await errJson(r);
      throw new Error(e.detail ? `${e.detail}${e.path ? ` (at ${e.path})` : ""}` : e.error || r.statusText);
    }
    return r.json();
  },
};

// Defaults for text the user burns INTO the video. Document content, not app
// chrome: white on footage and a translucent black box are the legible
// defaults for a caption, and the design tokens do not apply inside a frame.
const DEFAULT_TEXT_COLOR = "#ffffff";
const DEFAULT_TEXT_BOX = "#00000080";
/** What the Stroke controls start from: a black outline at 0 px is "none". */
const DEFAULT_TEXT_STROKE = { color: "#000000", width: 4 };

const rid = () => Math.random().toString(36).slice(2, 10);
/**
 * One URL shape for every asset: the server redirects to app storage or to
 * the media service, and a video element's range requests survive that.
 */
const assetUrl = (a: Asset) => `/api/assets/${encodeURIComponent(a.id)}/source`;

/**
 * Adaptive playback for one media-service clip. The library is fetched only
 * when such a clip actually plays, and Safari needs none of it.
 */
function MediaVideo({
  asset,
  elementRef,
  ...rest
}: {
  asset: Asset;
  elementRef: (v: HTMLVideoElement | null) => void;
} & React.VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let dead = false;
    let hls: { destroy: () => void } | null = null;

    (async () => {
      const play = await api.get<{ ready: boolean; hls?: string }>(`/api/assets/${asset.id}/playback`);
      if (dead || !play.ready || !play.hls) return;
      if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = play.hls;
        return;
      }
      const { default: Hls } = await import("hls.js");
      if (dead || !Hls.isSupported()) return;
      const instance = new Hls({ maxBufferLength: 30 });
      instance.loadSource(play.hls);
      instance.attachMedia(v);
      hls = instance;
    })().catch(() => {
      /* the tile already shows whether the clip is ready */
    });

    return () => {
      dead = true;
      hls?.destroy();
    };
  }, [asset.id]);

  return (
    <video
      ref={(v) => {
        ref.current = v;
        elementRef(v);
      }}
      {...rest}
    />
  );
}

/** A frame of media-service footage, which beats decoding the video for one. */
const frameUrl = (a: Pick<Asset, "id">, at = 0) => `/api/assets/${encodeURIComponent(a.id)}/frame?t=${Math.max(0, at).toFixed(1)}`;
const isVideoAsset = (a: Asset) => a.content_type.startsWith("video/");
const isImageAsset = (a: Asset) => a.content_type.startsWith("image/");
const isAudioAsset = (a: Asset) => a.content_type.startsWith("audio/");

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Duration of one main element given known source durations. */
function mainDur(el: MainElement, srcDur: (src: string) => number | undefined): number {
  if (el.type === "image") return el.duration;
  const d = srcDur(el.src);
  if (el.duration !== undefined) {
    // Play-window form: usable even before metadata loads (clamped when known).
    return d === undefined ? el.duration : Math.min(el.duration, Math.max(0, d - (el.trimStart ?? 0)));
  }
  if (d === undefined) return 0;
  return Math.max(0, d - (el.trimStart ?? 0) - (el.trimEnd ?? 0));
}

/**
 * Segments of the main track on the output timeline: end to end, in whole
 * output frames as the export renders them, each with the transition into it
 * around its start (`before` / `after` the cut), shortened to fit as the
 * export does (shared/transition.ts).
 */
function mainSegments(edl: Edl, srcDur: (src: string) => number | undefined) {
  const els = edl.main.elements;
  const { placed } = layOut(
    els.map((el) => mainDur(el, srcDur)),
    els.map((el) => el.transition),
    edl.output.fps,
  );
  return els.map((el, i) => ({ el, i, ...placed[i] }));
}

/** Where the cut ends: the last clip's end, in the same whole frames. */
function cutEnd(segments: { start: number; dur: number }[]): number {
  return segments.reduce((end, s) => Math.max(end, s.start + s.dur), 0);
}

// ── media metadata / filmstrip / waveform caches (module-level) ─────────────

const durCache = new Map<string, number>();
const peaksCache = new Map<string, number[]>();

function useSourceDurations(edl: Edl, assets: Asset[]) {
  // `version` is not cosmetic: it is what gives `srcDur` a new identity when a
  // duration lands, which is what invalidates the `segments` memo downstream.
  // Without it a project whose EDL already references an asset at mount (any
  // reopened project, or one an agent wrote) renders every clip at zero length
  // forever, because the cache fills after the memo has already been computed.
  const [version, bump] = useState(0);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const resolve = useCallback(
    (src: string): Asset | undefined => (src.startsWith("asset:") ? byId.get(src.slice(6)) : undefined),
    [byId],
  );

  useEffect(() => {
    const srcs = new Set<string>();
    for (const el of edl.main.elements) srcs.add(el.src);
    for (const t of edl.overlays ?? []) for (const el of t.elements) if ("src" in el) srcs.add((el as OverlayMedia).src);
    for (const t of edl.audio ?? []) for (const el of t.elements) srcs.add(el.src);
    for (const src of srcs) {
      if (durCache.has(src)) continue;
      const a = resolve(src);
      if (!a || isImageAsset(a)) continue;
      // Duration is data first (probed at upload); the network probe is only
      // the fallback for legacy assets — and it backfills the row it heals.
      if (typeof a.duration === "number" && a.duration > 0) {
        durCache.set(src, a.duration);
        bump((n) => n + 1);
        continue;
      }
      const media = document.createElement(isAudioAsset(a) ? "audio" : "video");
      media.preload = "metadata";
      media.src = assetUrl(a);
      media.onloadedmetadata = () => {
        durCache.set(src, media.duration);
        bump((n) => n + 1);
        fetch(`/api/assets/${a.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration: media.duration }),
        }).catch(() => {});
      };
    }
  }, [edl, resolve]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDur = useCallback((src: string) => durCache.get(src), [version]);
  return { srcDur, resolveAsset: resolve };
}

/** Draw a strip of frames from a video source into a canvas. */
function FilmStrip({ url, from, to, width, height }: { url: string; from: number; to: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width < 24) return;
    let dead = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = url;
    const n = Math.max(1, Math.min(10, Math.floor(width / 56)));
    const ctx = canvas.getContext("2d")!;
    v.onloadedmetadata = async () => {
      const span = Math.max(0.01, to - from);
      const fw = width / n;
      for (let i = 0; i < n && !dead; i++) {
        v.currentTime = Math.min(v.duration - 0.05, from + ((i + 0.5) * span) / n);
        await new Promise<void>((res) => {
          const done = () => (v.removeEventListener("seeked", done), res());
          v.addEventListener("seeked", done);
        });
        if (dead) return;
        // Fill the cell without distorting the frame: scale to cover, then
        // take the middle of what does not fit. A 16:9 clip in a narrow cell
        // was being squeezed sideways.
        const vw = v.videoWidth || fw;
        const vh = v.videoHeight || height;
        const scale = Math.max(fw / vw, height / vh);
        const sw = Math.min(vw, fw / scale);
        const sh = Math.min(vh, height / scale);
        ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, i * fw, 0, fw, height);
      }
    };
    return () => {
      dead = true;
      v.src = "";
    };
  }, [url, from, to, width, height]);
  return <canvas ref={ref} width={Math.max(1, width)} height={height} className="w-full h-full rounded-[3px]" />;
}

/**
 * The same strip for media-service footage, from the service's own frames.
 * Decoding a master in the browser to draw ten thumbnails competed with
 * playback for the same bytes, which is part of what made it stutter.
 */
function FrameStrip({ asset, from, to, width }: { asset: Asset; from: number; to: number; width: number }) {
  const n = Math.max(1, Math.min(10, Math.floor(width / 56)));
  const span = Math.max(0.01, to - from);
  return (
    <div className="flex w-full h-full">
      {Array.from({ length: n }, (_, i) => (
        <img
          key={i}
          src={frameUrl(asset, from + ((i + 0.5) * span) / n)}
          alt=""
          loading="lazy"
          className="h-full object-cover"
          style={{ width: `${100 / n}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Text drawn on the stage: a text overlay or a caption. The same line breaks
 * and placement the export uses, one centred line per element, so what shows
 * here is what renders.
 */
function TextOnStage({
  t,
  frame,
  scale,
  selected = false,
  onPointerDown,
}: {
  t: Pick<OverlayText, "text" | "fontSize" | "fontFamily" | "color" | "background" | "stroke" | "opacity" | "align" | "x" | "y">;
  frame: Edl["output"];
  scale: number;
  selected?: boolean;
  /** Absent for captions, which are placed by the project's style, not dragged. */
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const family = t.fontFamily ?? "sans";
  const lines = wrapLines(t.text, t.fontSize, frame.width, family);
  const step = lineStep(t.fontSize, !!t.background) / frame.height;
  const top = fitTop(t.y, blockHeight(t.text, t.fontSize, frame.width, family, !!t.background), frame.height);
  const stroke = drawnStroke(t.stroke, t.fontSize);
  return (
    <>
      {lines.map((line, n) =>
        line.trim() ? (
          <div
            key={n}
            onPointerDown={onPointerDown}
            className={`absolute select-none whitespace-pre leading-tight ${onPointerDown ? "cursor-move" : "pointer-events-none"} ${selected ? "outline outline-2 outline-ring" : ""}`}
            style={{
              left: `${t.x * 100}%`,
              top: `${(top + n * step) * 100}%`,
              transform: t.align === "center" ? "translateX(-50%)" : t.align === "right" ? "translateX(-100%)" : undefined,
              fontSize: t.fontSize * scale,
              fontFamily: t.fontFamily === "serif" ? "serif" : t.fontFamily === "mono" ? "monospace" : "Inter, sans-serif",
              color: t.color ?? DEFAULT_TEXT_COLOR,
              background: t.background,
              padding: t.background ? `${0.3 * t.fontSize * scale}px ${0.45 * t.fontSize * scale}px` : undefined,
              // Round-joined, like the export's; see shared/outline.ts.
              textShadow: stroke ? outlineShadow(stroke.width * scale, stroke.color) : undefined,
              opacity: t.opacity ?? 1,
              textAlign: t.align ?? "left",
            }}
          >
            {line}
          </div>
        ) : null,
      )}
    </>
  );
}

/** Simple peak waveform for an audio source. */
function Waveform({ url, width, height }: { url: string; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width < 24) return;
    let dead = false;
    (async () => {
      let peaks = peaksCache.get(url);
      if (!peaks) {
        const buf = await (await fetch(url)).arrayBuffer();
        const audio = await new AudioContext().decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const buckets = 240;
        const step = Math.floor(data.length / buckets) || 1;
        peaks = Array.from({ length: buckets }, (_, i) => {
          let max = 0;
          for (let j = i * step; j < (i + 1) * step && j < data.length; j += 32) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
          }
          return max;
        });
        peaksCache.set(url, peaks);
      }
      if (dead) return;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      const bw = width / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i] * (height - 2));
        ctx.fillRect(i * bw, (height - h) / 2, Math.max(1, bw - 0.5), h);
      }
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [url, width, height]);
  return <canvas ref={ref} width={Math.max(1, width)} height={height} className="w-full h-full" />;
}

// ── projects (the home screen) ──────────────────────────────────────────────

function fmtDate(s: string): string {
  // SQLite datetime('now') is space-separated UTC; normalise for Date().
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A row of the projects list: no document, but its first clip as a cover. */
type ProjectSummary = Omit<EditProject, "edl" | "brief"> & {
  cover_key: string | null;
  cover_type: string | null;
  /** Where the cut starts in the cover clip (its trimStart), in seconds. */
  cover_at: number | null;
  cover_asset: string | null;
  /** Set when the cover clip lives on the media service, not in app storage. */
  cover_media: string | null;
  /** Clips taken from the project's Drive folders. */
  footage: number;
};

/** The frame a project is recognised by: its opening shot, or a blank tile. */
function ProjectCover({ p }: { p: ProjectSummary }) {
  const [broken, setBroken] = useState(false);
  const url = p.cover_key ? `/api/uploads/${encodeURIComponent(p.cover_key)}` : null;
  // Half a second in, not frame zero: footage often fades up from black.
  const at = (p.cover_at ?? 0) + 0.5;
  return (
    <div className="aspect-video bg-surface-sunken grid place-items-center overflow-hidden">
      {p.cover_media && p.cover_asset && !broken ? (
        // Footage on the media service has nothing in app storage to play
        // from; it has frames. Until it is ready there is no frame: blank tile.
        <img
          src={frameUrl({ id: p.cover_asset }, at)}
          alt=""
          onError={() => setBroken(true)}
          className="w-full h-full object-cover bg-black"
        />
      ) : p.cover_media ? (
        <Film className="w-6 h-6 text-faint" />
      ) : url && p.cover_type?.startsWith("video/") ? (
        <video
          src={`${url}#t=${at}`}
          muted
          preload="metadata"
          className="w-full h-full object-cover bg-black"
        />
      ) : url && p.cover_type?.startsWith("image/") ? (
        <img src={url} alt="" className="w-full h-full object-cover" />
      ) : (
        <Film className="w-6 h-6 text-faint" />
      )}
    </div>
  );
}

export function ProjectsHome({ navigate }: { navigate: (to: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<ProjectSummary | null>(null);
  const [fromFolder, setFromFolder] = useState(false);
  // A project with a lot of footage is deleted over several calls.
  const [removing, setRemoving] = useState<{ id: string; left: number } | null>(null);
  const [removeErr, setRemoveErr] = useState("");

  useEffect(() => {
    api.get<ProjectSummary[]>("/api/projects").then(setProjects).catch(() => setProjects([]));
  }, []);

  const remove = async (p: ProjectSummary) => {
    setConfirmDel(null);
    setRemoveErr("");
    setRemoving({ id: p.id, left: p.footage });
    try {
      let left = Infinity;
      for (;;) {
        const r = await api.send<{ ok: boolean; remaining?: number }>("DELETE", `/api/projects/${p.id}`);
        if (r.ok) break;
        // No progress means the media service is unreachable: stop, and say so.
        if ((r.remaining ?? 0) >= left) throw new Error("some of its footage could not be deleted yet. Try again in a minute");
        left = r.remaining ?? 0;
        setRemoving({ id: p.id, left });
      }
      setProjects((cur) => cur?.filter((x) => x.id !== p.id) ?? null);
    } catch (e) {
      setRemoveErr(`“${p.name}”: ${String((e as Error).message)}`);
    } finally {
      setRemoving(null);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.send<EditProject>("POST", "/api/projects", { name: "Untitled project" });
      navigate(`/edits/${p.id}`);
    } finally {
      setBusy(false);
    }
  };

  const newProject = (
    <>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New project
    </>
  );
  const fromFolderButton = (
    <button onClick={() => setFromFolder(true)} className={btnSecondary}>
      <Folder className="w-4 h-4" /> From a Drive folder
    </button>
  );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Toolbar grammar: identity left, the one solid action right. The
            button appears here only once there is a list; an empty page
            carries it in the empty state, so there are never two. */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-heading-1">
              Projects
              {projects && projects.length > 0 && (
                <span className="ml-2 text-data text-muted tabular-nums">{projects.length}</span>
              )}
            </h1>
            <p className="text-body-sm text-muted mt-0.5">
              One project is one video: upload your footage, trim it, put the clips in order, add
              text and music, and export it to MP4.
            </p>
          </div>
          {projects && projects.length > 0 && (
            <div className="flex gap-2 shrink-0">
              {fromFolderButton}
              <button onClick={create} disabled={busy} className={btnPrimary}>
                {newProject}
              </button>
            </div>
          )}
        </div>
        {removeErr && <p className="text-body-sm text-danger mb-4">Could not delete {removeErr}</p>}

        {projects === null ? (
          /* Loading is the shape of the answer, never a spinner. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${card} overflow-hidden`}>
                <div className="aspect-video bg-surface-sunken animate-pulse" />
                <div className="px-4 py-3 space-y-2">
                  <div className="h-3 w-2/3 rounded-full bg-surface-sunken animate-pulse" />
                  <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<Scissors className="w-8 h-8" />}
            title="No projects yet"
            body="Start a project, upload a clip, and cut it down."
            action={
              <div className="flex gap-2 justify-center">
                {fromFolderButton}
                <button onClick={create} disabled={busy} className={btnPrimary}>
                  {newProject}
                </button>
              </div>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              // Two sibling buttons, not one inside the other: open is the
              // card, delete is its own target (and never needs a hover to
              // show, which a touch screen does not have).
              <div key={p.id} className={`${card} relative overflow-hidden`}>
                <button
                  onClick={() => navigate(`/edits/${p.id}`)}
                  className="block w-full text-left hover:bg-surface-sunken"
                >
                  <ProjectCover p={p} />
                  <div className="pl-4 pr-12 py-3">
                    <div className="text-body-sm font-medium truncate">{p.name}</div>
                    <div className="text-fine text-faint mt-0.5">
                      {removing?.id === p.id
                        ? `Deleting${removing.left ? `, ${removing.left} clips to go` : ""}`
                        : `Edited ${fmtDate(p.updated_at)}${p.footage ? ` · ${p.footage} clips from Drive` : ""}`}
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => setConfirmDel(p)}
                  disabled={removing?.id === p.id}
                  className={`${btnIcon} absolute right-2 bottom-3 hover:text-danger`}
                  aria-label={`Delete ${p.name}`}
                  title="Delete project"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {confirmDel && (
          <ConfirmDialog
            title={`Delete “${confirmDel.name}”?`}
            body={
              confirmDel.footage
                ? `The project, its export history and its ${confirmDel.footage} clips from Drive go with it. The originals in Google Drive are not touched, and footage from your media library stays there.`
                : "The project and its export history go with it. Your footage stays in the media library."
            }
            onConfirm={() => remove(confirmDel)}
            onClose={() => setConfirmDel(null)}
          />
        )}

        {fromFolder && (
          <FolderLinkDialog
            title="New project from a Drive folder"
            submitLabel="Create project"
            onSubmit={async (url) => {
              const p = await api.send<EditProject>("POST", "/api/projects", { folder: url });
              navigate(`/edits/${p.id}`);
            }}
            onClose={() => setFromFolder(false)}
          />
        )}
      </div>
    </main>
  );
}

// ── the editor ──────────────────────────────────────────────────────────────

/** Which pane is on screen below the lg breakpoint (desktop shows all three). */
type Pane = "library" | "canvas" | "inspector";

type Sel =
  | { area: "main"; i: number }
  /** The cut into main clip `i`, where its transition sits. */
  | { area: "cut"; i: number }
  | { area: "ovl"; ti: number; i: number }
  | { area: "aud"; ti: number; i: number }
  | null;

export function EditRoute({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [project, setProject] = useState<EditProject | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [footage, setFootage] = useState<FootageList | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    Promise.all([
      api.get<EditProject>(`/api/projects/${id}`),
      api.get<Asset[]>("/api/assets"),
      // A first look only: the panel's own reads move the footage on.
      api.get<FootageList>(`/api/projects/${id}/footage?logs=0&step=0`),
    ])
      .then(([p, a, f]) => {
        setProject(p);
        // The project's own clips from Drive sit beside the library's, so
        // the timeline can play them.
        setAssets([...a, ...readyFootage(f)]);
        setFootage(f);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, [id]);

  if (err)
    return (
      <div className="flex-1 grid place-items-center">
        <EmptyState
          icon={<Film className="w-8 h-8" />}
          title="This project could not be opened"
          body={err}
          action={
            <button className={btnSecondary} onClick={() => navigate("/")}>
              Back to projects
            </button>
          }
        />
      </div>
    );
  if (!project || !assets || !footage)
    return (
      <div className="flex-1 grid place-items-center text-faint">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  return <EditEditor initial={project} initialAssets={assets} initialFootage={footage} />;
}

export function EditEditor({
  initial,
  initialAssets,
  initialFootage,
}: {
  initial: EditProject;
  initialAssets: Asset[];
  initialFootage: FootageList;
}) {
  const [name, setName] = useState(initial.name);
  const [brief, setBrief] = useState(initial.brief ?? "");
  const [edl, setEdl] = useState<Edl>(initial.edl);
  // Undo history. Every edit already replaces the whole document, so a step
  // is just the document before it. A stroke (dragging a trim handle) folds
  // into one step: undo should walk back an action, not a pixel.
  const edlRef = useRef(edl);
  edlRef.current = edl;
  const past = useRef<Edl[]>([]);
  const future = useRef<Edl[]>([]);
  const lastEdit = useRef(0);
  const [, bumpHistory] = useState(0);
  const [assets, setAssets] = useState<Asset[]>(initialAssets);
  const [sel, setSel] = useState<Sel>(null);
  const [tab, setTab] = useState<RailTab>("media");
  // Phones and tablets get ONE pane at a time; the four-region grid is a
  // desktop layout. Selection state chooses which pane is on screen.
  const [pane, setPane] = useState<"library" | "canvas" | "inspector">("canvas");
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [autocutOpen, setAutocutOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const playheadRef = useRef(0);
  // While a video is playing it IS the clock: the wall clock only fills in
  // for stretches with no video (stills, text). Driving the wall clock and
  // seeking the video to match made every rebuffer force a seek, which
  // rebuffered again — the stutter people saw on long footage.
  const mediaClock = useRef<(() => number | null) | null>(null);
  const { srcDur, resolveAsset } = useSourceDurations(edl, assets);

  // ── persistence (debounced) ───────────────────────────────────────────────
  const dirty = useRef(false);
  // What the server holds. Compared against this, not the document the page
  // opened with: undo can walk back to that very document, and comparing with
  // it skipped the save, so the undo showed on screen and never persisted.
  const saved = useRef({ edl: initial.edl, name: initial.name, brief: initial.brief ?? "" });
  useEffect(() => {
    const last = saved.current;
    if (edl === last.edl && name === last.name && brief === last.brief) {
      dirty.current = false;
      setSaveState("saved");
      return;
    }
    dirty.current = true;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        await api.send("PUT", `/api/projects/${initial.id}`, { name, edl, brief });
        saved.current = { edl, name, brief };
        dirty.current = false;
        setSaveState("saved");
      } catch (e) {
        setSaveState(String((e as Error).message));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [edl, name, brief, initial.id, initial.edl, initial.name, initial.brief]);

  /**
   * Replace the document, remembering the version before it. `coalesce` folds
   * this edit into the previous step when they belong to the same gesture.
   */
  const commit = useCallback((next: Edl, coalesce = false) => {
    const cur = edlRef.current;
    if (next === cur) return;
    const now = Date.now();
    if (!(coalesce && now - lastEdit.current < 600)) {
      past.current = [...past.current, cur].slice(-50);
    }
    lastEdit.current = now;
    future.current = [];
    edlRef.current = next;
    setEdl(next);
    bumpHistory((n) => n + 1);
  }, []);

  const update = useCallback(
    (fn: (draft: Edl) => void, coalesce = false) => {
      const draft = structuredClone(edlRef.current);
      fn(draft);
      commit(draft, coalesce);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [...future.current, edlRef.current];
    edlRef.current = prev;
    setEdl(prev);
    setSel(null);
    bumpHistory((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, edlRef.current];
    edlRef.current = next;
    setEdl(next);
    setSel(null);
    bumpHistory((n) => n + 1);
  }, []);

  // Cmd+Z / Ctrl+Z, and Shift for redo. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── derived timeline ──────────────────────────────────────────────────────
  const segments = useMemo(() => mainSegments(edl, srcDur), [edl, srcDur]);
  const total = cutEnd(segments);

  // Captions: the transcripts of the videos on the timeline, and the caption
  // lines they give once laid onto it. Worked out, never stored.
  const captionIds = useMemo(
    () => [...new Set(edl.main.elements.filter((e) => e.type === "video" && e.src.startsWith("asset:")).map((e) => e.src.slice(6)))],
    [edl.main.elements],
  );
  const transcripts = useTranscripts(captionIds, edl.captions?.lang ?? "en", !!edl.captions?.enabled || tab === "captions");
  const captionLayer = useMemo(() => {
    const cfg = edl.captions;
    if (!cfg?.enabled) return null;
    const placed = segments
      .filter((sg) => sg.el.type === "video" && sg.el.src.startsWith("asset:"))
      .map((sg) => ({ src: sg.el.src, start: sg.start, dur: sg.dur, trimStart: (sg.el as MainVideo).trimStart ?? 0 }));
    const cues = new Map<string, Cue[]>();
    for (const [src, t] of transcripts) if (t.status === "ready") cues.set(src, t.cues);
    return { lines: captionTimeline(placed, cues, cfg.style.maxChars), style: cfg.style };
  }, [edl.captions, segments, transcripts]);

  // Distinct video clips on the main track, in timeline order — the unit
  // Auto-cut operates on (the arrangement is the user's intent).
  const timelineClips = useMemo(() => {
    const seen = new Set<string>();
    const out: Asset[] = [];
    for (const el of edl.main.elements) {
      if (el.type !== "video" || !el.src.startsWith("asset:")) continue;
      const id = el.src.slice(6);
      if (seen.has(id)) continue;
      seen.add(id);
      const a = assets.find((x) => x.id === id);
      if (a) out.push(a);
    }
    return out;
  }, [edl, assets]);

  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(t, Math.max(0.001, total)));
    playheadRef.current = clamped;
    setPlayhead(clamped);
  }, [total]);

  // Master clock — drives the playhead state (media elements sync in Player).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const fromMedia = mediaClock.current?.();
      let t = fromMedia !== null && fromMedia !== undefined && Number.isFinite(fromMedia)
        ? fromMedia
        : playheadRef.current + dt;
      if (t >= total) {
        t = total;
        setPlaying(false);
      }
      playheadRef.current = t;
      setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // ── mutations the panels share ────────────────────────────────────────────
  const addAssetToTimeline = (a: Asset) => {
    if (isAudioAsset(a)) {
      update((d) => {
        d.audio = d.audio ?? [];
        if (d.audio.length === 0) d.audio.push({ id: rid(), elements: [] });
        d.audio[0].elements.push({ id: rid(), type: "audio", src: `asset:${a.id}`, startTime: playheadRef.current, volume: 0.5 });
      });
      setTab("audio");
    } else if (isVideoAsset(a)) {
      update((d) => d.main.elements.push({ id: rid(), type: "video", src: `asset:${a.id}` }));
    } else {
      update((d) => d.main.elements.push({ id: rid(), type: "image", src: `asset:${a.id}`, duration: 3 }));
    }
  };

  const addText = () => {
    update((d) => {
      d.overlays = d.overlays ?? [];
      if (d.overlays.length === 0) d.overlays.push({ id: rid(), elements: [] });
      d.overlays[0].elements.push({
        id: rid(),
        type: "text",
        text: "Your text",
        fontSize: 64,
        startTime: Math.min(playheadRef.current, Math.max(0, total - 2)),
        duration: 3,
        x: 0.5,
        y: 0.42,
        align: "center",
        color: DEFAULT_TEXT_COLOR,
        background: DEFAULT_TEXT_BOX,
      });
      setSel({ area: "ovl", ti: 0, i: d.overlays[0].elements.length - 1 });
    });
  };

  /** Cut the main-track clip under `t` in two, both halves the same source. */
  const splitAt = (t: number) => {
    const seg = segments.find((s) => t > s.start + 0.05 && t < s.start + s.dur - 0.05);
    if (!seg) return;
    const off = t - seg.start;
    update((d) => {
      const el = d.main.elements[seg.i];
      if (el.type === "image") {
        const right = { ...structuredClone(el), id: rid(), duration: el.duration - off };
        el.duration = off;
        keepEdgeFades([el, right]);
        d.main.elements.splice(seg.i + 1, 0, right);
      } else {
        // Its own length, not the whole frames it is drawn at: a play window
        // rounded up could ask the export for more than the source has.
        const halves = splitClip(structuredClone(el), off, mainDur(el, srcDur), rid());
        if (halves) d.main.elements.splice(seg.i, 1, ...halves);
      }
    });
  };

  const splitAtPlayhead = () => splitAt(playheadRef.current);

  const deleteSelected = () => {
    if (!sel) return;
    update((d) => {
      if (sel.area === "main") d.main.elements.splice(sel.i, 1);
      if (sel.area === "cut") delete d.main.elements[sel.i]?.transition;
      if (sel.area === "ovl") d.overlays?.[sel.ti]?.elements.splice(sel.i, 1);
      if (sel.area === "aud") d.audio?.[sel.ti]?.elements.splice(sel.i, 1);
    });
    setSel(null);
  };

  // Delete or Backspace removes what is selected, as the trash button does.
  // Ignored while typing, so editing text never deletes a clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!sel) return;
      e.preventDefault();
      deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Transport and edit shortcuts, the ones an editor is expected to answer to:
  // Space plays or pauses, Cmd/Ctrl+B splits at the playhead, the arrows step
  // the playhead (a frame, or a second with Shift), Home/End jump to the ends.
  // Ignored while typing; Space yields to a focused button so it still clicks,
  // and the arrows leave Cmd/Alt (browser history, word jumps) alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === " " && plain) {
        if (el?.closest("button, a, [role='button']")) return;
        e.preventDefault();
        setPlaying((p) => !p);
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === "ArrowLeft" && plain) {
        e.preventDefault();
        seek(playheadRef.current - (e.shiftKey ? 1 : 1 / edlRef.current.output.fps));
      } else if (e.key === "ArrowRight" && plain) {
        e.preventDefault();
        seek(playheadRef.current + (e.shiftKey ? 1 : 1 / edlRef.current.output.fps));
      } else if (e.key === "Home" && plain) {
        e.preventDefault();
        seek(0);
      } else if (e.key === "End" && plain) {
        e.preventDefault();
        seek(total);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Project bar. The name edits in place — there is no edit mode and no
          pencil: the value itself is the control. */}
      <div className="flex items-center gap-3 px-4 h-12 border-b border-border bg-surface shrink-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Project name"
          className="min-w-24 flex-1 lg:flex-none lg:w-64 bg-transparent text-heading-3 outline-none rounded-sm h-7 px-1.5 -mx-1.5 hover:bg-surface-sunken focus:bg-surface focus:shadow-edge"
        />
        <span
          className={`text-fine shrink-0 ${
            saveState === "saved" ? "text-faint" : saveState === "saving" ? "text-muted" : "text-danger"
          }`}
        >
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState}
        </span>
        <div className="flex-1" />
        <button
          onClick={undo}
          disabled={past.current.length === 0}
          title="Undo (Cmd+Z)"
          aria-label="Undo"
          className={btnIcon}
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={redo}
          disabled={future.current.length === 0}
          title="Redo (Shift+Cmd+Z)"
          aria-label="Redo"
          className={btnIcon}
        >
          <Redo2 className="w-4 h-4" />
        </button>
        <button
          onClick={() => setAskOpen(true)}
          className={btnSecondary}
          title="Change the cut by describing it"
        >
          <Wand2 className="w-4 h-4" /> <span className="hidden sm:inline">Ask</span>
        </button>
        <button
          onClick={() => setAutocutOpen(true)}
          className={btnSecondary}
          title="Assemble a cut from several clips with AI"
        >
          <Sparkles className="w-4 h-4" /> <span className="hidden sm:inline">Auto-cut</span>
        </button>
        <ShareControl projectId={initial.id} />
        <ExportControls projectId={initial.id} disabled={dirty.current || edl.main.elements.length === 0} />
      </div>

      {/* Row 2, small screens only: which pane is on screen. */}
      <div className="lg:hidden flex items-center px-4 h-11 border-b border-border bg-surface shrink-0">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-sunken p-0.5">
          {(
            [
              ["library", "Library"],
              ["canvas", "Edit"],
              ["inspector", "Options"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPane(key)}
              aria-pressed={pane === key}
              className={`h-7 px-3 text-button rounded-sm ${
                pane === key ? "bg-surface text-foreground shadow-raised" : "text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {askOpen && (
        <AskDialog
          projectId={initial.id}
          onClose={() => setAskOpen(false)}
          onApplied={(next) => {
            // One step for the whole instruction, like Auto-cut.
            commit(next);
            setSel(null);
          }}
        />
      )}

      {autocutOpen && (
        <AutocutModal
          projectId={initial.id}
          clips={timelineClips}
          brief={brief}
          setBrief={setBrief}
          onClose={() => setAutocutOpen(false)}
          onApplied={(next) => {
            // One step for the whole AI pass: undo puts the cut back as it was.
            commit(next);
            setSel(null);
            setAutocutOpen(false);
            seek(0);
          }}
        />
      )}

      {/* three-panel middle */}
      <div className="flex-1 flex min-h-0">
        <LeftPanel
          projectId={initial.id}
          initialFootage={initialFootage}
          pane={pane}
          tab={tab}
          setTab={setTab}
          assets={assets}
          setAssets={setAssets}
          onAdd={addAssetToTimeline}
          onAddText={addText}
          edl={edl}
          update={update}
          transcripts={transcripts}
        />
        <Player
          pane={pane}
          edl={edl}
          segments={segments}
          total={total}
          playhead={playhead}
          playheadRef={playheadRef}
          mediaClock={mediaClock}
          captions={captionLayer}
          playing={playing}
          resolveAsset={resolveAsset}
          sel={sel}
          setSel={setSel}
          update={update}
        />
        <Inspector
          pane={pane}
          edl={edl}
          sel={sel}
          update={update}
          srcDur={srcDur}
          resolveAsset={resolveAsset}
          segments={segments}
          onDelete={deleteSelected}
          brief={brief}
          setBrief={setBrief}
          playheadRef={playheadRef}
        />
      </div>

      {/* timeline */}
      <TimelinePanel
        pane={pane}
        edl={edl}
        segments={segments}
        total={total}
        playhead={playhead}
        playing={playing}
        setPlaying={setPlaying}
        seek={seek}
        sel={sel}
        setSel={setSel}
        update={update}
        srcDur={srcDur}
        resolveAsset={resolveAsset}
        splitAtPlayhead={splitAtPlayhead}
        splitAt={splitAt}
        deleteSelected={deleteSelected}
      />
    </div>
  );
}

// ── auto-cut modal ──────────────────────────────────────────────────────────

function AutocutModal({
  projectId,
  clips,
  brief,
  setBrief,
  onClose,
  onApplied,
}: {
  projectId: string;
  clips: Asset[];
  brief: string;
  setBrief: (b: string) => void;
  onClose: () => void;
  onApplied: (edl: Edl) => void;
}) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");

  const run = async () => {
    setRunning(true);
    setMsg("Watching all clips together — this takes a minute for long footage…");
    try {
      const res = await api.send<EditProject & { notes?: string }>("POST", `/api/projects/${projectId}/autocut`, {
        asset_ids: clips.map((c) => c.id),
      });
      onApplied(res.edl);
      void res.notes;
    } catch (e) {
      setMsg(String((e as Error).message));
      setRunning(false);
    }
  };

  return (
    <Dialog
      title="Auto-cut"
      icon={<Sparkles className="w-4 h-4 text-muted" />}
      description="One pass watches every clip on your timeline together and assembles the strongest sequence for your brief: ordering, trims and captions included. The result replaces the main track, ready to adjust."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={btnGhost}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button
            onClick={run}
            data-autofocus
            disabled={running || clips.length === 0 || clips.length > 8}
            className={btnPrimary}
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Assemble cut
          </button>
        </>
      }
    >
      <div className="mt-4">
        <Row label="What is this video for?">
          <textarea
            className={`${inputCls} min-h-16`}
            placeholder="e.g. 30-second product teaser for Instagram — energetic, lead with the best demo moment"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </Row>

        <Row label={`Clips on the timeline (${clips.length})`}>
          <div className="max-h-44 overflow-y-auto space-y-1 rounded-sm p-2 shadow-edge">
            {clips.length === 0 && (
              <div className="text-fine text-faint py-2 text-center">
                Add video clips to the timeline first (Media panel, then click a clip).
              </div>
            )}
            {clips.map((a, i) => (
              <div key={a.id} className="flex items-center gap-2 text-body-sm py-0.5">
                <span className="text-faint text-fine w-4 tabular-nums">{i + 1}.</span>
                <span className="truncate">{a.name}</span>
              </div>
            ))}
          </div>
        </Row>

        {clips.length > 8 && (
          <div className="text-fine text-danger">Auto-cut handles up to 8 clips at once.</div>
        )}
        {/* Work with an unknown duration says so in place, never a bare spinner. */}
        {msg && <div className="text-fine text-muted">{msg}</div>}
      </div>
    </Dialog>
  );
}

// ── left panel ──────────────────────────────────────────────────────────────

function LeftPanel({
  projectId,
  initialFootage,
  pane,
  tab,
  setTab,
  assets,
  setAssets,
  onAdd,
  onAddText,
  edl,
  update,
  transcripts,
}: {
  projectId: string;
  initialFootage: FootageList;
  pane: Pane;
  tab: RailTab;
  setTab: (t: RailTab) => void;
  edl: Edl;
  update: (fn: (d: Edl) => void, coalesce?: boolean) => void;
  transcripts: Map<string, TranscriptState>;
  assets: Asset[];
  setAssets: React.Dispatch<React.SetStateAction<Asset[]>>;
  onAdd: (a: Asset) => void;
  onAddText: () => void;
}) {
  const uploads = useUploads();
  useEffect(() => onUploaded((a) => setAssets((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev]))), [setAssets]);
  // The project's clips from Drive are listed apart from the library, and
  // their readiness comes with that list: asking the media service about each
  // of a shoot's hundreds of clips one by one is what this avoids.
  const footage = useFootage(projectId, initialFootage, setAssets);
  const footageIds = useMemo(
    () => new Set(footage.list.items.flatMap((i) => (i.asset ? [i.asset.id] : []))),
    [footage.list],
  );
  const hasFootage = footage.list.sources.length > 0;
  const [view, setView] = useState<"project" | "library">(hasFootage ? "project" : "library");
  const library = useMemo(() => assets.filter((a) => !footageIds.has(a.id)), [assets, footageIds]);
  const { ready: mediaReady, ingesting: mediaIngesting } = useMediaReady(library);
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const [deleteErr, setDeleteErr] = useState("");

  const deleteAsset = async (a: Asset) => {
    setDeleteErr("");
    try {
      await api.send("DELETE", `/api/assets/${a.id}`);
      setAssets((prev) => prev.filter((x) => x.id !== a.id));
      if (footageIds.has(a.id)) footage.refresh();
    } catch (e) {
      // Refused while a project still uses it: the message names the projects.
      setDeleteErr(String((e as Error).message));
    }
  };
  const [driveOpen, setDriveOpen] = useState(false);
  const closeDrive = useCallback(() => setDriveOpen(false), []);
  const [folderOpen, setFolderOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list =
    tab === "media" ? library.filter((a) => isVideoAsset(a) || isImageAsset(a)) : tab === "audio" ? library.filter(isAudioAsset) : [];
  const showFootage = tab === "media" && hasFootage && view === "project";

  return (
    /* The rail is surface-sunken; the canvas beside it stays white. The step
       between them is small, and the border carries the separation. */
    <div className={`${pane === "library" ? "flex" : "hidden"} lg:flex w-full lg:w-60 shrink-0 border-r border-border bg-surface-sunken min-h-0`}>
      <div className="w-14 shrink-0 border-r border-border flex flex-col items-center py-3 gap-1">
        {(
          [
            ["media", Film, "Media"],
            ["audio", Music, "Audio"],
            ["text", TypeIcon, "Text"],
            ["captions", CaptionsIcon, "Captions"],
          ] as const
        ).map(([key, Icon, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`w-11 py-2 rounded-sm flex flex-col items-center gap-1 text-fine ${
              tab === key ? "bg-surface text-foreground shadow-raised" : "text-muted hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0 overflow-y-auto p-3">
        {tab === "captions" ? (
          <CaptionsPanel
            edl={edl}
            update={update}
            transcripts={transcripts}
            clips={[...new Set(edl.main.elements.filter((e) => e.type === "video" && e.src.startsWith("asset:")).map((e) => e.src.slice(6)))]
              .map((id) => assets.find((x) => x.id === id))
              .filter((x): x is Asset => !!x)}
          />
        ) : tab === "text" ? (
          <button
            onClick={onAddText}
            className="w-full h-8 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add text
          </button>
        ) : (
          <>
            {tab === "media" && hasFootage && (
              <div className="grid grid-cols-2 gap-0.5 p-0.5 mb-3 rounded-sm bg-surface shadow-edge">
                {(
                  [
                    ["project", "This project"],
                    ["library", "Library"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setView(key)}
                    aria-pressed={view === key}
                    className={`h-7 rounded-xs text-fine ${
                      view === key ? "bg-surface-sunken text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {folderOpen && (
              <FolderLinkDialog
                title="Add a Drive folder"
                submitLabel="Add folder"
                onSubmit={async (url) => {
                  await api.send("POST", `/api/projects/${projectId}/footage/folders`, { url });
                  footage.refresh();
                  setView("project");
                  setFolderOpen(false);
                }}
                onClose={() => setFolderOpen(false)}
              />
            )}
            {deleteErr && <div className="text-fine text-danger mb-2">{deleteErr}</div>}
            {deleting && (
              <ConfirmDialog
                title={`Delete “${deleting.name}”?`}
                body={
                  footageIds.has(deleting.id)
                    ? "Its copy in this project is deleted. The original in Google Drive is not touched, and checking the folder for new files does not bring it back."
                    : "It is removed from the library for everyone in your workspace, and cannot be recovered here. The original in Google Drive, if it came from there, is not touched."
                }
                onConfirm={() => {
                  const a = deleting;
                  setDeleting(null);
                  void deleteAsset(a);
                }}
                onClose={() => setDeleting(null)}
              />
            )}
            {showFootage ? (
              <FootagePanel
                projectId={projectId}
                footage={footage}
                onAdd={onAdd}
                onDelete={setDeleting}
                onAddFolder={() => setFolderOpen(true)}
              />
            ) : (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full h-8 mb-2 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
            >
              <Upload className="w-4 h-4" /> Upload
            </button>
            <button
              onClick={() => setDriveOpen(true)}
              className="w-full h-8 mb-2 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
            >
              <Cloud className="w-4 h-4" /> Google Drive
            </button>
            {tab === "media" && (
              <button
                onClick={() => setFolderOpen(true)}
                className="w-full h-8 mb-3 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
              >
                <Link2 className="w-4 h-4" /> Drive folder link
              </button>
            )}
            {driveOpen && (
              <DriveDialog
                kind={tab === "audio" ? "audio" : "media"}
                onImported={(a) => setAssets((prev) => [a, ...prev])}
                onClose={closeDrive}
              />
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={tab === "audio" ? "audio/*" : "video/*,image/*"}
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // Reset so re-picking the SAME file fires change again —
                // without this, retrying an upload silently does nothing.
                e.target.value = "";
                for (const f of files) startUpload(f);
              }}
            />
            {uploads.length > 0 && <UploadTray uploads={uploads} />}
            <div className="space-y-2">
              {list.map((a) => {
                const preparing = !!a.media_uid && !mediaReady.has(a.id);
                return (
                <div key={a.id} className="relative group/tile">
                <button
                  onClick={() => !preparing && onAdd(a)}
                  disabled={preparing}
                  title={preparing ? "Still being prepared" : "Add to timeline"}
                  aria-label={`Add ${a.name} to the timeline`}
                  className="block w-full text-left rounded-sm bg-surface shadow-edge overflow-hidden hover:bg-surface-sunken group disabled:hover:bg-surface"
                >
                  {isVideoAsset(a) ? (
                    preparing ? (
                      <div className="w-full h-20 grid place-items-center bg-surface-sunken text-fine text-muted gap-1">
                        {mediaIngesting.has(a.id) && (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Preparing
                          </>
                        )}
                      </div>
                    ) : a.media_uid ? (
                      <img src={frameUrl(a, 1)} alt="" className="w-full h-20 object-cover bg-black" />
                    ) : (
                      <video src={assetUrl(a)} muted preload="metadata" className="w-full h-20 object-cover bg-black" />
                    )
                  ) : isImageAsset(a) ? (
                    <img src={assetUrl(a)} alt="" className="w-full h-20 object-cover bg-black" />
                  ) : (
                    <div className="w-full h-12 grid place-items-center bg-track-audio-tint">
                      <Music className="w-5 h-5 text-track-audio" />
                    </div>
                  )}
                  <div className="pl-2 pr-8 py-1.5 text-fine truncate text-muted group-hover:text-foreground">{a.name}</div>
                </button>
                {/* Shown on hover or keyboard focus. Screens without hover and
                    agents (data-hover-only) always see it. */}
                <button
                  onClick={() => setDeleting(a)}
                  data-hover-only
                  className="absolute right-1 bottom-0.5 grid place-items-center w-6 h-6 rounded-xs text-faint hover:text-danger hover:bg-danger-tint opacity-0 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`Delete ${a.name} from the library`}
                  title="Delete from the library"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                </div>
                );
              })}
              {list.length === 0 && (
                <p className="text-fine text-muted py-4 text-center">
                  {tab === "audio"
                    ? "No music or voiceover yet. Upload an audio file to mix it under the cut."
                    : "No footage yet. Upload a clip or a still, then click it to put it on the timeline."}
                </p>
              )}
            </div>
          </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── footage from Drive folders ──────────────────────────────────────────────

/**
 * The project's clips from its Drive folders. Each read moves their import
 * and logging on by a step, so it is read again while any are on their way;
 * a clip that has come in joins the editor's assets.
 */
function useFootage(
  projectId: string,
  initial: FootageList,
  setAssets: React.Dispatch<React.SetStateAction<Asset[]>>,
): { list: FootageList; refresh: () => void } {
  const [list, setList] = useState(initial);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (tick === 0 && initial.sources.length === 0) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const l = await api.get<FootageList>(`/api/projects/${projectId}/footage?logs=0`);
        if (dead) return;
        setList(l);
        const ready = readyFootage(l);
        setAssets((prev) => {
          const have = new Set(prev.map((a) => a.id));
          const add = ready.filter((a) => !have.has(a.id));
          return add.length ? [...prev, ...add] : prev;
        });
        const c = l.counts;
        const inFlight = c.importing + c.logging;
        const queued = c.waiting + (c.ready - c.logged - c.log_failed - c.logging);
        // Held by a limit with nothing in flight: reading again changes nothing.
        const held = (l.imports_paused || l.logging_paused) && inFlight === 0;
        if (inFlight + queued > 0 && !held) timer = setTimeout(read, 10_000);
      } catch {
        if (!dead) timer = setTimeout(read, 30_000);
      }
    };
    void read();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [projectId, tick, setAssets, initial.sources.length]);

  return { list, refresh };
}

/** A small text action that fits the 184px media rail. */
const railAction =
  "inline-flex items-center gap-1 h-6 px-1.5 rounded-xs text-fine text-muted hover:text-foreground hover:bg-surface-sunken disabled:opacity-50";

const KIND_LABEL: Record<NonNullable<FootageItem["log"]>["kind"], string> = {
  interview: "Interview",
  stage: "Stage",
  "b-roll": "B-roll",
  other: "Other",
};

/** What a clip is doing, or what its log says it is. */
function footageLine(i: FootageItem): string {
  if (i.status === "waiting") return "Waiting to import";
  if (i.status === "importing") return "Importing";
  if (i.status === "failed") return `Not imported: ${i.error ?? "unknown error"}`;
  if (i.log_status === "done" && i.log) return i.log.summary;
  if (i.log_status === "failed") return `Not logged: ${i.log_error ?? "unknown error"}`;
  return "Logging";
}

function FootagePanel({
  projectId,
  footage,
  onAdd,
  onDelete,
  onAddFolder,
}: {
  projectId: string;
  footage: { list: FootageList; refresh: () => void };
  onAdd: (a: Asset) => void;
  onDelete: (a: Asset) => void;
  onAddFolder: () => void;
}) {
  const { list, refresh } = footage;
  const c = list.counts;
  const [busy, setBusy] = useState<"sync" | "retry" | null>(null);
  const [note, setNote] = useState("");
  const groups = useMemo(() => {
    // With one folder its name heads the panel, so the groups drop it:
    // "Cam B", not "Day 1/Cam B" on every group.
    const single = list.sources.length === 1 ? `${list.sources[0].name}/` : null;
    const by = new Map<string, FootageItem[]>();
    for (const i of list.items) {
      const k = (single && i.folder.startsWith(single) ? i.folder.slice(single.length) : i.folder) || list.sources[0]?.name || "Drive folder";
      by.set(k, [...(by.get(k) ?? []), i]);
    }
    return [...by].map(([folder, items]) => ({ folder, items, prefix: sharedPrefix(items.map((i) => i.name)) }));
  }, [list.items, list.sources]);

  const act = async (kind: "sync" | "retry") => {
    setBusy(kind);
    setNote("");
    try {
      if (kind === "sync") {
        const r = await api.send<{ added: number }>("POST", `/api/projects/${projectId}/footage/sync`);
        setNote(r.added ? `${r.added} new ${r.added === 1 ? "clip" : "clips"} found` : "No new files");
      } else {
        await api.send("POST", `/api/projects/${projectId}/footage/retry`);
      }
      refresh();
    } catch (e) {
      setNote(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const failed = c.failed + c.log_failed;
  const coming = c.waiting + c.importing;
  return (
    <div>
      <div className="mb-2 text-fine text-muted">
        <div className="text-foreground truncate" title={list.sources.map((s) => s.name).join(", ")}>
          {list.sources.map((s) => s.name).join(", ")} · {c.total} {c.total === 1 ? "clip" : "clips"}
        </div>
        <div className="tabular-nums">
          {coming > 0 ? `${c.ready} of ${c.total} imported` : "All imported"}
          {c.ready > 0 && ` · ${c.logged} logged`}
        </div>
      </div>
      {(list.imports_paused || list.logging_paused) && (
        <div className="mb-2 rounded-sm bg-warning-tint px-2 py-1.5 text-fine text-foreground">
          {list.imports_paused && <p>Importing is paused: {list.imports_paused}</p>}
          {list.logging_paused && <p>Logging is paused: {list.logging_paused}</p>}
          <button onClick={refresh} className="mt-1 text-link hover:underline">
            Try again
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-x-1 gap-y-0.5 mb-3 -ml-1.5">
        <button onClick={() => act("sync")} disabled={busy !== null} className={railAction} title="Look in the folders again for files added since">
          {busy === "sync" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Check for new files
        </button>
        {failed > 0 && (
          <button onClick={() => act("retry")} disabled={busy !== null} className={railAction}>
            {busy === "retry" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Redo2 className="w-3.5 h-3.5" />} Retry {failed} failed
          </button>
        )}
        <button onClick={onAddFolder} className={railAction}>
          <Plus className="w-3.5 h-3.5" /> Add folder
        </button>
      </div>
      {note && <p className="text-fine text-muted mb-2">{note}</p>}
      {groups.map(({ folder, items, prefix }) => (
        <details key={folder} open className="group/folder mb-2">
          <summary className="flex items-center gap-1 py-1 text-fine text-muted cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:text-foreground">
            <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform group-open/folder:rotate-90" />
            <span className="truncate">{folder}</span>
            <span className="ml-auto tabular-nums text-faint">{items.length}</span>
          </summary>
          <div className="mt-1 space-y-0.5">
            {items.map((i) => (
              <FootageRow key={i.id} item={i} label={i.name.slice(prefix.length)} onAdd={onAdd} onDelete={onDelete} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function FootageRow({
  item,
  label,
  onAdd,
  onDelete,
}: {
  item: FootageItem;
  /** The name less what the folder's names share. */
  label: string;
  onAdd: (a: Asset) => void;
  onDelete: (a: Asset) => void;
}) {
  const asset = item.status === "ready" ? item.asset : null;
  const line = footageLine(item);
  const failed = item.status === "failed" || item.log_status === "failed";
  return (
    <div className="relative group/tile">
      <button
        onClick={() => asset && onAdd(asset)}
        disabled={!asset}
        title={`${item.name}\n${line}${asset ? "\n\nAdd to timeline" : ""}`}
        aria-label={asset ? `Add ${item.name} to the timeline` : `${item.name}: ${line}`}
        className="w-full p-1 rounded-sm text-left hover:bg-surface disabled:hover:bg-transparent"
      >
        <div className="flex gap-2 items-start">
          <div className="w-14 h-8 shrink-0 rounded-xs overflow-hidden bg-surface-sunken grid place-items-center text-faint">
            {asset ? (
              <img src={frameUrl(asset, 1)} alt="" loading="lazy" className="w-full h-full object-cover bg-black" />
            ) : item.status === "importing" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : item.status === "failed" ? (
              <X className="w-3.5 h-3.5 text-danger" />
            ) : (
              <Film className="w-3.5 h-3.5" />
            )}
          </div>
          <div className="min-w-0 flex-1 text-fine text-foreground break-words line-clamp-2">{label}</div>
        </div>
        <div className={`mt-0.5 text-fine line-clamp-2 ${failed ? "text-danger" : "text-muted"}`}>
          {item.log && (
            <span className="text-faint">
              {KIND_LABEL[item.log.kind]}
              {item.log.quality === "unusable" && ", unusable"} ·{" "}
            </span>
          )}
          {line}
        </div>
      </button>
      {asset && (
        // On the thumbnail, so it takes no width from the name beside it.
        <button
          onClick={() => onDelete(asset)}
          data-hover-only
          className="absolute left-1 top-1 grid place-items-center w-6 h-6 rounded-xs bg-surface/90 text-muted hover:text-danger hover:bg-danger-tint opacity-0 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Delete ${item.name} from this project`}
          title="Delete from this project"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * A link to a Drive folder anyone with the link can view: its videos, and
 * those in every folder inside it, become the project's footage.
 */
function FolderLinkDialog({
  title,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  /** Throws with the reason the folder can't be used. */
  onSubmit: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onSubmit(url.trim());
    } catch (e) {
      setErr(String((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      icon={<Folder className="w-4 h-4 text-muted" />}
      description="Paste the link to a Google Drive folder that anyone with the link can view. Every video in it, and in the folders inside it, is copied into this project and logged clip by clip: what it shows, what is said, and its best moments. That runs in the background, so you can close the project meanwhile."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={btnGhost}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button onClick={submit} disabled={!url.trim() || busy} className={btnPrimary}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Folder className="w-4 h-4" />}
            {busy ? "Reading the folder" : submitLabel}
          </button>
        </>
      }
    >
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className={inputCls}
          placeholder="https://drive.google.com/drive/folders/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Google Drive folder link"
          data-autofocus
        />
      </form>
      {err && <p className="mt-2 text-fine text-danger">{err}</p>}
    </Dialog>
  );
}

// ── ask for a change ────────────────────────────────────────────────────────

/**
 * Change the cut by asking. The model calls checked operations on the server
 * rather than writing the document, and the answer says what it did, so an
 * edit is reviewable instead of a black box. The whole pass is one undo step.
 */
function AskDialog({
  projectId,
  onClose,
  onApplied,
}: {
  projectId: string;
  onClose: () => void;
  onApplied: (edl: Edl) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    if (!instruction.trim()) return;
    setRunning(true);
    setErr("");
    try {
      const out = await api.send<{ edl: Edl; said: string; applied: string[] }>(
        "POST",
        `/api/projects/${projectId}/instruct`,
        { instruction: instruction.trim() },
      );
      onApplied(out.edl);
      onClose();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      title="Ask for a change"
      icon={<Wand2 className="w-4 h-4 text-muted" />}
      description="Describe the change in your words. It edits the cut you have, one step you can undo."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={btnGhost}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button onClick={run} disabled={running || !instruction.trim()} className={btnPrimary}>
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Apply
          </button>
        </>
      }
    >
      <div className="mt-4">
        <textarea
          className={`${inputCls} min-h-16`}
          placeholder="e.g. drop the first two seconds of clip 1, put the demo first, and add a title that says Spring Open Day for the first 3 seconds"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          data-autofocus
        />
        <p className="mt-2 text-fine text-faint">
          It can trim, split, delete, reorder and mute clips, watch a clip and cut its dead air and false starts,
          add or remove on-screen text, and change the format (vertical for Reels, square, 4:5 and the rest).
        </p>
        {running && <div className="mt-2 text-fine text-muted">Working through the cut…</div>}
        {err && <div className="mt-2 text-fine text-danger break-words">{err}</div>}
      </div>
    </Dialog>
  );
}

// ── Google Drive picker ─────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  duration: number | null;
  thumbnail: string | null;
}

interface DriveFolder {
  id: string;
  name: string;
}

/**
 * Files on their way into the library, one row each: how far along, and a
 * way to stop it. A failed one says why and offers Retry, which resumes a
 * video from where it stopped rather than sending it again.
 */
function UploadTray({ uploads }: { uploads: UploadItem[] }) {
  return (
    <ul className="mb-3 space-y-1.5" aria-label="Uploads">
      {uploads.map((u) => {
        const pct = u.size ? Math.min(100, Math.round((u.sent / u.size) * 100)) : 0;
        return (
          <li key={u.id} className="rounded-sm bg-surface shadow-edge px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="flex-1 min-w-0 truncate text-fine" title={u.name}>
                {u.name}
              </span>
              {u.status === "failed" && (
                <button onClick={() => retryUpload(u.id)} className="text-fine text-foreground hover:underline shrink-0">
                  Retry
                </button>
              )}
              <button
                onClick={() => cancelUpload(u.id)}
                className="grid place-items-center w-5 h-5 rounded-xs text-faint hover:text-foreground hover:bg-surface-sunken shrink-0"
                aria-label={u.status === "failed" ? `Discard ${u.name}` : `Cancel uploading ${u.name}`}
                title={u.status === "failed" ? "Discard" : "Cancel upload"}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {u.status === "failed" ? (
              <p className="text-fine text-danger mt-0.5">{u.error}</p>
            ) : (
              <>
                <div
                  className="mt-1 h-1 rounded-full bg-border overflow-hidden"
                  role="progressbar"
                  aria-label={`Uploading ${u.name}`}
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-fine text-muted mt-0.5 tabular-nums">
                  {u.status === "finishing"
                    ? "Adding to the library…"
                    : `${pct}% of ${fmtBytes(u.size)}`}
                </p>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function fmtBytes(n: number | null): string {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/**
 * Footage handed to the media service is not playable while it ingests, so
 * the library says so and the clip stays out of the timeline until it is.
 * Polls only while something is still pending.
 */
function useMediaReady(assets: Asset[]): { ready: Set<string>; ingesting: Set<string> } {
  const [ready, setReady] = useState<Set<string>>(new Set());
  // Only what the service has actually reported as not ready yet. Until the
  // first answer a clip is merely unknown, and calling it "Preparing" flashed
  // that label on every page load for footage that had long been ready.
  const [ingesting, setIngesting] = useState<Set<string>>(new Set());
  const pending = assets.filter((a) => a.media_uid && !ready.has(a.id)).map((a) => a.id);
  const key = pending.join(",");

  useEffect(() => {
    if (!key) return;
    let dead = false;
    const check = async () => {
      const done: string[] = [];
      const waiting: string[] = [];
      for (const id of key.split(",")) {
        try {
          const r = await api.get<{ ready: boolean }>(`/api/assets/${id}/playback`);
          (r.ready ? done : waiting).push(id);
        } catch {
          /* a hiccup: ask again on the next pass */
        }
      }
      if (dead) return;
      if (done.length) setReady((cur) => new Set([...cur, ...done]));
      setIngesting(new Set(waiting));
    };
    check();
    const t = setInterval(check, 5000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [key]);

  return { ready, ingesting };
}

// ── captions ────────────────────────────────────────────────────────────────

interface TranscriptState {
  status: "loading" | "ready" | "no_speech" | "unavailable" | "preparing" | "transcribing" | "error";
  cues: Cue[];
}

/**
 * The transcripts of the clips on the timeline, in the captions' language.
 * The media service makes one in minutes, so pending ones are asked again
 * until they arrive. Footage in app storage has none.
 */
function useTranscripts(assetIds: string[], lang: string, active: boolean): Map<string, TranscriptState> {
  const [states, setStates] = useState<Map<string, TranscriptState>>(new Map());
  const key = `${lang}|${assetIds.join(",")}`;

  useEffect(() => {
    if (!active || assetIds.length === 0) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Set<string>();

    const pass = async () => {
      const next = new Map<string, TranscriptState>();
      let waiting = false;
      for (const id of assetIds) {
        if (done.has(id)) continue;
        try {
          const r = await api.get<{ status: TranscriptState["status"]; vtt?: string }>(
            `/api/assets/${id}/transcript?lang=${lang}`,
          );
          next.set(`asset:${id}`, { status: r.status, cues: r.vtt ? parseVtt(r.vtt) : [] });
          if (r.status === "preparing" || r.status === "transcribing") waiting = true;
          else done.add(id);
        } catch {
          next.set(`asset:${id}`, { status: "error", cues: [] });
        }
      }
      if (dead) return;
      setStates((cur) => new Map([...cur, ...next]));
      if (waiting) timer = setTimeout(pass, 10_000);
    };
    void pass();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return states;
}

const CAPTION_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["it", "Italiano"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["nl", "Nederlands"],
  ["pt", "Português"],
  ["pl", "Polski"],
  ["cs", "Čeština"],
  ["ru", "Русский"],
  ["ja", "日本語"],
  ["ko", "한국어"],
];

const TRANSCRIPT_LABEL: Record<TranscriptState["status"], string> = {
  loading: "Checking…",
  ready: "Transcript ready",
  no_speech: "No speech found",
  unavailable: "Kept in the app's own storage, which has no transcripts. Upload it again to get one.",
  preparing: "Still being prepared…",
  transcribing: "Transcribing…",
  error: "Could not load the transcript",
};

/** One segmented choice, the pattern the panel uses for every setting. */
function Choice<T extends string | number | boolean>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="inline-flex w-full items-center gap-0.5 rounded-sm bg-surface p-0.5 shadow-edge" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`flex-1 h-6 rounded-xs text-fine ${value === v ? "bg-surface-sunken text-foreground" : "text-muted hover:text-foreground"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function CaptionsPanel({
  edl,
  update,
  transcripts,
  clips,
}: {
  edl: Edl;
  update: (fn: (d: Edl) => void, coalesce?: boolean) => void;
  transcripts: Map<string, TranscriptState>;
  clips: Asset[];
}) {
  const cfg = edl.captions ?? DEFAULT_CAPTIONS;
  const set = (patch: Partial<ProjectCaptions>) =>
    update((d) => {
      d.captions = { ...(d.captions ?? DEFAULT_CAPTIONS), ...patch };
    });
  const setStyle = (patch: Partial<CaptionStyle>) => set({ style: { ...cfg.style, ...patch } });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-sm">Show captions</span>
        <button
          role="switch"
          aria-checked={cfg.enabled}
          aria-label="Show captions"
          onClick={() => set({ enabled: !cfg.enabled })}
          className={`relative w-9 h-5 rounded-full transition-colors ${cfg.enabled ? "bg-primary" : "bg-border"}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface shadow-raised transition-all ${cfg.enabled ? "left-4.5" : "left-0.5"}`} />
        </button>
      </div>
      <p className="text-fine text-faint">
        Captions come from each clip's transcript, so they follow every trim, split and reorder. One style for the
        whole video.
      </p>

      <div>
        <Zone>Language</Zone>
        <div className="grid grid-cols-2 gap-1">
          {CAPTION_LANGUAGES.map(([code, name]) => (
            <button
              key={code}
              onClick={() => set({ lang: code })}
              aria-pressed={cfg.lang === code}
              className={`h-7 rounded-xs text-fine truncate px-1 ${cfg.lang === code ? "bg-surface text-foreground shadow-edge" : "text-muted hover:text-foreground"}`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Zone>Style</Zone>
        <Choice
          label="Position"
          value={cfg.style.position}
          options={[["bottom", "Bottom"], ["top", "Top"]]}
          onChange={(position) => setStyle({ position })}
        />
        <Choice
          label="Size"
          value={cfg.style.size}
          options={[[0.045, "Small"], [0.055, "Medium"], [0.07, "Large"]]}
          onChange={(size) => setStyle({ size })}
        />
        <Choice
          label="Line length"
          value={cfg.style.maxChars}
          options={[[22, "Short"], [32, "Medium"], [44, "Long"]]}
          onChange={(maxChars) => setStyle({ maxChars })}
        />
        <Choice
          label="Background"
          value={cfg.style.background}
          options={[[true, "Box"], [false, "No box"]]}
          onChange={(background) => setStyle({ background })}
        />
        <Choice
          label="Outline"
          value={!!cfg.style.outline}
          options={[[true, "Outline"], [false, "No outline"]]}
          onChange={(outline) => setStyle({ outline })}
        />
        <label className="flex items-center justify-between gap-2 text-fine text-muted">
          Text color
          {/* The value is a colour authored into the video, not app chrome. */}
          <input type="color" className="field p-1 w-16" value={cfg.style.color.slice(0, 7)} onChange={(e) => setStyle({ color: e.target.value })} />
        </label>
      </div>

      <div>
        <Zone>Clips</Zone>
        {clips.length === 0 ? (
          <p className="text-fine text-faint">Put a video on the timeline to caption it.</p>
        ) : (
          <ul className="space-y-1.5">
            {clips.map((a) => {
              const state = transcripts.get(`asset:${a.id}`)?.status ?? "loading";
              return (
                <li key={a.id} className="text-fine">
                  <div className="truncate text-foreground">{a.name}</div>
                  <div className={state === "ready" ? "text-success" : "text-faint"}>{TRANSCRIPT_LABEL[state]}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Search the org's Google Drive and copy picked files into the library. */
function DriveDialog({
  kind,
  onImported,
  onClose,
}: {
  kind: "media" | "audio";
  onImported: (a: Asset) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<{ connected: boolean; folder: DriveFolder | null } | null>(null);
  // Where we are, deepest last. The first entry is the org's folder limit, or
  // My Drive when there is none; the picker can never walk above it.
  const [trail, setTrail] = useState<DriveFolder[]>([]);
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [picked, setPicked] = useState<DriveFile | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [savingFolder, setSavingFolder] = useState(false);
  const [err, setErr] = useState("");

  const here = trail[trail.length - 1];

  useEffect(() => {
    api
      .get<{ connected: boolean; folder: DriveFolder | null }>("/api/drive")
      .then((s) => {
        setStatus(s);
        setTrail([s.folder ?? { id: "root", name: "My Drive" }]);
      })
      .catch((e) => setErr(String((e as Error).message)));
  }, []);

  const load = useCallback(
    async (page?: string) => {
      if (!here) return;
      const qs = new URLSearchParams({ kind, folder: here.id });
      if (search.trim()) qs.set("q", search.trim());
      if (page) qs.set("page", page);
      const r = await api.get<{ folders: DriveFolder[]; files: DriveFile[]; nextPageToken: string | null }>(
        `/api/drive/files?${qs}`,
      );
      setFolders(page ? (cur) => [...cur, ...r.folders] : r.folders);
      setFiles((cur) => (page && cur ? [...cur, ...r.files] : r.files));
      setNext(r.nextPageToken);
    },
    [kind, search, here],
  );

  // Search as you type, a beat after the last key; also reloads on a move.
  useEffect(() => {
    if (!status?.connected || !here) return;
    const t = setTimeout(() => {
      setErr("");
      load().catch((e) => setErr(String((e as Error).message)));
    }, 300);
    return () => clearTimeout(t);
  }, [status, load, here]);

  const openFolder = (f: DriveFolder) => {
    setTrail((cur) => [...cur, f]);
    setFiles(null);
    setFolders([]);
    setPicked(null);
    setSearch("");
  };

  const goTo = (i: number) => {
    setTrail((cur) => cur.slice(0, i + 1));
    setFiles(null);
    setFolders([]);
    setPicked(null);
    setSearch("");
  };

  const setLimit = async (folderId: string | null) => {
    setSavingFolder(true);
    setErr("");
    try {
      const r = await api.send<{ folder: DriveFolder | null }>("PUT", "/api/drive/folder", { folderId });
      setStatus((cur) => (cur ? { ...cur, folder: r.folder } : cur));
      setTrail([r.folder ?? { id: "root", name: "My Drive" }]);
      setFiles(null);
      setFolders([]);
      setPicked(null);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setSavingFolder(false);
    }
  };

  const importFile = async (f: DriveFile) => {
    setImporting(f.id);
    setErr("");
    try {
      const asset = await api.send<Asset>("POST", "/api/drive/import", {
        fileId: f.id,
        ...(f.duration ? { duration: f.duration } : {}),
      });
      onImported(asset);
      setImported((cur) => new Set(cur).add(f.id));
    } catch (e) {
      setErr(`${f.name}: ${String((e as Error).message)}`);
    } finally {
      setImporting(null);
    }
  };

  const kindIcon = (t: string) =>
    t.startsWith("video/") ? <Film className="w-4 h-4" /> : t.startsWith("audio/") ? <Music className="w-4 h-4" /> : <ImageIcon className="w-4 h-4" />;

  const limited = !!status?.folder;
  const atLimitRoot = trail.length === 1;
  const atRoot = !limited && here?.id === "root";
  const canLimitHere = !atLimitRoot && here?.id !== "sharedWithMe";
  // A deep path keeps its start and its end; the middle collapses.
  const crumbs: ({ folder: DriveFolder; at: number } | "gap")[] =
    trail.length > 3
      ? [{ folder: trail[0], at: 0 }, "gap", ...trail.slice(-2).map((f, i) => ({ folder: f, at: trail.length - 2 + i }))]
      : trail.map((f, i) => ({ folder: f, at: i }));

  return (
    <Dialog
      title="Import from Google Drive"
      icon={<Cloud className="w-4 h-4 text-muted" />}
      description="Files are copied into your media library, so an edit keeps working if the original is moved or deleted."
      onClose={onClose}
      size="lg"
      footer={
        <button onClick={onClose} className={btnGhost}>
          Done <Kbd>esc</Kbd>
        </button>
      }
    >
      {status?.connected === false ? (
        <p className="mt-4 text-body-sm text-muted">
          Google Drive isn't connected yet. Connect Google Drive in your Clawnify dashboard under
          Integrations, then open this again.
        </p>
      ) : (
        <div className="mt-4">
          {/* Where you are, and the org's one folder rule. */}
          <div className="flex items-center gap-2 mb-2 min-h-7">
            <nav className="flex items-center gap-1 min-w-0 flex-1 text-fine text-muted">
              {crumbs.map((c, i) =>
                c === "gap" ? (
                  <span key="gap" className="flex items-center gap-1 shrink-0 text-faint">
                    <ChevronRight className="w-3 h-3" />…
                  </span>
                ) : (
                  <span key={c.folder.id} className="flex items-center gap-1 min-w-0">
                    {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-faint" />}
                    <button
                      onClick={() => goTo(c.at)}
                      disabled={c.at === trail.length - 1}
                      className="truncate hover:text-foreground disabled:text-foreground disabled:hover:text-foreground"
                    >
                      {c.folder.name}
                    </button>
                  </span>
                ),
              )}
            </nav>
            {limited && atLimitRoot ? (
              <button onClick={() => setLimit(null)} disabled={savingFolder} className={`${btnGhost} shrink-0`}>
                Show all of Drive
              </button>
            ) : (
              canLimitHere && (
                <button onClick={() => here && setLimit(here.id)} disabled={savingFolder} className={`${btnGhost} shrink-0`}>
                  Limit to this folder
                </button>
              )
            )}
          </div>

          <input
            className={inputCls}
            placeholder={kind === "audio" ? "Search audio in this folder" : "Search videos and images in this folder"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search Google Drive"
            data-autofocus
          />

          <div className="mt-2 flex flex-col sm:flex-row gap-3">
            <div className="flex-1 min-w-0 max-h-80 overflow-y-auto scroll-slim -ml-2 pr-1">
              {files === null ? (
                /* Loading is the shape of the answer, never a spinner. */
                [0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-2">
                    <div className="w-12 h-9 rounded-sm bg-surface-sunken animate-pulse" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-2/3 rounded-full bg-surface-sunken animate-pulse" />
                      <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
                    </div>
                  </div>
                ))
              ) : folders.length === 0 && files.length === 0 ? (
                <p className="px-2 py-4 text-center text-fine text-muted">
                  {search.trim() ? "Nothing in this folder matches that name." : "This folder is empty."}
                </p>
              ) : (
                <>
                  {atRoot && files.length === 0 && folders.length === 1 && (
                    <p className="px-2 pt-1 pb-2 text-fine text-faint">
                      Nothing here in your own Drive. Files people shared with you are below.
                    </p>
                  )}
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => openFolder(f)}
                      className="w-full flex items-center gap-3 px-2 py-2 rounded-sm text-left hover:bg-surface-sunken"
                    >
                      <span className="grid place-items-center w-12 h-9 rounded-sm bg-surface-sunken text-muted shrink-0">
                        <Folder className="w-4 h-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body-sm">{f.name}</span>
                      <ChevronRight className="w-4 h-4 text-faint shrink-0" />
                    </button>
                  ))}
                  {files.map((f) => {
                    const done = imported.has(f.id);
                    return (
                      <button
                        key={f.id}
                        onClick={() => setPicked(f)}
                        className={`w-full flex items-center gap-3 px-2 py-2 rounded-sm text-left hover:bg-surface-sunken ${picked?.id === f.id ? "bg-surface-sunken" : ""}`}
                      >
                        <span className="grid place-items-center w-12 h-9 rounded-sm bg-surface-sunken text-muted shrink-0 overflow-hidden">
                          {f.thumbnail ? (
                            <img src={f.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            kindIcon(f.mimeType)
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm">{f.name}</span>
                          <span className="block text-fine text-faint tabular-nums">
                            {[fmtBytes(f.size), f.duration ? fmtTime(f.duration) : ""].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {done && <Check className="w-4 h-4 text-success shrink-0" />}
                      </button>
                    );
                  })}
                  {next && (
                    <button
                      onClick={() => load(next).catch((e) => setErr(String((e as Error).message)))}
                      className={`${btnGhost} ${stretch} mt-1`}
                    >
                      Load more
                    </button>
                  )}
                </>
              )}
            </div>

            {/* What you picked, before you commit to copying it. */}
            {picked && (
            <div className="w-full sm:w-56 shrink-0">
              <>
                <div className="space-y-2">
                  <div className="aspect-video rounded-sm bg-surface-sunken grid place-items-center overflow-hidden text-muted">
                    {picked.thumbnail ? (
                      <img src={picked.thumbnail} alt="" className="w-full h-full object-contain" />
                    ) : (
                      kindIcon(picked.mimeType)
                    )}
                  </div>
                  <div className="text-body-sm break-words">{picked.name}</div>
                  <div className="text-fine text-faint tabular-nums">
                    {[
                      fmtBytes(picked.size),
                      picked.duration ? fmtTime(picked.duration) : "",
                      picked.modifiedTime ? new Date(picked.modifiedTime).toLocaleDateString() : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {imported.has(picked.id) ? (
                    <div className="flex items-center gap-1.5 text-fine text-success">
                      <Check className="w-4 h-4" /> In your library
                    </div>
                  ) : (
                    <button
                      onClick={() => importFile(picked)}
                      disabled={importing !== null}
                      className={`${btnPrimary} ${stretch}`}
                    >
                      {importing === picked.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Import
                    </button>
                  )}
                  {importing === picked.id && (
                    <div className="text-fine text-muted">Copying from Drive, this takes a moment for long videos…</div>
                  )}
                </div>
              </>
            </div>
            )}
          </div>
          {err && <div className="mt-2 text-fine text-danger break-words">{err}</div>}
        </div>
      )}
    </Dialog>
  );
}

// ── player ──────────────────────────────────────────────────────────────────

function Player({
  pane,
  edl,
  segments,
  total,
  playhead,
  playheadRef,
  mediaClock,
  captions,
  playing,
  resolveAsset,
  sel,
  setSel,
  update,
}: {
  pane: Pane;
  edl: Edl;
  segments: ReturnType<typeof mainSegments>;
  total: number;
  playhead: number;
  playheadRef: React.MutableRefObject<number>;
  /** Filled here so the master clock can follow the playing video. */
  mediaClock: React.MutableRefObject<(() => number | null) | null>;
  /** The project's captions, already laid onto the timeline, or null when off. */
  captions: { lines: CaptionLine[]; style: CaptionStyle } | null;
  playing: boolean;
  resolveAsset: (src: string) => Asset | undefined;
  sel: Sel;
  setSel: (s: Sel) => void;
  /** `coalesce` folds this edit into the previous undo step (one drag, one step). */
  update: (fn: (d: Edl) => void, coalesce?: boolean) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Scale to FIT: the limiting dimension wins. `aspect-ratio` alone sized the
  // stage from the full width and let it run off the bottom of the pane
  // (max-height never applied, because the parent's height is indefinite), so
  // the frame was clipped.
  const [fit, setFit] = useState({ w: 0, h: 0, scale: 1 });
  const scale = fit.scale;
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      // Content box, not border box: the pane carries padding, and measuring
      // through it puts the stage back over the edge it was meant to clear.
      const cs = getComputedStyle(box);
      const width = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const height = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const s = Math.min(width / edl.output.width, height / edl.output.height);
      if (s > 0 && Number.isFinite(s)) {
        setFit({ w: edl.output.width * s, h: edl.output.height * s, scale: s });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [edl.output.width, edl.output.height]);

  const active = segments.find((s) => playhead >= s.start && playhead < s.start + s.dur) ?? segments[segments.length - 1];
  const cutLength = cutEnd(segments);
  // A transition under way, centred on its cut: both clips on screen from
  // `before` ahead of the cut to `after` past it. The clip under the playhead
  // stays `active`, the one the clock follows; the other plays alongside it,
  // into the footage past its trim.
  const across = segments.find(
    (s) => s.i > 0 && s.before + s.after > 0 && playhead >= s.start - s.before && playhead < s.start + s.after,
  );
  const blend =
    across?.el.transition
      ? {
          from: segments[across.i - 1],
          to: across,
          look: transitionLook(across.el.transition.type, (playhead - (across.start - across.before)) / (across.before + across.after), edl.output),
        }
      : null;
  type Seg = (typeof segments)[number];
  /** On screen and playing: the active clip, and both sides of a transition. */
  const live = (seg: Seg) => seg.dur > 0 && (seg === active || (!!blend && (seg === blend.from || seg === blend.to)));
  /** How a clip's layer is drawn now: as itself, or partway through a transition. */
  const layerLook = (seg: Seg) => (blend && seg === blend.from ? blend.look.from : blend && seg === blend.to ? blend.look.to : undefined);
  /** A clip's sound in a transition, on acrossfade's curve; 1 otherwise. */
  const crossGain = (seg: Seg) => (blend && seg === blend.from ? blend.look.gains[0] : blend && seg === blend.to ? blend.look.gains[1] : 1);
  const filterId = useId().replace(/:/g, "");
  /** An overlay's opacity right now: its own times its fades. */
  const overlayOpacity = (el: { startTime: number; duration: number; opacity?: number; fadeIn?: number; fadeOut?: number }) =>
    (el.opacity ?? 1) * fadeGain(el, heardFor(el.startTime, el.duration, cutLength), playhead - el.startTime);

  // A cropped clip is placed from its source's own size (shared/crop.ts).
  const cropped: Asset[] = [];
  for (const el of [...edl.main.elements, ...(edl.overlays ?? []).flatMap((t) => t.elements)]) {
    const a = el.type !== "text" && el.crop ? resolveAsset(el.src) : undefined;
    if (a) cropped.push(a);
  }
  const shapes = useShapes(cropped);
  // The decoded frame's own size wins once the element has it: it is the
  // upright picture the export crops, whatever the media service reports.
  const [decoded, setDecoded] = useState(new Map<string, Shape>());
  const noteSize = (id: string) => (e: React.SyntheticEvent<HTMLVideoElement | HTMLImageElement>) => {
    const m = e.currentTarget;
    const width = m instanceof HTMLVideoElement ? m.videoWidth : m.naturalWidth;
    const height = m instanceof HTMLVideoElement ? m.videoHeight : m.naturalHeight;
    if (!width || !height) return;
    setDecoded((cur) => {
      const was = cur.get(id);
      return was && was.width === width && was.height === height ? cur : new Map(cur).set(id, { width, height });
    });
  };
  const shapeFor = (a: Asset) => decoded.get(a.id) ?? shapes.get(a.id);

  // The playing video's position on the timeline, for the master clock.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    mediaClock.current = () => {
      const seg = activeRef.current;
      if (!seg || seg.el.type !== "video" || seg.dur <= 0) return null;
      const v = videoRefs.current.get(seg.el.id);
      // A paused or starved element is not a clock: let the wall clock carry
      // on rather than freezing the playhead while the buffer fills.
      if (!v || v.paused || v.readyState < 2) return null;
      return seg.start + (v.currentTime - (seg.el.trimStart ?? 0));
    };
    return () => {
      mediaClock.current = null;
    };
  }, [mediaClock]);

  // Sync media elements to the master clock (drift-corrected seeks).
  useEffect(() => {
    const t = playhead;
    for (const seg of segments) {
      const v = videoRefs.current.get(seg.el.id);
      if (!v || seg.el.type !== "video") continue;
      if (live(seg)) {
        // In a transition a clip plays past its trims. Where its source has
        // nothing there (it starts at 0:00, or ends) the edge frame holds, as
        // in the export; play() on an ended video would start it over instead.
        const end = Number.isFinite(v.duration) ? v.duration : Infinity;
        const raw = (seg.el.trimStart ?? 0) + (t - seg.start);
        const wanted = Math.max(0, Math.min(raw, end));
        const hold = raw < 0 || raw >= end - 0.05;
        // Playing, the video leads and needs no correction; only a real jump
        // (a scrub, or a cut to another clip) is worth a seek, because each
        // one empties the buffer. Paused, follow the playhead closely.
        const jumped = Math.abs(v.currentTime - wanted) > (playing && !hold ? 0.75 : 0.05);
        if (jumped && !v.seeking) v.currentTime = wanted;
        v.volume = Math.min(1, Math.min(1, seg.el.volume ?? 1) * fadeGain(seg.el, seg.dur, t - seg.start) * crossGain(seg));
        v.muted = seg.el.sourceAudio === false;
        if (playing && !hold && v.paused) v.play().catch(() => {});
        if ((!playing || hold) && !v.paused) v.pause();
      } else {
        if (!v.paused) v.pause();
        // The clip after the active one waits where it will start playing: its
        // first frame, or as far before it as its transition in reaches. A clip
        // that starts where it was last left, within the seek tolerance above,
        // runs ahead of the clock, and the playhead jumps when it takes over.
        const first = Math.max(0, (seg.el.trimStart ?? 0) - seg.before);
        if (active && seg.i === active.i + 1 && !v.seeking && Math.abs(v.currentTime - first) > 0.05) v.currentTime = first;
      }
    }
    for (const [ti, track] of (edl.audio ?? []).entries()) {
      for (const el of track.elements) {
        const a = audioRefs.current.get(el.id);
        if (!a) continue;
        const dur = el.duration ?? Math.max(0, (durCache.get(el.src) ?? 0) - (el.trimStart ?? 0) - (el.trimEnd ?? 0));
        const inWindow = t >= el.startTime && t < el.startTime + dur;
        const wanted = (el.trimStart ?? 0) + (t - el.startTime);
        if (inWindow && playing && !track.muted) {
          if (Math.abs(a.currentTime - wanted) > 0.25) a.currentTime = wanted;
          // The export's afade envelope, so fades sound in the preview as they will in the file.
          const gain = fadeGain(el, heardFor(el.startTime, dur, cutLength), t - el.startTime);
          a.volume = Math.min(1, el.volume ?? 1) * gain;
          if (a.paused) a.play().catch(() => {});
        } else if (!a.paused) a.pause();
      }
      void ti;
    }
  }, [playhead, playing, segments, active, blend?.to, edl.audio]);

  // Drag overlays on the stage (position as canvas fractions).
  const dragOverlay = (ti: number, i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSel({ area: "ovl", ti, i });
    const stage = stageRef.current!;
    const rect = stage.getBoundingClientRect();
    const el = (edl.overlays ?? [])[ti].elements[i];
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = el.x;
    const oy = el.y;
    const move = (ev: PointerEvent) => {
      const nx = Math.max(0, Math.min(1, ox + (ev.clientX - startX) / rect.width));
      const ny = Math.max(0, Math.min(1, oy + (ev.clientY - startY) / rect.height));
      update((d) => {
        const t = d.overlays?.[ti]?.elements[i];
        if (t) {
          t.x = Math.round(nx * 1000) / 1000;
          t.y = Math.round(ny * 1000) / 1000;
        }
      }, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Clicking the picture selects the clip on screen, the way it would in any
  // editor; pressing on a filled clip and dragging also reframes it, in the
  // same gesture. Titles stop the event themselves, so they keep their drag.
  const onScreen = active && active.dur > 0 ? active.el : undefined;
  const reframable = onScreen?.fit === "cover";

  const stagePointerDown = (e: React.PointerEvent) => {
    if (!onScreen) return setSel(null);
    const i = edl.main.elements.findIndex((el) => el.id === onScreen.id);
    if (i < 0) return setSel(null);
    if (!(sel?.area === "main" && sel.i === i)) setSel({ area: "main", i });
    if (!reframable) return;

    const media = stageRef.current?.querySelector(`[data-clip="${CSS.escape(onScreen.id)}"]`);
    const natural =
      media instanceof HTMLVideoElement
        ? { width: media.videoWidth, height: media.videoHeight }
        : media instanceof HTMLImageElement
          ? { width: media.naturalWidth, height: media.naturalHeight }
          : null;
    // Until the clip has loaded there is no frame to slide.
    if (!natural?.width || !natural.height) return;
    e.preventDefault();
    const overflow = coverOverflow(croppedShape(natural, onScreen.crop), edl.output);
    const rect = stageRef.current!.getBoundingClientRect();
    const from = onScreen.anchor ?? CENTRE;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      // A plain click only selects; a few pixels of travel starts the reframe.
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      moved = true;
      const next = dragAnchor(from, (ev.clientX - startX) / rect.width, (ev.clientY - startY) / rect.height, overflow);
      update((d) => {
        const el = d.main.elements[i];
        if (el) el.anchor = next;
      }, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={boxRef}
      className={`${pane === "canvas" ? "grid" : "hidden"} lg:grid flex-1 min-w-0 min-h-0 bg-surface-sunken place-items-center p-4 overflow-hidden`}
      // The grey around the frame is where a click lets go of the selection.
      onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}
    >
      <div style={{ width: fit.w || undefined, height: fit.h || undefined }}>
        <div
          ref={stageRef}
          className={`relative w-full h-full overflow-hidden rounded-md shadow-edge ${reframable ? "cursor-grab active:cursor-grabbing" : onScreen ? "cursor-pointer" : ""}`}
          style={{ background: edl.output.background ?? "#000" }}
          onPointerDown={stagePointerDown}
        >
          {/* main track media: a full-frame layer per clip, the active one shown,
              and in a transition the clip coming in drawn over it */}
          {blend?.look.through && (
            <div className="absolute inset-0 pointer-events-none" style={{ background: blend.look.through }} />
          )}
          {blend && (blend.look.blurBox || blend.look.block) ? (
            <TransitionFilter id={filterId} blurBox={blend.look.blurBox} block={blend.look.block} scale={scale} />
          ) : null}
          {segments.map((seg) => {
            const a = resolveAsset(seg.el.src);
            if (!a) return null;
            const visible = live(seg);
            const look = layerLook(seg);
            const effect = look && ((blend?.look.blurBox ?? 0) > 1 || (blend?.look.block ?? 0) * scale >= 1) ? `url(#${filterId})` : undefined;
            // The clip's own fade, as the export draws it before any transition
            // joins it to the next: the whole frame to black.
            const gain = visible ? fadeGain(seg.el, seg.dur, playhead - seg.start) : 1;
            const fit = seg.el.fit ?? "contain";
            const at = fit === "cover" ? (seg.el.anchor ?? CENTRE) : CENTRE;
            const shape = seg.el.crop ? shapeFor(a) : undefined;
            // A cropped clip: the box is the kept part, placed as the export
            // places it, and the whole source is drawn inside it and clipped.
            const place = shape ? placeClip(shape, seg.el.crop, edl.output, fit, seg.el.anchor) : undefined;
            const common = {
              className: place ? "absolute max-w-none" : "absolute inset-0 w-full h-full",
              style: (place
                ? { ...pct(place.source), objectFit: "fill" }
                : // object-position is the export's crop offset, so both frame it alike.
                  { objectFit: fit, objectPosition: `${at.x * 100}% ${at.y * 100}%` }) as React.CSSProperties,
              "data-clip": seg.el.id,
              onLoadedMetadata: noteSize(a.id),
              onLoad: noteSize(a.id),
            };
            return (
              <div
                key={seg.el.id}
                className={`absolute inset-0 ${visible ? "" : "hidden"}`}
                // The background fills the bars, so a clip blends, wipes and
                // slides together with them, as each is one frame in the export.
                style={{
                  background: edl.output.background ?? "#000",
                  opacity: look?.opacity,
                  transform: look?.transform,
                  clipPath: look?.clipPath,
                  filter: effect,
                }}
              >
              {/* The same wrapper either way, so cropping never reloads the video. */}
              <div className={`absolute ${place ? "overflow-hidden" : "inset-0"}`} style={place ? pct(place.box) : undefined}>
                {seg.el.type === "video" ? (
                  a.media_uid ? (
                    <MediaVideo
                      key={seg.el.id}
                      asset={a}
                      elementRef={(v) => {
                        if (v) videoRefs.current.set(seg.el.id, v);
                      }}
                      preload="auto"
                      playsInline
                      {...common}
                    />
                  ) : (
                    <video
                      key={seg.el.id}
                      ref={(v) => {
                        if (v) videoRefs.current.set(seg.el.id, v);
                      }}
                      src={assetUrl(a)}
                      preload="auto"
                      playsInline
                      {...common}
                    />
                  )
                ) : (
                  <img key={seg.el.id} src={assetUrl(a)} {...common} />
                )}
              </div>
              {/* its fade to black, over the clip and under everything laid on it */}
              {gain < 1 && (
                // The export's fade colour, whatever the project's background.
                <div className="absolute inset-0 pointer-events-none" style={{ background: "#000", opacity: 1 - gain }} />
              )}
              </div>
            );
          })}

          {/* project captions, under the overlays so a title placed by hand stays on top */}
          {captions &&
            captions.lines
              .filter((line) => playhead >= line.from && playhead < line.to)
              .map((line, n) => (
                <TextOnStage
                  key={`caption-${line.from}-${n}`}
                  t={captionText(line, captions.style, edl.output, `caption-${n}`)}
                  frame={edl.output}
                  scale={scale}
                />
              ))}

          {/* overlays */}
          {(edl.overlays ?? []).map((track, ti) =>
            track.hidden
              ? null
              : track.elements.map((el, i) => {
                  const show = playhead >= el.startTime && playhead < el.startTime + el.duration;
                  if (!show) return null;
                  const selected = sel?.area === "ovl" && sel.ti === ti && sel.i === i;
                  if (el.type === "text") {
                    return (
                      <TextOnStage
                        key={el.id}
                        t={{ ...(el as OverlayText), opacity: overlayOpacity(el) }}
                        frame={edl.output}
                        scale={scale}
                        selected={selected}
                        onPointerDown={dragOverlay(ti, i)}
                      />
                    );
                  }
                  const m = el as OverlayMedia;
                  const a = resolveAsset(m.src);
                  if (!a) return null;
                  const shape = m.crop ? shapeFor(a) : undefined;
                  if (shape && m.crop) {
                    const kept = croppedShape(shape, m.crop);
                    const { source } = placeClip(shape, m.crop, kept, "contain");
                    return (
                      <div
                        key={el.id}
                        onPointerDown={dragOverlay(ti, i)}
                        className={`absolute cursor-move overflow-hidden ${selected ? "outline outline-2 outline-ring" : ""}`}
                        style={{
                          left: `${m.x * 100}%`,
                          top: `${m.y * 100}%`,
                          width: `${m.width * 100}%`,
                          aspectRatio: `${kept.width} / ${kept.height}`,
                          opacity: overlayOpacity(m),
                        }}
                      >
                        {m.type === "image" ? (
                          <img src={assetUrl(a)} className="absolute max-w-none pointer-events-none" style={pct(source)} />
                        ) : (
                          <video src={assetUrl(a)} muted className="absolute max-w-none pointer-events-none" style={{ ...pct(source), objectFit: "fill" }} />
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={el.id}
                      onPointerDown={dragOverlay(ti, i)}
                      className={`absolute cursor-move ${selected ? "outline outline-2 outline-ring" : ""}`}
                      style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.width * 100}%`, opacity: overlayOpacity(m) }}
                    >
                      {m.type === "image" ? (
                        <img src={assetUrl(a)} onLoad={noteSize(a.id)} className="w-full h-auto pointer-events-none" />
                      ) : (
                        <video src={assetUrl(a)} onLoadedMetadata={noteSize(a.id)} muted className="w-full h-auto pointer-events-none" />
                      )}
                    </div>
                  );
                }),
          )}

          {/* audio elements live off-stage */}
          {(edl.audio ?? []).flatMap((track) =>
            track.elements.map((el) => {
              const a = resolveAsset(el.src);
              return a ? (
                <audio
                  key={el.id}
                  ref={(n) => {
                    if (n) audioRefs.current.set(el.id, n);
                  }}
                  src={assetUrl(a)}
                  preload="auto"
                />
              ) : null;
            }),
          )}

          {total === 0 && (
            <div className="absolute inset-0 grid place-items-center px-6 text-center text-body-sm text-faint">
              Add clips from the Media panel to start the cut
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A blur or pixelate transition's effect, as an SVG filter both clips' layers
 * use. Sizes come in output pixels (shared/transition.ts) and are drawn at the
 * stage's scale. The blur is centred where xfade's box runs right of each
 * pixel, which does not read at half a frame's spread; the blocks sample each
 * square at its centre, as xfade does.
 */
function TransitionFilter({ id, blurBox, block, scale }: { id: string; blurBox?: number; block?: number; scale: number }) {
  const b = (block ?? 0) * scale;
  return (
    <svg className="absolute w-0 h-0" aria-hidden>
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {blurBox && blurBox > 1 ? (
          // A box of width w spreads like a Gaussian of deviation w/√12.
          <feGaussianBlur stdDeviation={`${(blurBox / Math.sqrt(12)) * scale} 0`} edgeMode="duplicate" />
        ) : b >= 1 ? (
          <>
            <feFlood x={b / 2} y={b / 2} width={1} height={1} />
            <feComposite width={b} height={b} />
            <feTile result="grid" />
            <feComposite in="SourceGraphic" in2="grid" operator="in" />
            <feMorphology operator="dilate" radius={b / 2} />
          </>
        ) : null}
      </filter>
    </svg>
  );
}

/** A rectangle in shares of its container, as CSS. */
const pct = (r: { left: number; top: number; width: number; height: number }): React.CSSProperties => ({
  left: `${r.left * 100}%`,
  top: `${r.top * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});

// ── format ──────────────────────────────────────────────────────────────────

type Shape = { width: number; height: number };

/** Each asset's own frame size, looked up once per page load. */
const shapeCache = new Map<string, Promise<Shape | null>>();

function shapeOf(a: Asset): Promise<Shape | null> {
  let found = shapeCache.get(a.id);
  if (!found) {
    found = findShape(a).catch(() => null);
    // Footage still ingesting has no size yet: ask again next time.
    found.then((shape) => shape || shapeCache.delete(a.id));
    shapeCache.set(a.id, found);
  }
  return found;
}

async function findShape(a: Asset): Promise<Shape | null> {
  if (a.media_uid) {
    const r = await api.get<{ ready: boolean; width?: number | null; height?: number | null }>(`/api/assets/${a.id}/playback`);
    return r.ready && r.width && r.height ? { width: r.width, height: r.height } : null;
  }
  if (isImageAsset(a)) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = assetUrl(a);
    });
  }
  if (!isVideoAsset(a)) return null;
  // Only the header is read; the element lets go of the file straight after.
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (shape: Shape | null) => {
      v.removeAttribute("src");
      v.load();
      resolve(shape);
    };
    v.onloadedmetadata = () => done(v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null);
    v.onerror = () => done(null);
    v.src = assetUrl(a);
  });
}

function useShapes(assets: Asset[]): Map<string, Shape> {
  const [shapes, setShapes] = useState(new Map<string, Shape>());
  const key = assets.map((a) => a.id).join(",");
  useEffect(() => {
    let dead = false;
    for (const a of assets) {
      shapeOf(a).then((shape) => {
        if (!dead && shape) setShapes((cur) => (cur.has(a.id) ? cur : new Map(cur).set(a.id, shape)));
      });
    }
    return () => {
      dead = true;
    };
    // The ids are the dependency: the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shapes;
}

/** A shape drawn to scale in a fixed square, so shapes compare at a glance. */
function ShapeGlyph({ width, height }: Shape) {
  return (
    <span className="grid place-items-center w-4 h-4 shrink-0" aria-hidden>
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ aspectRatio: `${width} / ${height}`, [width >= height ? "width" : "height"]: "100%" }}
      />
    </span>
  );
}

/**
 * The video's shape. The presets cover where videos are posted; "Original"
 * offers the shapes of the footage on the timeline, so a project can match
 * its clips. Changing it keeps the resolution and rescales titles and logos
 * (shared/format.ts, which Ask uses too), as one undo step.
 */
function FormatPicker({
  edl,
  update,
  resolveAsset,
}: {
  edl: Edl;
  update: (fn: (d: Edl) => void) => void;
  resolveAsset: (src: string) => Asset | undefined;
}) {
  const [open, setOpen] = useState(false);
  const frame = edl.output;
  const clips = useMemo(() => {
    const seen = new Map<string, Asset>();
    for (const el of edl.main.elements) {
      const a = resolveAsset(el.src);
      if (a && !seen.has(a.id)) seen.set(a.id, a);
    }
    return [...seen.values()];
  }, [edl.main.elements, resolveAsset]);
  const shapes = useShapes(clips);

  // One choice per distinct shape, named after the first clip that has it.
  const originals: { shape: Shape; clip: Asset }[] = [];
  for (const clip of clips) {
    const shape = shapes.get(clip.id);
    if (shape && !originals.some((o) => sameShape(o.shape, shape))) originals.push({ shape, clip });
  }

  const preset = presetFor(frame.width, frame.height);
  const choose = (shape: Shape) => {
    setOpen(false);
    const size = sizeFor(`${shape.width}:${shape.height}`, Math.max(frame.width, frame.height));
    if (!size || (size.width === frame.width && size.height === frame.height)) return;
    update((d) => Object.assign(d, reshape(d, size.width, size.height)));
  };

  // The current shape, as the one entry it matches: a preset first, then a clip's own shape.
  const chosenPreset = FORMAT_PRESETS.find((p) => {
    const r = parseRatio(p.ratio)!;
    return sameShape({ width: r.w, height: r.h }, frame);
  });
  const chosenOriginal = originals.find((o) => sameShape(o.shape, frame));
  const chosenKey = chosenPreset
    ? `preset ${chosenPreset.ratio}`
    : chosenOriginal
      ? `original ${chosenOriginal.clip.id}`
      : undefined;

  const item = (value: string, shape: Shape, name: string, detail: string) => (
    <CommandItem key={value} value={value} chosen={value === chosenKey} onSelect={() => choose(shape)}>
      <ShapeGlyph {...shape} />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{name}</span>
        <span className="block truncate text-fine text-faint">{detail}</span>
      </span>
      <span className="text-fine text-muted tabular-nums">{ratioLabel(shape.width, shape.height)}</span>
    </CommandItem>
  );

  return (
    <Row label="Format">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SelectTrigger kind="field">
            <ShapeGlyph {...frame} />
            <span className="flex-1 truncate">{preset ? preset.name : "Custom"}</span>
            <span className="text-fine text-muted tabular-nums">{ratioLabel(frame.width, frame.height)}</span>
          </SelectTrigger>
        </PopoverTrigger>
        <PopoverContent>
          <Command label="Format" chosen={chosenKey}>
            <CommandGroup heading="Presets">
              {FORMAT_PRESETS.map((p) => {
                const r = parseRatio(p.ratio)!;
                return item(`preset ${p.ratio}`, { width: r.w, height: r.h }, p.name, p.hint);
              })}
            </CommandGroup>
            {originals.length > 0 && (
              <CommandGroup heading="Original">
                {originals.map(({ shape, clip }) =>
                  item(`original ${clip.id}`, shape, clip.name, `${shape.width}×${shape.height}`),
                )}
              </CommandGroup>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </Row>
  );
}

const FONTS: { value: NonNullable<OverlayText["fontFamily"]>; name: string; css: string }[] = [
  { value: "sans", name: "Sans", css: "Inter, sans-serif" },
  { value: "serif", name: "Serif", css: "serif" },
  { value: "mono", name: "Mono", css: "monospace" },
];

/** A title's typeface, each choice written in its own face. */
function FontPicker({
  value,
  onChange,
}: {
  value: NonNullable<OverlayText["fontFamily"]>;
  onChange: (f: NonNullable<OverlayText["fontFamily"]>) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = FONTS.find((f) => f.value === value) ?? FONTS[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SelectTrigger kind="field">
          <span className="flex-1 truncate" style={{ fontFamily: current.css }}>
            {current.name}
          </span>
        </SelectTrigger>
      </PopoverTrigger>
      <PopoverContent>
        <Command label="Font" chosen={current.value}>
          {FONTS.map((f) => (
            <CommandItem
              key={f.value}
              value={f.value}
              chosen={f.value === value}
              onSelect={() => {
                onChange(f.value);
                setOpen(false);
              }}
            >
              <span className="flex-1" style={{ fontFamily: f.css }}>
                {f.name}
              </span>
            </CommandItem>
          ))}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A labelled group of buttons. A <label> would pass a click on its text to the first button. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <span className="block text-label text-muted mb-1">{label}</span>
      {children}
    </div>
  );
}

type Fit = "contain" | "cover";
const FIT_CHOICES: [Fit, string][] = [
  ["contain", "Fit with bars"],
  ["cover", "Fill and crop"],
];

/** Letterbox or fill, for every clip at once: what a change of format usually needs next. */
function ClipsFit({ edl, update }: { edl: Edl; update: (fn: (d: Edl) => void) => void }) {
  if (edl.main.elements.length === 0) return null;
  const fits = new Set(edl.main.elements.map((e) => e.fit ?? "contain"));
  return (
    <Field label="How clips fill the frame">
      <Choice<Fit | "mixed">
        label="How clips fill the frame"
        value={fits.size === 1 ? [...fits][0] : "mixed"}
        options={FIT_CHOICES}
        onChange={(fit) =>
          update((d) => {
            for (const el of d.main.elements) el.fit = fit as Fit;
          })
        }
      />
    </Field>
  );
}

/**
 * Which part of a filled clip stays in frame. Only the side that spills over
 * the frame can move, so only its three choices are offered; dragging the
 * clip in the preview is the fine control.
 */
function ClipFraming({
  asset,
  crop,
  frame,
  onChange,
}: {
  asset: Asset | undefined;
  crop: Crop | undefined;
  frame: Edl["output"];
  onChange: (anchor: Anchor) => void;
}) {
  const shapes = useShapes(asset ? [asset] : []);
  const shape = asset && shapes.get(asset.id);
  if (!shape) return null;
  const overflow = coverOverflow(croppedShape(shape, crop), frame);
  const sideways = overflow.x > 0.005;
  if (!sideways && overflow.y <= 0.005) return null;

  const group = "inline-flex items-center gap-0.5 rounded-sm bg-surface-sunken p-0.5";
  const cell = "grid place-items-center w-7 h-6 rounded-xs text-muted hover:text-foreground hover:bg-surface";
  const choices: [number, string, React.ReactNode][] = sideways
    ? [
        [0, "Keep the left side", <AlignStartVertical key="l" className="w-4 h-4" />],
        [0.5, "Keep the middle", <AlignCenterVertical key="c" className="w-4 h-4" />],
        [1, "Keep the right side", <AlignEndVertical key="r" className="w-4 h-4" />],
      ]
    : [
        [0, "Keep the top", <AlignStartHorizontal key="t" className="w-4 h-4" />],
        [0.5, "Keep the middle", <AlignCenterHorizontal key="m" className="w-4 h-4" />],
        [1, "Keep the bottom", <AlignEndHorizontal key="b" className="w-4 h-4" />],
      ];

  return (
    <Field label="Framing">
      <div className="flex items-center gap-2">
        <div className={group} role="group" aria-label="Framing">
          {choices.map(([v, label, icon]) => (
            <button
              key={label}
              className={cell}
              aria-label={label}
              title={label}
              onClick={() => onChange(sideways ? { x: v, y: 0.5 } : { x: 0.5, y: v })}
            >
              {icon}
            </button>
          ))}
        </div>
        <span className="text-fine text-faint">or drag it in the preview</span>
      </div>
    </Field>
  );
}

/** Letterbox or fill, for one clip. */
function ClipFit({ value, onChange }: { value?: Fit; onChange: (fit: Fit) => void }) {
  return (
    <Field label="How it fills the frame">
      <Choice<Fit> label="How it fills the frame" value={value ?? "contain"} options={FIT_CHOICES} onChange={onChange} />
    </Field>
  );
}

// ── crop ────────────────────────────────────────────────────────────────────

/** The shapes a crop can be held to. "frame" is the video's own shape. */
const CROP_RATIOS = ["free", "frame", "16:9", "9:16", "1:1", "4:5"] as const;
type CropRatio = (typeof CROP_RATIOS)[number];

const HANDLES: { h: Handle; at: string; cursor: string }[] = [
  { h: "nw", at: "left-0 top-0", cursor: "nwse-resize" },
  { h: "n", at: "left-1/2 top-0", cursor: "ns-resize" },
  { h: "ne", at: "left-full top-0", cursor: "nesw-resize" },
  { h: "e", at: "left-full top-1/2", cursor: "ew-resize" },
  { h: "se", at: "left-full top-full", cursor: "nwse-resize" },
  { h: "s", at: "left-1/2 top-full", cursor: "ns-resize" },
  { h: "sw", at: "left-0 top-full", cursor: "nesw-resize" },
  { h: "w", at: "left-0 top-1/2", cursor: "ew-resize" },
];

/**
 * The part of the picture a clip keeps. Opens the crop dialog; the crop is
 * applied before the clip fits or fills the frame, so what is kept is scaled
 * up the way footage shot at that size would be.
 */
function CropField({
  asset,
  crop,
  frame,
  window,
  startAt,
  hint,
  onChange,
}: {
  asset: Asset | undefined;
  crop: Crop | undefined;
  frame: Edl["output"];
  /** The part of a video the clip plays, in source seconds, for the scrubber. */
  window?: { from: number; to: number };
  /** Where the scrubber starts: the source second under the playhead. */
  startAt: () => number;
  hint: string;
  onChange: (crop: Crop | undefined) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!asset) return null;
  return (
    <Field label="Crop">
      <div className="flex items-center gap-2">
        <button className={btnSecondary} onClick={() => setOpen(startAt())}>
          <CropIcon className="w-4 h-4" /> {crop ? "Change crop" : "Crop"}
        </button>
        {crop && (
          <button className={btnGhost} onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>
      {open !== null && (
        <CropDialog
          asset={asset}
          initial={crop}
          frame={frame}
          window={window}
          startAt={open}
          hint={hint}
          onClose={() => setOpen(null)}
          onApply={(next) => {
            onChange(next);
            setOpen(null);
          }}
        />
      )}
    </Field>
  );
}

function CropDialog({
  asset,
  initial,
  frame,
  window: span,
  startAt,
  hint,
  onClose,
  onApply,
}: {
  asset: Asset;
  initial: Crop | undefined;
  frame: Edl["output"];
  window?: { from: number; to: number };
  startAt: number;
  hint: string;
  onClose: () => void;
  onApply: (crop: Crop | undefined) => void;
}) {
  // As in the preview: the decoded frame's size, once the element has it.
  const [decoded, setDecoded] = useState<Shape | null>(null);
  const reported = useShapes([asset]).get(asset.id);
  const shape = decoded ?? reported;
  const noteSize = (e: React.SyntheticEvent<HTMLVideoElement | HTMLImageElement>) => {
    const m = e.currentTarget;
    const width = m instanceof HTMLVideoElement ? m.videoWidth : m.naturalWidth;
    const height = m instanceof HTMLVideoElement ? m.videoHeight : m.naturalHeight;
    if (width && height && (decoded?.width !== width || decoded?.height !== height)) setDecoded({ width, height });
  };
  const [crop, setCrop] = useState<Crop>(initial ?? FULL);
  const [ratioKey, setRatioKey] = useState<CropRatio>("free");
  const [t, setT] = useState(span ? Math.min(span.to, Math.max(span.from, startAt)) : 0);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const ratioOfKey = (key: CropRatio): number | undefined => {
    if (key === "free") return undefined;
    if (key === "frame") return frame.width / frame.height;
    const r = parseRatio(key)!;
    return r.w / r.h;
  };
  const ratio = ratioOfKey(ratioKey);

  useEffect(() => {
    const v = videoRef.current;
    if (v && v.readyState > 0 && Math.abs(v.currentTime - t) > 0.01) v.currentTime = t;
  }, [t]);

  const pickRatio = (key: CropRatio) => {
    setRatioKey(key);
    const r = ratioOfKey(key);
    if (r && shape) setCrop(cropToRatio(shape, r, { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 }));
  };

  const drag = (handle: Handle | "move") => (e: React.PointerEvent) => {
    if (!shape) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = boxRef.current!.getBoundingClientRect();
    const from = crop;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / rect.width;
      const dy = (ev.clientY - sy) / rect.height;
      setCrop(handle === "move" ? moveCrop(from, dx, dy) : resizeCrop(from, handle, dx, dy, shape, ratio));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Arrow keys move the kept area; Shift moves it further.
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setCrop((c) => moveCrop(c, d[0], d[1]));
  };

  const video = isVideoAsset(asset);
  const media = {
    className: "absolute inset-0 w-full h-full pointer-events-none",
    style: { objectFit: "fill" } as React.CSSProperties,
  };
  const kept = shape && croppedShape(shape, crop);
  // "Video 9:16" already says 9:16: don't offer it twice.
  const isFrameShape = (key: CropRatio) => {
    const r = key !== "free" && key !== "frame" ? parseRatio(key) : null;
    return !!r && sameShape({ width: r.w, height: r.h }, frame);
  };
  const ratioLabelFor = (key: CropRatio) =>
    key === "free" ? "Free" : key === "frame" ? `Video ${ratioLabel(frame.width, frame.height)}` : key;

  return (
    <Dialog
      title="Crop"
      icon={<CropIcon className="w-4 h-4 text-muted" />}
      description={hint}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button
            className={`${btnGhost} mr-auto`}
            disabled={isFull(crop)}
            onClick={() => {
              setCrop(FULL);
              setRatioKey("free");
            }}
          >
            Reset
          </button>
          <button onClick={onClose} className={btnGhost}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button onClick={() => onApply(tidyCrop(crop))} className={btnPrimary} disabled={!shape} data-autofocus>
            <Check className="w-4 h-4" /> Done
          </button>
        </>
      }
    >
      <div className="mt-4">
        <Choice<CropRatio>
          label="Shape"
          value={ratioKey}
          options={CROP_RATIOS.filter((k) => !isFrameShape(k)).map((k) => [k, ratioLabelFor(k)])}
          onChange={pickRatio}
        />
      </div>
      <div className="mt-3 grid place-items-center rounded-md bg-surface-sunken p-3">
        {shape ? (
          <div
            ref={boxRef}
            className="relative select-none touch-none"
            style={{
              aspectRatio: `${shape.width} / ${shape.height}`,
              width: `min(100%, calc(50vh * ${shape.width / shape.height}))`,
            }}
          >
            {/* The picture and its dimming are clipped; the handles are not, so a corner on the edge stays whole. */}
            <div className="absolute inset-0 overflow-hidden">
              {video ? (
                asset.media_uid ? (
                  <MediaVideo
                    asset={asset}
                    elementRef={(v) => (videoRef.current = v)}
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = t;
                      noteSize(e);
                    }}
                    muted
                    playsInline
                    preload="auto"
                    {...media}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    src={assetUrl(asset)}
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = t;
                      noteSize(e);
                    }}
                    muted
                    playsInline
                    preload="auto"
                    {...media}
                  />
                )
              ) : (
                <img src={assetUrl(asset)} alt="" onLoad={noteSize} {...media} />
              )}
              <div
                className="absolute pointer-events-none"
                style={{ ...pct({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }), boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)" }}
              />
            </div>
            {/* The kept area. */}
            <div
              role="group"
              aria-label="Kept area. Arrow keys move it."
              tabIndex={0}
              onKeyDown={onKey}
              onPointerDown={drag("move")}
              className="absolute cursor-move outline outline-2 outline-white focus-visible:outline-ring"
              style={pct({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })}
            >
              {HANDLES.map(({ h, at, cursor }) => (
                <span
                  key={h}
                  onPointerDown={drag(h)}
                  className={`absolute ${at} -translate-x-1/2 -translate-y-1/2 grid place-items-center w-6 h-6`}
                  style={{ cursor }}
                  aria-hidden
                >
                  <span className="block w-2.5 h-2.5 rounded-xs bg-white shadow-raised" />
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-16 text-body-sm text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the picture…
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        {video && span && span.to - span.from > 0.05 && (
          <input
            type="range"
            className="flex-1"
            aria-label="Frame to look at"
            min={span.from}
            max={span.to}
            step={0.01}
            value={t}
            onChange={(e) => setT(Number(e.target.value))}
          />
        )}
        {kept && shape && (
          <span className="ml-auto text-fine text-faint tabular-nums">
            Keeps {Math.round(kept.width)}×{Math.round(kept.height)} of {shape.width}×{shape.height}
            {ratio === undefined && !isFull(crop) ? ` (${ratioLabel(Math.round(kept.width), Math.round(kept.height))})` : ""}
          </span>
        )}
      </div>
    </Dialog>
  );
}

// ── inspector ───────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-label text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Section title inside the inspector rail — sentence case in `label`, never
 *  the 11px tracked style (that one belongs above a KPI number). */
function Zone({ children }: { children: React.ReactNode }) {
  return <div className="text-label text-muted mb-3">{children}</div>;
}

const inputCls = "field";

function NumberRow({ label, value, onChange, step = 0.1, min, max }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <Row label={label}>
      <input type="number" className={inputCls} value={Number(value.toFixed(3))} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  );
}

function SliderRow({ label, value, onChange, min = 0, max = 1, step = 0.01 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <Row label={`${label} — ${value.toFixed(2)}`}>
      <input type="range" className="w-full" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  );
}

/**
 * Fade in and out for any clip. `heard` is how long it is seen or heard: the
 * fade-out ends there, so music or a logo running past the cut fades out with
 * the video.
 */
function Fades({
  el,
  heard,
  onChange,
}: {
  el: { fadeIn?: number; fadeOut?: number };
  heard: number;
  onChange: (key: "fadeIn" | "fadeOut", seconds: number) => void;
}) {
  const row = (key: "fadeIn" | "fadeOut", label: string) => {
    // Ten seconds covers fades set by hand; a longer one set by an agent widens
    // the slider rather than being misreported. Past what is heard a fade does
    // nothing more, so the slider stops there.
    const set = el[key] ?? 0;
    const max = Math.max(0.1, Math.floor(Math.min(heard, Math.max(10, set)) * 10) / 10);
    const v = Math.min(set, max);
    return (
      <Row label={`${label} — ${v > 0 ? `${v.toFixed(1)}s` : "off"}`}>
        <input
          type="range"
          className="w-full"
          aria-label={label}
          value={v}
          min={0}
          max={max}
          step={0.1}
          onChange={(e) => onChange(key, Number(e.target.value))}
        />
      </Row>
    );
  };
  return (
    <>
      {row("fadeIn", "Fade in")}
      {row("fadeOut", "Fade out")}
    </>
  );
}

/**
 * A style's icon: how the picture changes, drawn small. Wipes and slides are
 * drawn moving left and turned for the other directions.
 */
function TransitionIcon({ type, className = "w-4 h-4" }: { type?: TransitionType; className?: string }) {
  const turn = type?.endsWith("-right") ? 180 : type?.endsWith("-up") ? 90 : type?.endsWith("-down") ? -90 : 0;
  const glyph = (() => {
    switch (type) {
      case undefined:
        // A cut: two clips meeting, the mark editors put on an edit.
        return <path d="M2.5 4v8l5.5-4zM13.5 4v8L8 8z" fill="currentColor" stroke="none" />;
      case "dissolve":
        return (
          <>
            <rect x="1.75" y="3.25" width="8.5" height="8.5" rx="1.5" />
            <rect x="5.75" y="4.25" width="8.5" height="8.5" rx="1.5" fill="currentColor" fillOpacity={0.35} />
          </>
        );
      case "fade-black":
      case "fade-white":
        // Out of one frame, through a solid one (or a blank one), into the next.
        return (
          <>
            <rect x="1" y="4.5" width="4" height="7" rx="1" />
            <rect x="6" y="4.5" width="4" height="7" rx="1" fill={type === "fade-black" ? "currentColor" : "none"} />
            <rect x="11" y="4.5" width="4" height="7" rx="1" />
          </>
        );
      case "blur":
        return (
          <>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M4.5 6.5h7M3.5 8h9M5 9.5h5.5" />
          </>
        );
      case "pixelize":
        return (
          <>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M2 3h6v5H2zM8 8h6v5H8z" fill="currentColor" fillOpacity={0.45} stroke="none" />
          </>
        );
      default:
        return type.startsWith("wipe") ? (
          // The edge sweeping across the frame.
          <>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M8 2.75v10.5" />
            <path d="M8.75 3h4a1.25 1.25 0 0 1 1.25 1.25v7.5A1.25 1.25 0 0 1 12.75 13h-4z" fill="currentColor" fillOpacity={0.35} stroke="none" />
            <path d="M6.5 8H3.5M5 6.5 3.5 8 5 9.5" />
          </>
        ) : (
          // The next frame pushing in, the arrow its way.
          <>
            <rect x="6.25" y="3.75" width="8" height="8.5" rx="1.5" fill="currentColor" fillOpacity={0.35} />
            <path d="M4.25 8H1M2.5 6.5 1 8l1.5 1.5" />
          </>
        );
    }
  })();
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={turn ? { transform: `rotate(${turn}deg)` } : undefined}
      aria-hidden
    >
      {glyph}
    </svg>
  );
}

/** A tile's short name: its group says the rest ("Wipe" over "Left"). */
const tileName = (name: string) => {
  const short = name.replace(/^(Wipe|Slide|Fade) /, "");
  return short.charAt(0).toUpperCase() + short.slice(1);
};

/**
 * The transition on one cut: a style from the tiles (or none, a cut), its
 * length, and a way to put the same one on every cut. `plays` is what it
 * actually gets once shortened to fit the clips on either side
 * (shared/transition.ts).
 */
function TransitionPanel({
  value,
  plays,
  shortened,
  onChange,
  onApplyToAll,
}: {
  value?: Transition;
  plays: number;
  shortened: boolean;
  onChange: (t: Transition | undefined, coalesce?: boolean) => void;
  onApplyToAll: (t: Transition) => void;
}) {
  const tile = (key: string, chosen: boolean, title: string, label: string, icon: React.ReactNode, pick: () => void) => (
    <button
      key={key}
      onClick={pick}
      title={title}
      aria-pressed={chosen}
      className={`flex flex-col items-center gap-1 rounded-sm px-1 py-2 text-fine leading-tight text-center ${
        chosen ? "bg-surface-sunken text-foreground shadow-edge" : "text-muted hover:bg-surface-sunken hover:text-foreground"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <>
      <div className="grid grid-cols-3 gap-1 mb-3">
        {tile("cut", !value, "Cut: no transition", "Cut", <TransitionIcon className="w-6 h-6" />, () => onChange(undefined))}
      </div>
      {TRANSITION_GROUPS.map((group) => (
        <div key={group.label} className="mb-3">
          <span className="block text-label text-muted mb-1">{group.label}</span>
          <div className="grid grid-cols-3 gap-1">
            {group.items.map((item) =>
              tile(item.type, item.type === value?.type, item.name, tileName(item.name), <TransitionIcon type={item.type} className="w-6 h-6" />, () =>
                onChange({ type: item.type, duration: value?.duration ?? DEFAULT_TRANSITION_SECONDS }),
              ),
            )}
          </div>
        </div>
      ))}
      {value && (
        <Row label={`Length: ${value.duration.toFixed(1)}s`}>
          <input
            type="range"
            className="w-full"
            aria-label="Transition length"
            value={value.duration}
            min={0.1}
            max={MAX_TRANSITION_SECONDS}
            step={0.1}
            // One drag, one undo step, as on the fade sliders.
            onChange={(e) => onChange({ ...value, duration: Number(e.target.value) }, true)}
          />
        </Row>
      )}
      {value && shortened && (
        <p className="text-fine text-muted -mt-2 mb-3">
          Plays {plays.toFixed(1)}s: the clips on either side are too short for more.
        </p>
      )}
      {value && (
        <button onClick={() => onApplyToAll(value)} className={`${btnSecondary} ${stretch}`}>
          Apply to every cut
        </button>
      )}
    </>
  );
}

function Inspector({
  pane,
  edl,
  sel,
  update,
  srcDur,
  resolveAsset,
  segments,
  onDelete,
  brief,
  setBrief,
  playheadRef,
}: {
  pane: Pane;
  edl: Edl;
  sel: Sel;
  /** `coalesce` folds this edit into the previous undo step (one drag, one step). */
  update: (fn: (d: Edl) => void, coalesce?: boolean) => void;
  srcDur: (src: string) => number | undefined;
  resolveAsset: (src: string) => Asset | undefined;
  segments: ReturnType<typeof mainSegments>;
  onDelete: () => void;
  brief: string;
  setBrief: (b: string) => void;
  /** Read when the crop dialog opens, so the inspector need not re-render with the playhead. */
  playheadRef: React.MutableRefObject<number>;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState("");

  const body = () => {
    if (!sel)
      return (
        <div className="mt-2">
          <FormatPicker edl={edl} update={update} resolveAsset={resolveAsset} />
          <ClipsFit edl={edl} update={update} />
          <Row label="Project brief: what is this video for?">
            <textarea
              className={`${inputCls} min-h-20`}
              placeholder="e.g. 30-second product teaser for Instagram — energetic"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Row>
          <p className="text-fine text-muted">
            The brief anchors every AI action: cuts are only “effective” relative to a goal.
          </p>
          <div className="mt-4 text-fine text-faint text-center tabular-nums">
            {edl.output.width}×{edl.output.height} at {edl.output.fps}fps
            <br />
            Select a clip to edit it
          </div>
        </div>
      );

    if (sel.area === "cut") {
      const el = edl.main.elements[sel.i];
      const seg = segments.find((x) => x.i === sel.i);
      if (!el || !seg || sel.i === 0) return null;
      const plays = seg.before + seg.after;
      return (
        <>
          <Zone>Transition</Zone>
          <TransitionPanel
            value={el.transition}
            plays={plays}
            // Within half a frame is the length asked for, rounded to frames.
            shortened={!!el.transition && plays < el.transition.duration - 0.5 / edl.output.fps}
            onChange={(t, coalesce) =>
              update((d) => {
                const clip = d.main.elements[sel.i];
                if (t) clip.transition = t;
                else delete clip.transition;
              }, coalesce)
            }
            onApplyToAll={(t) => update((d) => d.main.elements.forEach((clip, k) => k > 0 && (clip.transition = { ...t })))}
          />
        </>
      );
    }

    if (sel.area === "main") {
      const el = edl.main.elements[sel.i];
      if (!el) return null;
      const set = (fn: (e: MainElement) => void) => update((d) => fn(d.main.elements[sel.i]));
      const dur = srcDur(el.src);
      const seg = segments.find((x) => x.i === sel.i);
      const mainCrop = (clip: MainElement) => {
        const from = clip.type === "video" ? (clip.trimStart ?? 0) : 0;
        return (
          <CropField
            asset={resolveAsset(clip.src)}
            crop={clip.crop}
            frame={edl.output}
            window={clip.type === "video" && seg ? { from, to: from + seg.dur } : undefined}
            // The frame under the playhead when it is on this clip, else the clip's first.
            startAt={() => from + (seg ? Math.min(seg.dur, Math.max(0, playheadRef.current - seg.start)) : 0)}
            hint="Keep part of the picture. What you keep fills the clip's place in the frame, scaled up the way it fits or fills."
            onChange={(crop) =>
              set((x) => {
                if (crop) x.crop = crop;
                else delete x.crop;
              })
            }
          />
        );
      };
      const mainFades = seg && (
        <>
          <Fades
            el={el}
            heard={seg.dur}
            // One drag, one undo step, as on audio clips.
            onChange={(k, n) => update((d) => void (d.main.elements[sel.i][k] = n > 0 ? n : undefined), true)}
          />
          {(el.fadeIn || el.fadeOut) && (
            <p className="text-fine text-muted -mt-2 mb-3">
              {el.type === "video" ? "Fades from and to black, with the clip's sound." : "Fades from and to black."} A fade out
              here and a fade in on the next clip make a fade through black.
            </p>
          )}
        </>
      );
      return (
        <>
          <Zone>{el.type === "video" ? "Video clip" : "Image"}</Zone>
          {el.type === "video" ? (
            <>
              <NumberRow label="Trim start (s)" value={el.trimStart ?? 0} min={0} onChange={(n) => set((e) => ((e as MainVideo).trimStart = Math.max(0, n)))} />
              {el.duration !== undefined ? (
                <NumberRow label="Play duration (s)" value={el.duration} min={0.1} onChange={(n) => set((e) => ((e as MainVideo).duration = Math.max(0.1, n)))} />
              ) : (
                <NumberRow label="Trim end (s)" value={el.trimEnd ?? 0} min={0} onChange={(n) => set((e) => ((e as MainVideo).trimEnd = Math.max(0, n)))} />
              )}
              <ClipFit value={el.fit} onChange={(fit) => set((x) => ((x as MainVideo).fit = fit))} />
              {el.fit === "cover" && (
                <ClipFraming
                  asset={resolveAsset(el.src)}
                  crop={el.crop}
                  frame={edl.output}
                  onChange={(anchor) => set((x) => ((x as MainVideo).anchor = anchor))}
                />
              )}
              {mainCrop(el)}
              <Row label="Clip audio">
                <button
                  className={`${inputCls} text-left`}
                  onClick={() => set((e) => ((e as MainVideo).sourceAudio = (e as MainVideo).sourceAudio === false ? undefined : false))}
                >
                  {el.sourceAudio === false ? "Muted — click to enable" : "On — click to mute"}
                </button>
              </Row>
              <SliderRow label="Volume" value={el.volume ?? 1} max={2} onChange={(n) => set((e) => ((e as MainVideo).volume = n))} />
              {mainFades}
              <button
                disabled={analyzing}
                onClick={async () => {
                  const a = resolveAsset(el.src);
                  if (!a) return;
                  setAnalyzing(true);
                  setAnalyzeMsg("");
                  try {
                    // Give the model the purpose + surroundings — even cleanup
                    // shouldn't be blind to what the clip sits inside.
                    const others = segments
                      .filter((s) => s.i !== sel.i)
                      .map((s) => resolveAsset(s.el.src)?.name)
                      .filter(Boolean)
                      .join(", ");
                    const context = [
                      brief && `Project purpose: ${brief}.`,
                      others && `On the timeline it sits alongside: ${others}.`,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    // The part of the source this clip plays now: the analysis
                    // stays inside it instead of undoing the trims already made.
                    const seg = segments.find((x) => x.i === sel.i);
                    const from = (el as MainVideo).trimStart ?? 0;
                    const window = seg ? { start: from, end: from + seg.dur } : undefined;
                    const r = await api.send<AnalyzeResult>("POST", `/api/assets/${a.id}/analyze`, {
                      // Cuts only. Captions are their own deliberate step: added
                      // here they landed on top of subtitles already in the footage.
                      mode: "cuts",
                      ...(context ? { prompt: context } : {}),
                      ...(window ? { window } : {}),
                    });
                    const keeps = r.cuts.filter((c) => c.keep).sort((x, y) => x.start_ms - y.start_ms);
                    if (keeps.length === 0) {
                      setAnalyzeMsg("No keep-segments proposed.");
                      return;
                    }
                    update((d) => {
                      const base = d.main.elements[sel.i] as MainVideo;
                      const parts: MainVideo[] = keeps.map((k) => {
                        const p = { ...structuredClone(base), id: rid(), trimStart: k.start_ms / 1000, duration: (k.end_ms - k.start_ms) / 1000 };
                        delete p.trimEnd;
                        return p;
                      });
                      keepEdgeFades(parts);
                      d.main.elements.splice(sel.i, 1, ...parts);
                    });
                    setAnalyzeMsg(
                      keeps.length === 1 ? "Nothing to cut: the clip was kept whole." : `Kept ${keeps.length} parts.`,
                    );
                  } catch (e) {
                    setAnalyzeMsg(String((e as Error).message));
                  } finally {
                    setAnalyzing(false);
                  }
                }}
                /* Secondary, not solid: Export is this screen's one ink action. */
                className={`${btnSecondary} ${stretch} mt-1 mb-2`}
              >
                {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Clean up clip (AI)
              </button>
              {analyzing && (
                <div className="text-fine text-muted mb-2">Watching the clip — this takes a moment…</div>
              )}
              {analyzeMsg && <div className="text-fine text-muted mb-2">{analyzeMsg}</div>}
            </>
          ) : (
            <>
              <NumberRow label="Duration (s)" value={el.duration} min={0.1} onChange={(n) => set((e) => ((e as MainImage).duration = Math.max(0.1, n)))} />
              <ClipFit value={el.fit} onChange={(fit) => set((x) => ((x as MainImage).fit = fit))} />
              {el.fit === "cover" && (
                <ClipFraming
                  asset={resolveAsset(el.src)}
                  crop={el.crop}
                  frame={edl.output}
                  onChange={(anchor) => set((x) => ((x as MainImage).anchor = anchor))}
                />
              )}
              {mainCrop(el)}
              {mainFades}
            </>
          )}
        </>
      );
    }

    if (sel.area === "ovl") {
      const el = edl.overlays?.[sel.ti]?.elements[sel.i];
      if (!el) return null;
      const set = (fn: (e: OverlayElement) => void) => update((d) => fn(d.overlays![sel.ti].elements[sel.i]));
      return (
        <>
          <Zone>{el.type === "text" ? "Text" : el.type === "image" ? "Image overlay" : "Video overlay"}</Zone>
          {el.type === "text" && (
            <>
              <Row label="Text">
                <textarea className={`${inputCls} min-h-16`} value={el.text} onChange={(e) => set((x) => ((x as OverlayText).text = e.target.value))} />
              </Row>
              <NumberRow label="Font size (px)" value={el.fontSize} step={1} min={8} max={400} onChange={(n) => set((x) => ((x as OverlayText).fontSize = Math.round(n)))} />
              <Row label="Font">
                <FontPicker value={el.fontFamily ?? "sans"} onChange={(f) => set((x) => ((x as OverlayText).fontFamily = f))} />
              </Row>
              <div className="grid grid-cols-2 gap-2">
                <Row label="Color">
                  {/* The value IS a colour the user is authoring into the video,
                      not app chrome — a colour input is the right control. */}
                  <input type="color" className="field p-1" value={(el.color ?? DEFAULT_TEXT_COLOR).slice(0, 7)} onChange={(e) => set((x) => ((x as OverlayText).color = e.target.value))} />
                </Row>
                <Row label="Box (hex+alpha)">
                  <input className={inputCls} value={el.background ?? ""} placeholder="#00000080" onChange={(e) => set((x) => ((x as OverlayText).background = e.target.value || undefined))} />
                </Row>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Row label="Stroke">
                  {/* Dimmed while there is no outline; picking a colour adds one. */}
                  <input
                    type="color"
                    className={`field p-1 ${el.stroke ? "" : "opacity-40"}`}
                    title={el.stroke ? undefined : "No outline: pick a colour to add one"}
                    value={(el.stroke?.color ?? DEFAULT_TEXT_STROKE.color).slice(0, 7)}
                    onChange={(e) =>
                      set((x) => {
                        const t = x as OverlayText;
                        t.stroke = { color: e.target.value, width: t.stroke?.width ?? Math.min(DEFAULT_TEXT_STROKE.width, maxStrokeWidth(t.fontSize)) };
                      })
                    }
                  />
                </Row>
                <NumberRow
                  label="Width (px)"
                  value={el.stroke?.width ?? 0}
                  step={1}
                  min={0}
                  max={maxStrokeWidth(el.fontSize)}
                  onChange={(n) =>
                    set((x) => {
                      const t = x as OverlayText;
                      const width = Math.round(Math.min(maxStrokeWidth(t.fontSize), Math.max(0, n || 0)));
                      t.stroke = width > 0 ? { color: t.stroke?.color ?? DEFAULT_TEXT_STROKE.color, width } : undefined;
                    })
                  }
                />
              </div>
              {el.stroke && el.stroke.width > maxStrokeWidth(el.fontSize) && (
                <p className="text-fine text-muted -mt-2 mb-3">
                  Drawn at {maxStrokeWidth(el.fontSize)} px: an outline is at most a fifth of the font size.
                </p>
              )}
            </>
          )}
          {el.type !== "text" && <SliderRow label="Width" value={(el as OverlayMedia).width} min={0.02} onChange={(n) => set((x) => ((x as OverlayMedia).width = n))} />}
          {el.type !== "text" && (
            <CropField
              asset={resolveAsset(el.src)}
              crop={el.crop}
              frame={edl.output}
              window={
                el.type === "video"
                  ? { from: el.trimStart ?? 0, to: (el.trimStart ?? 0) + el.duration }
                  : undefined
              }
              startAt={() => (el.trimStart ?? 0) + Math.min(el.duration, Math.max(0, playheadRef.current - el.startTime))}
              hint="Keep part of the picture. It keeps its width on screen, and its height follows what you keep."
              onChange={(crop) =>
                set((x) => {
                  const m = x as OverlayMedia;
                  if (crop) m.crop = crop;
                  else delete m.crop;
                })
              }
            />
          )}
          <PositionRow
            el={el}
            frame={edl.output}
            onPlace={(place) => set((x) => Object.assign(x, place))}
          />
          <SliderRow label="Opacity" value={el.opacity ?? 1} onChange={(n) => set((x) => (x.opacity = n))} />
          <Fades
            el={el}
            heard={heardFor(el.startTime, el.duration, cutEnd(segments))}
            onChange={(k, n) => update((d) => void (d.overlays![sel.ti].elements[sel.i][k] = n > 0 ? n : undefined), true)}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberRow label="Start (s)" value={el.startTime} min={0} onChange={(n) => set((x) => (x.startTime = Math.max(0, n)))} />
            <NumberRow label="Duration (s)" value={el.duration} min={0.1} onChange={(n) => set((x) => (x.duration = Math.max(0.1, n)))} />
          </div>
        </>
      );
    }

    const el = edl.audio?.[sel.ti]?.elements[sel.i];
    if (!el) return null;
    const set = (fn: (e: AudioElement) => void) => update((d) => fn(d.audio![sel.ti].elements[sel.i]));
    const clipDur = el.duration ?? Math.max(0, (srcDur(el.src) ?? 0) - (el.trimStart ?? 0) - (el.trimEnd ?? 0));
    const heard = heardFor(el.startTime, clipDur, cutEnd(segments));
    return (
      <>
        <Zone>Audio</Zone>
        <SliderRow label="Volume" value={el.volume ?? 1} max={2} onChange={(n) => set((x) => (x.volume = n))} />
        <Fades
          el={el}
          heard={heard}
          // One drag, one undo step: commit() folds edits under 600 ms apart.
          onChange={(k, n) => update((d) => void (d.audio![sel.ti].elements[sel.i][k] = n > 0 ? n : undefined), true)}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label="Start (s)" value={el.startTime} min={0} onChange={(n) => set((x) => (x.startTime = Math.max(0, n)))} />
          <NumberRow label="Trim start (s)" value={el.trimStart ?? 0} min={0} onChange={(n) => set((x) => (x.trimStart = Math.max(0, n)))} />
        </div>
        <NumberRow label="Duration (s, blank = source)" value={el.duration ?? 0} min={0} onChange={(n) => set((x) => (x.duration = n > 0 ? n : undefined))} />
      </>
    );
  };

  return (
    <div className={`${pane === "inspector" ? "block" : "hidden"} lg:block w-full lg:w-64 shrink-0 border-l border-border bg-surface overflow-y-auto p-4`}>
      {body()}
      {sel && (sel.area !== "cut" || edl.main.elements[sel.i]?.transition) && (
        <button onClick={onDelete} className={`${btnDanger} ${stretch} mt-2`}>
          <Trash2 className="w-4 h-4" /> {sel.area === "cut" ? "Remove transition" : "Delete"}
        </button>
      )}
    </div>
  );
}

// ── overlay position ────────────────────────────────────────────────────────

/** How far from the frame's edge an aligned overlay sits, as a share of it. */
const EDGE = 0.06;

/**
 * Place an overlay by intent (left, centre, bottom) instead of coordinates;
 * dragging it on the canvas stays the fine control. Text moves on both axes.
 * An image or video overlay moves only sideways here: its height follows the
 * source's shape, which this panel does not know.
 */
function PositionRow({
  el,
  frame,
  onPlace,
}: {
  el: OverlayText | OverlayMedia;
  frame: Edl["output"];
  onPlace: (place: { x?: number; y?: number; align?: OverlayText["align"] }) => void;
}) {
  const isText = el.type === "text";
  const text = el as OverlayText;
  const width = isText ? 0 : (el as OverlayMedia).width;

  const horizontal = (side: "left" | "center" | "right") => {
    if (isText) {
      onPlace({ align: side, x: side === "left" ? EDGE : side === "center" ? 0.5 : 1 - EDGE });
    } else {
      onPlace({ x: side === "left" ? EDGE : side === "center" ? (1 - width) / 2 : 1 - EDGE - width });
    }
  };

  const vertical = (side: "top" | "middle" | "bottom") => {
    const h =
      blockHeight(text.text, text.fontSize, frame.width, text.fontFamily ?? "sans", !!text.background) / frame.height;
    const y = side === "top" ? EDGE : side === "middle" ? (1 - h) / 2 : 1 - EDGE - h;
    onPlace({ y: Math.max(0, Math.min(1, Math.round(y * 1000) / 1000)) });
  };

  const group = "inline-flex items-center gap-0.5 rounded-sm bg-surface-sunken p-0.5";
  const cell = "grid place-items-center w-7 h-6 rounded-xs text-muted hover:text-foreground hover:bg-surface";

  return (
    <Row label="Position">
      <div className="flex items-center gap-2">
        <div className={group} role="group" aria-label="Horizontal position">
          <button className={cell} onClick={() => horizontal("left")} aria-label="Align left" title="Align left">
            <AlignStartVertical className="w-4 h-4" />
          </button>
          <button className={cell} onClick={() => horizontal("center")} aria-label="Centre horizontally" title="Centre horizontally">
            <AlignCenterVertical className="w-4 h-4" />
          </button>
          <button className={cell} onClick={() => horizontal("right")} aria-label="Align right" title="Align right">
            <AlignEndVertical className="w-4 h-4" />
          </button>
        </div>
        {isText && (
          <div className={group} role="group" aria-label="Vertical position">
            <button className={cell} onClick={() => vertical("top")} aria-label="Align top" title="Align top">
              <AlignStartHorizontal className="w-4 h-4" />
            </button>
            <button className={cell} onClick={() => vertical("middle")} aria-label="Centre vertically" title="Centre vertically">
              <AlignCenterHorizontal className="w-4 h-4" />
            </button>
            <button className={cell} onClick={() => vertical("bottom")} aria-label="Align bottom" title="Align bottom">
              <AlignEndHorizontal className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </Row>
  );
}

// ── share by link ───────────────────────────────────────────────────────────

interface ShareState {
  url: string | null;
  /** Off only: whether there is a finished export to share. */
  can_share?: boolean;
  /** On only: when the export viewers see finished, and a newer one if any. */
  exported_at?: string;
  newer_export?: number | null;
}

/** "Oct 1, 14:02" from SQLite's space-separated UTC datetime. */
function fmtWhen(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * One public link per project, pinned to one finished export so a later
 * draft never reaches viewers by accident. The state is read when the popover
 * opens, so it reflects an export made since.
 */
function ShareControl({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  // null while loading, so no action shows before the real state is known.
  const [share, setShare] = useState<ShareState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setShare(null);
    setError("");
    setCopied(false);
    setConfirmOff(false);
    api.get<ShareState>(`/api/projects/${projectId}/share`).then(setShare).catch(() => {});
  }, [open, projectId]);

  const change = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setError("");
    try {
      setShare(await api.send<ShareState>(method, `/api/projects/${projectId}/share`));
      setCopied(false);
      setConfirmOff(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const url = share?.url ?? null;
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={btnSecondary} title="Share a link to this video">
          <Link2 className="w-4 h-4" /> <span className="hidden sm:inline">Share</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" width="w-80">
        <div className="p-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-body-sm font-medium">Share by link</span>
            <span className="text-fine text-muted">
              Anyone with the link can watch and download this video, without signing in.
            </span>
          </div>
          {!share ? null : url ? (
            <>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={url}
                  aria-label="Share link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="field flex-1 min-w-0"
                />
                {/* Fixed width, so "Copied" does not shift the field. */}
                <button onClick={copy} className={`${btnPrimary} w-24 justify-center`}>
                  {copied ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <span className="text-fine text-muted">
                Plays the export from {fmtWhen(share.exported_at ?? "")}.
                {share.newer_export ? " You have exported since; viewers still see this one." : ""}
              </span>
              {share.newer_export ? (
                <button onClick={() => change("PUT")} disabled={busy} className={`${btnSecondary} self-start`}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} Show the newest export
                </button>
              ) : null}
              {/* Turning off is final for everyone holding the link (a new one
                  gets a new address), so it asks once, in place. */}
              {confirmOff ? (
                <div className="flex flex-col gap-2">
                  <span className="text-fine text-muted">
                    People who have this link will no longer be able to watch. A new link gets a new address.
                  </span>
                  <div className="flex gap-2">
                    <button onClick={() => change("DELETE")} disabled={busy} className={btnDanger}>
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />} Turn off
                    </button>
                    <button onClick={() => setConfirmOff(false)} className={btnGhost}>
                      Keep link
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setConfirmOff(true)} className={`${btnGhost} self-start -ml-2`}>
                  Turn off link
                </button>
              )}
            </>
          ) : share.can_share === false ? (
            <span className="text-fine text-muted">Export the video first. A link plays a finished export.</span>
          ) : (
            <button onClick={() => change("PUT")} disabled={busy} className={`${btnPrimary} self-start`}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Create link
            </button>
          )}
          {error && <span className="text-fine text-danger">{error}</span>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── export controls ─────────────────────────────────────────────────────────

/** The export presets, as the edit service encodes them (crf 30 / 23 / 18). */
const QUALITIES = [
  { value: "draft", name: "Draft", hint: "Fastest, to check the cut" },
  { value: "standard", name: "Standard", hint: "For sharing" },
  { value: "high", name: "High", hint: "Best quality, slowest" },
] as const;

function QualityPicker({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = QUALITIES.find((q) => q.value === value) ?? QUALITIES[1];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SelectTrigger kind="view" className="max-sm:hidden" aria-label="Export quality">
          {current.name}
        </SelectTrigger>
      </PopoverTrigger>
      <PopoverContent>
        <Command label="Export quality" chosen={current.value}>
          {QUALITIES.map((q) => (
            <CommandItem
              key={q.value}
              value={q.value}
              chosen={q.value === value}
              onSelect={() => {
                onChange(q.value);
                setOpen(false);
              }}
            >
              <span className="flex-1 min-w-0">
                <span className="block">{q.name}</span>
                <span className="block text-fine text-faint">{q.hint}</span>
              </span>
            </CommandItem>
          ))}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ExportControls({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [quality, setQuality] = useState("standard");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ExportJob | null>(null);

  useEffect(() => {
    api.get<ExportJob[]>(`/api/exports?project_id=${projectId}`).then((j) => setLast(j[0] ?? null)).catch(() => {});
  }, [projectId]);

  // The render runs in the background on the edit service, and each read of
  // the job is what moves it on, so keep reading until it settles. This also
  // picks a running export back up after a reload. One read at a time: the
  // next is scheduled only once the last has answered.
  const exporting = last?.status === "exporting" ? last.id : null;
  useEffect(() => {
    if (!exporting) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(async () => {
        const job = await api.get<ExportJob>(`/api/exports/${exporting}`).catch(() => null);
        if (stop) return;
        if (job && job.status !== "exporting") setLast(job);
        else tick();
      }, 3000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [exporting]);

  const run = async () => {
    setBusy(true);
    try {
      const job = await api.send<ExportJob & { failure?: { detail?: string; path?: string } }>(
        "POST",
        `/api/projects/${projectId}/export`,
        { quality },
      );
      setLast(job);
    } catch (e) {
      setLast({ id: 0, project_id: projectId, status: "failed", output_url: null, error: String((e as Error).message), duration: null, created_at: "" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {last?.status === "completed" && last.output_url && (
        <a
          href={last.output_url}
          target="_blank"
          className="hidden sm:inline text-body-sm text-link underline decoration-border underline-offset-2"
        >
          Last export ↗
        </a>
      )}
      {/* A failure is data that happens to be alarming: danger TEXT, not a pill. */}
      {last?.status === "failed" && (
        <span className="text-fine text-danger max-w-64 truncate" title={last.error ?? ""}>
          {last.error}
        </span>
      )}
      <QualityPicker value={quality} onChange={setQuality} />
      <button onClick={run} disabled={busy || !!exporting || disabled} className={btnPrimary}>
        {busy || exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />}
        {exporting ? "Exporting" : "Export"}
      </button>
    </div>
  );
}

// ── timeline ────────────────────────────────────────────────────────────────

const RULER_H = 22;
const MAIN_H = 40;
/** Space between neighbouring clips on the main track, in pixels. */
const CLIP_GAP = 4;
const ROW_H = 30;
const HEAD_W = 96;

function TimelinePanel({
  pane,
  edl,
  segments,
  total,
  playhead,
  playing,
  setPlaying,
  seek,
  sel,
  setSel,
  update,
  srcDur,
  resolveAsset,
  splitAtPlayhead,
  splitAt,
  deleteSelected,
}: {
  pane: Pane;
  edl: Edl;
  segments: ReturnType<typeof mainSegments>;
  total: number;
  playhead: number;
  playing: boolean;
  setPlaying: (b: boolean) => void;
  seek: (t: number) => void;
  sel: Sel;
  setSel: (s: Sel) => void;
  /** `coalesce` folds this edit into the previous undo step (one drag, one step). */
  update: (fn: (d: Edl) => void, coalesce?: boolean) => void;
  srcDur: (src: string) => number | undefined;
  resolveAsset: (src: string) => Asset | undefined;
  splitAtPlayhead: () => void;
  /** Split the main-track clip under a timeline time (right-click "Split here"). */
  splitAt: (t: number) => void;
  deleteSelected: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(40); // px per second
  // The visible width of the track area. The ruler and every row reach at
  // least this far, so a short or empty project does not stop mid-screen.
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(300, (total || 10) * zoom + 60, viewW - HEAD_W);
  const dragMain = useRef<{ from: number; over: number } | null>(null);
  // Timeline seconds under the last right-click, for "Split here".
  const menuAt = useRef(0);
  const [, bump] = useState(0);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEAD_W + el.scrollLeft) / zoom);
  };

  const scrub = (e: React.PointerEvent) => {
    setPlaying(false);
    seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Trim handles (main clips): pointer drag on the left/right 8px.
  const trimDrag = (i: number, side: "l" | "r") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSel({ area: "main", i });
    const startX = e.clientX;
    const el = edl.main.elements[i];
    const orig = structuredClone(el);
    const src = el.type === "video" ? srcDur(el.src) : undefined;
    const move = (ev: PointerEvent) => {
      const ds = (ev.clientX - startX) / zoom;
      update((d) => {
        const t = d.main.elements[i];
        if (t.type === "image") {
          const o = orig as MainImage;
          t.duration = Math.max(0.2, side === "r" ? o.duration + ds : o.duration - ds);
        } else if ((orig as MainVideo).duration !== undefined) {
          // Play-window form: left handle moves the in-point (window shrinks),
          // right handle grows/shrinks the window; export clamps to the source.
          const o = orig as MainVideo;
          const tv = t as MainVideo;
          if (side === "l") {
            const shift = Math.max(-(o.trimStart ?? 0), Math.min(ds, o.duration! - 0.2));
            tv.trimStart = Math.round(((o.trimStart ?? 0) + shift) * 100) / 100;
            tv.duration = Math.round((o.duration! - shift) * 100) / 100;
          } else {
            tv.duration = Math.max(0.2, Math.round((o.duration! + ds) * 100) / 100);
          }
        } else if (src !== undefined) {
          const o = orig as MainVideo;
          if (side === "l") {
            const ns = Math.max(0, Math.min((o.trimStart ?? 0) + ds, src - (o.trimEnd ?? 0) - 0.2));
            (t as MainVideo).trimStart = Math.round(ns * 100) / 100;
          } else {
            const ne = Math.max(0, Math.min((o.trimEnd ?? 0) - ds, src - (o.trimStart ?? 0) - 0.2));
            (t as MainVideo).trimEnd = Math.round(ne * 100) / 100;
          }
        }
      }, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Move/resize for floating elements (overlays + audio).
  const floatDrag = (area: "ovl" | "aud", ti: number, i: number, mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSel({ area, ti, i } as Sel);
    const startX = e.clientX;
    const get = (d: Edl) => (area === "ovl" ? d.overlays![ti].elements[i] : d.audio![ti].elements[i]);
    const orig = structuredClone(area === "ovl" ? edl.overlays![ti].elements[i] : edl.audio![ti].elements[i]) as {
      startTime: number;
      duration?: number;
    };
    const move = (ev: PointerEvent) => {
      const ds = (ev.clientX - startX) / zoom;
      update((d) => {
        const t = get(d) as { startTime: number; duration?: number };
        if (mode === "move") t.startTime = Math.max(0, Math.round((orig.startTime + ds) * 100) / 100);
        else t.duration = Math.max(0.2, Math.round(((orig.duration ?? 1) + ds) * 100) / 100);
      }, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks = useMemo(() => {
    const stepOptions = [0.5, 1, 2, 5, 10, 30, 60];
    const step = stepOptions.find((s) => s * zoom >= 42) ?? 60;
    const out: number[] = [];
    for (let t = 0; t <= width / zoom; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  }, [zoom, width]);

  return (
    <div className={`${pane === "canvas" ? "flex" : "hidden"} lg:flex h-64 shrink-0 border-t border-border bg-surface flex-col`}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        <button
          onClick={() => setPlaying(!playing)}
          className={btnIcon}
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (space)"
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <span className="text-data tabular-nums whitespace-nowrap">
          <span className="text-foreground">{fmtTime(playhead)}</span>
          <span className="text-faint"> / {fmtTime(total)}</span>
        </span>
        <div className="w-px h-5 bg-border mx-1" />
        <button onClick={splitAtPlayhead} className={btnIcon} aria-label="Split at playhead" title="Split at playhead (Cmd+B)">
          <Scissors className="w-4 h-4" />
        </button>
        <button onClick={deleteSelected} disabled={!sel} className={btnIcon} aria-label="Delete selected" title="Delete selected">
          <Trash2 className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <input
          type="range"
          min={10}
          max={160}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-32 accent-foreground"
          aria-label="Timeline zoom"
          title="Zoom"
        />
      </div>

      {/* tracks */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto relative"
        // A click on the empty timeline (a lane with nothing under the
        // pointer, or the space below the tracks) lets go of the selection.
        // Clips and the ruler handle their own presses.
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t.dataset.empty !== undefined) setSel(null);
        }}
      >
        <div style={{ width: width + HEAD_W }} className="relative" data-empty>
          {/* ruler */}
          <div className="sticky top-0 z-20 flex bg-surface" style={{ height: RULER_H }}>
            <div style={{ width: HEAD_W }} className="shrink-0 border-r border-b border-border bg-surface" />
            <div className="relative flex-1 border-b border-border cursor-ew-resize select-none" onPointerDown={scrub}>
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-border text-fine text-faint pl-1 pt-0.5 tabular-nums" style={{ left: t * zoom }}>
                  {t % 1 === 0 ? fmtTime(t) : ""}
                </div>
              ))}
            </div>
          </div>

          {/* main track */}
          <TrackRow label="Video" height={MAIN_H} group>
            {segments.map((seg) => {
              const a = resolveAsset(seg.el.src);
              const selected = sel?.area === "main" && sel.i === seg.i;
              // A gap between clips, taken from the right edge so the ruler
              // stays exact. Without it the two halves of a split fused into
              // one strip; each piece should read as its own video.
              const w = Math.max(8, seg.dur * zoom - CLIP_GAP);
              return (
                <ContextMenu key={seg.el.id}>
                <ContextMenuTrigger asChild>
                <div
                  draggable
                  onContextMenu={(e) => {
                    // Where the right-click landed, in timeline seconds.
                    const box = e.currentTarget.getBoundingClientRect();
                    menuAt.current = seg.start + (e.clientX - box.left) / zoom;
                    setSel({ area: "main", i: seg.i });
                  }}
                  onDragStart={() => (dragMain.current = { from: seg.i, over: seg.i })}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragMain.current) dragMain.current.over = seg.i;
                  }}
                  onDragEnd={() => {
                    const d = dragMain.current;
                    dragMain.current = null;
                    if (!d || d.from === d.over) return;
                    update((doc) => {
                      const [m] = doc.main.elements.splice(d.from, 1);
                      doc.main.elements.splice(d.over, 0, m);
                    });
                    bump((n) => n + 1);
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSel({ area: "main", i: seg.i });
                  }}
                  className={`absolute top-1 bottom-1 rounded-xs overflow-hidden bg-black cursor-grab ${selected ? "ring-2 ring-ring" : "shadow-edge"}`}
                  style={{ left: seg.start * zoom, width: w }}
                  title={a?.name}
                >
                  {seg.el.type === "video" && a && seg.dur > 0 ? (
                    a.media_uid ? (
                      <FrameStrip
                        asset={a}
                        from={(seg.el as MainVideo).trimStart ?? 0}
                        to={((seg.el as MainVideo).trimStart ?? 0) + seg.dur}
                        width={Math.round(w)}
                      />
                    ) : (
                      <FilmStrip
                        url={assetUrl(a)}
                        from={(seg.el as MainVideo).trimStart ?? 0}
                        to={((seg.el as MainVideo).trimStart ?? 0) + seg.dur}
                        width={Math.round(w)}
                        height={MAIN_H - 8}
                      />
                    )
                  ) : a ? (
                    <img src={assetUrl(a)} className="w-full h-full object-cover" />
                  ) : null}
                  <FadeRamps fadeIn={seg.el.fadeIn} fadeOut={seg.el.fadeOut} heard={seg.dur} zoom={zoom} height={MAIN_H - 8} />
                  {/* Clear of the cut's mark, which sits half over a clip's start. */}
                  <div className={`absolute ${seg.i > 0 ? "left-3" : "left-1"} bottom-0.5 text-fine text-on-accent/90 drop-shadow truncate max-w-[90%] tabular-nums`}>
                    {a?.name} · {seg.dur.toFixed(1)}s
                  </div>
                  <div onPointerDown={trimDrag(seg.i, "l")} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" />
                  <div onPointerDown={trimDrag(seg.i, "r")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" />
                </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => splitAt(menuAt.current)}>
                    <Scissors className="w-4 h-4" /> Split here
                  </ContextMenuItem>
                  <ContextMenuItem
                    danger
                    onSelect={() => {
                      update((d) => {
                        d.main.elements.splice(seg.i, 1);
                      });
                      setSel(null);
                    }}
                  >
                    <Trash2 className="w-4 h-4" /> Delete clip
                  </ContextMenuItem>
                </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {/* Each cut between two clips carries a mark, centred in the gap: its
                transition's icon, or (on hover) the way to add one. A transition
                also tints the stretch it plays, half each side of the cut, without
                taking the pointer from the clips' trim handles under it. */}
            {segments.slice(1).map((seg) => {
              const t = seg.el.transition;
              const span = seg.before + seg.after;
              const chosen = sel?.area === "cut" && sel.i === seg.i;
              const at = seg.start * zoom - CLIP_GAP / 2;
              return (
                <div key={`cut-${seg.el.id}`}>
                  {t && span > 0 && (
                    <div
                      className="absolute z-[4] top-1 bottom-1 rounded-xs bg-white/15 ring-1 ring-inset ring-white/60 pointer-events-none"
                      style={{ left: (seg.start - seg.before) * zoom, width: span * zoom }}
                    />
                  )}
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (!t) update((d) => void (d.main.elements[seg.i].transition = { type: "dissolve", duration: DEFAULT_TRANSITION_SECONDS }));
                      setSel({ area: "cut", i: seg.i });
                    }}
                    className={`absolute z-[6] top-1/2 grid place-items-center w-5 h-5 rounded-xs bg-surface shadow-raised ${
                      t ? "text-foreground" : "text-muted opacity-0 group-hover/track:opacity-100 focus-visible:opacity-100"
                    } ${chosen ? "ring-2 ring-ring opacity-100" : ""}`}
                    style={{ left: at, transform: "translate(-50%, -50%)" }}
                    title={t ? `${transitionName(t.type)}, ${span.toFixed(1)}s` : "Add transition"}
                    aria-label={t ? `${transitionName(t.type)} between clips ${seg.i} and ${seg.i + 1}` : `Add a transition between clips ${seg.i} and ${seg.i + 1}`}
                  >
                    <TransitionIcon type={t?.type} className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </TrackRow>

          {/* overlay tracks */}
          {(edl.overlays ?? []).map((track, ti) => (
            <TrackRow
              key={track.id}
              label={`Overlay ${ti + 1}`}
              height={ROW_H}
              action={
                <button
                  onClick={() => update((d) => (d.overlays![ti].hidden = !d.overlays![ti].hidden))}
                  className="text-muted hover:text-foreground"
                  title={track.hidden ? "Show" : "Hide"}
                >
                  {track.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              }
            >
              {track.elements.map((el, i) => {
                const selected = sel?.area === "ovl" && sel.ti === ti && sel.i === i;
                return (
                  <div
                    key={el.id}
                    onPointerDown={floatDrag("ovl", ti, i, "move")}
                    className={`absolute top-1 bottom-1 rounded-xs px-1.5 text-fine flex items-center gap-1 truncate cursor-grab ${
                      selected ? "ring-2 ring-ring" : ""
                    } ${el.type === "text" ? "bg-track-text-tint text-track-text" : "bg-track-image-tint text-track-image"} ${track.hidden ? "opacity-40" : ""}`}
                    style={{ left: el.startTime * zoom, width: Math.max(14, el.duration * zoom) }}
                  >
                    <FadeRamps fadeIn={el.fadeIn} fadeOut={el.fadeOut} heard={heardFor(el.startTime, el.duration, total)} zoom={zoom} height={ROW_H - 8} />
                    {/* relative: above the ramps, which are positioned */}
                    {el.type === "text" ? <TypeIcon className="relative w-3 h-3 shrink-0" /> : <ImageIcon className="relative w-3 h-3 shrink-0" />}
                    <span className="relative truncate">{el.type === "text" ? (el as OverlayText).text : resolveAsset((el as OverlayMedia).src)?.name}</span>
                    <div onPointerDown={floatDrag("ovl", ti, i, "resize")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize" />
                  </div>
                );
              })}
            </TrackRow>
          ))}

          {/* audio tracks */}
          {(edl.audio ?? []).map((track, ti) => (
            <TrackRow
              key={track.id}
              label={`Audio ${ti + 1}`}
              height={ROW_H}
              action={
                <button
                  onClick={() => update((d) => (d.audio![ti].muted = !d.audio![ti].muted))}
                  className="text-muted hover:text-foreground"
                  title={track.muted ? "Unmute" : "Mute"}
                >
                  {track.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
              }
            >
              {track.elements.map((el, i) => {
                const selected = sel?.area === "aud" && sel.ti === ti && sel.i === i;
                const a = resolveAsset(el.src);
                const dur = el.duration ?? Math.max(0.5, (durCache.get(el.src) ?? 3) - (el.trimStart ?? 0) - (el.trimEnd ?? 0));
                const w = Math.max(14, dur * zoom);
                return (
                  <div
                    key={el.id}
                    onPointerDown={floatDrag("aud", ti, i, "move")}
                    className={`absolute top-1 bottom-1 rounded-xs overflow-hidden bg-track-audio cursor-grab ${
                      selected ? "ring-2 ring-ring" : ""
                    } ${track.muted ? "opacity-40" : ""}`}
                    style={{ left: el.startTime * zoom, width: w }}
                    title={a?.name}
                  >
                    {a && <Waveform url={assetUrl(a)} width={Math.round(w)} height={ROW_H - 8} />}
                    <FadeRamps fadeIn={el.fadeIn} fadeOut={el.fadeOut} heard={heardFor(el.startTime, dur, total)} zoom={zoom} height={ROW_H - 8} />
                    <div onPointerDown={floatDrag("aud", ti, i, "resize")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize" />
                  </div>
                );
              })}
            </TrackRow>
          ))}

          {/* playhead */}
          <div className="absolute top-0 bottom-0 z-30 pointer-events-none" style={{ left: HEAD_W + playhead * zoom }}>
            <div className="w-px h-full bg-foreground" />
            <div className="absolute -top-0 -left-[5px] w-[11px] h-3 bg-foreground rounded-b-xs" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The fade ramps on a clip: the part a fade takes away is dimmed under a sloped edge. */
function FadeRamps({ fadeIn, fadeOut, heard, zoom, height }: { fadeIn?: number; fadeOut?: number; heard: number; zoom: number; height: number }) {
  const fin = Math.min(fadeIn ?? 0, heard) * zoom;
  const fout = Math.min(fadeOut ?? 0, heard) * zoom;
  if (fin <= 0 && fout <= 0) return null;
  const end = heard * zoom;
  return (
    <svg className="absolute inset-0 pointer-events-none" width={end} height={height} aria-hidden>
      {fin > 0 && <polygon points={`0,0 ${fin},0 0,${height}`} className="fill-surface/60" />}
      {fin > 0 && <line x1={0} y1={height} x2={fin} y2={0} className="stroke-surface" strokeWidth={1} />}
      {fout > 0 && <polygon points={`${end - fout},0 ${end},0 ${end},${height}`} className="fill-surface/60" />}
      {fout > 0 && <line x1={end - fout} y1={0} x2={end} y2={height} className="stroke-surface" strokeWidth={1} />}
    </svg>
  );
}

function TrackRow({
  label,
  height,
  action,
  group = false,
  children,
}: {
  label: string;
  height: number;
  action?: React.ReactNode;
  /** Lets marks inside show on hover of the whole track (`group-hover/track:`). */
  group?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex" style={{ height }}>
      <div style={{ width: HEAD_W }} className="shrink-0 border-r border-b border-border px-2 flex items-center justify-between bg-surface sticky left-0 z-10">
        <span className="text-fine text-muted truncate">{label}</span>
        {action}
      </div>
      <div className={`relative flex-1 border-b border-border bg-surface-sunken/50 ${group ? "group/track" : ""}`} data-empty>
        {children}
      </div>
    </div>
  );
}
