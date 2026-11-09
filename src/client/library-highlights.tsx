import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Film, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, frameUrl, MediaVideo, type Asset } from "./edit";
import { btnGhost, btnPrimary, btnSecondary, btnIcon, card } from "./ui";

export interface LibraryHighlight {
  id: string; asset_id: string; kind: "soundbite" | "broll";
  src_in: number; src_out: number; text: string; speaker: string;
  name: string; key: string; content_type: string; size: number;
  duration: number; media_uid: string | null; project_name: string | null;
}
export const highlightAsset = (h: LibraryHighlight): Asset => ({ ...h, id: h.asset_id });
const time = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The same bounded source picker is used alone and inside every editor. */
export function SharedHighlights({ onAdd, navigate }: {
  onAdd?: (h: LibraryHighlight) => void;
  navigate?: (to: string) => void;
}) {
  const [items, setItems] = useState<LibraryHighlight[]>([]);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string }[]>([]);
  const request = useRef<{ selection: string; id: string } | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async (from = 0) => {
    const seq = ++sequence.current;
    setLoading(true); setError("");
    try {
      const data = await api.get<{ items: LibraryHighlight[]; next_offset: number | null }>(`/api/highlights?search=${encodeURIComponent(search)}&offset=${from}`);
      if (seq !== sequence.current) return;
      setItems(prev => from ? [...prev, ...data.items] : data.items);
      setOffset(data.next_offset);
    } catch (e) { if (seq === sequence.current) setError((e as Error).message); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [search]);
  useEffect(() => {
    ++sequence.current; setSelected(new Set()); setPlaying(null);
    const timer = setTimeout(() => void load(), 200);
    return () => { clearTimeout(timer); ++sequence.current; };
  }, [load]);
  const create = async () => {
    setCreating(true); setError("");
    const ids = [...selected].sort(); const selection = JSON.stringify(ids);
    if (request.current?.selection !== selection) request.current = { selection, id: crypto.randomUUID() };
    try {
      const result = await api.send<{ projects: { id: string; name: string }[] }>("POST", "/api/highlights/projects", { ids, request_id: request.current.id });
      setCreated(result.projects); setSelected(new Set()); request.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };
  const remove = async (h: LibraryHighlight) => {
    if (!window.confirm("Remove this shared highlight for everyone? Existing edits keep their clips.")) return;
    try {
      await api.send("DELETE", `/api/highlights/${h.id}`);
      setItems(prev => prev.filter(p => p.id !== h.id));
      setSelected(prev => { const next = new Set(prev); next.delete(h.id); return next; });
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="min-w-0">
    <label className="block text-fine text-muted mb-1" htmlFor={onAdd ? "source-highlights-search" : "shared-highlights-search"}>Search highlights</label>
    <input id={onAdd ? "source-highlights-search" : "shared-highlights-search"} className="field w-full mb-3" value={search} onChange={e => setSearch(e.target.value)} placeholder="Words, speaker or video" />
    {!onAdd && <div className="flex flex-wrap items-center gap-3 mb-4">
      <button disabled={!selected.size || creating} onClick={() => void create()} className={btnPrimary}>
        {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />} Create portrait clips{selected.size ? ` (${selected.size})` : ""}
      </button>
      <span className="text-fine text-muted">Choose up to 12. Each opens as a separate editable 9:16 project.</span>
    </div>}
    {error && <p role="alert" className="text-body-sm text-danger mb-3">{error} <button className={btnGhost} onClick={() => void load()}>Retry</button></p>}
    {created.length > 0 && <div className="mb-4 space-y-2" role="status">
      <p className="text-body-sm">{created.length} portrait {created.length === 1 ? "clip" : "clips"} created.</p>
      {created.map(p => <button key={p.id} className={btnSecondary} onClick={() => navigate?.(`/edits/${p.id}`)}>{p.name}</button>)}
    </div>}
    {!loading && !error && !items.length && <p className="text-body-sm text-muted py-6">{search ? "No matching highlights." : "Highlights found in your projects appear here, ready to reuse in any edit."}</p>}
    <div className={onAdd ? "space-y-3" : "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4"}>
      {items.map(h => <article key={h.id} className={`${card} min-w-0 overflow-hidden`}>
        <div className="aspect-video bg-surface-sunken relative">
          {playing === h.id ? <MediaVideo key={h.id} asset={highlightAsset(h)} elementRef={() => {}} startAt={h.src_in} controls autoPlay playsInline className="w-full h-full object-contain"
            onPlay={e => { const v = e.currentTarget; if (v.currentTime < h.src_in || v.currentTime >= h.src_out) v.currentTime = h.src_in; }}
            onTimeUpdate={e => { const v = e.currentTarget; if (v.currentTime >= h.src_out) { v.pause(); v.currentTime = h.src_in; } }} />
          : <button className="w-full h-full relative" onClick={() => setPlaying(h.id)} aria-label={`Preview ${h.text || h.name}`}>
            <img src={frameUrl(highlightAsset(h), h.src_in)} alt="" loading="lazy" className="w-full h-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center"><span className="rounded-full bg-surface p-2 shadow-raised"><Play className="w-5 h-5" /></span></span>
          </button>}
        </div>
        <div className="p-3 space-y-2">
          <p className="text-body-sm line-clamp-3">{h.text || h.name}</p>
          <p className="text-fine text-muted truncate">{h.speaker || h.name}</p>
          <p className="text-fine text-muted tabular-nums">{time(h.src_in)}–{time(h.src_out)} · {h.kind === "soundbite" ? "Soundbite" : "B-roll"}</p>
          {onAdd ? <button className={`${btnSecondary} w-full`} onClick={() => onAdd(h)}><Plus className="w-4 h-4" /> Add to timeline</button>
          : <div className="flex items-center justify-between gap-2">
            <label className="text-body-sm flex items-center gap-2"><input type="checkbox" checked={selected.has(h.id)} disabled={creating || (!selected.has(h.id) && selected.size >= 12)} onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(h.id) : next.delete(h.id); return next; })} /> Select clip</label>
            <button className={btnIcon} onClick={() => void remove(h)} aria-label={`Remove highlight ${h.text || h.name}`}><Trash2 className="w-4 h-4" /></button>
          </div>}
        </div>
      </article>)}
    </div>
    {loading && <p role="status" className="text-body-sm text-muted py-3 flex gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading highlights…</p>}
    {!loading && offset !== null && <button className={`${btnSecondary} mt-4`} onClick={() => void load(offset)}>Load more</button>}
  </div>;
}

export function SharedHighlightsRoute({ navigate }: { navigate: (to: string) => void }) {
  return <main className="flex-1 overflow-y-auto p-4 sm:p-6">
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-3"><button className={btnGhost} onClick={() => navigate("/")}><ArrowLeft className="w-4 h-4" /> Projects</button><h1 className="text-heading-2">Highlights</h1></div>
      <p className="text-body-sm text-muted mb-5">Shared moments from your videos. Reuse them in any project or create portrait clips.</p>
      <SharedHighlights navigate={navigate} />
    </div>
  </main>;
}
