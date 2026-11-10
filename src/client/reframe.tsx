import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { api, frameUrl, type Asset, type Edl } from "./edit";
import { Dialog, btnPrimary, btnSecondary } from "./ui";
import { analysisWindows, framedPieces, focusCrop, type Shot, type Layout } from "../shared/reframe";
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
/** One stretch of the clip, analysed on its own (analysisWindows). */
type Part = {from:number;to:number;id?:string;status:string;error?:string;shots?:Shot[]};
const BUSY=["starting","running","preparing"];
const whole:Crop={x:0,y:0,width:1,height:1};
const time=(t:number)=>`${Math.floor(t/60)}:${(t%60).toFixed(1).padStart(4,"0")}`;
export function ReframeDialog({edl:doc,assets,selected,onApply,onClose}:{edl:Edl;assets:Asset[];selected:number;onApply:(next:Edl,shown:string|null)=>void;onClose:()=>void}) {
  // The cut as its 9:16 version sees it: that is what is read and reframed here.
  const tall=target(doc);
  const edl=tall?formatView(tall.doc,tall.id):doc;
  const [index,setIndex]=useState(selected), [shots,setShots]=useState<Shot[]>([]), [active,setActive]=useState(0);
  const [shape,setShape]=useState<Shape>({width:1920,height:1080}), [error,setError]=useState("");
  const [frame,setFrame]=useState(0);
  const generation=useRef(0);
  const [poll,setPoll]=useState(0);
  const element=edl.main.elements[index], clip=element?.type === "video" ? element : undefined, asset=assets.find(a=>clip?.src===`asset:${a.id}`);
  const start=clip?.trimStart ?? 0, duration=clip?.duration ?? Math.max(0,(asset?.duration ?? 0)-start-(clip?.trimEnd ?? 0));
  // A long clip is read in parts of up to five minutes; the shots are joined once every part is done.
  const [parts,setParts]=useState<Part[]>([]);
  const busy=parts.some(p=>BUSY.includes(p.status));
  const failed=parts.filter(p=>p.status==="failed"||p.status==="error");
  const done=parts.filter(p=>p.status==="done").length;
  useEffect(()=>{
    ++generation.current;setActive(0);setFrame(start);
    setParts(duration>0?analysisWindows(start,start+duration).map(w=>({...w,status:"idle"})):[]);
    setShots(clip?.type === "video" ? [{from:start,to:start+duration,layout:clip.split?"split":clip.crop?"speaker":"whole",review:false,reason:"Current framing",subjects:[],top:clip.split?.top ?? clip.crop ?? whole,bottom:clip.split?.bottom ?? whole}] : []);
    return ()=>{++generation.current;};
  },[index]);
  const settle=(i:number,r:Result)=>{
    if(r.shape)setShape(r.shape);
    setParts(ps=>ps.map((p,k)=>k===i?{...p,id:r.id ?? p.id,status:r.status,error:r.error ?? undefined,shots:r.shots ?? p.shots}:p));
  };
  const fail=(i:number,message:string)=>setParts(ps=>ps.map((p,k)=>k===i?{...p,status:"error",error:message}:p));
  const ask=(p:Part,retry:boolean)=>api.send<Result>("POST","/api/reframe",{asset_id:asset?.id,start:p.from,end:p.to,retry});
  const analyze=async()=>{
    const seq=++generation.current;
    await Promise.all(parts.map(async(p,i)=>{
      if(p.status==="done"||BUSY.includes(p.status))return;
      // Checking on an analysis that could not be read starts nothing new.
      if(p.status==="error"&&p.id){setParts(ps=>ps.map((q,k)=>k===i?{...q,status:"running",error:undefined}:q));return;}
      setParts(ps=>ps.map((q,k)=>k===i?{...q,status:"starting",error:undefined}:q));
      try{const r=await ask(p,p.status==="failed");if(seq===generation.current)settle(i,r);}
      catch(e){if(seq===generation.current)fail(i,(e as Error).message);}
    }));
    setPoll(v=>v+1);
  };
  useEffect(()=>{
    if(!busy)return;
    const seq=generation.current;
    const timer=setTimeout(async()=>{
      await Promise.all(parts.map(async(p,i)=>{
        if(!BUSY.includes(p.status)||p.status==="starting"&&!p.id)return;
        try{const r=p.id ? await api.get<Result>(`/api/reframe/${p.id}`) : await ask(p,false);if(seq===generation.current)settle(i,r);}
        catch(e){if(seq===generation.current)fail(i,(e as Error).message);}
      }));
      setPoll(v=>v+1);
    },4000);
    return()=>clearTimeout(timer);
  },[busy,poll]);
  // Every part read: its shots, in order, become the clip's.
  useEffect(()=>{
    if(!parts.length||parts.some(p=>p.status!=="done"))return;
    setShots(parts.flatMap(p=>p.shots ?? []).filter(s=>s.to>start && s.from<start+duration).sort((a,b)=>a.from-b.from));
    setActive(0);setFrame(start);
  },[parts]);
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
      <div className="flex flex-wrap gap-3 items-center"><button className={btnSecondary} disabled={busy||!asset?.media_uid||duration<=0} onClick={()=>void analyze()}>
        {busy?<Loader2 className="w-4 h-4 animate-spin"/>:<Sparkles className="w-4 h-4"/>}{failed.length?"Retry analysis":"Analyze framing"}</button>
        <span className="text-fine text-muted" role="status">{parts.some(p=>p.status==="preparing")?"Preparing video…":busy?`Reading camera shots…${parts.length>1?` ${done} of ${parts.length} parts done.`:""} You can close this and return later.`:parts.length>1?`This clip is read in ${parts.length} parts of up to five minutes. Parts already read are reused; new ones use your workspace’s AI credits.`:"Existing analysis is reused. New analysis uses your workspace’s AI credits."}</span>
      </div>
      {failed.length>0&&!busy&&<p role="alert" className="text-body-sm text-danger">{parts.length>1?`${failed.length} of ${parts.length} parts could not be read. `:""}{failed[0].error}</p>}
      {error&&<p role="alert" className="text-body-sm text-danger">{error}</p>}
      {shot&&asset&&<div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <div className="space-y-3 min-w-0">
          <label className="block text-body-sm">Shot<select className="field w-full mt-1" value={active} onChange={e=>{const i=Number(e.target.value);setActive(i);setFrame(Math.max(start,shots[i].from));}}>{shots.map((s,i)=><option key={i} value={i}>{time(s.from)}–{time(s.to)}{s.review?" · Review":""}</option>)}</select></label>
          <p className="text-body-sm text-muted">{shot.reason}</p>
          <label className="block text-body-sm">Layout<select className="field w-full mt-1" value={shot.layout} onChange={e=>layout(e.target.value as Layout)}><option value="whole">Whole shot</option><option value="speaker">Focus</option><option value="split">Two stacked views</option></select></label>
          {shot.layout==="split"&&<p className="text-fine text-muted">After applying, select the clip and choose Adjust views to move either view, or Swap to change which is on top.</p>}
        </div>
        <div className="space-y-2 min-w-0">
          <div className="relative aspect-[9/16] max-h-[380px] mx-auto overflow-hidden bg-black rounded-md" style={{width:"min(100%, 214px)"}}>
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
