// A project's highlights: the selects an editor looks at first. Each pick
// plays straight from its in to its out (streamed at preview size, so nobody
// downloads 4K to review), and a person keeps or drops it. What is kept goes
// to an editor's own software as a timeline or a sheet, or to this app's
// editor. Found in the background (src/server/highlights.ts): this page can
// be left while that runs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { api, frameUrl, MediaVideo, type Asset } from "./edit";
import { EmptyState, Kbd, Popover, PopoverContent, PopoverTrigger, SelectTrigger, btnGhost, btnIcon, btnPrimary, btnSecondary, card } from "./ui";

type Kind = "soundbite" | "broll";
type Pick = "keep" | "drop" | null;

interface HighlightClip {
  id: string;
  name: string;
  folder: string;
  asset_id: string | null;
  media_uid: string | null;
  duration: number | null;
}

interface Highlight {
  id: string;
  clip: HighlightClip;
  kind: Kind;
  start: number;
  end: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  pick: Pick;
  origin: string;
}

interface SkippedClip {
  id: string;
  name: string;
  folder: string;
  reason: string;
  asset_id: string | null;
  duration: number | null;
}

interface HighlightList {
  asked: boolean;
  brief: string;
  clips: { logged: number; done: number; pending: number; failed: number; skipped: number; not_asked: number };
  counts: { total: number; soundbites: number; broll: number; kept: number; dropped: number; open: number };
  paused: string | null;
  highlights: Highlight[];
  next_offset: number | null;
  skipped?: SkippedClip[];
}

interface Filters {
  kind: "" | Kind;
  min: number;
  pick: "all" | "open" | "keep" | "drop";
  folder: string;
  sort: "score" | "clip";
}

const PAGE = 200;

/** Seconds → "M:SS.s": a position in a clip. */
function clock(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

function query(f: Filters, offset: number, extra = ""): string {
  const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: f.sort, pick: f.pick });
  if (f.kind) p.set("kind", f.kind);
  if (f.min > 1) p.set("min_score", String(f.min));
  if (f.folder) p.set("folder", f.folder);
  return `?${p}${extra}`;
}

const asAsset = (c: { asset_id: string | null; name: string; duration: number | null; media_uid?: string | null }): Asset | null =>
  c.asset_id
    ? { id: c.asset_id, key: "", name: c.name, content_type: "video/mp4", size: 0, duration: c.duration, media_uid: c.media_uid ?? null }
    : null;

/** A frame that can't be had leaves the black box, not a broken image. */
const hideImage = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = "hidden";
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The folder less what every folder shares: "Cam B", not "Day 1/Cam B". */
function shortFolder(folder: string): string {
  const i = folder.indexOf("/");
  return i >= 0 ? folder.slice(i + 1) : folder;
}

