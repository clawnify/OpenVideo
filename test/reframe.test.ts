import { describe, expect, it } from "vitest";
import { normalizeShots, framedPieces, sourceTime, focusCrop, validCrop } from "../src/shared/reframe";
import { splitClip } from "../src/shared/split";
const shape={width:1920,height:1080};
const region={x:.3,y:.2,width:.1,height:.5};
const raw=(from:string,to:string,layout="speaker",confidence="high")=>({from,to,layout,confidence,reason:"Speaker visible",subjects:[{label:"speaker",region},{label:"host",region:{...region,x:.6}}]});
describe("source-time framing",()=>{
  it.each([24,30,60])("never removes a minimum-duration clip at %s fps",fps=>{
    const p=framedPieces({id:"tiny",duration:.05},.05,fps,[],()=>"new");
    expect(p).toHaveLength(1);expect(p[0].duration).toBeGreaterThanOrEqual(.05);
  });
  it("does not make illegal two-frame fragments at 60 fps",()=>{
    const shots=normalizeShots({shots:[raw("0:00:00","0:00:00.110"),raw("0:00:00.110","0:00:01")]},0,1,shape);
    const p=framedPieces({id:"c",duration:1},1,60,shots,()=>crypto.randomUUID());
    expect(p.every(c=>c.duration!>=.05)).toBe(true);expect(p.reduce((n,c)=>n+Math.round(c.duration!*60),0)).toBe(60);
  });
  it("requires whole-source clocks and preserves a missing interval",()=>{
    expect(sourceTime("1:60:00")).toBeNull();
    const shots=normalizeShots({shots:[raw("0:00:00","0:00:10"),raw("0:02:10","0:02:20")]},120,140,shape);
    expect(shots.map(s=>[s.from,s.to,s.layout])).toEqual([[120,130,"whole"],[130,140,"speaker"]]);
    expect(shots[0].review).toBe(true);
  });
  it("reads clocks written short and answers counted from the start of the stretch",()=>{
    expect([sourceTime("8:30.5"),sourceTime("510"),sourceTime("0:08:30.000")]).toEqual([510.5,510,510]);
    // Asked for 8:30-8:44 of the talk, answered 0:00-0:14: the same shots, moved onto the talk's clock.
    const shots=normalizeShots({shots:[raw("0:00:00","0:00:06"),raw("0:00:06","0:00:14")]},510,524,shape);
    expect(shots.map(s=>[s.from,s.to,s.layout])).toEqual([[510,516,"speaker"],[516,524,"speaker"]]);
    // Times on the whole video's clock are used as given.
    expect(normalizeShots({shots:[raw("0:08:30","0:08:44")]},510,524,shape).map(s=>[s.from,s.to])).toEqual([[510,524]]);
  });
  it("keeps the whole shot for low confidence or invalid boxes",()=>{
    expect(normalizeShots({shots:[raw("0:00:00","0:00:10","speaker","low")]},0,10,shape)[0].layout).toBe("whole");
    const r=raw("0:00:00","0:00:10");r.subjects=[{label:"bad",region:{...region,x:.95}}];
    expect(normalizeShots({shots:[r]},0,10,shape)[0].layout).toBe("whole");
  });
  it("keeps wide subjects whole when a portrait crop cannot contain them",()=>{
    const r=raw("0:00:00","0:00:10");r.subjects=[{label:"wide",region:{x:.1,y:.1,width:.8,height:.8}}];
    const s=normalizeShots({shots:[r]},0,10,shape)[0];expect(s.layout).toBe("whole");expect(s.review).toBe(true);
  });
  it("contains suggested crops and chooses split only with two valid subjects",()=>{
    for(const ratio of [9/16,9/8])expect(validCrop(focusCrop(region,shape,ratio))).toBe(true);
    const s=normalizeShots({shots:[raw("0:00:00","0:00:10","split")]},0,10,shape)[0];
    expect(s.layout).toBe("split");expect(validCrop(s.top)).toBe(true);expect(validCrop(s.bottom)).toBe(true);
  });
  it("keeps exact duration across near-frame camera cuts and only outer fades",()=>{
    const shots=normalizeShots({shots:[raw("0:02:00","0:02:01.017"),raw("0:02:01.017","0:02:01.040"),raw("0:02:01.040","0:02:10","split")]},120,130,shape);
    const clip={id:"c",trimStart:120,duration:10,fadeIn:.5,fadeOut:.7,transition:{type:"dissolve",duration:.5}};
    const p=framedPieces(clip,10,30,shots,()=>crypto.randomUUID());
    expect(p.reduce((n,c)=>n+Math.round(c.duration!*30),0)).toBe(300);
    expect(p[0].fadeIn).toBe(.5);expect(p.at(-1)?.fadeOut).toBe(.7);
    expect(p.slice(1).every(c=>!c.fadeIn&&!c.transition)).toBe(true);
    expect(p.slice(0,-1).every(c=>!c.fadeOut)).toBe(true);
  });
  it("keeps split framing attached when a clip is trimmed or split again",()=>{
    const shots=normalizeShots({shots:[raw("0:02:00","0:02:10","split")]},120,130,shape);
    const [p]=framedPieces({id:"c",trimStart:123,duration:4,split:undefined},4,30,shots,()=>"new");
    expect(p.trimStart).toBe(123);expect(p.duration).toBe(4);expect(p.split).toBeTruthy();
    const halves=splitClip(p,2,4,"second")!;expect(halves[0].split).toEqual(halves[1].split);expect(halves[1].trimStart).toBe(125);
  });
});
