import { useCallback, useEffect, useRef, useState } from "react";
import { EditProjectsSection, EditRoute } from "./edit";
import { STARTER_HTML } from "./starter";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import {
  ArrowLeft,
  Film,
  Plus,
  Upload,
  Trash2,
  Copy,
  Check,
  Loader2,
  Play,
  Pause,
  Video,
  Image as ImageIcon,
  Type as TypeIcon,
  Music,
  AlertCircle,
  X,
} from "lucide-react";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  btnDanger,
  btnGhost,
  btnIcon,
  btnPrimary,
  btnSecondary,
  card,
  chip,
  stretch,
} from "./ui";

// ── types ────────────────────────────────────────────────────────────

interface Composition {
  id: string;
  name: string;
  description: string;
  html: string;
  fps: number;
  updated_at: string;
}

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
}

interface RenderJob {
  id: number;
  composition_id: string;
  status: "rendering" | "completed" | "failed";
  output_url: string | null;
  error: string | null;
  created_at: string;
}

// ── api ──────────────────────────────────────────────────────────────

async function errText(r: Response): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error || r.statusText;
}

const api = {
  async get<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  },
  async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  },
};

// ── app ──────────────────────────────────────────────────────────────

type Tab = "compose" | "timeline" | "media" | "renders";

// Minimal history-based router: `/` = gallery, `/<id>` = editor for that id.
function useRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { path, navigate };
}

export function App() {
  const { path, navigate } = useRouter();
  // "/" → gallery; "/edits/<id>" → footage editor; "/<id>" → composition editor.
  const id = decodeURIComponent(path.replace(/^\/+|\/+$/g, ""));
  const editId = id.startsWith("edits/") ? id.slice(6) : id === "edits" ? "" : null;

  return (
    <div className="h-dvh flex flex-col text-foreground">
      {/* Brand row: the app icon is the identity object, and the accent hue
          lives here (plus count badges and the focus ring) and nowhere else. */}
      <header className="flex items-center gap-2 px-5 h-14 border-b border-border bg-surface shrink-0">
        {id && (
          <button onClick={() => navigate("/")} className={`${btnGhost} -ml-2`}>
            <ArrowLeft className="w-4 h-4" /> Videos
          </button>
        )}
        <span className="grid place-items-center w-7 h-7 rounded-sm bg-accent text-on-accent shrink-0">
          <Film className="w-4 h-4" />
        </span>
        <span className="text-heading-3">OpenVideo</span>
        <span className="text-fine text-faint hidden sm:inline">edit &amp; render video</span>
      </header>

      {editId ? (
        <EditRoute id={editId} navigate={navigate} />
      ) : id ? (
        <EditorRoute id={id} navigate={navigate} />
      ) : (
        <Gallery navigate={navigate} />
      )}
    </div>
  );
}

// ── gallery ──────────────────────────────────────────────────────────

