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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Type as TypeIcon,
  Upload,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Dialog,
  EmptyState,
  Kbd,
  btnDanger,
  btnGhost,
  btnIcon,
  btnPrimary,
  btnSecondary,
  card,
  stretch,
} from "./ui";

// ── shared shapes (validated server-side; these are view types) ─────────────

export interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  /** Seconds, probed client-side at upload (null for legacy/images). */
  duration?: number | null;
}

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
}
interface MainImage {
  id: string;
  type: "image";
  src: string;
  duration: number;
  fit?: "contain" | "cover";
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
  align?: "left" | "center" | "right";
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
}

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

const rid = () => Math.random().toString(36).slice(2, 10);
const assetUrl = (a: Asset) => `/api/uploads/${encodeURIComponent(a.key)}`;
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

/** Segments of the main track on the output timeline. */
function mainSegments(edl: Edl, srcDur: (src: string) => number | undefined) {
  let t = 0;
  return edl.main.elements.map((el, i) => {
    const dur = mainDur(el, srcDur);
    const seg = { el, i, start: t, dur };
    t += dur;
    return seg;
  });
}

// ── media metadata / filmstrip / waveform caches (module-level) ─────────────

const durCache = new Map<string, number>();
const peaksCache = new Map<string, number[]>();

function useSourceDurations(edl: Edl, assets: Asset[]) {
  // `version` is not cosmetic: it is what gives `srcDur` a new identity when a
  // duration lands, which is what invalidates the `segments` memo downstream.
  // Without it a project whose EDL already references an asset at mount (the
  // "Use in an edit" flow) renders every clip at zero length forever, because
  // the cache fills after the memo has already been computed.
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
        ctx.drawImage(v, i * fw, 0, fw, height);
      }
    };
    return () => {
      dead = true;
      v.src = "";
    };
  }, [url, from, to, width, height]);
  return <canvas ref={ref} width={Math.max(1, width)} height={height} className="w-full h-full rounded-[3px]" />;
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

// ── projects list (rendered on the home gallery) ────────────────────────────

