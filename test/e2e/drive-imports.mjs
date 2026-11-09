// Real Hono routes, SQLite, connection SDK, range/tus transport and signature
// verification. Only the external Drive/media/queue HTTP boundary is simulated.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const app = (await import('./.server.mjs')).default;
const db = new DatabaseSync(':memory:');
db.exec(readFileSync('schema.sql', 'utf8'));
const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
const uid = 'a'.repeat(32), fileId = 'private_file_123456', total = 201 * 1024 * 1024;
let offset = 0, actions = 0, ready = false, queued = [], patches = [], calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const zero = new Uint8Array(1024 * 1024);
const bytes = n => new ReadableStream({ pull(c) { if (!n) return c.close(); const k = Math.min(n, zero.length); c.enqueue(zero.subarray(0, k)); n -= k; } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls.push([url.hostname, url.pathname, init.method ?? 'GET']);
  if (url.pathname === '/.well-known/jwks.json') return json({ keys: [{ ...jwk, kid: 'test' }] });
  if (url.hostname === 'queue.test') { queued.push(JSON.parse(init.body)); return json({ id: String(queued.length), status: 'pending', run_at: 'now' }); }
  if (url.hostname === 'svc.test' && url.pathname === '/media/uploads') return json({ id: uid, upload_url: 'https://upload.test/tus', expires_at: new Date(Date.now()+6*3600000).toISOString() });
  if (url.hostname === 'svc.test' && url.pathname === '/media/' + uid) return json({ id: uid, ready, state: ready ? 'ready' : 'pendingupload', duration: 1506, width: 1920, height: 1080, error: null });
  if (url.hostname === 'piece.test') {
    const [a,b] = url.pathname.slice(1).split('-').map(Number);
    return new Response(bytes(b-a+1), { headers: { 'Content-Type':'video/mp4' } });
  }
  if (url.hostname === 'upload.test' && init.method === 'HEAD') return new Response(null, { headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(total) } });
  if (url.hostname === 'upload.test' && init.method === 'PATCH') {
    assert.equal(Number(new Headers(init.headers).get('Upload-Offset')), offset);
    let received = 0; for await (const b of init.body) received += b.length;
    patches.push(received); offset += received; ready = offset === total;
    return new Response(null, { status:204, headers:{ 'Upload-Offset':String(offset) } });
  }
  throw new Error('Unexpected fetch: ' + url.hostname + url.pathname);
};
const env = {
  CLAWNIFY_ORG_ID:'org', CLAWNIFY_TOKEN:'test', CLAWNIFY_QUEUE_URL:'https://queue.test/queue', SERVICES_URL:'https://svc.test', UPLOADS:{},
  STORAGE:{ async query(sql, params=[]) {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { rows: st.all(...params) };
    const r = st.run(...params); return { rows:[], meta:{ changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid) } };
  } },
  CREDENTIALS:{
    getToken:async()=>null, listConnected:async()=>['googledrive'], listConnections:async()=>[{ service:'googledrive', account:'acct', isDefault:true }],
    executeTool:async()=>{ actions++; throw new Error('Whole-file action must never run'); },
    proxyRequest:async(service,org,req,opts)=>{
      assert.equal(service,'googledrive'); assert.equal(org,'org');
      const p = n => req.parameters?.find(p=>p.name===n)?.value;
      if (p('alt') === 'media') {
        assert.equal(opts.account,'acct');
        const [,a,b] = /^bytes=(\d+)-(\d+)$/.exec(p('Range'));
        return { successful:true, data:null, status:206, headers:{ 'content-range':`bytes ${a}-${b}/${total}` }, file:{ url:`https://piece.test/${a}-${b}`, contentType:'video/mp4', size:Number(b)-Number(a)+1, expiresAt:null } };
      }
      return { successful:true, status:200, data:{ name:'Private talk.mp4', mimeType:'video/mp4', size:String(total), version:'16', capabilities:{canDownload:true}, videoMediaMetadata:{durationMillis:'1506000'}, parents:['outside_folder'] } };
    },
  },
};
const request = async(path, method='GET', body, headers={}) => {
  const waits=[];
  const res=await app.fetch(new Request('https://video.apps.clawnify.com'+path, { method, headers:{'Content-Type':'application/json',...headers}, ...(body===undefined?{}:{body:JSON.stringify(body)}) }),env,{ waitUntil:p=>waits.push(p) });
  await Promise.all(waits); return {status:res.status,body:await res.json()};
};
const callback = async id => {
  const body={import_id:id}; const ts=String(Math.floor(Date.now()/1000));
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key.privateKey,new TextEncoder().encode(ts+'.'+JSON.stringify(body)));
  db.prepare('UPDATE drive_imports SET next_step_at=0 WHERE id=?').run(id);
  return request('/api/drive/imports/step','POST',body,{'X-Queue-Signature':Buffer.from(sig).toString('base64'),'X-Queue-Timestamp':ts,'X-Queue-Key-Id':'test'});
};
assert.equal((await request('/api/drive/imports/step','POST',{import_id:'anything'})).status,401);
const start=await request('/api/drive/import','POST',{fileId}); assert.equal(start.status,202);
const id=start.body.import.id; assert.equal(start.body.import.state,'queued');
assert.equal((await request('/api/drive/import','POST',{fileId})).body.import.id,id);
assert.equal((await callback(id)).status,200); assert.equal(offset,200*1024*1024);
assert.equal((await request('/api/assets/media','POST',{uid})).status,409);
assert.equal((await request('/api/assets/uploads/'+uid,'DELETE')).status,409);
db.prepare("UPDATE media_uploads SET created_at='2020-01-01 00:00:00'").run();
ready=true;
assert.deepEqual((await request('/api/assets')).body,[]); // browser sweep must not promote an unfinished import
ready=false;
assert.equal((await callback(id)).status,200); assert.equal(offset,total);
assert.equal((await request('/api/drive/imports/'+id)).body.state,'processing');
assert.equal((await callback(id)).status,200);
assert.equal((await request('/api/drive/imports/'+id)).body.state,'ready');
assert.equal((await callback(id)).status,200);
const library=(await request('/api/assets')).body; assert.equal(library.length,1); assert.equal(library[0].size,total);
assert.deepEqual(patches,[200*1024*1024,1024*1024]); assert.equal(actions,0);
assert.ok(!JSON.stringify((await request('/api/drive/imports')).body).includes('upload.test'));
assert.equal(db.prepare('SELECT count(*) n FROM media_uploads').get().n,0);
db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run('drive_folder',JSON.stringify({id:'limited_folder_123',name:'Only this folder'}));
assert.equal((await request('/api/drive/import','POST',{fileId})).status,403);
console.log('Drive import integration passed: signed callbacks, private ranges, two real streamed pieces, duplicate delivery, folder guard, sweep exclusion, one complete library asset.');
