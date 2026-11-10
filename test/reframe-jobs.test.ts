import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDB } from "../src/server/db";
import { reframing } from "../src/server/reframe";
import { startVideoAnalysis, getVideoAnalysis } from "@clawnify/services";
import { mediaState, prepareMedia } from "../src/server/media";
vi.mock("@clawnify/services",async importOriginal=>({...await importOriginal<typeof import("@clawnify/services")>(),startVideoAnalysis:vi.fn(),getVideoAnalysis:vi.fn()}));
vi.mock("../src/server/media",()=>({mediaState:vi.fn(),prepareMedia:vi.fn()}));
let db:DatabaseSync;
const env={CLAWNIFY_TOKEN:"test"};
const req=async(body:any)=>{const r=await reframing.request("/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},env);return {status:r.status,body:await r.json() as any};};
const read=async(id:string)=>(await reframing.request(`/${id}`,{},env)).json() as Promise<any>;
const input={asset_id:"a",start:120,end:140};
beforeEach(()=>{
  db?.close();db=new DatabaseSync(":memory:");db.exec(readFileSync(new URL("../schema.sql",import.meta.url),"utf8"));
  db.prepare("INSERT INTO assets(id,key,name,content_type,size,duration,media_uid) VALUES ('a','media/a','talk.mp4','video/mp4',100,1500,?)").run("a".repeat(32));
  initDB({STORAGE:{async query(sql,params=[]){const s=db.prepare(sql);if(/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))return {rows:s.all(...params)};const r=s.run(...params);return {rows:[],meta:{changes:Number(r.changes)}};}}});
  vi.resetAllMocks();vi.mocked(mediaState).mockResolvedValue({media:{id:"a".repeat(32),state:"ready",ready:true,analysis:"ready",duration:1500,width:1920,height:1080,progress:100,error:null}});
  vi.mocked(startVideoAnalysis).mockResolvedValue({job_id:"job",status:"running"});
  vi.mocked(getVideoAnalysis).mockResolvedValue({status:"running",job_id:"job"});
});
describe("shared framing jobs",()=>{
  it("asks without a shot-count cap the provider refuses, and shows the service's reason on failure",async()=>{
    const started=await req(input);
    const schema=vi.mocked(startVideoAnalysis).mock.calls[0][1].schema as any;
    expect(schema.properties.shots.maxItems).toBeUndefined();
    // Room for the thinking a part of nearly five minutes needs.
    expect(vi.mocked(startVideoAnalysis).mock.calls[0][1].max_output_tokens).toBeGreaterThanOrEqual(32000);
    expect(vi.mocked(startVideoAnalysis).mock.calls[0][1].prompt).toContain("from 0:02:00.000 to 0:02:20.000 of the whole video");
    vi.mocked(getVideoAnalysis).mockResolvedValueOnce({job_id:"job",status:"failed",error:"analyze_failed",detail:"the analysis failed — try again"});
    const after=await read(started.body.id);
    expect(after).toMatchObject({status:"failed",job_id:"job"});
    expect(after.error).toContain("the analysis failed — try again");
  });
  it("claims a source interval once, including simultaneous clicks",async()=>{
    const results=await Promise.all([req(input),req(input)]);
    expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
    expect(results.every(r=>r.status===200)).toBe(true);
    expect(results[0].body.id).toBe(results[1].body.id);
    const good=results[0];
    expect((await req(input)).body.id).toBe(good.body.id);
    expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
  });
  it("does not restart a failure when another first request arrives late",async()=>{
    const state=await vi.mocked(mediaState).getMockImplementation()!({token:"test"},"a");
    let release!:()=>void;
    const delayed=new Promise<void>(r=>release=r);
    vi.mocked(mediaState).mockImplementationOnce(async()=>state).mockImplementationOnce(async()=>{await delayed;return state;});
    vi.mocked(startVideoAnalysis).mockRejectedValueOnce(new Error("lost submission"));
    const first=req(input),second=req(input);
    const a=await first;expect(a.body.status).toBe("failed");release();
    const b=await second;expect(b.status).toBe(200);expect(b.body.id).toBe(a.body.id);expect(b.body.status).toBe("failed");
    expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
  });
  it("caches validated advice and reuses it after re-trimming",async()=>{
    const {body}=await req(input);
    vi.mocked(getVideoAnalysis).mockResolvedValue({job_id:"job",status:"done",result:{shots:[]}});
    const done=await read(body.id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.answer)).toEqual({shots:[]});
    const again=await req({...input,start:125,end:135});expect(again.body.id).toBe(body.id);expect(again.body.shots[0].layout).toBe("whole");expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
  });
  it("does not automatically submit another job after a submission failure",async()=>{
    vi.mocked(startVideoAnalysis).mockRejectedValueOnce(new Error("timeout"));
    expect((await req(input)).body.status).toBe("failed");
    expect((await req(input)).body.status).toBe("failed");expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
    expect((await req({...input,retry:true})).body.status).toBe("running");expect(startVideoAnalysis).toHaveBeenCalledTimes(2);
  });
  it("marks an interrupted submission failed and never silently retries it",async()=>{
    const {body}=await req(input);db.prepare("UPDATE video_reframes SET status='starting',job_id=NULL,updated_at=0 WHERE id=?").run(body.id);
    expect((await read(body.id)).status).toBe("failed");expect(startVideoAnalysis).toHaveBeenCalledTimes(1);
  });
  it("waits for media preparation without starting inference",async()=>{
    vi.mocked(mediaState).mockResolvedValue({media:{id:"a",state:"ready",ready:true,analysis:"preparing",duration:1500,width:1920,height:1080,progress:100,error:null}});
    vi.mocked(prepareMedia).mockResolvedValue({media:{id:"a",state:"ready",ready:true,duration:1500,width:1920,height:1080,progress:100,error:null}});
    expect((await req(input)).body.status).toBe("preparing");expect(startVideoAnalysis).not.toHaveBeenCalled();
  });
  it("refuses deleted sources and out-of-range selections",async()=>{
    expect((await req({...input,end:1600})).status).toBe(400);
    const {body}=await req(input);db.prepare("UPDATE assets SET deleting=1 WHERE id='a'").run();
    expect((await reframing.request(`/${body.id}`,{},env)).status).toBe(404);expect((await req(input)).status).toBe(409);
  });
});
