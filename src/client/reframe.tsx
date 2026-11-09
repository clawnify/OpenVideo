import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { api, frameUrl, type Asset, type Edl } from "./edit";
import { Dialog, btnPrimary, btnSecondary } from "./ui";
import { framedPieces, focusCrop, type Shot, type Layout } from "../shared/reframe";
import { placeClip, sideBySide, type Crop, type Shape } from "../shared/crop";
import { sameShape } from "../shared/format";
import { addFormat, findFormat, formatView, liftView } from "../shared/formats";

/** Social video's shape: the format AI reframe frames. */
const TALL = "9:16";
const TALL_FRAME = { width: 1080, height: 1920 };

/** Where the reframe lands: the project's 9:16 format, added if missing, or the main one when it is 9:16 already. */
function target(edl: Edl): { doc: Edl; id: string | null } | null {
  if (sameShape(edl.output, TALL_FRAME)) return { doc: edl, id: null };
  const doc = addFormat(edl, TALL);
  return findFormat(doc, TALL) ? { doc, id: TALL } : null;
}

type Result = {id?:string;status:string;shots?:Shot[];error?:string;shape?:Shape};
const whole:Crop={x:0,y:0,width:1,height:1};
const time=(t:number)=>`${Math.floor(t/60)}:${(t%60).toFixed(1).padStart(4,"0")}`;
export function ReframeDialog({edl:doc,assets,selected,onApply,onClose}:{edl:Edl;assets:Asset[];selected:number;onApply:(next:Edl,shown:string|null)=>void;onClose:()=>void}) {
  // The cut as its 9:16 version sees it: that is what is read and reframed here.
  const tall=target(doc);
  const edl=tall?formatView(tall.doc,tall.id):doc;
  const [index,setIndex]=useState(selected), [shots,setShots]=useState<Shot[]>([]), [active,setActive]=useState(0);
  const [shape,setShape]=useState<Shape>({width:1920,height:1080}), [status,setStatus]=useState("idle"), [error,setError]=useState("");
  const [frame,setFrame]=useState(0), [job,setJob]=useState<string|null>(null);
  const generation=useRef(0);
  const [poll,setPoll]=useState(0);
  const element=edl.main.elements[index], clip=element?.type === "video" ? element : undefined, asset=assets.find(a=>clip?.src===`asset:${a.id}`);
  const start=clip?.trimStart ?? 0, duration=clip?.duration ?? Math.max(0,(asset?.duration ?? 0)-start-(clip?.trimEnd ?? 0));
  const busy=["starting","running","preparing"].includes(status);
  useEffect(()=>{
    ++generation.current;setJob(null);setStatus("idle");setError("");setActive(0);setFrame(start);
    setShots(clip?.type === "video" ? [{from:start,to:start+duration,layout:clip.split?"split":clip.crop?"speaker":"whole",review:false,reason:"Current framing",subjects:[],top:clip.split?.top ?? clip.crop ?? whole,bottom:clip.split?.bottom ?? whole}] : []);
    return ()=>{++generation.current;};
  },[index]);
  const accept=(r:Result)=>{
    setPoll(v=>v+1);setStatus(r.status);setJob(r.id ?? null);setError(r.error ?? "");if(r.shape)setShape(r.shape);
    if(r.shots){setShots(r.shots.filter(s=>s.to>start && s.from<start+duration));setActive(0);setFrame(start);}
  };
  const analyze=async(retry=false)=>{
    const seq=++generation.current;setError("");setStatus("starting");
    try{const r=await api.send<Result>("POST","/api/reframe",{asset_id:asset?.id,start,end:start+duration,retry});if(seq===generation.current)accept(r);}
    catch(e){if(seq===generation.current){setStatus("error");setError((e as Error).message);}}
  };
  useEffect(()=>{
    if(!busy)return;
    const seq=generation.current;
    const timer=setTimeout(async()=>{
      try{
        const r=job ? await api.get<Result>(`/api/reframe/${job}`) : await api.send<Result>("POST","/api/reframe",{asset_id:asset?.id,start,end:start+duration});
        if(seq===generation.current)accept(r);
      }catch(e){if(seq===generation.current){setStatus("error");setError((e as Error).message);}}
    },4000);
    return()=>clearTimeout(timer);
  },[status,job,poll,busy]);
  const shot=shots[active];
  const change=(patch:Partial<Shot>)=>setShots(v=>v.map((s,i)=>i===active?{...s,...patch,review:false}:s));
  // Without detected people, two stacked views start from the shot's left and right halves.
  const halves=sideBySide(shape,TALL_FRAME);
  const layout=(layout:Layout)=>change({layout,top:shot.subjects[0]?focusCrop(shot.subjects[0].region,shape,layout==="split"?9/8:9/16):layout==="split"?halves.top:shot.top??whole,bottom:shot.subjects[1]?focusCrop(shot.subjects[1].region,shape,9/8):layout==="split"?halves.bottom:shot.bottom??whole});
  const apply=()=>{
    if(clip?.type!=="video")return;
    if(!tall){setError("This project has four formats already. Remove one to add a 9:16 version.");return;}
    const view=formatView(tall.doc,tall.id);
    const pieces=framedPieces(clip,duration,view.output.fps,shots,()=>crypto.randomUUID());
    if(view.main.elements.length-1+pieces.length+(view.overlays??[]).reduce((n,t)=>n+t.elements.length,0)>100){setError("This edit has too many elements. Reframe fewer shots at a time.");return;}
    // Only the 9:16 framing changes: the other formats keep theirs, and the cut keeps its timing.
    view.main.elements.splice(index,1,...pieces);onApply(liftView(tall.doc,view,tall.id),tall.id);onClose();
  };
  return <Dialog title="AI reframe" icon={<Sparkles className="w-5 h-5" />} size="lg" onClose={onClose}
    description="Suggest framing for each camera shot in the 9:16 version, then adjust it. The other formats keep their framing. Framing holds still within each shot."
    footer={<><button className={btnSecondary} onClick={onClose}>Close</button><button className={btnPrimary} disabled={busy||!shot||!asset} onClick={apply}>Apply to 9:16</button></>}>
    <div className="space-y-4">
      <label className="block text-body-sm">Video clip<select className="field w-full mt-1" disabled={busy} value={index} onChange={e=>setIndex(Number(e.target.value))}>
        {edl.main.elements.map((el,i)=>el.type==="video"?<option key={el.id} value={i}>{i+1}. {assets.find(a=>el.src===`asset:${a.id}`)?.name??"Video"} · {time(el.trimStart??0)}</option>:null)}
      </select></label>
      <div className="flex flex-wrap gap-3 items-center"><button className={btnSecondary} disabled={busy||!asset?.media_uid||duration<=0} onClick={()=>void analyze(status==="failed")}>
        {busy?<Loader2 className="w-4 h-4 animate-spin"/>:<Sparkles className="w-4 h-4"/>}{status==="failed"?"Retry analysis":"Analyze framing"}</button>
        <span className="text-fine text-muted" role="status">{status==="preparing"?"Preparing video…":busy?"Reading camera shots… You can close this and return later.":"Existing analysis is reused. New analysis uses your workspace’s AI credits."}</span>
      </div>
      {error&&<p role="alert" className="text-body-sm text-danger">{error} {job&&status==="error"&&<button className={btnSecondary} onClick={()=>{setError("");setStatus("running");}}>Check again</button>}</p>}
      {shot&&asset&&<div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <div className="space-y-3 min-w-0">
          <label className="block text-body-sm">Shot<select className="field w-full mt-1" value={active} onChange={e=>{const i=Number(e.target.value);setActive(i);setFrame(Math.max(start,shots[i].from));}}>{shots.map((s,i)=><option key={i} value={i}>{time(s.from)}–{time(s.to)}{s.review?" · Review":""}</option>)}</select></label>
          <p className="text-body-sm text-muted">{shot.reason}</p>
          <label className="block text-body-sm">Layout<select className="field w-full mt-1" value={shot.layout} onChange={e=>layout(e.target.value as Layout)}><option value="whole">Whole shot</option><option value="speaker">Focus</option><option value="split">Two stacked views</option></select></label>
          {shot.layout==="split"&&<p className="text-fine text-muted">After applying, select the clip and choose Adjust views to move either view, or Swap to change which is on top.</p>}
        </div>
        <div className="space-y-2 min-w-0">
          <div className="relative aspect-[9/16] max-h-[380px] mx-auto overflow-hidden bg-inverse rounded-md" style={{width:"min(100%, 214px)"}}>
            {(shot.layout==="split"?[shot.top??whole,shot.bottom??whole]:[shot.layout==="speaker"?shot.top??whole:undefined]).map((crop,i)=>{
              const height=shot.layout==="split"?960:1920;
              const place=placeClip(shape,crop,{width:1080,height},shot.layout==="whole"?"contain":"cover");
              return <div key={i} className="absolute w-full overflow-hidden" style={{top:`${i*50}%`,height:shot.layout==="split"?"50%":"100%"}}>
                <div className="absolute overflow-hidden" style={{left:`${place.box.left*100}%`,top:`${place.box.top*100}%`,width:`${place.box.width*100}%`,height:`${place.box.height*100}%`}}>
                  <img alt="Framing preview" src={frameUrl(asset,frame)} onLoad={e=>{const m=e.currentTarget;if(m.naturalWidth&&m.naturalHeight)setShape({width:m.naturalWidth,height:m.naturalHeight});}} className="absolute max-w-none" style={{left:`${place.source.left*100}%`,top:`${place.source.top*100}%`,width:`${place.source.width*100}%`,height:`${place.source.height*100}%`}}/>
                </div>
              </div>;
            })}
          </div>
          <label className="block text-fine text-muted">Preview frame · {time(frame)}<input aria-label="Preview frame" className="w-full" type="range" min={Math.max(start,shot.from)} max={Math.min(start+duration,shot.to)-.05} step="0.1" value={frame} onChange={e=>setFrame(Number(e.target.value))}/></label>
        </div>
      </div>}
    </div>
  </Dialog>;
}
