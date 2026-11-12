import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../scripts/dom.js',import.meta.url),'utf8');
function fixture() {
 const account={getClientRects:()=>[{}],getAttribute:()=> 'Google Account: Person (person@example.com)'};
 const rows=[];
 const element = (text,attrs={})=>({textContent:text,getAttribute:k=>attrs[k],getClientRects:()=>[{}]});
 const make=(id,subject='Subject')=>{
  const r={id,subject,checked:false,unread:true,opens:0,labels:['Inbox'],sender:'sender@example.org',time:'Wed, Nov 11, 2026, 1:18 PM'};
  const span=element('',{'data-legacy-thread-id':id});
  const cb={getAttribute:()=>String(r.checked),click:()=>{r.checked=!r.checked;}};
  r.getClientRects=()=>[{}]; r.classList={contains:()=>r.unread};
  r.querySelectorAll=s=>s==='[data-legacy-thread-id]'?[span,span]:s==='.yW span[email]'?[element('',{email:r.sender})]:s==='.at'?r.labels.map(l=>element(l)):[];
  r.querySelector=s=>s==='[role=checkbox]'?cb:s==='.bog'?{textContent:r.subject,click:()=>{r.opens++;r.unread=false;}}:s==='td.xW span[title]'?element('',{title:r.time}):s==='.yW'?element('Sender 2'):null;
  rows.push(r);return r;
 };
 const doc={body:{innerText:'No conversations found.'},querySelectorAll:s=>s==='[aria-label]'?[account]:s==='tr.zA'?rows:[]};
 const loc={origin:'https://mail.google.com',pathname:'/mail/u/0/',hash:'#search/in%3Ainbox'};
 const run=vm.runInNewContext('('+source+')',{document:doc,location:loc});
 return{rows,make,doc,loc,run:(op,args={})=>JSON.parse(JSON.stringify(run({op,account:'person@example.com',base_path:'/mail/u/0/',...args})))};
}
test('reads stable thread IDs, not volatile row indexes',()=>{
 const f=fixture();f.make('abcdef0123456789');
 const result=f.run('rows');assert.equal(result.rows[0].id,'abcdef0123456789');
 f.rows[0].id='unused'; // DOM-bound stable attribute remains the original ID.
 assert.equal(f.run('rows').rows[0].id,'abcdef0123456789');
});
test('account/origin mismatch stops before any input',()=>{
 const f=fixture();f.make('abcdef0123456789');
 assert.throws(()=>f.run('rows',{account:'wrong@example.com'}),/ACCOUNT_CHANGED/);
 f.loc.origin='https://accounts.google.com';assert.throws(()=>f.run('rows'),/NOT_GMAIL/);
});
test('existing selection is never reused or cleared blindly',()=>{
 const f=fixture(),a=f.make('abcdef0123456789'),b=f.make('abcdef0123456780');
 const refs=f.run('rows').rows; b.checked=true;
 assert.throws(()=>f.run('select',{refs:[refs[0]]}),/EXISTING_SELECTION/);
 assert.throws(()=>f.run('deselect',{refs:[refs[0]]}),/SELECTION_MISMATCH/);
 assert.equal(b.checked,true);assert.equal(a.checked,false);
});
test('all identities and preconditions are checked before selecting any row',()=>{
 const f=fixture();const a=f.make('abcdef0123456789'),b=f.make('abcdef0123456780');
 const refs=f.run('rows').rows; b.subject='A new reply changed this';
 assert.throws(()=>f.run('select',{refs}),/REVISION_CHANGED/);
 assert.equal(a.checked,false);assert.equal(b.checked,false);
});
test('exact selection can be cleared after read/label state changed',()=>{
 const f=fixture(),a=f.make('abcdef0123456789');const ref=f.run('rows').rows[0];
 f.run('select',{refs:[{...ref,expected:{unread:true,labels:['Inbox']}}]});
 a.unread=false;a.labels.push('Example');assert.equal(f.run('deselect',{refs:[ref]}).count,0);
});
test('deselect tolerates disappearance of processed rows but not unrelated selection',()=>{
 const f=fixture();f.make('abcdef0123456789');const b=f.make('abcdef0123456780');
 const ref=f.run('rows').rows[0];f.rows.splice(0,1);
 assert.equal(f.run('deselect',{refs:[ref]}).count,0);
 b.checked=true;assert.throws(()=>f.run('deselect',{refs:[ref]}),/SELECTION_MISMATCH/);
 assert.equal(b.checked,true);
});
test('inspection requires explicit read-side-effect permission',()=>{
 const f=fixture(),a=f.make('abcdef0123456789');const ref=f.run('rows').rows[0];
 assert.throws(()=>f.run('open',{ref}),/OPEN_WOULD_MARK_READ/);assert.equal(a.opens,0);
 f.run('open',{ref,allow_mark_read:true});assert.equal(a.opens,1);assert.equal(a.unread,false);
});
test('missing/duplicate legacy IDs fail closed',()=>{
 const f=fixture();f.make('not-a-thread-id');assert.throws(()=>f.run('rows'),/STABLE_THREAD_ID/);
 const g=fixture();g.make('abcdef0123456789');g.make('abcdef0123456789');assert.throws(()=>g.run('rows'),/DUPLICATE_THREAD/);
});
