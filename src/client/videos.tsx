// The videos of one project: every edit made from its footage (the cut you
// started with, cut-downs, a teaser), each with its own timeline, formats,
// export and share link. Opened from the project bar; picking one opens it in
// the editor. Footage, highlights and the conversation belong to the project.

import { useCallback, useEffect, useState } from "react";
import { Copy, Film, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "./edit";
import { Popover, PopoverContent, PopoverTrigger, SelectTrigger, btnGhost, btnIcon } from "./ui";
import { ratioLabel } from "../shared/format";

export interface ProjectVideo {
  id: string;
  name: string;
  /** The project's first video, which holds its footage: deleted only with the project. */
  first: boolean;
  /** Each format's size, "1080x1920". */
  shapes: string[];
  seconds: number;
  updated_at: string;
}

const length = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)}s`);
const shapes = (v: ProjectVideo) =>
  v.shapes
    .map((s) => {
      const [w, h] = s.split("x").map(Number);
      return ratioLabel(w, h);
    })
    .join(" · ");

export function useProjectVideos(videoId: string) {
  const [videos, setVideos] = useState<ProjectVideo[] | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ videos: ProjectVideo[] }>(`/api/projects/${videoId}/videos`);
      setVideos(r.videos);
    } catch {
      setVideos((v) => v ?? []);
    }
  }, [videoId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { videos, reload: load };
}

export function VideoSwitcher({
  videoId,
  videos,
  reload,
  onOpen,
}: {
  videoId: string;
  videos: ProjectVideo[] | null;
  reload: () => Promise<void>;
  onOpen?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);
  const make = async (from?: string) => {
    setBusy(from ? "copy" : "new");
    setErr("");
    try {
      const n = (videos?.length ?? 1) + 1;
      const current = videos?.find((v) => v.id === from);
      const made = await api.send<{ id: string }>("POST", `/api/projects/${videoId}/videos`, {
        name: current ? `${current.name} (copy)` : `Video ${n}`,
        ...(from ? { from } : {}),
      });
      setOpen(false);
      onOpen?.(made.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (v: ProjectVideo) => {
    if (!window.confirm(`Delete the video "${v.name}"? Its exports and share link go with it. The footage stays in the project.`)) return;
    setBusy(v.id);
    setErr("");
    try {
      await api.send("DELETE", `/api/projects/${v.id}`);
      await reload();
      if (v.id === videoId) onOpen?.(videos!.find((x) => x.first)!.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const count = videos?.length ?? 1;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SelectTrigger kind="view" aria-label="Videos in this project" title="The videos made from this project's footage">
          <Film className="w-4 h-4 text-muted" />
          <span className="hidden sm:inline">Videos</span>
          <span className="tabular-nums text-muted">{count}</span>
        </SelectTrigger>
      </PopoverTrigger>
      <PopoverContent width="w-80">
        <div className="p-1.5 max-h-96 overflow-y-auto">
          {videos === null && (
            <div className="flex items-center gap-2 p-2 text-fine text-muted">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {videos?.map((v) => (
            <div key={v.id} className={`group flex items-center gap-2 rounded-sm px-2 py-1.5 ${v.id === videoId ? "bg-surface-sunken" : "hover:bg-surface-sunken"}`}>
              <button
                className="flex-1 min-w-0 text-left"
                onClick={() => {
                  setOpen(false);
                  if (v.id !== videoId) onOpen?.(v.id);
                }}
                aria-current={v.id === videoId ? "page" : undefined}
              >
                <span className="block truncate text-body-sm">{v.name}</span>
                <span className="block text-fine text-muted tabular-nums">
                  {shapes(v)} · {length(v.seconds)}
                  {v.first ? " · first video" : ""}
                </span>
              </button>
              {!v.first && (
                <button
                  className={`${btnIcon} opacity-0 group-hover:opacity-100 focus:opacity-100`}
                  onClick={() => void remove(v)}
                  disabled={busy !== null}
                  aria-label={`Delete ${v.name}`}
                >
                  {busy === v.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border p-1.5 flex flex-col">
          <button className={`${btnGhost} justify-start`} onClick={() => void make()} disabled={busy !== null}>
            {busy === "new" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New video (9:16)
          </button>
          <button className={`${btnGhost} justify-start`} onClick={() => void make(videoId)} disabled={busy !== null}>
            {busy === "copy" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />} Copy this video
          </button>
          {err && <p className="px-2 pt-1 text-fine text-danger break-words">{err}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
