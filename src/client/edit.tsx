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
  const [, bump] = useState(0);
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

  const srcDur = useCallback((src: string) => durCache.get(src), []);
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
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <Scissors className="w-4 h-4 text-primary" /> Footage edits
          </h2>
          <p className="text-sm text-muted mt-0.5">Cut and sequence real clips, overlay text, mix music — export to MP4.</p>
        </div>
        <button
          onClick={create}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-primary text-on-primary text-sm font-medium hover:bg-primary-hover disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New edit
        </button>
      </div>
      {projects === null ? (
        <div className="text-faint text-sm py-6">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="text-faint text-sm py-6 border border-dashed border-border rounded-md text-center">
          No edit projects yet.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/edits/${p.id}`)}
              className="text-left p-4 rounded-md border border-border bg-surface hover:border-faint"
            >
              <div className="font-medium truncate">{p.name}</div>
              <div className="text-xs text-faint mt-1">{p.updated_at?.slice(0, 10)}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── the editor ──────────────────────────────────────────────────────────────

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
      <div className="p-8 text-danger text-sm">
        {err} — <button className="underline" onClick={() => navigate("/")}>back</button>
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
        color: "#ffffff",
        background: "#00000080",
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
      {/* project bar */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-border bg-surface shrink-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-transparent font-medium outline-none rounded-sm px-1 -mx-1 focus:bg-surface-sunken"
        />
        <span className={`text-xs ${saveState === "saved" ? "text-faint" : saveState === "saving" ? "text-muted" : "text-danger"}`}>
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setAutocutOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-border text-sm hover:bg-surface-sunken"
          title="Assemble a cut from several clips with AI"
        >
          <Sparkles className="w-4 h-4 text-primary" /> Auto-cut
        </button>
        <ExportControls projectId={initial.id} disabled={dirty.current || edl.main.elements.length === 0} />
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
          tab={tab}
          setTab={setTab}
          assets={assets}
          setAssets={setAssets}
          onAdd={addAssetToTimeline}
          onAddText={addText}
        />
        <Player
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
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-6" onPointerDown={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-primary" /> Auto-cut
        </h2>
        <p className="text-sm text-muted mb-4">
          One pass watches every clip on your timeline together and assembles the strongest sequence for your
          brief — ordering, trims and captions included. The result replaces the main track, ready to adjust.
        </p>

        <Row label="What is this video for?">
          <textarea
            className={`${inputCls} min-h-16`}
            placeholder="e.g. 30-second product teaser for Instagram — energetic, lead with the best demo moment"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </Row>

        <Row label={`Clips on the timeline (${clips.length})`}>
          <div className="max-h-44 overflow-y-auto space-y-1 border border-border rounded-sm p-2">
            {clips.length === 0 && (
              <div className="text-xs text-faint py-2 text-center">
                Add video clips to the timeline first (Media panel → click a clip).
              </div>
            )}
            {clips.map((a, i) => (
              <div key={a.id} className="flex items-center gap-2 text-sm py-0.5">
                <span className="text-faint text-xs w-4">{i + 1}.</span>
                <span className="truncate">{a.name}</span>
              </div>
            ))}
          </div>
        </Row>

        {clips.length > 8 && <div className="text-xs text-danger mb-2">Auto-cut handles up to 8 clips at once.</div>}
        {msg && <div className="text-xs text-muted mb-3">{msg}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-sm border border-border text-sm hover:bg-surface-sunken">
            Cancel
          </button>
          <button
            onClick={run}
            disabled={running || clips.length === 0 || clips.length > 8}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-primary text-on-primary text-sm font-medium hover:bg-primary-hover disabled:opacity-60"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Assemble cut
          </button>
        </div>
      </div>
    </div>
  );
}

// ── left panel ──────────────────────────────────────────────────────────────

function LeftPanel({
  tab,
  setTab,
  assets,
  setAssets,
  onAdd,
  onAddText,
}: {
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
    <div className="w-60 shrink-0 border-r border-border bg-surface flex min-h-0">
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
            className={`w-11 py-2 rounded-sm flex flex-col items-center gap-1 text-[10px] ${
              tab === key ? "bg-surface-sunken text-foreground" : "text-muted hover:text-foreground"
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
            className="w-full py-2.5 rounded-sm border border-dashed border-border text-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add text
          </button>
        ) : (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="w-full py-2 mb-3 rounded-sm border border-dashed border-border text-sm text-muted hover:text-foreground hover:border-faint flex items-center justify-center gap-1.5"
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
            {uploadErr && <div className="text-xs text-danger mb-2">{uploadErr}</div>}
            <div className="space-y-2">
              {list.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onAdd(a)}
                  title="Add to timeline"
                  className="w-full text-left rounded-sm border border-border overflow-hidden hover:border-faint group"
                >
                  {isVideoAsset(a) ? (
                    <video src={assetUrl(a)} muted preload="metadata" className="w-full h-20 object-cover bg-black" />
                  ) : isImageAsset(a) ? (
                    <img src={assetUrl(a)} className="w-full h-20 object-cover bg-black" />
                  ) : (
                    <div className="w-full h-12 grid place-items-center bg-surface-sunken">
                      <Music className="w-5 h-5 text-muted" />
                    </div>
                  )}
                  <div className="px-2 py-1.5 text-xs truncate text-muted group-hover:text-foreground">{a.name}</div>
                </button>
              ))}
              {list.length === 0 && <div className="text-xs text-faint py-4 text-center">Nothing here yet.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── player ──────────────────────────────────────────────────────────────────

function Player({
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / edl.output.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [edl.output.width]);

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
    <div className="flex-1 min-w-0 bg-surface-sunken grid place-items-center p-4 overflow-hidden">
      <div className="w-full max-w-full" style={{ maxHeight: "100%", aspectRatio: `${edl.output.width}/${edl.output.height}` }}>
        <div
          ref={stageRef}
          className="relative w-full h-full overflow-hidden rounded-md shadow-sm"
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
                          color: t.color ?? "#fff",
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
            <div className="absolute inset-0 grid place-items-center text-faint text-sm">Add clips from the Media panel</div>
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
      <span className="eyebrow block mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full px-2 py-1.5 rounded-sm border border-border bg-surface text-sm outline-none focus:border-ring";

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
          <Row label="Project brief — what is this video for?">
            <textarea
              className={`${inputCls} min-h-20`}
              placeholder="e.g. 30-second product teaser for Instagram — energetic"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Row>
          <p className="text-xs text-faint">
            The brief anchors every AI action — cuts are only "effective" relative to a goal.
          </p>
          <div className="mt-4 text-xs text-faint text-center">
            Canvas: {edl.output.width}×{edl.output.height} @ {edl.output.fps}fps · Select a clip to edit it
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
          <div className="eyebrow mb-3">{el.type === "video" ? "Video clip" : "Image"}</div>
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
                            color: "#ffffff",
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
                className="w-full mt-1 mb-2 py-2 rounded-sm bg-primary text-on-primary text-sm font-medium hover:bg-primary-hover disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Clean up clip (AI)
              </button>
              {analyzeMsg && <div className="text-xs text-muted mb-2">{analyzeMsg}</div>}
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
          <div className="eyebrow mb-3">{el.type === "text" ? "Text" : el.type === "image" ? "Image overlay" : "Video overlay"}</div>
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
                  <input type="color" className="w-full h-8 rounded-sm border border-border bg-surface" value={(el.color ?? "#ffffff").slice(0, 7)} onChange={(e) => set((x) => ((x as OverlayText).color = e.target.value))} />
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
        <div className="eyebrow mb-3">Audio</div>
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
    <div className="w-64 shrink-0 border-l border-border bg-surface overflow-y-auto p-4">
      {body()}
      {sel && (
        <button onClick={onDelete} className="w-full mt-2 py-2 rounded-sm border border-border text-sm text-danger hover:bg-danger-tint flex items-center justify-center gap-1.5">
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
        <a href={last.output_url} target="_blank" className="text-sm text-link hover:underline">
          Last export ↗
        </a>
      )}
      {last?.status === "failed" && (
        <span className="text-xs text-danger max-w-64 truncate" title={last.error ?? ""}>
          {last.error}
        </span>
      )}
      <select value={quality} onChange={(e) => setQuality(e.target.value)} className="px-2 py-1.5 rounded-sm border border-border bg-surface text-sm">
        <option value="draft">Draft</option>
        <option value="standard">Standard</option>
        <option value="high">High</option>
      </select>
      <button
        onClick={run}
        disabled={busy || disabled}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-primary text-on-primary text-sm font-medium hover:bg-primary-hover disabled:opacity-60"
      >
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
    <div className="h-64 shrink-0 border-t border-border bg-surface flex flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        <button onClick={() => setPlaying(!playing)} className="p-1.5 rounded-sm hover:bg-surface-sunken" title="Play / pause (space)">
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <span className="text-sm tabular-nums">
          <span className="text-primary">{fmtTime(playhead)}</span>
          <span className="text-faint"> / {fmtTime(total)}</span>
        </span>
        <div className="w-px h-5 bg-border mx-1" />
        <button onClick={splitAtPlayhead} className="p-1.5 rounded-sm hover:bg-surface-sunken text-muted hover:text-foreground" title="Split at playhead">
          <Scissors className="w-4 h-4" />
        </button>
        <button onClick={deleteSelected} disabled={!sel} className="p-1.5 rounded-sm hover:bg-surface-sunken text-muted hover:text-foreground disabled:opacity-40" title="Delete selected">
          <Trash2 className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <input type="range" min={10} max={160} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-32" title="Zoom" />
      </div>

      {/* tracks */}
      <div ref={scrollRef} className="flex-1 overflow-auto relative">
        <div style={{ width: width + HEAD_W }} className="relative">
          {/* ruler */}
          <div className="sticky top-0 z-20 flex bg-surface" style={{ height: RULER_H }}>
            <div style={{ width: HEAD_W }} className="shrink-0 border-r border-b border-border bg-surface" />
            <div className="relative flex-1 border-b border-border cursor-ew-resize select-none" onPointerDown={scrub}>
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-border text-[10px] text-faint pl-1 pt-0.5" style={{ left: t * zoom }}>
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
                  className={`absolute top-1 bottom-1 rounded-[4px] overflow-hidden border ${selected ? "border-ring ring-1 ring-ring" : "border-black/30"} bg-black cursor-grab`}
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
                  <div className="absolute left-1 bottom-0.5 text-[10px] text-white/90 drop-shadow truncate max-w-[90%]">
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
                    className={`absolute top-1 bottom-1 rounded-[4px] border px-1.5 text-[10px] flex items-center gap-1 truncate cursor-grab ${
                      selected ? "border-ring ring-1 ring-ring" : "border-transparent"
                    } ${el.type === "text" ? "bg-primary/25 text-foreground" : "bg-ring/25"} ${track.hidden ? "opacity-40" : ""}`}
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
                    className={`absolute top-1 bottom-1 rounded-[4px] overflow-hidden border bg-success/30 cursor-grab ${
                      selected ? "border-ring ring-1 ring-ring" : "border-transparent"
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
            <div className="w-px h-full bg-primary" />
            <div className="absolute -top-0 -left-[5px] w-[11px] h-3 bg-primary rounded-b-[3px]" />
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
        <span className="text-[11px] text-muted truncate">{label}</span>
        {action}
      </div>
      <div className="relative flex-1 border-b border-border bg-surface-sunken/50">{children}</div>
    </div>
  );
}