function fmtDate(s: string): string {
  // SQLite datetime('now') is space-separated UTC; normalise for Date().
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Gallery({ navigate }: { navigate: (to: string) => void }) {
  const [comps, setComps] = useState<Composition[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.get<Composition[]>("/api/compositions").then(setComps).catch(() => setComps([]));
  }, []);

  async function newVideo() {
    setCreating(true);
    try {
      const c = await api.send<Composition>("POST", "/api/compositions", {
        name: "Untitled",
        html: STARTER_HTML,
      });
      navigate(`/${c.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Toolbar grammar: identity left, the one solid action right. */}
        <div className="flex items-center justify-between gap-4 mb-6">
          <h1 className="text-heading-1">
            Your videos
            {comps && comps.length > 0 && (
              <span className="ml-2 text-data text-muted tabular-nums">{comps.length}</span>
            )}
          </h1>
          <button onClick={newVideo} disabled={creating} className={btnPrimary}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            New video
          </button>
        </div>

        {comps === null ? (
          /* Loading is the shape of the answer, never a spinner. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${card} overflow-hidden`}>
                <div className="aspect-video bg-surface-sunken animate-pulse" />
                <div className="px-4 py-3 space-y-2">
                  <div className="h-3 w-1/2 rounded-full bg-surface-sunken animate-pulse" />
                  <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : comps.length === 0 ? (
          <EmptyState
            icon={<Video className="w-8 h-8" />}
            title="No videos yet"
            body="A video is motion graphics you author as HTML on a timeline — a title card, a lower third, an intro. Start from a template and edit it live."
            action={
              <button onClick={newVideo} disabled={creating} className={btnPrimary}>
                <Plus className="w-4 h-4" /> New video
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {comps.map((c) => (
              <button
                key={c.id}
                onClick={() => navigate(`/${c.id}`)}
                className={`${card} group text-left overflow-hidden hover:bg-surface-sunken`}
              >
                <div className="aspect-video bg-black overflow-hidden">
                  <iframe
                    src={`/api/compositions/${c.id}/preview?seek=${posterTime(c.html)}`}
                    className="w-full h-full pointer-events-none"
                    scrolling="no"
                    tabIndex={-1}
                    title={c.name}
                  />
                </div>
                <div className="px-4 py-3">
                  <div className="truncate text-body-sm font-medium">{c.name}</div>
                  <div className="text-fine text-faint mt-0.5">Edited {fmtDate(c.updated_at)}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        <EditProjectsSection navigate={navigate} />
      </div>
    </main>
  );
}

// ── editor route (fetch one composition by id from the URL) ───────────

function EditorRoute({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  // undefined = loading, null = not found, Composition = loaded.
  const [comp, setComp] = useState<Composition | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setComp(undefined);
    api
      .get<Composition>(`/api/compositions/${id}`)
      .then((c) => alive && setComp(c))
      .catch(() => alive && setComp(null));
    return () => {
      alive = false;
    };
  }, [id]);

  if (comp === undefined) {
    return <div className="flex-1 grid place-items-center text-body-sm text-faint">Loading…</div>;
  }
  if (comp === null) {
    return (
      <div className="flex-1 grid place-items-center">
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title="That video doesn’t exist"
          body="It may have been deleted, or the link is wrong."
          action={
            <button onClick={() => navigate("/")} className={btnSecondary}>
              <ArrowLeft className="w-4 h-4" /> Back to your videos
            </button>
          }
        />
      </div>
    );
  }
  return <Editor key={comp.id} comp={comp} navigate={navigate} />;
}

// ── editor ───────────────────────────────────────────────────────────

function Editor({
  comp,
  navigate,
}: {
  comp: Composition;
  navigate: (to: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("timeline");
  const [html, setHtml] = useState(comp.html);
  const [name, setName] = useState(comp.name);
  const [fps, setFps] = useState(comp.fps);
  const [previewKey, setPreviewKey] = useState(0);
  // Resizable layout, persisted per-seam across reloads.
  const vLayout = useDefaultLayout({
    id: "ove:editor-v:v2",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const hLayout = useDefaultLayout({
    id: "ove:editor-h:v2",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Selected clip (by index) for the right-side inspector.
  const [selectedClip, setSelectedClip] = useState<number | null>(null);

  // Playhead state, kept in sync with the preview iframe's master clock.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [playing, setPlaying] = useState(false); // default paused
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(5);

  // Refs so the (stable) message handler can re-apply state after an iframe reload.
  const timeRef = useRef(0);
  const winRef = useRef<{ start: number; end: number | null } | null>(null);
  const restoreRef = useRef<number | null>(null);

  function post(msg: Record<string, unknown>) {
    iframeRef.current?.contentWindow?.postMessage({ target: "hf-preview", ...msg }, "*");
  }

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const m = e.data;
      if (!m || m.source !== "hf-preview") return;
      if (typeof m.duration === "number") setDuration(m.duration);
      if (m.type === "time" && typeof m.t === "number") {
        setTime(m.t);
        timeRef.current = m.t;
      }
      if (m.type === "select" && typeof m.index === "number") setSelectedClip(m.index); // clicked in the video
      if (m.type === "meta") {
        // iframe (re)loaded — re-apply the loop window and restore the playhead.
        const w = winRef.current;
        post({ type: "window", start: w ? w.start : 0, end: w ? w.end : null });
        if (restoreRef.current != null) {
          post({ type: "seek", t: restoreRef.current });
          restoreRef.current = null;
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function seek(t: number) {
    setPlaying(false);
    setTime(t);
    post({ type: "seek", t });
  }
  function togglePlay() {
    const next = !playing;
    setPlaying(next);
    post({ type: next ? "play" : "pause" });
  }

  // The selected clip defines a loop window the preview loops within. Selecting
  // a clip only sets the window — it never moves the playhead (you clicked
  // something you can already see) and never auto-plays.
  const clips = parseClips(html).clips;
  const poster = posterTime(html);
  const selClip = selectedClip != null ? clips.find((c) => c.index === selectedClip) ?? null : null;

  useEffect(() => {
    winRef.current = selClip ? { start: selClip.start, end: selClip.start + selClip.duration } : null;
    const w = winRef.current;
    post({ type: "window", start: w ? w.start : 0, end: w ? w.end : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClip]);

  // Spacebar toggles play/pause (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      togglePlay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function updateClip(index: number, patch: ClipPatch) {
    setHtml((h) => applyClipPatch(h, index, patch));
    // Debounce the preview reload so typing stays smooth; restore the current
    // playhead afterwards so an edit doesn't jump the time either.
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      restoreRef.current = timeRef.current;
      setPreviewKey((k) => k + 1);
    }, 350);
  }

  async function save() {
    setSaving(true);
    try {
      await api.send("PUT", `/api/compositions/${comp.id}`, { name, html, fps });
      setPreviewKey((k) => k + 1); // reload iframe
      setTime(poster);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await api.send("DELETE", `/api/compositions/${comp.id}`);
    navigate("/");
  }

  return (
    <main className="flex-1 min-h-0 min-w-0 bg-background">
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${comp.name}”?`}
          body="The composition and its render history go with it. This cannot be undone."
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      <Group
        orientation="vertical"
        defaultLayout={vLayout.defaultLayout}
        onLayoutChanged={vLayout.onLayoutChanged}
      >
        {/* preview (left) + clip inspector (right) — Remotion-style */}
        <Panel id="stage" defaultSize="68%" minSize="40%" className="min-h-0">
          <Group
            orientation="horizontal"
            defaultLayout={hLayout.defaultLayout}
            onLayoutChanged={hLayout.onLayoutChanged}
          >
            <Panel id="preview" defaultSize="74%" minSize="45%" className="min-w-0 p-5">
              {/* Preview stage: the harness scales + centers the composition,
                  letterboxing it inside this black stage (any panel shape). */}
              <div className="h-full w-full min-h-0 min-w-0 bg-black rounded-md overflow-hidden shadow-edge">
                <iframe
                  ref={iframeRef}
                  key={previewKey}
                  src={`/api/compositions/${comp.id}/preview?seek=${poster}`}
                  className="w-full h-full"
                  title="preview"
                />
              </div>
            </Panel>

            <Separator className="ove-sep-x" />

            <Panel id="inspector" defaultSize="26%" minSize="18%" maxSize="46%" className="bg-surface overflow-y-auto">
              {selClip ? (
                <Inspector
                  key={selClip.index}
                  clip={selClip}
                  onChange={(p) => updateClip(selClip.index, p)}
                  onClose={() => setSelectedClip(null)}
                />
              ) : (
                <div className="px-4 py-4">
                  <div className="text-label text-muted mb-1">Inspector</div>
                  <p className="text-body-sm text-muted">
                    Select a clip, in the timeline or in the video, to edit it.
                  </p>
                </div>
              )}
            </Panel>
          </Group>
        </Panel>

        <Separator className="ove-sep-y" />

        {/* timeline + options */}
        <Panel id="dock" defaultSize="32%" minSize="16%" maxSize="60%" className="flex flex-col bg-background min-h-0">
          {/* view switcher: a segmented track, active segment raised white */}
          <div className="px-5 pt-3 shrink-0">
            <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-sunken p-0.5">
              {(["timeline", "compose", "media", "renders"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={`h-7 px-3 text-button capitalize rounded-sm ${
                    tab === t ? "bg-surface text-foreground shadow-raised" : "text-muted hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 pt-3 min-h-0">
        {tab === "compose" && (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="field flex-1"
                placeholder="Composition name"
                aria-label="Composition name"
              />
              <label className="flex items-center gap-2 text-label text-muted">
                fps
                <select
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value))}
                  className="field w-auto"
                >
                  <option value={24}>24</option>
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                </select>
              </label>
            </div>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
              aria-label="Composition HTML"
              className="field h-[40vh] font-mono text-fine"
            />
            <div className="flex items-center gap-2">
              <button onClick={save} disabled={saving} className={btnPrimary}>
                {saving ? "Saving…" : "Save & preview"}
              </button>
              <button onClick={() => setConfirmDelete(true)} className={btnDanger}>
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          </div>
        )}

        {tab === "timeline" && (
          <Timeline
            html={html}
            fps={fps}
            time={time}
            duration={duration}
            playing={playing}
            selected={selectedClip}
            onSelect={setSelectedClip}
            onSeek={seek}
            onTogglePlay={togglePlay}
          />
        )}
        {tab === "media" && <MediaPanel />}
        {tab === "renders" && <RendersPanel comp={comp} />}
          </div>
        </Panel>
      </Group>
    </main>
  );
}

// ── timeline ─────────────────────────────────────────────────────────

type ClipType = "video" | "image" | "text" | "audio";
interface Clip {
  index: number; // position among .clip elements — stable handle for editing
  start: number;
  duration: number;
  track: number;
  type: ClipType;
  label: string;
  text: string;
  color: string;
  fontSize: string;
  src: string;
}

/** Parse HyperFrames `.clip` elements out of the composition HTML into tracks. */
function parseClips(html: string): { clips: Clip[]; tracks: number } {
  let clips: Clip[] = [];
  let tracks = 1;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    clips = Array.from(doc.querySelectorAll(".clip")).map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const type: ClipType =
        tag === "video" ? "video" : tag === "img" ? "image" : tag === "audio" ? "audio" : "text";
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      const label = text.slice(0, 28) || type[0].toUpperCase() + type.slice(1);
      return {
        index,
        start: parseFloat(el.getAttribute("data-start") || "0") || 0,
        duration: parseFloat(el.getAttribute("data-duration") || "0") || 0,
        track: parseInt(el.getAttribute("data-track-index") || "0", 10) || 0,
        type,
        label,
        text,
        color: (el as HTMLElement).style?.color || "",
        fontSize: (el as HTMLElement).style?.fontSize || "",
        src: el.getAttribute("src") || "",
      };
    });
    tracks = Math.max(1, ...clips.map((c) => c.track + 1));
  } catch {
    /* malformed HTML mid-edit — show an empty timeline */
  }
  return { clips, tracks };
}

/**
 * A frame worth showing when nothing is playing.
 *
 * Compositions animate IN (`gsap.from({opacity: 0})`), so at t=0 every element
 * is still invisible and the composition renders as an empty frame. Landing the
 * gallery thumbnails and the editor on t=0 therefore showed a black rectangle
 * and made the app look broken on first open — the starter composition is meant
 * to be the thing that teaches you what this is, and it was showing nothing.
 *
 * Halfway through is the frame a video tool would pick for a poster: past the
 * entrances, before any outro.
 */
export function posterTime(html: string): number {
  const { clips } = parseClips(html);
  const end = clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
  return end > 0 ? Math.round((end / 2) * 100) / 100 : 0;
}

export type ClipPatch = Partial<{
  text: string;
  color: string;
  fontSize: string;
  src: string;
  start: number;
  duration: number;
  track: number;
}>;

/** Apply an inspector edit to clip #index by round-tripping the HTML through the DOM. */
function applyClipPatch(html: string, index: number, patch: ClipPatch): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector("[data-composition-id]");
    const el = doc.querySelectorAll(".clip")[index] as HTMLElement | undefined;
    if (!root || !el) return html;
    if (patch.text !== undefined) el.textContent = patch.text;
    if (patch.color !== undefined) el.style.color = patch.color;
    if (patch.fontSize !== undefined) el.style.fontSize = patch.fontSize;
    if (patch.src !== undefined) el.setAttribute("src", patch.src);
    if (patch.start !== undefined) el.setAttribute("data-start", String(patch.start));
    if (patch.duration !== undefined) el.setAttribute("data-duration", String(patch.duration));
    if (patch.track !== undefined) el.setAttribute("data-track-index", String(patch.track));
    return root.outerHTML;
  } catch {
    return html;
  }
}

// Category, not decoration: one hue per element kind, from the generated
// category palette, and the SAME four the footage timeline uses, so a video
// clip is the same colour wherever it appears in the app.
//
// A clip is a TINT fill with same-hue text and a solid bar at its left edge,
// not a solid block: a timeline is mostly one kind of clip, and a wall of the
// solid role reads as a paint chart rather than a classification.
export const CLIP_BAR: Record<ClipType, string> = {
  video: "bg-track-video",
  image: "bg-track-image",
  text: "bg-track-text",
  audio: "bg-track-audio",
};
const CLIP_FILL: Record<ClipType, string> = {
  video: "bg-track-video-tint text-track-video",
  image: "bg-track-image-tint text-track-image",
  text: "bg-track-text-tint text-track-text",
  audio: "bg-track-audio-tint text-track-audio",
};
function clipIcon(type: ClipType) {
  const c = "w-3.5 h-3.5 shrink-0";
  if (type === "video") return <Video className={c} />;
  if (type === "image") return <ImageIcon className={c} />;
  if (type === "audio") return <Music className={c} />;
  return <TypeIcon className={c} />;
}
/** Frame timecode MM:SS.FF (Remotion-style). */
function fmtTC(t: number, fps: number) {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  let f = Math.round((total - Math.floor(total)) * fps);
  if (f >= fps) f = fps - 1;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}.${p(f)}`;
}

function Timeline({
  html,
  fps,
  time,
  duration,
  playing,
  selected,
  onSelect,
  onSeek,
  onTogglePlay,
}: {
  html: string;
  fps: number;
  time: number;
  duration: number;
  playing: boolean;
  selected: number | null;
  onSelect: (index: number) => void;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const { clips, tracks } = parseClips(html);
  const dur = Math.max(duration, 0.1);
  const rows = Array.from({ length: tracks }, (_, i) => tracks - 1 - i); // highest track on top
  const ticks = Array.from({ length: Math.ceil(dur) }, (_, i) => i + 1).filter((s) => s <= dur + 0.001);
  const pct = (t: number) => `${Math.max(0, Math.min(t / dur, 1)) * 100}%`;

  function seekAt(clientX: number) {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r) return;
    onSeek(((clientX - r.left) / r.width) * dur);
  }
  function onPointerDown(e: React.PointerEvent) {
    seekAt(e.clientX);
    const move = (ev: PointerEvent) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className={`${card} text-foreground overflow-hidden select-none`}>
      {/* transport */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border">
        <button
          onClick={onTogglePlay}
          className={btnIcon}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
      </div>

      <div className="flex">
        <div className="shrink-0 border-r border-border w-28">
          {/* current-time readout in the corner (Remotion-style) */}
          <div className="h-7 flex items-center px-3 border-b border-border text-data tabular-nums">
            {fmtTC(time, fps)}
          </div>
          {rows.map((tr) => (
            <div
              key={tr}
              className="h-10 flex items-center px-3 text-fine text-muted border-b border-border"
            >
              Track {tr + 1}
            </div>
          ))}
        </div>

        <div className="relative flex-1 cursor-pointer bg-background" ref={areaRef} onPointerDown={onPointerDown}>
          <div className="relative h-7 border-b border-border">
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full border-l border-border" style={{ left: pct(s) }}>
                <span className="absolute left-1 top-1 text-[10px] text-faint">{fmtTC(s, fps)}</span>
              </div>
            ))}
          </div>

          {rows.map((tr) => (
            <div key={tr} className="relative h-10 border-b border-border">
              {clips
                .filter((c) => c.track === tr)
                .map((c) => (
                  <div
                    key={c.index}
                    onPointerDown={(e) => {
                      e.stopPropagation(); // select, don't scrub
                      onSelect(c.index);
                    }}
                    className={`absolute top-1 bottom-1 rounded-sm flex items-center gap-1.5 pl-1.5 pr-2 text-fine overflow-hidden cursor-pointer ${CLIP_FILL[c.type]} ${
                      c.index === selected ? "ring-2 ring-offset-1 ring-ring ring-offset-surface" : ""
                    }`}
                    style={{ left: pct(c.start), width: pct(c.duration) }}
                    title={`${c.label} · ${c.start}s–${c.start + c.duration}s`}
                  >
                    <span className={`w-0.5 self-stretch my-0.5 rounded-full shrink-0 ${CLIP_BAR[c.type]}`} />
                    {clipIcon(c.type)}
                    <span className="truncate">{c.label}</span>
                  </div>
                ))}
            </div>
          ))}

          <div className="absolute top-0 bottom-0 w-px bg-foreground pointer-events-none z-10" style={{ left: pct(time) }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-3 h-3 rounded-sm bg-foreground" />
          </div>
        </div>
      </div>

      {clips.length === 0 && (
        <div className="px-3 py-3 text-fine text-muted">
          No timed clips yet. Add elements with <code>class="clip"</code> + <code>data-start</code> /{" "}
          <code>data-duration</code> / <code>data-track-index</code> in the Compose tab.
        </div>
      )}
    </div>
  );
}

// ── inspector ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-label text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Section title inside a rail. Sentence case in `label`, never uppercase:
 *  the 11px tracked style belongs above a KPI number and nowhere else. */
function Zone({ children }: { children: React.ReactNode }) {
  return <div className="text-label text-muted">{children}</div>;
}

const inputCls = "field";

/** Right-side quick editor for the selected clip — fields depend on the clip type. */
function Inspector({
  clip,
  onChange,
  onClose,
}: {
  clip: Clip;
  onChange: (patch: ClipPatch) => void;
  onClose: () => void;
}) {
  const typeLabel = clip.type[0].toUpperCase() + clip.type.slice(1);
  const num = (v: string) => (v === "" ? 0 : parseFloat(v) || 0);

  return (
    <div className="overflow-hidden">
      {/* header zone */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border">
        {/* Category bar: the cheapest visible classification there is, and it
            never competes with the text. */}
        <span className={`w-0.5 h-6 rounded-full shrink-0 ${CLIP_BAR[clip.type]}`} />
        <span className="text-muted">{clipIcon(clip.type)}</span>
        <div className="min-w-0">
          <div className="text-heading-3 truncate">{typeLabel}</div>
        </div>
        <span className={`ml-auto shrink-0 tabular-nums ${chip}`}>Track {clip.track + 1}</span>
        <button onClick={onClose} className={btnIcon} aria-label="Close inspector">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* content zone */}
      <div className="px-4 py-4 space-y-3 border-b border-border">
        <Zone>Content</Zone>
        {clip.type === "text" && (
          <>
            <Field label="Text">
              <input className={inputCls} value={clip.text} onChange={(e) => onChange({ text: e.target.value })} />
            </Field>
            <Field label="Color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Text colour"
                  className="field w-8 shrink-0 p-1"
                  value={toHex(clip.color)}
                  onChange={(e) => onChange({ color: e.target.value })}
                />
                <input
                  className={inputCls}
                  value={clip.color}
                  onChange={(e) => onChange({ color: e.target.value })}
                  placeholder="#ffffff"
                />
              </div>
            </Field>
            <Field label="Font size">
              <input
                className={inputCls}
                value={clip.fontSize}
                onChange={(e) => onChange({ fontSize: e.target.value })}
                placeholder="96px"
              />
            </Field>
          </>
        )}

        {(clip.type === "image" || clip.type === "video" || clip.type === "audio") && (
          <Field label="Source">
            <input
              className={inputCls}
              value={clip.src}
              onChange={(e) => onChange({ src: e.target.value })}
              placeholder="assets/your-file"
            />
          </Field>
        )}
      </div>

      {/* timing zone */}
      <div className="px-4 py-4 space-y-3">
        <Zone>Timing</Zone>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Start (s)">
            <input
              type="number"
              step="0.1"
              className={`${inputCls} tabular-nums`}
              value={clip.start}
              onChange={(e) => onChange({ start: num(e.target.value) })}
            />
          </Field>
          <Field label="Dur (s)">
            <input
              type="number"
              step="0.1"
              className={`${inputCls} tabular-nums`}
              value={clip.duration}
              onChange={(e) => onChange({ duration: num(e.target.value) })}
            />
          </Field>
          <Field label="Track">
            <input
              type="number"
              min="1"
              className={`${inputCls} tabular-nums`}
              value={clip.track + 1}
              onChange={(e) => onChange({ track: Math.max(0, Math.round(num(e.target.value)) - 1) })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

/** Best-effort convert a CSS color (hex or rgb) to #rrggbb for the color input. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return "#ffffff";
}

// ── media ────────────────────────────────────────────────────────────

function MediaPanel() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setAssets(await api.get<Asset[]>("/api/assets"));
  }
  useEffect(() => {
    load();
  }, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", f);
        await fetch("/api/assets", { method: "POST", body: fd });
      }
      await load();
    } finally {
      setUploading(false);
    }
  }

  async function del(id: string) {
    await api.send("DELETE", `/api/assets/${id}`);
    load();
  }

  function copy(key: string) {
    navigator.clipboard.writeText(`assets/${key}`);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  }

  const isImg = (t: string) => t.startsWith("image/");

  return (
    <div className="max-w-3xl space-y-4">
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
        className="flex flex-col items-center gap-2 py-8 rounded-md border-2 border-dashed border-border bg-surface text-muted text-body-sm cursor-pointer hover:border-faint"
      >
        {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
        Drop a logo or product demo here, or click to upload
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => upload(e.target.files)}
        />
      </div>

      <p className="text-fine text-muted">
        Reference media in your composition HTML by its path, e.g.{" "}
        <code className="px-1 py-0.5 bg-surface-sunken rounded-xs">&lt;img src="assets/logo.png"&gt;</code>. Only
        referenced assets are shipped to the renderer.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {assets.map((a) => (
          <div key={a.id} className={`${card} overflow-hidden`}>
            <div className="aspect-video bg-surface-sunken grid place-items-center overflow-hidden">
              {isImg(a.content_type) ? (
                <img src={`/api/uploads/${a.key}`} alt={a.name} className="w-full h-full object-contain" />
              ) : a.content_type.startsWith("video/") ? (
                <video src={`/api/uploads/${a.key}`} className="w-full h-full object-cover" muted />
              ) : (
                <Film className="w-6 h-6 text-faint" />
              )}
            </div>
            <div className="p-2 flex items-center gap-1">
              <code className="flex-1 text-fine truncate text-muted">assets/{a.key}</code>
              <button onClick={() => copy(a.key)} className={btnIcon} aria-label={`Copy path for ${a.name}`} title="Copy path">
                {copied === a.key ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setConfirmDel(a)}
                className={`${btnIcon} hover:text-danger`}
                aria-label={`Delete ${a.name}`}
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {assets.length === 0 && (
        <EmptyState
          icon={<Film className="w-8 h-8" />}
          title="Nothing in the library yet"
          body="Upload a logo, a product demo or a still, then reference it from your composition HTML."
        />
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete “${confirmDel.name}”?`}
          body="Any composition that references this file will render without it."
          onConfirm={() => {
            del(confirmDel.id);
            setConfirmDel(null);
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// ── renders ──────────────────────────────────────────────────────────

// Tinted badge = a signal that demands attention (vs a chip, which is a fact).
const RENDER_TONE: Record<RenderJob["status"], string> = {
  rendering: "warning",
  completed: "success",
  failed: "danger",
};

function RendersPanel({ comp }: { comp: Composition }) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [rendering, setRendering] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    const all = await api.get<RenderJob[]>("/api/renders");
    setJobs(all.filter((j) => j.composition_id === comp.id));
  }
  useEffect(() => {
    load();
  }, [comp.id]);

  async function render() {
    setRendering(true);
    setErr("");
    try {
      await api.send("POST", "/api/renders", { composition_id: comp.id });
      await load();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <button onClick={render} disabled={rendering} className={btnPrimary}>
        {rendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {rendering ? "Rendering… (this can take a minute)" : "Render MP4"}
      </button>

      {err && (
        <div className="flex items-start gap-2 rounded-sm bg-danger-tint px-3 py-2 text-body-sm text-danger">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="break-words">{err}</span>
        </div>
      )}

      <div className="space-y-2">
        {jobs.map((j) => (
          <div key={j.id} className={`${card} p-3`}>
            {j.status === "completed" && j.output_url ? (
              <video src={j.output_url} controls className="w-full max-w-md rounded-md bg-black" />
            ) : j.status === "failed" ? (
              <div className="flex items-start gap-2 text-body-sm text-danger">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{j.error || "Render failed"}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-body-sm text-muted">
                <Loader2 className="w-4 h-4 animate-spin" /> Rendering…
              </div>
            )}
            <div className="flex items-center gap-2 mt-2 text-fine text-faint tabular-nums">
              <Badge tone={RENDER_TONE[j.status]}>{j.status}</Badge>
              <span>
                #{j.id} · {new Date(j.created_at + "Z").toLocaleString()}
              </span>
            </div>
          </div>
        ))}
        {jobs.length === 0 && (
          <EmptyState
            icon={<Film className="w-8 h-8" />}
            title="No renders yet"
            body="Rendering runs the composition on the managed render service and hands back an MP4. It takes about a minute."
          />
        )}
      </div>
    </div>
  );
}