export function EditProjectsSection({ navigate }: { navigate: (to: string) => void }) {
  const [projects, setProjects] = useState<Omit<EditProject, "edl">[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Omit<EditProject, "edl">[]>("/api/projects").then(setProjects).catch(() => setProjects([]));
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.send<EditProject>("POST", "/api/projects", { name: "Untitled cut" });
      navigate(`/edits/${p.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-10">
      {/* Card title row: sentence case, a live count, and the add affordance
          at the right. The page's ONE solid action is "New video" above; this
          section adds with a secondary. */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-heading-2 flex items-center gap-2">
            <Scissors className="w-4 h-4 text-muted" /> Footage edits
            {projects && projects.length > 0 && (
              <span className="text-data text-muted tabular-nums">{projects.length}</span>
            )}
          </h2>
          <p className="text-body-sm text-muted mt-0.5">
            Video you already shot: trim it, put the clips in order, add text and music, export to
            MP4.
          </p>
        </div>
        {projects && projects.length > 0 && (
          <button onClick={create} disabled={busy} className={`${btnSecondary} shrink-0`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New edit
          </button>
        )}
      </div>
      {projects === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${card} p-4 space-y-2`}>
              <div className="h-3 w-2/3 rounded-full bg-surface-sunken animate-pulse" />
              <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Scissors className="w-8 h-8" />}
          title="No edits yet"
          body="Upload a clip and cut it down."
          action={
            <button onClick={create} disabled={busy} className={btnSecondary}>
              <Plus className="w-4 h-4" /> New edit
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/edits/${p.id}`)}
              className={`${card} text-left p-4 hover:bg-surface-sunken`}
            >
              <div className="text-body-sm font-medium truncate">{p.name}</div>
              <div className="text-fine text-faint mt-1">{p.updated_at?.slice(0, 10)}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── the editor ──────────────────────────────────────────────────────────────

/** Which pane is on screen below the lg breakpoint (desktop shows all three). */
type Pane = "library" | "canvas" | "inspector";

type Sel =
  | { area: "main"; i: number }
  | { area: "ovl"; ti: number; i: number }
  | { area: "aud"; ti: number; i: number }
  | null;

export function EditRoute({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [project, setProject] = useState<EditProject | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    Promise.all([api.get<EditProject>(`/api/projects/${id}`), api.get<Asset[]>("/api/assets")])
      .then(([p, a]) => {
        setProject(p);
        setAssets(a);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, [id]);

  if (err)
    return (
      <div className="flex-1 grid place-items-center">
        <EmptyState
          icon={<Film className="w-8 h-8" />}
          title="This edit could not be opened"
          body={err}
          action={
            <button className={btnSecondary} onClick={() => navigate("/")}>
              Back to your videos
            </button>
          }
        />
      </div>
    );
  if (!project || !assets)
    return (
      <div className="flex-1 grid place-items-center text-faint">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  return <EditEditor initial={project} initialAssets={assets} />;
}

export function EditEditor({ initial, initialAssets }: { initial: EditProject; initialAssets: Asset[] }) {
  const [name, setName] = useState(initial.name);
  const [brief, setBrief] = useState(initial.brief ?? "");
  const [edl, setEdl] = useState<Edl>(initial.edl);
  const [assets, setAssets] = useState<Asset[]>(initialAssets);
  const [sel, setSel] = useState<Sel>(null);
  const [tab, setTab] = useState<"media" | "audio" | "text">("media");
  // Phones and tablets get ONE pane at a time; the four-region grid is a
  // desktop layout. Selection state chooses which pane is on screen.
  const [pane, setPane] = useState<"library" | "canvas" | "inspector">("canvas");
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [autocutOpen, setAutocutOpen] = useState(false);
  const playheadRef = useRef(0);
  const { srcDur, resolveAsset } = useSourceDurations(edl, assets);

  // ── persistence (debounced) ───────────────────────────────────────────────
  const dirty = useRef(false);
  useEffect(() => {
    if (edl === initial.edl && name === initial.name && brief === (initial.brief ?? "")) return;
    dirty.current = true;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        await api.send("PUT", `/api/projects/${initial.id}`, { name, edl, brief });
        dirty.current = false;
        setSaveState("saved");
      } catch (e) {
        setSaveState(String((e as Error).message));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [edl, name, brief, initial.id, initial.edl, initial.name, initial.brief]);

  const update = useCallback((fn: (draft: Edl) => void) => {
    setEdl((cur) => {
      const draft = structuredClone(cur);
      fn(draft);
      return draft;
    });
  }, []);

  // ── derived timeline ──────────────────────────────────────────────────────
  const segments = useMemo(() => mainSegments(edl, srcDur), [edl, srcDur]);
  const total = segments.reduce((a, s) => a + s.dur, 0);

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
      let t = playheadRef.current + dt;
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

  const splitAtPlayhead = () => {
    const t = playheadRef.current;
    const seg = segments.find((s) => t > s.start + 0.05 && t < s.start + s.dur - 0.05);
    if (!seg) return;
    const off = t - seg.start;
    update((d) => {
      const el = d.main.elements[seg.i];
      if (el.type === "image") {
        const right = { ...structuredClone(el), id: rid(), duration: el.duration - off };
        el.duration = off;
        d.main.elements.splice(seg.i + 1, 0, right);
      } else {
        const ts = el.trimStart ?? 0;
        const te = el.trimEnd ?? 0;
        const right = { ...structuredClone(el), id: rid(), trimStart: ts + off };
        el.trimEnd = te + (seg.dur - off);
        d.main.elements.splice(seg.i + 1, 0, right);
      }
    });
  };

  const deleteSelected = () => {
    if (!sel) return;
    update((d) => {
      if (sel.area === "main") d.main.elements.splice(sel.i, 1);
      if (sel.area === "ovl") d.overlays?.[sel.ti]?.elements.splice(sel.i, 1);
      if (sel.area === "aud") d.audio?.[sel.ti]?.elements.splice(sel.i, 1);
    });
    setSel(null);
  };

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
          onClick={() => setAutocutOpen(true)}
          className={btnSecondary}
          title="Assemble a cut from several clips with AI"
        >
          <Sparkles className="w-4 h-4" /> <span className="hidden sm:inline">Auto-cut</span>
        </button>
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

      {autocutOpen && (
        <AutocutModal
          projectId={initial.id}
          clips={timelineClips}
          brief={brief}
          setBrief={setBrief}
          onClose={() => setAutocutOpen(false)}
          onApplied={(next) => {
            setEdl(next);
            setSel(null);
            setAutocutOpen(false);
            seek(0);
          }}
        />
      )}

      {/* three-panel middle */}
      <div className="flex-1 flex min-h-0">
        <LeftPanel
          pane={pane}
          tab={tab}
          setTab={setTab}
          assets={assets}
          setAssets={setAssets}
          onAdd={addAssetToTimeline}
          onAddText={addText}
        />
        <Player
          pane={pane}
          edl={edl}
          segments={segments}
          total={total}
          playhead={playhead}
          playheadRef={playheadRef}
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
  pane,
  tab,
  setTab,
  assets,
  setAssets,
  onAdd,
  onAddText,
}: {
  pane: Pane;
  tab: "media" | "audio" | "text";
  setTab: (t: "media" | "audio" | "text") => void;
  assets: Asset[];
  setAssets: React.Dispatch<React.SetStateAction<Asset[]>>;
  onAdd: (a: Asset) => void;
  onAddText: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Read the media length from the LOCAL file — instant, no server roundtrip,
  // immune to moov-at-end layouts that make network probing crawl.
  const probeLocal = (file: File): Promise<number | null> =>
    new Promise((res) => {
      if (!/^(video|audio)\//.test(file.type)) return res(null);
      const url = URL.createObjectURL(file);
      const media = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
      media.preload = "metadata";
      media.src = url;
      const done = (d: number | null) => {
        URL.revokeObjectURL(url);
        res(d);
      };
      media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? media.duration : null);
      media.onerror = () => done(null);
      setTimeout(() => done(null), 3_000);
    });

  const upload = async (file: File) => {
    setUploading(true);
    setUploadErr("");
    try {
      // Upload first — the duration probe trails behind as a PATCH so a slow
      // probe can never delay (or appear to swallow) the upload itself.
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/assets", { method: "POST", body: form });
      if (!r.ok) throw new Error((await errJson(r)).error || "upload failed");
      const created = (await r.json()) as Asset;
      setAssets((prev) => [created, ...prev]);
      probeLocal(file).then((d) => {
        if (!d) return;
        fetch(`/api/assets/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration: d }),
        })
          .then(async (res) => {
            const row = (await res.json()) as Asset;
            if (row?.id) setAssets((prev) => prev.map((a) => (a.id === row.id ? row : a)));
          })
          .catch(() => {});
      });
    } catch (e) {
      setUploadErr(`${file.name}: ${String((e as Error).message)}`);
    } finally {
      setUploading(false);
    }
  };

  const list =
    tab === "media" ? assets.filter((a) => isVideoAsset(a) || isImageAsset(a)) : tab === "audio" ? assets.filter(isAudioAsset) : [];

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
        {tab === "text" ? (
          <button
            onClick={onAddText}
            className="w-full h-8 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add text
          </button>
        ) : (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="w-full h-8 mb-3 rounded-sm border border-dashed border-border text-body-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload
            </button>
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
                for (const f of files) upload(f);
              }}
            />
            {uploadErr && <div className="text-fine text-danger mb-2">{uploadErr}</div>}
            <div className="space-y-2">
              {list.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onAdd(a)}
                  title="Add to timeline"
                  aria-label={`Add ${a.name} to the timeline`}
                  className="w-full text-left rounded-sm bg-surface shadow-edge overflow-hidden hover:bg-surface-sunken group"
                >
                  {isVideoAsset(a) ? (
                    <video src={assetUrl(a)} muted preload="metadata" className="w-full h-20 object-cover bg-black" />
                  ) : isImageAsset(a) ? (
                    <img src={assetUrl(a)} alt="" className="w-full h-20 object-cover bg-black" />
                  ) : (
                    <div className="w-full h-12 grid place-items-center bg-track-audio-tint">
                      <Music className="w-5 h-5 text-track-audio" />
                    </div>
                  )}
                  <div className="px-2 py-1.5 text-fine truncate text-muted group-hover:text-foreground">{a.name}</div>
                </button>
              ))}
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
      </div>
    </div>
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
  playing: boolean;
  resolveAsset: (src: string) => Asset | undefined;
  sel: Sel;
  setSel: (s: Sel) => void;
  update: (fn: (d: Edl) => void) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Scale to FIT, the way the composition preview's harness does: the limiting
  // dimension wins. `aspect-ratio` alone sized the stage from the full width
  // and let it run off the bottom of the pane (max-height never applied,
  // because the parent's height is indefinite), so the frame was clipped.
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

  // Sync media elements to the master clock (drift-corrected seeks).
  useEffect(() => {
    const t = playhead;
    for (const seg of segments) {
      const v = videoRefs.current.get(seg.el.id);
      if (!v || seg.el.type !== "video") continue;
      const isActive = seg === active && seg.dur > 0;
      const wanted = (seg.el.trimStart ?? 0) + (t - seg.start);
      if (isActive) {
        if (Math.abs(v.currentTime - wanted) > 0.18) v.currentTime = wanted;
        v.volume = Math.min(1, seg.el.volume ?? 1);
        v.muted = seg.el.sourceAudio === false;
        if (playing && v.paused) v.play().catch(() => {});
        if (!playing && !v.paused) v.pause();
      } else if (!v.paused) v.pause();
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
          a.volume = Math.min(1, el.volume ?? 1);
          if (a.paused) a.play().catch(() => {});
        } else if (!a.paused) a.pause();
      }
      void ti;
    }
  }, [playhead, playing, segments, active, edl.audio]);

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
      });
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
    >
      <div style={{ width: fit.w || undefined, height: fit.h || undefined }}>
        <div
          ref={stageRef}
          className="relative w-full h-full overflow-hidden rounded-md shadow-edge"
          style={{ background: edl.output.background ?? "#000" }}
          onPointerDown={() => setSel(null)}
        >
          {/* main track media (stacked; active visible) */}
          {segments.map((seg) => {
            const a = resolveAsset(seg.el.src);
            if (!a) return null;
            const visible = seg === active && seg.dur > 0;
            const fit = seg.el.fit ?? "contain";
            const common = {
              className: `absolute inset-0 w-full h-full ${visible ? "" : "hidden"}`,
              style: { objectFit: fit } as React.CSSProperties,
            };
            return seg.el.type === "video" ? (
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
            ) : (
              <img key={seg.el.id} src={assetUrl(a)} {...common} />
            );
          })}

          {/* overlays */}
          {(edl.overlays ?? []).map((track, ti) =>
            track.hidden
              ? null
              : track.elements.map((el, i) => {
                  const show = playhead >= el.startTime && playhead < el.startTime + el.duration;
                  if (!show) return null;
                  const selected = sel?.area === "ovl" && sel.ti === ti && sel.i === i;
                  if (el.type === "text") {
                    const t = el as OverlayText;
                    return (
                      <div
                        key={el.id}
                        onPointerDown={dragOverlay(ti, i)}
                        className={`absolute cursor-move select-none whitespace-pre leading-tight ${selected ? "outline outline-2 outline-ring" : ""}`}
                        style={{
                          left: `${t.x * 100}%`,
                          top: `${t.y * 100}%`,
                          transform: t.align === "center" ? "translateX(-50%)" : t.align === "right" ? "translateX(-100%)" : undefined,
                          fontSize: t.fontSize * scale,
                          fontFamily: t.fontFamily === "serif" ? "serif" : t.fontFamily === "mono" ? "monospace" : "Inter, sans-serif",
                          color: t.color ?? DEFAULT_TEXT_COLOR,
                          background: t.background,
                          padding: t.background ? `${0.3 * t.fontSize * scale}px ${0.45 * t.fontSize * scale}px` : undefined,
                          opacity: t.opacity ?? 1,
                          textAlign: t.align ?? "left",
                        }}
                      >
                        {t.text}
                      </div>
                    );
                  }
                  const m = el as OverlayMedia;
                  const a = resolveAsset(m.src);
                  if (!a) return null;
                  return (
                    <div
                      key={el.id}
                      onPointerDown={dragOverlay(ti, i)}
                      className={`absolute cursor-move ${selected ? "outline outline-2 outline-ring" : ""}`}
                      style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.width * 100}%`, opacity: m.opacity ?? 1 }}
                    >
                      {m.type === "image" ? (
                        <img src={assetUrl(a)} className="w-full h-auto pointer-events-none" />
                      ) : (
                        <video src={assetUrl(a)} muted className="w-full h-auto pointer-events-none" />
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
}: {
  pane: Pane;
  edl: Edl;
  sel: Sel;
  update: (fn: (d: Edl) => void) => void;
  srcDur: (src: string) => number | undefined;
  resolveAsset: (src: string) => Asset | undefined;
  segments: ReturnType<typeof mainSegments>;
  onDelete: () => void;
  brief: string;
  setBrief: (b: string) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState("");

  const body = () => {
    if (!sel)
      return (
        <div className="mt-2">
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
            Canvas {edl.output.width}×{edl.output.height} at {edl.output.fps}fps
            <br />
            Select a clip to edit it
          </div>
        </div>
      );

    if (sel.area === "main") {
      const el = edl.main.elements[sel.i];
      if (!el) return null;
      const set = (fn: (e: MainElement) => void) => update((d) => fn(d.main.elements[sel.i]));
      const dur = srcDur(el.src);
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
              <Row label="Fit">
                <select className={inputCls} value={el.fit ?? "contain"} onChange={(e) => set((x) => ((x as MainVideo).fit = e.target.value as "contain" | "cover"))}>
                  <option value="contain">Contain (letterbox)</option>
                  <option value="cover">Cover (fill & crop)</option>
                </select>
              </Row>
              <Row label="Clip audio">
                <button
                  className={`${inputCls} text-left`}
                  onClick={() => set((e) => ((e as MainVideo).sourceAudio = (e as MainVideo).sourceAudio === false ? undefined : false))}
                >
                  {el.sourceAudio === false ? "Muted — click to enable" : "On — click to mute"}
                </button>
              </Row>
              <SliderRow label="Volume" value={el.volume ?? 1} max={2} onChange={(n) => set((e) => ((e as MainVideo).volume = n))} />
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
                    const r = await api.send<AnalyzeResult>("POST", `/api/assets/${a.id}/analyze`, {
                      mode: "both",
                      ...(context ? { prompt: context } : {}),
                    });
                    const keeps = r.cuts.filter((c) => c.keep).sort((x, y) => x.start_ms - y.start_ms);
                    if (keeps.length === 0) {
                      setAnalyzeMsg("No keep-segments proposed.");
                      return;
                    }
                    const before = segments.slice(0, segments.findIndex((s) => s.i === sel.i)).reduce((acc, s) => acc + s.dur, 0);
                    update((d) => {
                      const base = d.main.elements[sel.i] as MainVideo;
                      const parts: MainVideo[] = keeps.map((k) => {
                        const p = { ...structuredClone(base), id: rid(), trimStart: k.start_ms / 1000, duration: (k.end_ms - k.start_ms) / 1000 };
                        delete p.trimEnd;
                        return p;
                      });
                      d.main.elements.splice(sel.i, 1, ...parts);
                      // Captions land on the output timeline: offset each by the
                      // kept time that precedes it inside this clip.
                      const caps = r.captions
                        .map((c) => {
                          let out = before;
                          for (const k of keeps) {
                            if (c.start_ms >= k.end_ms) out += (k.end_ms - k.start_ms) / 1000;
                            else if (c.start_ms >= k.start_ms) return { c, at: out + (c.start_ms - k.start_ms) / 1000 };
                            else return null;
                          }
                          return null;
                        })
                        .filter(Boolean) as { c: AnalyzeResult["captions"][number]; at: number }[];
                      if (caps.length) {
                        d.overlays = d.overlays ?? [];
                        const track: OverlayTrack = { id: rid(), elements: [] };
                        for (const { c, at } of caps) {
                          track.elements.push({
                            id: rid(),
                            type: "text",
                            text: c.text,
                            fontSize: Math.round(edl.output.height * 0.055),
                            startTime: Math.round(at * 100) / 100,
                            duration: Math.max(0.4, (c.end_ms - c.start_ms) / 1000),
                            x: 0.5,
                            y: 0.82,
                            align: "center",
                            color: DEFAULT_TEXT_COLOR,
                            background: "#000000a0",
                          });
                        }
                        d.overlays.push(track);
                      }
                    });
                    setAnalyzeMsg(`Applied ${keeps.length} segment${keeps.length > 1 ? "s" : ""}${r.captions.length ? ` + ${r.captions.length} captions` : ""}.`);
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
              <Row label="Fit">
                <select className={inputCls} value={el.fit ?? "contain"} onChange={(e) => set((x) => ((x as MainImage).fit = e.target.value as "contain" | "cover"))}>
                  <option value="contain">Contain (letterbox)</option>
                  <option value="cover">Cover (fill & crop)</option>
                </select>
              </Row>
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
                <select className={inputCls} value={el.fontFamily ?? "sans"} onChange={(e) => set((x) => ((x as OverlayText).fontFamily = e.target.value as OverlayText["fontFamily"]))}>
                  <option value="sans">Sans</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Mono</option>
                </select>
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
              <Row label="Align">
                <select className={inputCls} value={el.align ?? "left"} onChange={(e) => set((x) => ((x as OverlayText).align = e.target.value as OverlayText["align"]))}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </Row>
            </>
          )}
          {el.type !== "text" && <SliderRow label="Width" value={(el as OverlayMedia).width} min={0.02} onChange={(n) => set((x) => ((x as OverlayMedia).width = n))} />}
          <div className="grid grid-cols-2 gap-2">
            <SliderRow label="X" value={el.x} onChange={(n) => set((x) => (x.x = n))} />
            <SliderRow label="Y" value={el.y} onChange={(n) => set((x) => (x.y = n))} />
          </div>
          <SliderRow label="Opacity" value={el.opacity ?? 1} onChange={(n) => set((x) => (x.opacity = n))} />
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
    return (
      <>
        <Zone>Audio</Zone>
        <SliderRow label="Volume" value={el.volume ?? 1} max={2} onChange={(n) => set((x) => (x.volume = n))} />
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
      {sel && (
        <button onClick={onDelete} className={`${btnDanger} ${stretch} mt-2`}>
          <Trash2 className="w-4 h-4" /> Delete
        </button>
      )}
    </div>
  );
}

// ── export controls ─────────────────────────────────────────────────────────

function ExportControls({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [quality, setQuality] = useState("standard");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ExportJob | null>(null);

  useEffect(() => {
    api.get<ExportJob[]>(`/api/exports?project_id=${projectId}`).then((j) => setLast(j[0] ?? null)).catch(() => {});
  }, [projectId]);

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
      <select
        value={quality}
        onChange={(e) => setQuality(e.target.value)}
        aria-label="Export quality"
        className="field w-auto hidden sm:block"
      >
        <option value="draft">Draft</option>
        <option value="standard">Standard</option>
        <option value="high">High</option>
      </select>
      <button onClick={run} disabled={busy || disabled} className={btnPrimary}>
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />} Export
      </button>
    </div>
  );
}

// ── timeline ────────────────────────────────────────────────────────────────

const RULER_H = 22;
const MAIN_H = 52;
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
  update: (fn: (d: Edl) => void) => void;
  srcDur: (src: string) => number | undefined;
  resolveAsset: (src: string) => Asset | undefined;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(40); // px per second
  const width = Math.max(300, (total || 10) * zoom + 60);
  const dragMain = useRef<{ from: number; over: number } | null>(null);
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
      });
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
      });
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
    for (let t = 0; t <= (total || 10) + step; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  }, [zoom, total]);

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
        <button onClick={splitAtPlayhead} className={btnIcon} aria-label="Split at playhead" title="Split at playhead">
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
      <div ref={scrollRef} className="flex-1 overflow-auto relative">
        <div style={{ width: width + HEAD_W }} className="relative">
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
          <TrackRow label="Video" height={MAIN_H}>
            {segments.map((seg) => {
              const a = resolveAsset(seg.el.src);
              const selected = sel?.area === "main" && sel.i === seg.i;
              const w = Math.max(10, seg.dur * zoom);
              return (
                <div
                  key={seg.el.id}
                  draggable
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
                    <FilmStrip
                      url={assetUrl(a)}
                      from={(seg.el as MainVideo).trimStart ?? 0}
                      to={((seg.el as MainVideo).trimStart ?? 0) + seg.dur}
                      width={Math.round(w)}
                      height={MAIN_H - 8}
                    />
                  ) : a ? (
                    <img src={assetUrl(a)} className="w-full h-full object-cover" />
                  ) : null}
                  <div className="absolute left-1 bottom-0.5 text-fine text-on-accent/90 drop-shadow truncate max-w-[90%] tabular-nums">
                    {a?.name} · {seg.dur.toFixed(1)}s
                  </div>
                  <div onPointerDown={trimDrag(seg.i, "l")} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" />
                  <div onPointerDown={trimDrag(seg.i, "r")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" />
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
                    {el.type === "text" ? <TypeIcon className="w-3 h-3 shrink-0" /> : <ImageIcon className="w-3 h-3 shrink-0" />}
                    <span className="truncate">{el.type === "text" ? (el as OverlayText).text : resolveAsset((el as OverlayMedia).src)?.name}</span>
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

function TrackRow({ label, height, action, children }: { label: string; height: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex" style={{ height }}>
      <div style={{ width: HEAD_W }} className="shrink-0 border-r border-b border-border px-2 flex items-center justify-between bg-surface sticky left-0 z-10">
        <span className="text-fine text-muted truncate">{label}</span>
        {action}
      </div>
      <div className="relative flex-1 border-b border-border bg-surface-sunken/50">{children}</div>
    </div>
  );
}
