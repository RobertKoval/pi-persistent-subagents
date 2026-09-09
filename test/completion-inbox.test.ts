import {it} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionInbox} from '../src/completion-inbox.ts';
import type {WorkerSnapshot} from '../src/pool.ts';
const pause=()=>new Promise(r=>setTimeout(r,90));
function result(completionId:string, lastOutput='same'):WorkerSnapshot {
  return {id:'worker',completionId,lastOutput,status:'idle',alive:true,pid:123,sessionFile:'/tmp/session',cwd:'/tmp',createdAt:0,updatedAt:0,lastUsedAt:0,taskPreview:'task',usage:{input:0,output:1,cacheRead:0,cacheWrite:0,turns:1},cacheContinuity:'warm_process',depth:1};
}
it('deduplicates the same event but preserves identical text from distinct completions',async()=>{
 const delivered:WorkerSnapshot[][]=[];
 const box=new CompletionInbox({ready:()=>true,deliver:s=>delivered.push(s),notify:true});
 try {
  const first=result('one');box.publish(first);box.publish(first);
  await pause();assert.equal(delivered.length,1);assert.equal(delivered[0].length,1);
  box.consume([first],true);box.publish(first);await pause();assert.equal(delivered.length,1);
  box.publish(result('two'));await pause();assert.equal(delivered.length,2);
 }finally{box.dispose();}
});
it('retains immutable output while the next task runs, without marking unseen results consumed',async()=>{
 const box=new CompletionInbox({ready:()=>false,deliver:()=>assert.fail(),notify:true});
 try {
  const original=result('one','original');box.publish(original);original.lastOutput='mutated';
  const running={...original,status:'running' as const,lastOutput:null};
  assert.deepEqual(box.consume([running],false),[]);
  assert.equal(box.consume([running],true)[0].lastOutput,'original');
 }finally{box.dispose();}
});
it('verbose retrieval consumes only the returned revision, and shutdown cancels pending wakeups',async()=>{
 let ready=false;const delivered:WorkerSnapshot[][]=[];
 const box=new CompletionInbox({ready:()=>ready,deliver:s=>delivered.push(s),notify:true});
 const first=result('one');const second=result('two');box.publish(first);box.publish(second);
 assert.deepEqual(box.consume([second],false).map(s=>s.completionId),['two']);
 ready=true;await pause();assert.deepEqual(delivered[0].map(s=>s.completionId),['one']);
 box.publish(result('three'));box.dispose();await pause();assert.equal(delivered.length,1);
});
it('disabled notifications retain on-demand results without waking the manager',async()=>{
 const box=new CompletionInbox({ready:()=>true,deliver:()=>assert.fail(),notify:false});
 try {const s=result('one');box.publish(s);await pause();assert.equal(box.consume([s],true)[0].completionId,'one');}
 finally{box.dispose();}
});
