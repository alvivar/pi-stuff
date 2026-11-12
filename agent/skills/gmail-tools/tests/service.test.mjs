import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GmailService, outputText, validateInput } from '../scripts/service.mjs';
import { Readable } from 'node:stream';
import { parseArgs, stdinObject } from '../scripts/gmail.mjs';
import { parseBrowserResult, pythonValue, safeEnv } from '../scripts/bridge.mjs';
import { withState, statePaths } from '../scripts/store.mjs';
import { clone, createBatch, createPlan, emptyState, normalizeChanges } from '../scripts/core.mjs';

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
 const p=createPlan(b,normalizeChanges(b,[{n:1,read:true}]),[row]);p.status='running';s.batches[b.id]=b;s.plans[p.id]=p;
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
 const inspectFailure=`PI_GMAIL_RESULT:${JSON.stringify({ok:false,error:'opened_view_unverifiable',report:{opened:true,cleanup_error:'browser_error'}})}\n`;
 assert.equal(fail(inspectFailure).uncertain,true);
 for(const code of['browser_error','apply_interrupted','dom_operation_failed'])assert.equal(fail(result(code)).uncertain,true,code);
 for(const code of['precondition_changed','mutation_uncertain','tab_closed'])assert.equal(fail(result(code)).uncertain,false,code);
});
test('stdin JSON keeps UTF-8 characters split across chunks',async()=>{
 const bytes=Buffer.from('{"query":"café"}'),split=bytes.indexOf(0xc3)+1;
 assert.deepEqual(await stdinObject(Readable.from([bytes.subarray(0,split),bytes.subarray(split)])),{query:'café'});
});
test('browser request reaches Python with non-BMP Unicode intact',async()=>{
 const request={query:'subject:😀 café',labels:['Ünïcode 日本']};
 const code=`import json, urllib.parse\nrequest = ${pythonValue(request)}\nurllib.parse.quote(request["query"])\nprint(json.dumps(request))`;
 assert.match(code,/^[\x00-\x7f]*$/);
 const {stdout}=await promisify(execFile)('python',['-c',code]);
 assert.deepEqual(JSON.parse(stdout),request);
});
test('printed scan output stays within 48KB',async()=>{
 const h=harness();await h.service.run('connect',{account:connection.account});
 h.service.browser=async()=>({ok:true,query:'in:inbox',page:1,next_page:null,rows:Array.from({length:100},(_,i)=>
  ({...clone(row),id:i.toString(16).padStart(16,'0'),subject:'Long synthetic subject '.repeat(30),summary:'Sender '.repeat(20)}))});
 const printed=outputText(await h.service.run('scan',{query:'in:inbox',limit:100}));
 assert.ok(Buffer.byteLength(printed)<=48000);
 const out=JSON.parse(printed);
 assert.equal(out.truncated,true);assert.ok(out.rows.length>0&&out.rows.length<100);
});
test('oversized inspect keeps its status and shortens the text',async()=>{
 const h=harness(),{b}=await prepared(h);
 const text='\u0001\u{1F600}'.repeat(6000);
 h.service.browser=async()=>({ok:true,text,attachment_names:[],truncated:false,marked_read:true});
 const printed=outputText(await h.service.run('inspect',{batch_id:b.batch_id,n:1,allow_mark_read:true,redact_sensitive:false}));
 assert.ok(Buffer.byteLength(printed)<=48000);
 const out=JSON.parse(printed);
 assert.equal(out.ok,true);assert.equal(out.n,1);assert.equal(out.marked_read,true);assert.equal(out.truncated,true);
 assert.ok(out.text.length>0&&text.startsWith(out.text));
 assert.doesNotMatch(out.notice,/stored range/);
});
test('printed output counts the trailing newline',()=>{
 const printed=outputText({ok:true,n:1,marked_read:true,truncated:false,text:'\u0001'.repeat(9000),attachment_names:[]});
 assert.ok(Buffer.byteLength(printed)<=48000);assert.ok(printed.endsWith('}\n'));
});
test('large apply error keeps its recovery fields and shortens the journal',()=>{
 const journal=Array.from({length:1000},(_,i)=>({operation:'add_label',count:1,status:i<999?'verified':'attempting'}));
 const printed=outputText({ok:false,error:'apply_interrupted',message:'Execution stopped.',report:{journal,processed_count:7,uncertain:true}});
 assert.ok(Buffer.byteLength(printed)<=48000);
 const out=JSON.parse(printed);
 assert.equal(out.ok,false);assert.equal(out.error,'apply_interrupted');assert.equal(out.message,'Execution stopped.');
 assert.equal(out.report.uncertain,true);assert.equal(out.report.processed_count,7);assert.equal(out.truncated,true);
 assert.ok(out.report.journal.length>0&&out.report.journal.length<1000);
 assert.equal(out.report.journal.at(-1).status,'attempting');
 assert.match(out.notice,/verify/);
});
test('apply checkpoints running before the browser call; a later save failure does not mask its error',async()=>{
 const h=harness(),{p}=await prepared(h);
 let failSave=false;
 h.service.save=async s=>{if(failSave)throw Error('disk full');h.saved.push(clone(s));};
 h.service.browser=async()=>{
  assert.equal(h.saved.at(-1).plans[p.plan_id].status,'running');
  failSave=true;throw Error('simulated disconnect');
 };
 await assert.rejects(h.service.run('apply',{plan_id:p.plan_id,digest:p.digest},{confirmation:p.digest}),
  e=>/simulated disconnect/.test(e.message)&&/could not be saved: disk full/.test(e.message));
});
