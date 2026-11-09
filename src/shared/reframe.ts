import type { Crop, Shape } from "./crop";
import { keepEdgeFades, type SplittableClip } from "./split";

export type Layout = "whole" | "speaker" | "split";
export type Shot = { from: number; to: number; layout: Layout; reason: string; review: boolean;
  subjects: { label: string; region: Crop }[]; top?: Crop; bottom?: Crop };
export type SplitFrame = { top: Crop; bottom: Crop };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function sourceTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(value);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
export function validCrop(c: any): c is Crop {
  return !!c && [c.x,c.y,c.width,c.height].every(Number.isFinite) && c.x >= 0 && c.y >= 0 &&
    c.width >= .01 && c.height >= .01 && c.x+c.width <= 1.0001 && c.y+c.height <= 1.0001;
}
/** Enclose the observed subject, add breathing room, then fit inside the source. */
export function focusCrop(region: Crop, shape: Shape, ratio: number): Crop {
  const aspect = ratio * shape.height / shape.width;
  let h = Math.max(region.height * 1.25, region.width * 1.25 / aspect), w = h * aspect;
  const scale = Math.min(1, 1 / w, 1 / h); w *= scale; h *= scale;
  return { x: clamp(region.x + region.width / 2 - w / 2, 0, 1-w),
    y: clamp(region.y + region.height / 2 - h / 2, 0, 1-h), width: w, height: h };
}
const fallback = (from: number, to: number, reason: string): Shot => ({ from, to, layout: "whole", reason, review: true, subjects: [] });
/** Model advice is untrusted. Bad clocks, gaps and uncertain regions keep the whole picture. */
export function normalizeShots(value: unknown, start: number, end: number, shape: Shape): Shot[] {
  const raw = (value as any)?.shots;
  if (!Array.isArray(raw) || raw.length > 40) return [fallback(start,end,"Framing needs manual review.")];
  const out: Shot[] = []; let at = start;
  const sorted = raw.map(s=>({s,from:sourceTime(s?.from),to:sourceTime(s?.to)}))
    .filter(v=>v.from !== null && v.to !== null && v.to > v.from && v.from >= start-.1 && v.to <= end+.1)
    .sort((a,b)=>a.from!-b.from!);
  for (const {s,from,to} of sorted) {
    const lo = Math.max(at,from!), hi = Math.min(end,to!);
    if (hi-lo < .1) continue;
    if (lo-at > .1) out.push(fallback(at,lo,"No reliable framing for this section."));
    const subjects: Shot["subjects"] = Array.isArray(s.subjects) ? s.subjects.filter((p:any)=>validCrop(p?.region) && typeof p.label === "string")
      .slice(0,3).map((p:any)=>({label:p.label.slice(0,100),region:p.region as Crop})) : [];
    let layout: Layout = s.confidence === "high" && ["speaker","split","whole"].includes(s.layout) ? s.layout : "whole";
    if ((layout === "speaker" && subjects.length < 1) || (layout === "split" && subjects.length < 2)) layout = "whole";
    const contains = (c:Crop,r:Crop) => c.x <= r.x+.001 && c.y <= r.y+.001 && c.x+c.width >= r.x+r.width-.001 && c.y+c.height >= r.y+r.height-.001;
    if(layout !== "whole" && subjects.slice(0,layout === "split"?2:1).some(p=>!contains(focusCrop(p.region,shape,layout === "split"?9/8:9/16),p.region))) layout="whole";
    const review = layout === "whole" || s.confidence !== "high";
    out.push({from:out.length ? out[out.length-1].to : start,to:hi,layout,subjects,review,
      reason:typeof s.reason === "string" ? s.reason.slice(0,400) : "Review the framing.",
      ...(subjects[0] ? {top:focusCrop(subjects[0].region,shape,layout === "split" ? 9/8 : 9/16)} : {}),
      ...(subjects[1] ? {bottom:focusCrop(subjects[1].region,shape,9/8)} : {})});
    at = hi;
  }
  if (end-at > .001) out.push(fallback(at,end,"No reliable framing for this section."));
  return out.length ? out : [fallback(start,end,"Framing needs manual review.")];
}
/** Advice uses source time; edits use whole output frames. Never change the clip's length. */
export function framedPieces<T extends SplittableClip & { crop?: Crop; split?: SplitFrame; fit?: "cover" | "contain"; anchor?: {x:number;y:number} }>(
  clip: T, duration: number, fps: number, shots: Shot[], id: () => string,
): T[] {
  const start = clip.trimStart ?? 0, frames = Math.max(1,Math.round(duration*fps));
  const minimum = Math.ceil(.05 * fps);
  const cuts = [0];
  for (const n of [...new Set(shots.flatMap(s=>[s.from,s.to]).map(t=>clamp(Math.round((t-start)*fps),0,frames)))].sort((a,b)=>a-b)) {
    if (n-cuts[cuts.length-1] >= minimum && frames-n >= minimum) cuts.push(n);
  }
  cuts.push(frames);
  const pieces: T[] = [];
  for (let i=0;i<cuts.length-1;i++) {
    const a=cuts[i], b=cuts[i+1];
    const middle=start+(a+b)/2/fps;
    const shot=shots.find(s=>middle>=s.from && middle<s.to);
    const piece:T = {...clip,id:pieces.length ? id() : clip.id,trimStart:start+a/fps,duration:Math.max(.05,(b-a)/fps),fit:"contain"};
    delete piece.trimEnd; delete piece.crop; delete piece.anchor; delete piece.split;
    if(shot?.layout === "speaker" && validCrop(shot.top)){piece.crop=shot.top;piece.fit="cover";}
    if(shot?.layout === "split" && validCrop(shot.top) && validCrop(shot.bottom)) piece.split={top:shot.top,bottom:shot.bottom};
    pieces.push(piece);
  }
  keepEdgeFades(pieces); return pieces;
}
