import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuidesHandler} from '../../netlify/functions/guides.mjs';
import {resolveAuthContext} from '../../netlify/functions/_shared/auth/auth-context.mjs';
const origin='https://example.test', token='E'.repeat(43);
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0]);
function storeMock(){const data=new Map();let version=0;return {data,
 async get(key){return structuredClone(data.get(key)?.data ?? null);},
 async set(key,value,options={}){data.set(key,{data:value,metadata:options.metadata,etag:String(++version)});},
 async setJSON(key,value,options={}){if(options.onlyIfMatch && data.get(key)?.etag!==options.onlyIfMatch)return {modified:false};data.set(key,{data:structuredClone(value),etag:String(++version)});return {modified:true};},
 async getMetadata(key){return data.has(key)?{metadata:data.get(key).metadata}:null;},
 async getWithMetadata(key){return structuredClone(data.get(key)||null);},
 async *list({prefix}){yield {blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};}
};}
function resolver(role){if(!role)return async()=>null;const account={accountId:'11111111-1111-4111-8111-111111111111',role,status:role==='blocked'?'blocked':'active',authzVersion:1};return async()=>resolveAuthContext({}, {readValidSessionFromCookie:async()=>({sessionId:'33333333-3333-4333-8333-333333333333',authSource:'logto',accountId:account.accountId,logtoSubject:'subject',authzVersion:1}),findAccountByLogtoSubject:async()=>account,capabilitiesForAccount:a=>({authenticated:true,role:a.role,blocked:a.role==='blocked',canAccessRegistered:a.role!=='blocked',canAccessPremium:['vip','svip','admin'].includes(a.role),canAccessSvip:['svip','admin'].includes(a.role),isAdmin:a.role==='admin'})});}
function handler(store,role){return createGuidesHandler({store,resolveAuthContext:resolver(role),trustedOrigins:origin});}
function req(query='',body,headers={}){return new Request(origin+'/api/guides'+query,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:`__Host-shinegame_csrf=${token}`,'X-CSRF-Token':token,...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});}
async function seeded(category='vip',status='published'){const s=storeMock();await s.setJSON('guides/guide',{id:'guide',title:'Guide',titleEn:'',category,status,pages:['page'],updatedAt:'2026-09-07'});await s.set('assets/guide/page',png,{metadata:{contentType:'image/png'}});return s;}
for(const role of [null,'free','pending','vip','svip','admin','blocked'])test(`VIP manifest and direct image access: ${role}`,async()=>{const h=handler(await seeded(),role);for(const query of ['?id=guide','?id=guide&asset=page']){const response=await h(req(query));assert.equal(response.status,['vip','svip','admin'].includes(role)?200:role?403:401);assert.match(response.headers.get('cache-control'),/no-store/);}});
test('public catalog lists titles but never page IDs or draft metadata',async()=>{const s=await seeded();await s.setJSON('guides/secret',{id:'secret',title:'Draft',status:'draft',pages:['secret-page'],updatedAt:'2026'});const r=await handler(s,null)(req());const body=await r.json();assert.equal(body.guides.length,1);assert.equal(body.guides[0].pageCount,1);assert.equal(body.guides[0].pages,undefined);});
test('public images work without session and drafts do not',async()=>{const s=await seeded('public');assert.equal((await handler(s,null)(req('?id=guide&asset=page'))).status,200);await handler(s,'admin')(req('?id=guide',{action:'unpublish'}));assert.equal((await handler(s,null)(req('?id=guide&asset=page'))).status,404);assert.equal((await handler(s,'vip')(req('?id=guide'))).status,404);});
test('write and admin listing reject every non-admin role',async()=>{for(const role of [null,'free','vip','svip','blocked']){const s=await seeded();const h=handler(s,role);assert.notEqual((await h(req('?admin=1'))).status,200);assert.notEqual((await h(req('',{action:'create',title:'x',category:'vip'}))).status,200);assert.equal(s.data.size,2);}});
test('write requires same origin and CSRF before any storage mutation',async()=>{const s=storeMock(),h=handler(s,'admin');for(const headers of [{Origin:'https://evil.test'},{'X-CSRF-Token':''},{Cookie:''}])assert.equal((await h(req('',{action:'create',title:'x',category:'public'},headers))).status,403);assert.equal(s.data.size,0);});
test('create/upload/publish/unpublish cycle preserves original bytes and page order',async()=>{const s=storeMock(),h=handler(s,'admin');const {guide}=await (await h(req('',{action:'create',title:'测试',category:'vip'}))).json();const id=guide.id;const assets=[];for(let i=0;i<2;i++){const r=await h(req(`?id=${id}&upload=1`,png));assert.equal(r.status,200);assets.push((await r.json()).asset);}assert.equal((await handler(s,'vip')(req(`?id=${id}`))).status,404);assert.equal((await h(req(`?id=${id}`,{action:'publish',pages:assets.reverse()}))).status,200);const result=await handler(s,'vip')(req(`?id=${id}&asset=${assets[0]}`));assert.deepEqual(Buffer.from(await result.arrayBuffer()),png);assert.equal(result.headers.get('content-type'),'image/png');assert.equal((await h(req(`?id=${id}`,{action:'unpublish'}))).status,200);assert.equal((await handler(s,'vip')(req(`?id=${id}&asset=${assets[0]}`))).status,404);});
test('upload rejects SVG/HTML, oversized bytes, invalid IDs, foreign page references',async()=>{const s=await seeded('public','draft'),h=handler(s,'admin');for(const bytes of [Buffer.from('<svg/>'),Buffer.alloc(3*1024*1024+1)])assert.equal((await h(req('?id=guide&upload=1',bytes))).status,400);for(const query of ['?id=../guide','?id=guide&asset=../../x'])assert.equal((await h(req(query))).status,400);assert.equal((await h(req('?id=guide',{action:'publish',pages:['missing']}))).status,400);assert.equal((await h(req('?id=guide',{action:'publish',pages:['page','page']}))).status,400);assert.equal((await h(req('?id=guide',{action:'publish',pages:[]}))).status,400);});
test('edit publishes bilingual pages atomically, retains ID and blocks stale saves',async()=>{
 const s=await seeded(),h=handler(s,'admin');
 const upload=await h(req('?id=guide&upload=1',png));assert.equal(upload.status,200);const {asset}=await upload.json();
 assert.equal((await handler(s,'vip')(req(`?id=guide&asset=${asset}`))).status,404);
 assert.deepEqual((await (await handler(s,'vip')(req('?id=guide'))).json()).guide.pages,['page']);
 const body={action:'edit',revision:0,title:'Updated',titleEn:'English',category:'vip',pages:['page'],pagesEn:[asset]};
 assert.equal((await h(req('?id=guide',body))).status,200);
 const guide=(await (await h(req('?id=guide&admin=1'))).json()).guide;
 assert.equal(guide.id,'guide');assert.equal(guide.revision,1);assert.deepEqual(guide.pagesEn,[asset]);
 assert.equal((await handler(s,'free')(req(`?id=guide&asset=${asset}`))).status,403);
 assert.equal((await handler(s,'vip')(req(`?id=guide&asset=${asset}`))).status,200);
 assert.equal((await h(req('?id=guide',{...body,title:'Stale'}))).status,409);
 assert.equal((await s.get('guides/guide')).title,'Updated');
});
test('invalid edits keep old title, category and pages; language page IDs stay out of catalog',async()=>{
 const s=await seeded(),h=handler(s,'admin');
 assert.equal((await h(req('?id=guide',{action:'edit',revision:0,title:'Broken',category:'public',pages:['page'],pagesEn:['missing']}))).status,400);
 const old=await s.get('guides/guide');assert.equal(old.title,'Guide');assert.equal(old.category,'vip');
 await s.setJSON('guides/guide',{...old,pagesEn:['page']});const catalog=await (await handler(s,null)(req())).json();assert.equal(catalog.guides[0].pagesEn,undefined);assert.equal(catalog.guides[0].pageCountEn,1);
});
test('English-only edit and removal of old images are supported; concurrent storage update is rejected',async()=>{
 const s=await seeded('public'),h=handler(s,'admin');
 const {asset}=await (await h(req('?id=guide&upload=1',png))).json();
 const body={action:'edit',revision:0,title:'English only',category:'public',pages:[],pagesEn:[asset]};
 assert.equal((await h(req('?id=guide',body))).status,200);
 assert.equal((await handler(s,null)(req('?id=guide&asset=page'))).status,404);
 assert.equal((await handler(s,null)(req(`?id=guide&asset=${asset}`))).status,200);
 s.setJSON=async()=>({modified:false});assert.equal((await h(req('?id=guide',{...body,revision:1}))).status,409);
});
