import {it,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetricsStore,MetricsRecorder,metricsIdentity} from '../src/metrics.ts';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'pi-coverage-')),path=join(dir,'m.sqlite'),store=new MetricsStore(path);let now=1000;
  const recorder=new MetricsRecorder(store,metricsIdentity('/private','session','worker'),()=>now);
  cleanup.push(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,recorder,path,time:(t:number)=>now=t,report:()=>store.report({from:0,to:10000})};
}
const usage={input:20,output:10,cacheRead:60,cacheWrite:20,totalTokens:110,cost:{total:.1}};
function message(timestamp=1,provider='openai',api='openai-responses'){
  return {role:'assistant',timestamp,provider,api,model:'test',stopReason:'stop',usage};
}
for(const [provider,api] of [['openai','openai-responses'],['openai','openai-completions'],['openai-codex','openai-codex-responses'],['anthropic','anthropic-messages']]){
  it(`uses certified normalized cache fields for ${provider}/${api}`,()=>{
    const f=fixture();f.recorder.event({type:'message_end',message:message(1,provider,api)});
    const r=f.report();assert.equal(r.calls[0].cache_hit_ratio,.6);assert.equal(r.daily[0].cache_hit_ratio,.6);
    assert.deepEqual(r.calls[0].usage,usage);
  });
}
for(const values of [{input:0,cacheRead:0,cacheWrite:0,expected:null},{input:1,cacheRead:0,cacheWrite:0,expected:0},{input:0,cacheRead:1,cacheWrite:0,expected:1},{input:-1,cacheRead:1,cacheWrite:0,expected:null}]){
  it(`handles cache ratio boundary ${JSON.stringify(values)}`,()=>{
    const f=fixture();f.recorder.event({type:'message_end',message:{...message(),usage:{input:values.input,cacheRead:values.cacheRead,cacheWrite:values.cacheWrite}}});
    assert.equal(f.report().calls[0].cache_hit_ratio,values.expected);
  });
}
it('does not certify unknown providers, legacy rows or mixed-provider daily ratios',()=>{
  const f=fixture();f.recorder.event({type:'message_end',message:message()});
  f.recorder.event({type:'message_end',message:message(2,'custom','openai-responses')});
  f.recorder.event({type:'message_end',message:{...message(3),api:undefined}});
  const r=f.report();assert.equal(r.calls[1].cache_hit_ratio,null);assert.equal(r.calls[2].cache_hit_ratio,null);
  assert.equal(r.daily[0].cache_hit_ratio,null);assert.equal(r.daily[0].cache_ratio_unavailable,2);
});
it('treats provider names matching object properties as unknown rather than dropping telemetry',()=>{
  const f=fixture();for(const [i,provider] of ['constructor','toString','__proto__'].entries())f.recorder.event({type:'message_end',message:message(i+1,provider)});
  const r=f.report();assert.equal(r.calls.length,3);assert.ok(r.calls.every(c=>c.cache_hit_ratio===null));
});
it('records compaction usage once without pretending it is a single model call',()=>{
  const f=fixture();
  f.recorder.event({type:'compaction_start',reason:'threshold'});
  f.time(2000);
  const end={type:'compaction_end',reason:'threshold',aborted:false,result:{usage,summary:'PRIVATE_SUMMARY',details:{secret:'PRIVATE_DETAILS'}}};
  f.recorder.event(end);f.recorder.event(end);
  const r=f.report();assert.equal(r.compactions.length,1);assert.equal(r.calls.length,0);
  assert.equal(r.daily[0].output,10);assert.equal(r.daily[0].api_equivalent,.1);
  assert.equal(r.daily[0].model_calls,0);assert.equal(r.daily[0].compactions,1);assert.equal(r.daily[0].compaction_ms,1000);
  assert.equal(r.capacity.output_tokens,10);assert.equal(r.concurrency.peak,0);
  assert.equal(r.compactions[0].observed_tps,null);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
  for(const suffix of ['','-wal'])assert.doesNotMatch(readFileSync(f.path+suffix).toString(),/PRIVATE_/);
});
it('deduplicates main compaction by entry ID and excludes unknown extension model attribution',()=>{
  const f=fixture();
  for(let i=0;i<2;i++){
    f.recorder.event({type:'session_before_compact',reason:'manual'});f.time(2000);
    f.recorder.event({type:'session_compact',fromExtension:true,compactionEntry:{id:'same',timestamp:'2026-01-01',usage,summary:'SECRET'}});
  }
  const r=f.report();assert.equal(r.compactions.length,1);assert.equal(r.compactions[0].provider,'unknown');
  assert.equal(r.daily[0].output,10);
});
it('preserves a cancelled compaction without fabricated usage',()=>{
  const f=fixture();f.recorder.event({type:'session_before_compact',reason:'manual'});f.time(2000);
  f.recorder.event({type:'session_compact_failed',aborted:true,errorMessage:'PRIVATE_ERROR'});
  const r=f.report();assert.equal(r.compactions[0].status,'aborted');assert.equal(r.compactions[0].usage,null);
  assert.equal(r.daily[0].output,null);assert.equal(r.daily[0].missing_usage_calls,1);
});
it('measures observed retry backoff separately and retains each attempt usage',()=>{
  const f=fixture();f.recorder.event({type:'agent_start'});f.recorder.event({type:'turn_start'});
  f.recorder.event({type:'message_start',message:message()});f.time(1500);
  f.recorder.event({type:'message_end',message:{...message(),stopReason:'error'}});
  f.recorder.event({type:'agent_end',willRetry:true});
  const retry={type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:1000,errorMessage:'PRIVATE_ERROR'};
  f.recorder.event(retry);f.recorder.event(retry);f.time(2500);
  f.recorder.event({type:'agent_start'});f.recorder.event({type:'turn_start'});f.recorder.event({type:'message_start',message:message(2)});
  f.time(3000);f.recorder.event({type:'message_end',message:message(2)});f.recorder.event({type:'auto_retry_end',success:true,attempt:1});f.recorder.event({type:'agent_settled'});
  const r=f.report();assert.equal(r.calls.length,2);assert.equal(r.daily[0].output,20);assert.equal(r.retries.length,1);
  assert.equal(r.retries[0].end_ms-r.retries[0].start_ms,1000);assert.equal(r.tasks.length,1);
  assert.equal(r.tasks[0].retry_ms,1000);assert.equal(r.tasks[0].model_ms,1000);assert.equal(r.tasks[0].tool_ms,0);
  assert.equal(r.tasks[0].other_ms,0);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_ERROR/);
});
it('separates summarization retry wait from compaction operation time without double-counting usage',()=>{
  const f=fixture();f.recorder.event({type:'compaction_start',reason:'threshold'});f.time(1500);
  f.recorder.event({type:'summarization_retry_scheduled',attempt:1,maxAttempts:2,delayMs:1000});f.time(2500);
  f.recorder.event({type:'summarization_retry_attempt_start',source:'compaction',reason:'threshold'});f.time(3000);
  f.recorder.event({type:'compaction_end',result:{usage},aborted:false});
  const r=f.report();assert.equal(r.retries.length,1);assert.equal(r.retries[0].scope,'compaction');
  assert.equal(r.daily[0].output,10);assert.equal(r.daily[0].retry_ms,1000);assert.equal(r.daily[0].compaction_ms,2000);
});
it('counts a fresh retry episode after a successful turn resets Pi attempt numbering',()=>{
  const f=fixture();f.recorder.event({type:'agent_start'});
  for(let i=1;i<=2;i++){
    f.time(i*2000);f.recorder.event({type:'turn_start'});f.recorder.event({type:'message_end',message:{...message(i*2),stopReason:'error'}});
    f.recorder.event({type:'auto_retry_start',attempt:1,delayMs:100});f.time(i*2000+100);
    f.recorder.event({type:'turn_start'});f.recorder.event({type:'message_end',message:message(i*2+1)});
    f.recorder.event({type:'auto_retry_end',success:true});
  }
  f.recorder.event({type:'agent_settled'});assert.equal(f.report().retries.length,2);assert.equal(f.report().daily[0].retry_ms,200);
});
it('filters retry intervals by the actual failed call model',()=>{
  const f=fixture();f.recorder.event({type:'agent_start'});f.recorder.event({type:'message_end',message:{...message(),stopReason:'error'}});
  f.recorder.event({type:'auto_retry_start',attempt:1,delayMs:100});f.time(1100);f.recorder.event({type:'auto_retry_end',success:false});
  const r=f.store.report({from:0,to:10000,model:'nonexistent'});
  assert.equal(r.retries.length,0);assert.equal(r.daily.length,0);
});
it('keeps RPC compaction attribution unknown because its event omits extension provenance',()=>{
  const f=fixture();f.recorder.event({type:'message_end',message:message()});
  f.recorder.event({type:'compaction_start',reason:'manual'});f.time(2000);
  f.recorder.event({type:'compaction_end',result:{usage},aborted:false});
  const c=f.report().compactions[0];assert.equal(c.provider,'unknown');assert.equal(c.cache_hit_ratio,null);
});
