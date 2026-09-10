// Opt-in: uses the installed Pi and authenticated provider. Never opens an existing session.
import { PersistentPiRpcClient } from '../src/rpc-client.ts';
import { MetricsStore, metricId } from '../src/metrics.ts';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..'),work=await mkdtemp(join(tmpdir(),'pi-metrics-live-'));
const coverage=process.argv.includes('--compaction');
const db=join(work,'metrics.sqlite'),clients=[],sessions=[],workers=[];
const agentDir=process.env.PI_CODING_AGENT_DIR||join(homedir(),'.pi','agent');
const accounts=process.env.PI_TEST_ACCOUNTS_EXTENSION||join(agentDir,'npm/node_modules/@narumitw/pi-accounts');
const provider=process.env.PI_TEST_PROVIDER||'openai-codex',model=process.env.PI_TEST_MODEL||'gpt-5.6-luna';
await mkdir(join(work,'.pi'));await writeFile(join(work,'.pi','persistent-subagents.json'),JSON.stringify({metricsWorkers:true,metricsMain:true,notifyOnSettled:false}));
if(coverage)await writeFile(join(work,'.pi','settings.json'),JSON.stringify({compaction:{keepRecentTokens:100}}));
let sequence=0;
async function probe(client,tool,params={}){
  const id=String(++sequence);await client.prompt('/probe '+JSON.stringify({id,tool,params}));
  const messages=(await client.request({type:'get_messages'})).data.messages;
  const response=JSON.parse(messages.filter(m=>m.customType==='probe-result').at(-1).content);
  assert.equal(response.id,id);assert.ok(!response.error,response.error);return response.result;
}
try{
  for(let i=0;i<2;i++){
    const c=new PersistentPiRpcClient({command:'pi',args:['--no-extensions',...(existsSync(accounts)?['-e',accounts]:[]),'-e',join(root,'test/fakes/probe-extension.ts'),'--mode','rpc','--session',join(work,`parent-${i}.jsonl`),'--provider',provider,'--model',model,'--thinking','low','--offline','--no-context-files','--approve'],cwd:work,env:{...process.env,PI_PERSISTENT_SUBAGENTS_METRICS_DB:db,...(coverage?{PI_METRICS_TEST_TRUST_PROJECT:'1'}:{})},startupTimeoutMs:30000,commandTimeoutMs:120000,shutdownGraceMs:10000});
    clients.push(c);sessions.push((await c.start()).sessionId);
  }
  await Promise.all(clients.map(async(c)=>{
    const w=(await probe(c,'spawn_agent',{model,task:'Do not use tools. Write the integers 1 through 60 separated by spaces.'})).details;workers.push(w);
    await c.prompt(`Call wait_agent for worker ${w.id} with timeout_ms 120000. Then reply only OK. Do not call other tools.`);
    await c.waitForIdle(120000);
    const first=(await probe(c,'list_agents',{verbose:true})).details[0];
    await probe(c,'send_input',{id:w.id,message:'Do not use tools. Write the integers 61 through 120 separated by spaces.'});
    await probe(c,'wait_agent',{ids:[w.id],timeout_ms:120000});
    const second=(await probe(c,'list_agents',{verbose:true})).details[0];assert.equal(first.pid,second.pid);
  }));
  if(coverage){
    const worker=(await probe(clients[0],'list_agents',{verbose:true})).details[0];
    await probe(clients[0],'compact-worker',{pid:worker.pid});
    await clients[0].request({type:'compact'});
  }
  const parentEntries=await Promise.all(clients.map(async(_,i)=>(await readFile(join(work,`parent-${i}.jsonl`),'utf8')).trim().split('\n').map(JSON.parse)));
  const parentMessages=parentEntries.map(entries=>entries.filter(e=>e.type==='message'&&e.message?.role==='assistant').map(e=>e.message));
  const childMessages=await Promise.all(workers.map(async w=>(await readFile(w.sessionFile,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.type==='message'&&e.message?.role==='assistant').map(e=>e.message)));
  await Promise.all(clients.map(c=>c.stop()));
  const store=new MetricsStore(db),report=store.report({from:0,to:Date.now()+1000});store.close();
  for(const [role,messages] of [['main',parentMessages.flat()],['worker',childMessages.flat()]]){
    const calls=report.calls.filter(c=>c.role===role);assert.equal(calls.length,messages.length,role+' call count');
    for(const field of ['input','output','cacheRead','cacheWrite'])assert.equal(calls.reduce((n,c)=>n+(c.usage?.[field]??0),0),messages.reduce((n,m)=>n+(m.usage?.[field]??0),0),role+' '+field);
  }
  assert.equal(new Set(report.actors.map(a=>a.project_id)).size,1);
  assert.equal(report.calls.filter(c=>c.role==='worker').length,4);
  assert.ok(report.tools.some(t=>t.tool==='wait_agent'));
  assert.ok(report.calls.every(c=>c.start_ms!==null&&c.end_ms!==null));
  assert.ok(report.calls.some(c=>c.observed_tps!==null));
  assert.ok(report.concurrency.peak>=2);
  if(coverage){
    const workerEntries=await Promise.all(workers.map(async w=>(await readFile(w.sessionFile,'utf8')).trim().split('\n').map(JSON.parse)));
    const compactions=[...parentEntries.flat(),...workerEntries.flat()].filter(e=>e.type==='compaction');
    assert.equal(compactions.length,2);assert.equal(report.compactions.length,2);
    for(const field of ['input','output','cacheRead','cacheWrite'])assert.equal(report.compactions.reduce((n,c)=>n+(c.usage?.[field]??0),0),compactions.reduce((n,c)=>n+(c.usage?.[field]??0),0),'compaction '+field);
    for(const c of report.calls){
      assert.ok(c.cache_semantics);const denominator=c.usage.input+c.usage.cacheRead+c.usage.cacheWrite;
      assert.equal(c.cache_hit_ratio,denominator>0?c.usage.cacheRead/denominator:null);
    }
  }
  for(const w of workers)assert.throws(()=>process.kill(w.pid,0),{code:'ESRCH'});
  console.log(JSON.stringify({passed:true,compactions:report.compactions.length,parents:2,workerCalls:4,samePid:true,usageMatchesSessionLogs:true,peakConcurrency:report.concurrency.peak,cacheRead:report.calls.reduce((n,c)=>n+(c.usage?.cacheRead??0),0),observedStreamCalls:report.calls.filter(c=>c.observed_tps!==null).length,workersGone:true}));
}finally{
  await Promise.allSettled(clients.map(c=>c.stop()));
  for(const session of sessions){const {createHash}=await import('node:crypto');const scope='parent-'+createHash('sha256').update(session).digest('hex').slice(0,16);await rm(join(agentDir,'persistent-subagents','parents',scope),{recursive:true,force:true});}
  await rm(work,{recursive:true,force:true});
}
