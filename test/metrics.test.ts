import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MetricsStore, MetricsRecorder, metricsIdentity, concurrency } from '../src/metrics.ts';

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive:true,force:true}); });
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'pi-metrics-')); roots.push(dir);
  const path=join(dir,'metrics.sqlite'); const store=new MetricsStore(path);
  let now=1000;
  const identity=metricsIdentity('/private/project','session','worker','main');
  const recorder=new MetricsRecorder(store,identity,()=>now);
  return {path,store,recorder,identity,time:(n:number)=>{now=n;}};
}
const message=(timestamp=1,stopReason='stop')=>({role:'assistant',timestamp,provider:'openai',model:'test',stopReason,
  content:[{type:'text',text:'SECRET_RESPONSE'}],usage:{input:10,output:20,cacheRead:30,cacheWrite:5,reasoning:4,totalTokens:65,cost:{input:.1,output:.2,cacheRead:.03,cacheWrite:.01,total:.34}}});
it('restricts the database and WAL sidecars to the owner',()=>{
  const f=fixture();try{for(const suffix of ['','-wal','-shm'])assert.equal(statSync(f.path+suffix).mode&0o777,0o600);}finally{f.store.close();}
});
function begin(f:ReturnType<typeof fixture>,timestamp=1) {
  f.recorder.event({type:'agent_start'}); f.recorder.event({type:'turn_start'});
  f.time(1100); f.recorder.event({type:'message_start',message:message(timestamp)});
}
it('stores per-call raw numeric usage, stream observations, wait/tool spans and immutable cost',()=>{
  const f=fixture(); begin(f);
  for (const t of [1200,2200]) { f.time(t); f.recorder.event({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'SECRET_FRAGMENT'}}); }
  f.time(2300); f.recorder.event({type:'message_end',message:message()});
  f.recorder.event({type:'tool_execution_start',toolCallId:'tool1',toolName:'wait_agent',args:{secret:'SECRET_ARGS'}});
  f.time(3300); f.recorder.event({type:'tool_execution_end',toolCallId:'tool1',result:'SECRET_OUTPUT'});
  f.recorder.event({type:'agent_end'});
  const r=f.store.report({from:1000,to:4000});
  assert.equal(r.calls.length,1); assert.equal(r.calls[0].usage.output,20);
  assert.equal(r.calls[0].usage.reasoning,4); assert.equal(r.calls[0].observed_tps,20);
  assert.equal(r.calls[0].model_ms,1300); assert.equal(r.calls[0].ttff_ms,200);
  assert.equal(r.tasks[0].wait_ms,1000); assert.equal(r.tasks[0].model_ms,1300);
  assert.equal(r.tasks[0].duty_cycle,1300/2300);
  assert.equal(r.calls[0].price.total,.34); assert.ok(r.calls[0].price.source);
  assert.equal(r.calls[0].cache_hit_ratio,null);
  f.store.close();
  assert.doesNotMatch(readFileSync(f.path).toString(),/SECRET_|private\/project/);
});
it('deduplicates completion events across recorder instances and session reopen',()=>{
  const f=fixture(); begin(f); f.time(2000);
  f.recorder.event({type:'message_end',message:message()});
  f.recorder.event({type:'message_end',message:message()}); f.recorder.close(); f.store.close();
  const store=new MetricsStore(f.path); const other=new MetricsRecorder(store,f.identity,()=>5000);
  other.event({type:'message_end',message:message()});
  assert.equal(store.report({from:0,to:6000}).calls.length,1);
  assert.equal(store.report({from:0,to:6000}).daily[0].output,20); other.close(); store.close();
});
it('deduplicates the complete lifecycle on session replay, including task hours',()=>{
  const f=fixture();
  for(let i=0;i<2;i++){
    f.time(1000);begin(f);f.time(2000);f.recorder.event({type:'message_end',message:message()});f.recorder.event({type:'agent_end'});
  }
  const r=f.store.report({from:0,to:3000});
  assert.equal(r.calls.length,1);assert.equal(r.tasks.length,1);assert.equal(r.daily[0].worker_hours,1000/3600000);f.store.close();
});
it('clips task accounting to the selected report window',()=>{
  const f=fixture();begin(f);f.time(2000);f.recorder.event({type:'message_end',message:message()});
  f.time(3000);f.recorder.event({type:'turn_start'});f.recorder.event({type:'message_start',message:message(2)});
  f.time(4000);f.recorder.event({type:'message_end',message:message(2)});f.time(5000);f.recorder.event({type:'agent_end'});
  const t=f.store.report({from:2500,to:5000}).tasks[0];
  assert.equal(t.wall_ms,2500);assert.equal(t.model_ms,1000);assert.equal(t.other_ms,1500);f.store.close();
});
for (const reason of ['error','aborted']) it(`keeps ${reason} usage without inventing missing fields`,()=>{
  const f=fixture(); begin(f); f.time(2000);
  f.recorder.event({type:'message_end',message:{...message(1,reason),usage:undefined}});
  const call=f.store.report({from:0,to:3000}).calls[0];
  assert.equal(call.status,reason); assert.equal(call.usage,null); assert.equal(call.observed_tps,null);
  const day=f.store.report({from:0,to:3000}).daily[0];
  assert.equal(day.output,null);assert.equal(day.api_equivalent,null);
  f.recorder.close(); f.store.close();
});
it('splits durations at UTC midnight but attributes usage once at completion',()=>{
  const f=fixture(),midnight=Date.parse('2026-01-02T00:00:00Z');
  f.time(midnight-1000);f.recorder.event({type:'agent_start'});f.recorder.event({type:'turn_start'});f.recorder.event({type:'message_start',message:message()});
  f.time(midnight+1000);f.recorder.event({type:'message_end',message:message()});f.recorder.event({type:'agent_end'});
  const r=f.store.report({from:midnight-2000,to:midnight+2000});
  assert.deepEqual(r.daily.map(d=>d.model_call_ms),[1000,1000]);assert.deepEqual(r.daily.map(d=>d.output),[0,20]);
  assert.equal(f.store.report({from:midnight+1000,to:midnight+1001}).daily[0].output,20);
  assert.equal(f.store.report({from:midnight-2000,to:midnight+1000}).daily.reduce((n,d)=>n+(d.output??0),0),0);f.store.close();
});
it('does not revise historical prices or invent throughput for a single fragment',()=>{
  const f=fixture();begin(f);f.time(1500);f.recorder.event({type:'message_update',assistantMessageEvent:{type:'text_delta'}});
  f.time(2000);f.recorder.event({type:'message_end',message:message()});
  const updated=message();updated.usage.cost.total=100;
  f.recorder.event({type:'message_end',message:updated});
  const call=f.store.report({from:0,to:3000}).calls[0];assert.equal(call.price.total,.34);assert.equal(call.observed_tps,null);f.recorder.close();f.store.close();
});
it('closes interrupted calls and tasks, preserving an unknown usage',()=>{
  const f=fixture(); begin(f); f.time(2000); f.recorder.close();
  const r=f.store.report({from:0,to:3000});
  assert.equal(r.calls[0].status,'interrupted'); assert.equal(r.calls[0].end_ms,2000);
  assert.equal(r.calls[0].usage,null); assert.equal(r.tasks[0].end_ms,2000); f.store.close();
});
it('uses time-weighted concurrency, half-open boundaries and zero intervals',()=>{
  const r=concurrency([{start:0,end:10},{start:5,end:15},{start:15,end:20},{start:20,end:20}],0,25);
  assert.equal(r.peak,2); assert.equal(r.average,1); assert.equal(r.p95,2);
  assert.deepEqual(r.distribution,[{concurrency:0,ms:5},{concurrency:1,ms:15},{concurrency:2,ms:5}]);
  assert.equal(concurrency([{start:0,end:10},{start:10,end:20}],0,20).peak,1);
  assert.equal(concurrency([],0,20).average,0);
  assert.equal(concurrency([],0,0).average,null);
});
it('does not force overlapping tool and model intervals to sum to task wall time',()=>{
  const f=fixture(); begin(f);
  f.recorder.event({type:'tool_execution_start',toolCallId:'a',toolName:'bash'});
  f.time(2000); f.recorder.event({type:'message_end',message:message()});
  f.time(2500); f.recorder.event({type:'tool_execution_end',toolCallId:'a'});
  f.time(3000); f.recorder.event({type:'agent_end'});
  const task=f.store.report({from:0,to:4000}).tasks[0];
  assert.equal(task.model_ms,1000); assert.equal(task.tool_ms,1400);
  assert.equal(task.other_ms,500); assert.equal(task.wall_ms,2000); f.store.close();
});
it('two separate processes safely share SQLite and cannot double count the same response',async()=>{
  const f=fixture(); f.store.close();
  const module=new URL('../src/metrics.ts',import.meta.url).href;
  const code=`import {MetricsStore,MetricsRecorder,metricsIdentity} from ${JSON.stringify(module)};
    const s=new MetricsStore(process.argv[1]);const r=new MetricsRecorder(s,metricsIdentity('/p','same','worker','main'));
    for(let i=1;i<=30;i++)r.event({type:'message_end',message:{role:'assistant',timestamp:i,provider:'p',model:'m',stopReason:'stop',usage:{input:1,output:2}}});r.close();s.close();`;
  const run=()=>new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,f.path]);let err='';p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error(err)));});
  await Promise.all([run(),run()]); const s=new MetricsStore(f.path);
  assert.equal(s.report({from:0,to:Date.now()+1000}).calls.length,30); s.close();
});