export function HighlightsRoute({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [name, setName] = useState("");
  const [list, setList] = useState<HighlightList | null>(null);
  const [items, setItems] = useState<Highlight[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>({ kind: "", min: 1, pick: "all", folder: "", sort: "score" });
  const [selected, setSelected] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);

  useEffect(() => {
    api
      .get<{ name: string }>(`/api/projects/${id}`)
      .then((p) => setName(p.name))
      .catch((e) => setErr(String(e.message || e)));
    // The folders, for the camera filter: the short list form of the footage.
    api
      .get<{ items: { folder: string }[] }>(`/api/projects/${id}/footage?logs=0&step=0&limit=3000`)
      .then((f) => setFolders([...new Set(f.items.map((i) => i.folder))].sort()))
      .catch(() => {});
  }, [id]);

  const load = useCallback(
    async (keep: boolean) => {
      const r = await api.get<HighlightList>(`/api/projects/${id}/highlights${query(filters, 0, showSkipped ? "&skipped=1" : "")}`);
      setList(r);
      setItems((prev) => {
        if (!keep) return r.highlights;
        // A refresh while picks arrive keeps any later pages already loaded.
        const fresh = new Map(r.highlights.map((h) => [h.id, h]));
        const rest = prev.filter((h) => !fresh.has(h.id)).slice(Math.max(0, prev.length - PAGE));
        return prev.length > PAGE ? [...r.highlights, ...rest] : r.highlights;
      });
      setNextOffset(r.next_offset);
      return r;
    },
    [id, filters, showSkipped],
  );

  useEffect(() => {
    load(false).catch((e) => setErr(String(e.message || e)));
  }, [load]);

  // While clips are still being read, new picks arrive: look again now and then.
  const pending = list?.clips.pending ?? 0;
  useEffect(() => {
    if (!pending || list?.paused) return;
    const t = setInterval(() => load(true).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [pending, list?.paused, load]);

  const more = async () => {
    if (nextOffset === null) return;
    const r = await api.get<HighlightList>(`/api/projects/${id}/highlights${query(filters, nextOffset)}`);
    setItems((prev) => [...prev, ...r.highlights.filter((h) => !prev.some((p) => p.id === h.id))]);
    setNextOffset(r.next_offset);
  };

  const current = items.find((h) => h.id === selected) ?? items[0] ?? null;

  const setPick = useCallback(
    async (h: Highlight, pick: Pick) => {
      setItems((prev) => prev.map((x) => (x.id === h.id ? { ...x, pick } : x)));
      try {
        const updated = await api.send<Highlight>("PATCH", `/api/projects/${id}/highlights/${h.id}`, { pick });
        setItems((prev) => prev.map((x) => (x.id === h.id ? updated : x)));
        setList((l) => {
          if (!l) return l;
          const counts = { ...l.counts };
          const bump = (p: Pick, by: number) => {
            if (p === "keep") counts.kept += by;
            else if (p === "drop") counts.dropped += by;
            else counts.open += by;
          };
          bump(h.pick, -1);
          bump(pick, 1);
          return { ...l, counts };
        });
      } catch (e) {
        setItems((prev) => prev.map((x) => (x.id === h.id ? h : x)));
        setErr(String((e as Error).message || e));
      }
    },
    [id],
  );

  // A person's correction: who says it, as they know it ("Name, Title").
  const setSpeaker = useCallback(
    async (h: Highlight, speaker: string) => {
      if (speaker.trim() === h.speaker) return;
      setItems((prev) => prev.map((x) => (x.id === h.id ? { ...x, speaker: speaker.trim() } : x)));
      try {
        const updated = await api.send<Highlight>("PATCH", `/api/projects/${id}/highlights/${h.id}`, { speaker });
        setItems((prev) => prev.map((x) => (x.id === h.id ? updated : x)));
      } catch (e) {
        setItems((prev) => prev.map((x) => (x.id === h.id ? h : x)));
        setErr(String((e as Error).message || e));
      }
    },
    [id],
  );

  // Review at speed: a call moves on to the next pick.
  const decide = useCallback(
    (pick: Pick) => {
      if (!current) return;
      const i = items.findIndex((h) => h.id === current.id);
      setPick(current, current.pick === pick ? null : pick);
      if (pick && i >= 0 && i + 1 < items.length) setSelected(items[i + 1].id);
    },
    [current, items, setPick],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = current ? items.findIndex((h) => h.id === current.id) : -1;
      if (e.key === "ArrowDown" || e.key === "j") {
        if (i + 1 < items.length) setSelected(items[i + 1].id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        if (i > 0) setSelected(items[i - 1].id);
      } else if (e.key === "y") {
        decide("keep");
      } else if (e.key === "n") {
        decide("drop");
      } else if (e.key === "u" && current) {
        setPick(current, null);
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, items, decide, setPick]);

  if (err && !list) {
    return (
      <div className="flex-1 grid place-items-center">
        <EmptyState icon={<Sparkles className="w-8 h-8" />} title="Highlights could not be opened" body={err} />
      </div>
    );
  }
  if (!list) {
    return (
      <div className="flex-1 grid place-items-center text-faint">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button onClick={() => navigate(`/edits/${id}`)} className={`${btnGhost} -ml-2`}>
            <ArrowLeft className="w-4 h-4" /> Editor
          </button>
          <h1 className="text-heading-2 min-w-0 truncate">Highlights{name && <span className="text-muted font-normal"> · {name}</span>}</h1>
          {list.asked && list.counts.total > 0 && (
            <div className="ml-auto">
              <ExportMenu projectId={id} counts={list.counts} filters={filters} />
            </div>
          )}
        </div>

        {!list.asked ? (
          <AskPanel projectId={id} brief={list.brief} logged={list.clips.logged} onAsked={() => load(false)} />
        ) : (
          <>
            <Progress list={list} projectId={id} onAgain={() => load(false)} />
            <FilterBar filters={filters} setFilters={setFilters} folders={folders} counts={list.counts} />
            {err && <p className="mb-2 text-fine text-danger">{err}</p>}
            {items.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="w-8 h-8" />}
                title={pending ? "Reading the clips" : "No picks here"}
                body={
                  pending
                    ? "Picks appear here as each folder of clips is read. You can leave this page: it carries on without you."
                    : "Nothing matches these filters. Widen them to see more."
                }
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] items-start">
                <div className="order-2 lg:order-1 space-y-1">
                  {items.map((h) => (
                    <PickRow key={h.id} h={h} selected={current?.id === h.id} onSelect={() => setSelected(h.id)} onPick={(p) => setPick(h, h.pick === p ? null : p)} />
                  ))}
                  {nextOffset !== null && (
                    <button onClick={more} className={`${btnSecondary} mt-2`}>
                      Show more
                    </button>
                  )}
                </div>
                <div className="order-1 lg:order-2 lg:sticky lg:top-4">
                  {current && <Viewer h={current} onPick={decide} onSpeaker={(name) => setSpeaker(current, name)} />}
                </div>
              </div>
            )}
            <SkippedClips
              open={showSkipped}
              setOpen={setShowSkipped}
              count={list.clips.skipped}
              clips={list.skipped}
              projectId={id}
              onUsed={() => load(false)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function AskPanel({ projectId, brief, logged, onAsked }: { projectId: string; brief: string; logged: number; onAsked: () => void }) {
  const [text, setText] = useState(brief);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ask = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.send("POST", `/api/projects/${projectId}/highlights`, { brief: text });
      onAsked();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${card} p-4 sm:p-6 max-w-2xl`}>
      <h2 className="text-heading-3 mb-1">Find the highlights</h2>
      <p className="text-body-sm text-muted mb-4">
        Every logged clip is read, with its transcript, against what this video is for. You get the soundbites and the b-roll worth an
        editor's look, each scored with the reason why, and the clips not worth anyone's time are set aside with theirs.{" "}
        {logged > 0 ? `${logged} clips are logged.` : "No clip is logged yet: they are read as soon as they are."}
      </p>
      <label className="block text-fine text-muted mb-1" htmlFor="hl-brief">
        What is the video for?
      </label>
      <textarea
        id="hl-brief"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="e.g. A 60 to 90 second sizzle of our presence at the event: soundbites from interviews and panels, b-roll of the booth, people and stage"
        className="field w-full mb-3"
      />
      {err && <p className="mb-2 text-fine text-danger">{err}</p>}
      <button onClick={ask} disabled={busy} className={btnPrimary}>
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Find highlights
      </button>
    </div>
  );
}

function Progress({ list, projectId, onAgain }: { list: HighlightList; projectId: string; onAgain: () => void }) {
  const { clips, counts } = list;
  const [busy, setBusy] = useState(false);
  const again = async (all: boolean) => {
    setBusy(true);
    try {
      await api.send("POST", `/api/projects/${projectId}/highlights`, all ? { again: true } : {});
      onAgain();
    } finally {
      setBusy(false);
    }
  };
  const read = clips.done + clips.failed;
  return (
    <div className="mb-3 text-fine text-muted">
      <p className="tabular-nums">
        {clips.pending > 0 ? (
          <>
            <Loader2 className="inline w-3.5 h-3.5 mr-1 animate-spin align-[-2px]" />
            Reading clips: {read} of {read + clips.pending}
          </>
        ) : (
          `${plural(clips.done, "clip", "clips")} read`
        )}
        {" · "}
        {plural(counts.total, "pick", "picks")} ({plural(counts.soundbites, "soundbite", "soundbites")}, {counts.broll} b-roll) ·{" "}
        {plural(clips.skipped, "clip", "clips")} set aside
        {counts.kept + counts.dropped > 0 && ` · ${counts.kept} kept, ${counts.dropped} dropped`}
      </p>
      {list.paused && <p className="mt-1 rounded-sm bg-warning-tint px-2 py-1.5 text-foreground">Paused: {list.paused}</p>}
      {list.brief && <p className="mt-1 text-faint line-clamp-2" title={list.brief}>For: {list.brief}</p>}
      <div className="mt-1 -ml-2 flex flex-wrap gap-1">
        {clips.failed > 0 && (
          <button onClick={() => again(false)} disabled={busy} className={btnGhost}>
            <RotateCcw className="w-3.5 h-3.5" /> Retry {clips.failed} failed
          </button>
        )}
        {clips.pending === 0 && clips.not_asked > 0 && (
          <button onClick={() => again(false)} disabled={busy} className={btnGhost}>
            <Sparkles className="w-3.5 h-3.5" /> Read {clips.not_asked} new {clips.not_asked === 1 ? "clip" : "clips"}
          </button>
        )}
        {clips.pending === 0 && (
          <button
            onClick={() => again(true)}
            disabled={busy}
            className={btnGhost}
            title="Read every clip again. What you kept or dropped stays as it is."
          >
            <RotateCcw className="w-3.5 h-3.5" /> Find again
          </button>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm bg-surface-sunken p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-6 px-2 rounded-xs text-fine whitespace-nowrap ${value === o.value ? "bg-surface text-foreground shadow-raised" : "text-muted hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterBar({
  filters,
  setFilters,
  folders,
  counts,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  folders: string[];
  counts: HighlightList["counts"];
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters({ ...filters, [k]: v });
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Segmented
        label="Kind"
        value={filters.kind}
        onChange={(v) => set("kind", v)}
        options={[
          { value: "", label: "All" },
          { value: "soundbite", label: "Soundbites" },
          { value: "broll", label: "B-roll" },
        ]}
      />
      <Segmented
        label="Score"
        value={filters.min}
        onChange={(v) => set("min", v)}
        options={[
          { value: 1, label: "Any score" },
          { value: 3, label: "3+" },
          { value: 4, label: "4+" },
          { value: 5, label: "5" },
        ]}
      />
      <Segmented
        label="Review"
        value={filters.pick}
        onChange={(v) => set("pick", v)}
        options={[
          { value: "all", label: "All" },
          { value: "open", label: `To review (${counts.open})` },
          { value: "keep", label: `Kept (${counts.kept})` },
          { value: "drop", label: `Dropped (${counts.dropped})` },
        ]}
      />
      {folders.length > 1 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SelectTrigger kind="view">{filters.folder ? shortFolder(filters.folder) : "Every folder"}</SelectTrigger>
          </PopoverTrigger>
          <PopoverContent>
            <div className="p-1 max-h-72 overflow-y-auto">
              {["", ...folders].map((f) => (
                <button
                  key={f || "all"}
                  onClick={() => {
                    set("folder", f);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded-sm text-body-sm hover:bg-surface-sunken ${filters.folder === f ? "font-semibold" : ""}`}
                >
                  {f ? shortFolder(f) : "Every folder"}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <Segmented
        label="Order"
        value={filters.sort}
        onChange={(v) => set("sort", v)}
        options={[
          { value: "score", label: "Best first" },
          { value: "clip", label: "By clip" },
        ]}
      />
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-px" aria-label={`Score ${n} of 5`} title={`Score ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`w-3 h-3 ${i <= n ? "fill-current text-foreground" : "text-faint"}`} strokeWidth={1.5} />
      ))}
    </span>
  );
}

function PickButtons({ pick, onPick, size = "row" }: { pick: Pick; onPick: (p: Pick) => void; size?: "row" | "big" }) {
  if (size === "big") {
    return (
      <div className="flex gap-2">
        <button onClick={() => onPick("keep")} className={pick === "keep" ? `${btnPrimary}` : btnSecondary} aria-pressed={pick === "keep"}>
          <Check className="w-4 h-4" /> Keep <Kbd>Y</Kbd>
        </button>
        <button onClick={() => onPick("drop")} className={btnSecondary} aria-pressed={pick === "drop"}>
          <X className="w-4 h-4" /> Drop <Kbd>N</Kbd>
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 shrink-0">
      <button
        onClick={() => onPick("keep")}
        aria-pressed={pick === "keep"}
        aria-label="Keep"
        title="Keep"
        className={`${btnIcon} ${pick === "keep" ? "bg-success-tint text-success hover:bg-success-tint hover:text-success" : ""}`}
      >
        <Check className="w-4 h-4" />
      </button>
      <button
        onClick={() => onPick("drop")}
        aria-pressed={pick === "drop"}
        aria-label="Drop"
        title="Drop"
        className={`${btnIcon} ${pick === "drop" ? "bg-danger-tint text-danger hover:bg-danger-tint hover:text-danger" : ""}`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function PickRow({ h, selected, onSelect, onPick }: { h: Highlight; selected: boolean; onSelect: () => void; onPick: (p: Pick) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const asset = asAsset({ ...h.clip });
  return (
    <div
      ref={ref}
      className={`flex gap-2 p-2 rounded-md ${selected ? "bg-surface shadow-edge" : "hover:bg-surface"} ${h.pick === "drop" ? "opacity-60" : ""}`}
    >
      <button onClick={onSelect} className="flex gap-3 min-w-0 flex-1 text-left" aria-current={selected}>
        <div className="w-28 sm:w-36 shrink-0 aspect-video rounded-sm overflow-hidden bg-black">
          {asset && <img src={frameUrl(asset, (h.start + h.end) / 2)} alt="" loading="lazy" onError={hideImage} className="w-full h-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 text-fine text-muted">
            <Stars n={h.score} />
            <span>{h.kind === "soundbite" ? "Soundbite" : "B-roll"}</span>
            {h.speaker && <span className="truncate">· {h.speaker}</span>}
            {h.pick === "keep" && <span className="text-success">· Kept</span>}
            {h.pick === "drop" && <span className="text-danger">· Dropped</span>}
          </div>
          <p className="text-body-sm text-foreground line-clamp-3">{h.kind === "soundbite" ? `“${h.text}”` : h.text}</p>
          {h.reason && <p className="text-fine text-muted line-clamp-2">{h.reason}</p>}
          <p className="text-fine text-faint tabular-nums truncate" title={`${h.clip.folder}/${h.clip.name}`}>
            {shortFolder(h.clip.folder)} · {h.clip.name} · {clock(h.start)} to {clock(h.end)} ({(h.end - h.start).toFixed(1)} s)
          </p>
        </div>
      </button>
      <PickButtons pick={h.pick} onPick={onPick} />
    </div>
  );
}

/** The selected pick, played from its in to its out. Space plays it again. */
function Viewer({ h, onPick, onSpeaker }: { h: Highlight; onPick: (p: Pick) => void; onSpeaker: (name: string) => void }) {
  const video = useRef<HTMLMediaElement | null>(null);
  const asset = useMemo(() => asAsset({ ...h.clip }), [h.clip]);
  const range = useRef({ start: h.start, end: h.end });
  range.current = { start: h.start, end: h.end };

  const playPick = useCallback(() => {
    const v = video.current;
    if (!v) return;
    v.currentTime = range.current.start;
    v.play().catch(() => {});
  }, []);

  // A new pick in the same clip plays from its own in.
  useEffect(() => {
    const v = video.current;
    if (v && v.readyState > 0) playPick();
  }, [h.id, playPick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== " " || (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
      e.preventDefault();
      const v = video.current;
      if (v && !v.paused) v.pause();
      else playPick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playPick]);

  const playerProps = {
    controls: true,
    playsInline: true,
    className: "w-full h-full",
    onLoadedMetadata: playPick,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => {
      // Stop at the out, so a pick is heard as the editor would cut it.
      const v = e.currentTarget;
      if (!v.paused && v.currentTime >= range.current.end && v.currentTime < range.current.end + 0.6) v.pause();
    },
  };
  return (
    <div className={`${card} p-3`}>
      <div className="aspect-video rounded-sm overflow-hidden bg-black mb-2">
        {asset &&
          (asset.media_uid ? (
            <MediaVideo key={asset.id} asset={asset} startAt={h.start} elementRef={(v) => (video.current = v)} {...playerProps} />
          ) : (
            // A clip kept in the app's own storage plays from there.
            <video key={asset.id} src={`/api/assets/${encodeURIComponent(asset.id)}/source`} ref={(v) => void (video.current = v)} {...playerProps} />
          ))}
      </div>
      <p className="text-body-sm text-foreground mb-1">{h.kind === "soundbite" ? `“${h.text}”` : h.text}</p>
      {h.kind === "soundbite" && <SpeakerField key={h.id} value={h.speaker} onSave={onSpeaker} />}
      {h.reason && <p className="text-fine text-muted mt-1">Why: {h.reason}</p>}
      <p className="text-fine text-faint tabular-nums mt-1 mb-3">
        {h.clip.folder}/{h.clip.name} · {clock(h.start)} to {clock(h.end)}
      </p>
      <PickButtons pick={h.pick} onPick={onPick} size="big" />
      <p className="mt-2 text-fine text-faint">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> move · <Kbd>Space</Kbd> play · <Kbd>U</Kbd> undo
      </p>
    </div>
  );
}

/**
 * Who says a soundbite. Found picks describe people as they appear; whoever
 * knows them types the name and title here, and it goes to the exports.
 */
function SpeakerField({ value, onSave }: { value: string; onSave: (name: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <label className="block">
      <span className="sr-only">Who says it</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onSave(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Who says it: name, title"
        title="Who says it. Type their name and title if you know them."
        className="w-full -mx-1 px-1 py-0.5 rounded-xs bg-transparent text-fine text-muted hover:bg-surface-sunken focus:bg-surface-sunken focus:text-foreground outline-none"
      />
    </label>
  );
}

function SkippedClips({
  open,
  setOpen,
  count,
  clips,
  projectId,
  onUsed,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  count: number;
  clips: SkippedClip[] | undefined;
  projectId: string;
  onUsed: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!count) return null;
  const use = async (c: SkippedClip) => {
    setBusy(c.id);
    try {
      await api.send("POST", `/api/projects/${projectId}/highlights/items`, { clip: c.id, kind: "broll", text: c.reason ? `Used anyway (${c.reason})` : "Used anyway" });
      onUsed();
    } finally {
      setBusy(null);
    }
  };
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group/sk mt-6">
      <summary className="flex items-center gap-1 py-1 text-body-sm text-muted cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:text-foreground">
        <ChevronRight className="w-4 h-4 transition-transform group-open/sk:rotate-90" />
        {count} {count === 1 ? "clip" : "clips"} set aside, and why
      </summary>
      {!clips ? (
        <Loader2 className="w-4 h-4 m-2 animate-spin text-faint" />
      ) : (
        <div className="mt-1 space-y-1">
          {clips.map((c) => {
            const asset = asAsset({ ...c });
            return (
              <div key={c.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-surface">
                <div className="w-20 shrink-0 aspect-video rounded-sm overflow-hidden bg-black">
                  {asset && <img src={frameUrl(asset, Math.min(2, (c.duration ?? 2) / 2))} alt="" loading="lazy" onError={hideImage} className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-foreground truncate">
                    {shortFolder(c.folder)} · {c.name}
                  </p>
                  <p className="text-fine text-muted">{c.reason}</p>
                </div>
                <button onClick={() => use(c)} disabled={busy === c.id} className={btnGhost} title="Add the whole clip to the picks, kept">
                  {busy === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Use anyway
                </button>
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}

function ExportMenu({ projectId, counts, filters }: { projectId: string; counts: HighlightList["counts"]; filters: Filters }) {
  const [which, setWhich] = useState<"keep" | "not_dropped">(counts.kept > 0 ? "keep" : "not_dropped");
  const [scope, setScope] = useState<"all" | "filtered">("all");
  const n = which === "keep" ? counts.kept : counts.kept + counts.open;
  const href = (format: "xml" | "csv") => {
    const p = new URLSearchParams({ format, pick: which });
    if (scope === "filtered") {
      if (filters.kind) p.set("kind", filters.kind);
      if (filters.min > 1) p.set("min_score", String(filters.min));
      if (filters.folder) p.set("folder", filters.folder);
    }
    return `/api/projects/${projectId}/highlights/export?${p}`;
  };
  const filtered = !!(filters.kind || filters.min > 1 || filters.folder);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={btnPrimary}>
          <Download className="w-4 h-4" /> Export
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" width="w-80">
        <div className="p-3 space-y-3">
          <div>
            <p className="text-fine text-muted mb-1">Which picks</p>
            <Segmented
              label="Which picks"
              value={which}
              onChange={setWhich}
              options={[
                { value: "keep", label: `Kept (${counts.kept})` },
                { value: "not_dropped", label: `Kept and to review (${counts.kept + counts.open})` },
              ]}
            />
            {filtered && (
              <div className="mt-2">
                <Segmented
                  label="Filters"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "all", label: "Everything" },
                    { value: "filtered", label: "Only what's filtered" },
                  ]}
                />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <a href={n ? href("xml") : undefined} aria-disabled={!n} className={`${btnSecondary} w-full ${n ? "" : "pointer-events-none opacity-50"}`}>
              <Download className="w-4 h-4" /> Premiere Pro or Resolve (.xml)
            </a>
            <a href={n ? href("csv") : undefined} aria-disabled={!n} className={`${btnSecondary} w-full ${n ? "" : "pointer-events-none opacity-50"}`}>
              <Download className="w-4 h-4" /> Sheet (.csv)
            </a>
          </div>
          <p className="text-fine text-faint">
            The .xml is a timeline of the picks on the camera files. Download the footage folder without renaming anything, import
            the .xml, and point your editor at that folder when it asks where the media is.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
