import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatch, createPlan, normalizeChanges, desiredState, validatePlan, redact, publicBatch, clone } from '../scripts/core.mjs';

const conn = { account: 'person@example.com', tab_id: 'abc123', base_path: '/mail/u/0/' };
const row = (id='abcdef0123456789') => ({ id, sender:'sender@example.org', senders:['sender@example.org'],
 subject:'An ordinary conversation', time:'Wed, Nov 11, 2026, 1:18 PM', summary:'Sender 2', labels:['Inbox'], unread:true });
const batch = () => createBatch(conn, { query:'in:inbox', page:1, next_page:null, rows:[row()] });
const plan = (b, changes, fresh) => createPlan(b, normalizeChanges(b, changes), fresh);

test('snapshots are account-bound, stable-ID based and numbered once', () => {
 const b=batch(); assert.equal(b.rows[0].n,1); assert.match(b.id,/^batch-/);
 assert.equal(publicBatch(b).rows[0].ref,row().id);
 assert.throws(()=>createBatch(conn,{rows:[row(),row()]}),/duplicate/);
 assert.throws(()=>createBatch(conn,{rows:[{...row(),id:''}]}),/stable/);
 assert.throws(()=>createBatch({...conn,base_path:'/mail/u/evil/'},{rows:[]}),/Connect/);
});
test('no classification or read/destination defaults are introduced', () => {
 const p=plan(batch(),[{n:1,add_labels:['Example']}],[row()]);
 assert.deepEqual(p.entries[0].after,{unread:true,labels:['Example','Inbox']});
 assert.equal(p.entries[0].change.destination,undefined); assert.equal(p.entries[0].change.read,undefined);
});
test('reject duplicate numbers, empty changes and conflicting/system labels', () => {
 const b=batch();
 for (const changes of [[{n:1}], [{n:2,read:true}], [{n:1,read:true},{n:1,read:false}],
 [{n:1,add_labels:['X'],remove_labels:['X']}], [{n:1,add_labels:['Inbox']}],
 [{n:1,destination:'delete_forever'}], [{n:1,read:'true'}], [{n:1,read:true,arbitrary:'x'}]]) {
  assert.throws(()=>normalizeChanges(b,changes));
 }
});
test('reply/identity change is not silently reinterpreted', () => {
 assert.throws(()=>plan(batch(),[{n:1,read:true}],[{...row(),time:'Thu, Nov 12, 2026, 1:18 PM'}]),/changed/);
 assert.throws(()=>plan(batch(),[{n:1,read:true}],[row(),row()]),/Duplicate/);
});
test('manual state updates before preparation are rebased, not repeated blindly', () => {
 const fresh={...row(),labels:[],unread:false};
 const p=plan(batch(),[{n:1,read:true,destination:'archive'}],[fresh]);
 assert.deepEqual(p.entries[0].before,p.entries[0].after);
});
test('digest binds exact account, plan and operations; plans are single attempt', () => {
 const p=plan(batch(),[{n:1,read:true,destination:'archive'}],[row()]);
 validatePlan(p,p.digest,conn.account);
 assert.throws(()=>validatePlan(p,p.digest,'other@example.com'),/mismatch/);
 const changed=clone(p); changed.entries[0].after.labels.push('Other');
 assert.throws(()=>validatePlan(changed,p.digest,conn.account),/mismatch/);
 assert.throws(()=>validatePlan({...p,status:'uncertain'},p.digest,conn.account),/attempted/);
});
test('archive, trash and not-spam have explicit independent semantics', () => {
 const c={add_labels:[],remove_labels:[]};
 assert.deepEqual(desiredState(row(),{...c,destination:'archive'}),{unread:true,labels:[]});
 assert.deepEqual(desiredState(row(),{...c,destination:'trash'}),{unread:true,labels:['Trash']});
 assert.deepEqual(desiredState({...row(),labels:['Spam','Example']},{...c,destination:'not_spam'}),{unread:true,labels:['Example','Inbox']});
 assert.deepEqual(desiredState({...row(),labels:[]},{...c,destination:'not_spam'}),{unread:true,labels:[]});
 assert.throws(()=>desiredState({...row(),labels:['Spam']},{...c,destination:'archive'}),/implicitly/);
 assert.throws(()=>desiredState({...row(),labels:['Trash']},{...c,destination:'inbox'}),/implicitly/);
});
test('snapshots/plans retain a subject fingerprint, not raw numeric codes or snippets', () => {
 const raw={...row(),subject:'Your code 123456 for access',snippet:'private body excerpt'};
 const b=createBatch(conn,{rows:[raw],query:'in:inbox',page:1});
 assert.ok(!b.rows[0].subject.includes('123456'));assert.ok(!JSON.stringify(b).includes('private body excerpt'));
 assert.match(b.rows[0].subject_hash,/^[a-f0-9]{64}$/);
 const p=plan(b,[{n:1,read:true}],[raw]);
 assert.ok(!p.entries[0].row.subject.includes('123456'));
 validatePlan(p,p.digest,conn.account);
});
test('terminal controls and bidi overrides cannot enter confirmation text',()=>{
 const escape=String.fromCharCode(27), bidi=String.fromCharCode(0x202e);
 const value=redact(`subject${escape}[31m ${bidi}evil`);
 assert.ok(!value.includes(escape));assert.ok(!value.includes(bidi));
});
test('numeric codes, secret assignments, keys and URL tokens are redacted', () => {
 const value=redact('code 123456 password: private AKIAABCDEFGHIJKLMNOP https://example.com/?token=secret&code=654321 123456789012');
 for (const secret of ['123456','private','AKIAABCDEFGHIJKLMNOP','token=secret','654321','123456789012']) assert.ok(!value.includes(secret));
});
