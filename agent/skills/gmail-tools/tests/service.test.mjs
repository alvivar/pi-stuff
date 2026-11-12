import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GmailService, validateInput } from '../scripts/service.mjs';
import { parseArgs } from '../scripts/gmail.mjs';
import { parseBrowserResult, safeEnv } from '../scripts/bridge.mjs';
import { withState, statePaths } from '../scripts/store.mjs';
import { clone, createBatch, createPlan, emptyState } from '../scripts/core.mjs';

const connection = { account:'person@example.com',tab_id:'abc123',base_path:'/mail/u/0/' };
const row = { id:'abcdef0123456789',sender:'sender@example.org',senders:['sender@example.org'],
  subject:'Synthetic subject',time:'Wed, Nov 11, 2026, 1:18 PM',summary:'Sender',labels:['Inbox'],unread:true };
function harness() {
 const calls=[],saved=[];
 const browser=async req=>{
  calls.push(req.op);
  if(req.op==='connect')return{ok:true,connection};
  if(req.op==='scan')return{ok:true,rows:[{...clone(row),snippet:'private body excerpt'}],query:req.query,page:1,next_page:null};
  if(req.op==='lookup'||req.op==='verify')return{ok:true,rows:[clone(row)]};
  if(req.op==='apply')return{ok:true,results:[{n:1,ok:true}],journal:[]};
  throw Error('Unexpected operation');
 };
 const service=new GmailService({browser,save:async s=>saved.push(clone(s))});
 return{service,calls,saved};
}
async function prepared(h) {
 await h.service.run('connect',{account:connection.account});
 const b=await h.service.run('scan',{query:'in:inbox'});
 const p=await h.service.run('prepare',{batch_id:b.batch_id,changes:[{n:1,read:true,destination:'archive'}]});
 return{b,p};
}
test('service has no startup browser calls or Pi dependency',()=>{
 const h=harness();assert.deepEqual(h.calls,[]);
 assert.equal(h.service.state.version,1);
});
test('prepare, serialize, restore, retrieve and verify without mutating',async()=>{
 const h=harness(),{b,p}=await prepared(h);
 assert.equal(p.count,1);
 const restored=new GmailService({state:JSON.parse(JSON.stringify(h.service.state)),browser:h.service.browser});
 assert.equal((await restored.run('batch',{id:p.plan_id})).digest,p.digest);
 const v=await restored.run('verify',{plan_id:p.plan_id});
 assert.equal(v.results[0].still_before,true);assert.equal(v.results[0].matches,false);
 assert.ok(!h.calls.includes('apply'));
 assert.ok(!JSON.stringify(restored.state).includes('private body excerpt'));
});
test('missing/wrong confirmation and digest cause zero apply calls',async()=>{
 const h=harness(),{p}=await prepared(h);const before=h.calls.length;
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest}),/confirm/);
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:'0'.repeat(64)}),/confirm/);
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:'0'.repeat(64)},{confirmation:p.digest}),/mismatch/);
 assert.equal(h.calls.length,before);assert.equal(h.service.getPlan(p.plan_id).status,'prepared');
});
test('explicit matching acknowledgment applies once and writes running first',async()=>{
 const h=harness(),{p}=await prepared(h);
 const result=await h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:p.digest});
 assert.equal(result.status,'completed');assert.equal(h.calls.filter(c=>c==='apply').length,1);
 assert.ok(h.saved.some(s=>s.plans[p.plan_id]?.status==='running'));
 assert.equal(h.saved.at(-1).plans[p.plan_id].status,'completed');
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:p.digest}),/attempted/);
 assert.equal(h.calls.filter(c=>c==='apply').length,1);
});
test('interrupted apply is durably uncertain and cannot replay',async()=>{
 const h=harness(),{p}=await prepared(h);
 h.service.browser=async()=>{throw Error('simulated disconnect');};
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:p.digest}),/disconnect/);
 assert.equal(h.saved.at(-1).plans[p.plan_id].status,'uncertain');
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:p.digest}),/attempted/);
});
test('loading running state recovers uncertain, never prepared',()=>{
 const s=emptyState();s.connection=connection;
 const b=createBatch(connection,{rows:[row],query:'in:inbox',page:1});
 const p=createPlan(b,[{n:1,read:true}],[row]);p.status='running';s.batches[b.id]=b;s.plans[p.id]=p;
 const restored=new GmailService({state:s,browser:async()=>{throw Error('not called');}});
 assert.equal(restored.getPlan(p.id).status,'uncertain');
});
test('plain JSON protocol validation rejects unknown fields and loose types',()=>{
 for(const p of [{query:'in:inbox',arbitrary:true},{query:'in:inbox',limit:0},{query:'in:inbox',limit:'50'},[]])assert.throws(()=>validateInput('scan',p));
 assert.throws(()=>validateInput('inspect',{batch_id:'x',n:1,allow_mark_read:'true'}));
 assert.throws(()=>validateInput('apply',{plan_id:'x',digest:'bad'}));
});
test('CLI parsing isolates sessions and binds confirm to apply',()=>{
 assert.equal(parseArgs(['scan'],{PI_SESSION_ID:'session-a'}).session,'session-a');
 assert.equal(parseArgs(['scan','--session','explicit'],{}).session,'explicit');
 assert.throws(()=>parseArgs(['scan','--confirm','a'.repeat(64)],{}),/only valid/);
 assert.throws(()=>parseArgs(['scan','--session','a','--session','b'],{}),/duplicate/);
 assert.throws(()=>parseArgs(['scan','--session'],{}),/Invalid/);
 assert.throws(()=>statePaths(undefined));
 const p=statePaths('../anything','/tmp/skill-state');assert.match(p.file,/[a-f0-9]{64}\.json$/);
});
test('state survives separate invocations, is atomic and does not steal locks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gmail-state-test-'));
 try{
  await withState('session-a',async(s,save)=>{
   s.connection=connection;await save(s);
   await assert.rejects(withState('session-a',async()=>{}, {root}),/busy/);
  },{root});
  await withState('session-a',async(s)=>{assert.deepEqual(s.connection,connection);},{root});
  await withState('session-b',async(s)=>{assert.equal(s.connection,null);},{root});
  const file=statePaths('session-a',root).file;
  assert.equal(JSON.parse(await readFile(file,'utf8')).version,1);
  await writeFile(file,'not-json');
  await assert.rejects(withState('session-a',async()=>{throw Error('must not reset');},{root}),/not reset/);
  assert.equal(await readFile(file,'utf8'),'not-json');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('CLI help and invalid command run without browser or Pi packages',async()=>{
 const cli=fileURLToPath(new URL('../scripts/gmail.mjs',import.meta.url));
 const exec=promisify(execFile);
 const help=await exec(process.execPath,[cli,'--help'],{cwd:tmpdir(),env:{...process.env,PI_SESSION_ID:''}});
 assert.match(help.stdout,/no Pi extension/);
 await assert.rejects(exec(process.execPath,[cli,'unknown'],{cwd:tmpdir()}),e=>{
  const data=JSON.parse(e.stdout);assert.equal(data.ok,false);assert.match(data.message,/Unknown command/);return true;
 });
});
test('browser-use child cannot re-enable cloud autospawn from .env',async()=>{
 const saved=process.env.BU_AUTOSPAWN;process.env.BU_AUTOSPAWN='1';
 try{
  // browser-use loads .env with os.environ.setdefault; run.py tests BU_AUTOSPAWN for truthiness.
  const {stdout}=await promisify(execFile)('python',['-c',"import os;os.environ.setdefault('BU_AUTOSPAWN','1');print(repr(os.environ.get('BU_AUTOSPAWN')))"],{env:safeEnv()});
  assert.equal(stdout.trim(),"''");
 }finally{if(saved===undefined)delete process.env.BU_AUTOSPAWN;else process.env.BU_AUTOSPAWN=saved;}
});
test('browser failures with unknown outcome are marked uncertain, completed ones are not',()=>{
 const fail=(out,code=0)=>{try{parseBrowserResult({out,err:'',code});}catch(e){return e;}assert.fail('expected failure');};
 const result=error=>`PI_GMAIL_RESULT:${JSON.stringify({ok:false,error,message:'m'})}
`;
 assert.equal(fail('',1).uncertain,true);
 assert.equal(fail('PI_GMAIL_RESULT:{"ok":false,"error":"apply_interrupted",',1).uncertain,true);
 for(const code of['browser_error','apply_interrupted','dom_operation_failed'])assert.equal(fail(result(code)).uncertain,true,code);
 for(const code of['precondition_changed','mutation_uncertain','tab_closed'])assert.equal(fail(result(code)).uncertain,false,code);
});
