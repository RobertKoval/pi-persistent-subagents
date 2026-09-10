import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../src/index.ts';
import { decode } from '@toon-format/toon';
import { MetricsStore } from '../src/metrics.ts';
import { existsSync } from 'node:fs';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

async function harness(depth = 0, settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-adapter-'));
  await mkdir(join(root,'persistent-subagents'),{recursive:true});
  await writeFile(join(root,'persistent-subagents','config.json'),JSON.stringify(settings));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldScript = process.argv[1];
  const oldDepth = process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
  process.env.PI_PERSISTENT_SUBAGENT_DEPTH = String(depth);
  process.env.PI_CODING_AGENT_DIR = root;
  process.argv[1] = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const notifications: any[] = [];
  let entries: any[] = [];
  let active: string[] | undefined;
  let idle = true;
  const ctx: any = { isIdle: () => idle, hasPendingMessages: () => false, cwd: root, model: { provider: 'openai-codex', id: 'fake' }, thinkingLevel: 'low',
    sessionManager: { getSessionId: () => 'parent', getEntries: () => entries }, ui: { notify() {} } };
  extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand(name:string, command:any) { commands.set(name,command); },
    on: (name: string, fn: any) => events.set(name, fn), sendMessage(message: any, options: any) { notifications.push({message,options}); },
    getActiveTools: () => active ?? [...tools.keys()], setActiveTools(names: string[]) { active = names; } } as any);
  cleanups.push(async () => {
    await events.get('session_shutdown')?.({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    process.argv[1] = oldScript;
    if (oldDepth === undefined) delete process.env.PI_PERSISTENT_SUBAGENT_DEPTH; else process.env.PI_PERSISTENT_SUBAGENT_DEPTH = oldDepth;
    await rm(root, { recursive: true, force: true });
  });
  const call = (name: string, params: any, onUpdate?: (value: any) => void) => tools.get(name).execute('test', params, undefined, onUpdate, ctx);
  return { root, command:(args:string)=>commands.get('pmetrics').handler(args,ctx), event: (event:any) => events.get(event.type)?.(event,ctx), setIdle(value: boolean) { idle=value; }, notifications, call, start: () => events.get('session_start')({},ctx), active: () => active ?? [...tools.keys()], shutdown: () => events.get('session_shutdown')({},ctx), select(account: string) { entries = [{ type: 'custom', customType: 'pi-accounts-selection', data: { version: 1, sessionId: 'parent', providers: { 'openai-codex': account } } }]; } };
}

it('lists the same session path exposed by spawn after settling', async () => {
  const h = await harness();
  const spawned = (await h.call('spawn_agent', { task: 'hello' })).details;
  await h.call('wait_agent', { ids: [spawned.id], timeout_ms: 2000 });
  const listed = (decode((await h.call('list_agents', {verbose:true})).content[0].text) as any).agents[0];
  assert.equal(listed.session_file, spawned.sessionFile);
  assert.equal(listed.pid, spawned.pid);
  assert.equal(listed.status, 'idle');
});

it('seeds each new worker with its parent session account selection without copying credentials', async () => {
  const h = await harness();
  for (const account of ['test-work', 'test-other']) {
    h.select(account);
    const worker = (await h.call('spawn_agent', { task: 'hello' })).details;
    await h.call('wait_agent', { ids: [worker.id], timeout_ms: 2000 });
    const entries = (await readFile(worker.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
    const header = entries.find(e => e.type === 'session');
    const selection = entries.find(e => e.customType === 'pi-accounts-selection');
    assert.ok(selection, 'child must inherit session selection, not global default');
    assert.equal(selection.data.sessionId, header.id);
    assert.deepEqual(selection.data.providers, { 'openai-codex': account });
  }
});

for (const depth of [0,1,2]) {
  it(`exposes lifecycle tools only below the depth limit (depth ${depth})`, async () => {
    const h=await harness(depth); await h.start();
    assert.deepEqual(h.active(),depth===0 ? ['spawn_agent','send_input','wait_agent','list_agents','close_agent','resume_agent'] : []);
    if(depth>0) await assert.rejects(()=>h.call('spawn_agent',{task:'no'}),/depth limit/);
  });
}
it('session shutdown terminates the actual worker PID', async () => {
  const h=await harness();
  const w=(await h.call('spawn_agent',{task:'hello'})).details;
  await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  await h.shutdown();
  assert.throws(()=>process.kill(w.pid,0),{code:'ESRCH'});
});

for (const task of ['PRIVATE_OUTPUT_'.repeat(1000), '__PROVIDER_ERROR__']) {
  it(`sends a short completion signal that wakes the manager without steering (${task === '__PROVIDER_ERROR__' ? 'error' : 'success'}) and keeps results available on demand`, async () => {
    const h = await harness();
    const worker = (await h.call('spawn_agent', {task})).details;
    await eventually(()=>h.notifications.length===1);
    const {message,options} = h.notifications[0];
    const result=(await h.call('wait_agent',{ids:[worker.id],timeout_ms:2000})).details.statuses[worker.id];
    assert.ok(result.completionId);
    assert.equal(message.content, `Worker ${worker.id}: ${task === '__PROVIDER_ERROR__' ? 'error' : 'idle'} (result ${result.completionId}).\nUse wait_agent for unread results.`);
    assert.deepEqual(options,{triggerTurn:true});
    if(task==='__PROVIDER_ERROR__') assert.match(result.error,/usage limit/);
    else assert.equal(result.lastOutput,`ECHO:${task}`);
  });
}

it('returns compact TOON acknowledgements and lists, with full results and diagnostics only on request', async () => {
  const h=await harness();
  const task='multi-line output\nwith commas, quotes " and Unicode українська';
  const spawned=await h.call('spawn_agent',{task,model:'worker-model',name:'reviewer, "one"\nsecond line'});
  const w=spawned.details;
  await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  const sent=await h.call('send_input',{id:w.id,message:task});
  assert.deepEqual(decode(sent.content[0].text),{id:w.id,status:sent.details.status,pid:w.pid});
  const waited=await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  assert.deepEqual(decode(waited.content[0].text),{timed_out:false,agents:[{id:w.id,status:'idle',result_id:waited.details.statuses[w.id].completionId,error:null,output:`ECHO:${task}`}]});
  const list=decode((await h.call('list_agents',{})).content[0].text) as any;
  assert.deepEqual(list,{agents:[{id:w.id,name:'reviewer, "one"\nsecond line',status:'idle',pid:w.pid,model:'openai-codex/worker-model',error:null}]});
  const verbose=decode((await h.call('list_agents',{verbose:true})).content[0].text) as any;
  assert.equal(verbose.agents[0].session_file,w.sessionFile);
  assert.equal(verbose.agents[0].last_output,`ECHO:${task}`);
  const closed=decode((await h.call('close_agent',{id:w.id})).content[0].text);
  assert.deepEqual(closed,{id:w.id,status:'closed'});
  const resumed=await h.call('resume_agent',{id:w.id});
  assert.deepEqual(decode(resumed.content[0].text),{id:w.id,status:'idle',pid:resumed.details.pid,cache_continuity:'cold_process'});
});

it('retains provider failures and timeout state in compact wait results', async () => {
  const h=await harness();
  const w=(await h.call('spawn_agent',{task:'__SLOW__'})).details;
  const timeout=decode((await h.call('wait_agent',{ids:[w.id],timeout_ms:1})).content[0].text) as any;
  assert.equal(timeout.timed_out,true);
  assert.equal(timeout.agents[0].status,'running');
  await h.call('send_input',{id:w.id,message:'__PROVIDER_ERROR__',mode:'interrupt'});
  const result=decode((await h.call('wait_agent',{ids:[w.id],timeout_ms:2000})).content[0].text) as any;
  assert.match(result.agents[0].error,/usage limit/);
  assert.equal(result.agents[0].output,null);
});

async function eventually(check: () => boolean, timeout = 1500) {
  const end=Date.now()+timeout;
  while(!check() && Date.now()<end) await new Promise(r=>setTimeout(r,5));
  assert.ok(check(),'condition did not become true');
}
it('does not queue a wake-up while busy or wake later for a result already read', async () => {
  const h=await harness(); h.setIdle(false);
  const w=(await h.call('spawn_agent',{task:'ready'})).details;
  await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  assert.equal(h.notifications.length,0,'busy manager must not receive a queued follow-up');
  h.setIdle(true);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(h.notifications.length,0,'consumed completion must not wake the manager later');
});
it('preserves two completions before a read and batches one idle wake-up', async () => {
  const h=await harness(); h.setIdle(false);
  const w=(await h.call('spawn_agent',{task:'first'})).details;
  async function settle() {
    for(let i=0;i<200;i++) {
      const current=(await h.call('list_agents',{})).details[0];
      if(current.status==='idle')return current;
      await new Promise(r=>setTimeout(r,5));
    }
    assert.fail('worker did not settle');
  }
  const first=await settle();
  await h.call('send_input',{id:w.id,message:'second'});
  const second=await settle();
  assert.notEqual(first.completionId,second.completionId);
  assert.equal(h.notifications.length,0);
  h.setIdle(true); await eventually(()=>h.notifications.length===1);
  const read=await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  const body=decode(read.content[0].text) as any;
  assert.equal(body.agents[0].output,'ECHO:second');
  assert.equal(body.additional_results[0].output,'ECHO:first');
  assert.equal(body.additional_results[0].result_id,first.completionId);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(h.notifications.length,1);
});
it('keeps an unread completed result when newer work is closed and verbose-listed', async () => {
 const h=await harness();h.setIdle(false);
 const w=(await h.call('spawn_agent',{task:'unread A'})).details;
 for(let i=0;i<200;i++) {
  if((await h.call('list_agents',{})).details[0].status==='idle')break;
  await new Promise(r=>setTimeout(r,5));
 }
 await h.call('send_input',{id:w.id,message:'__SLOW__'});
 await h.call('close_agent',{id:w.id});
 await h.call('list_agents',{verbose:true});
 const read=decode((await h.call('wait_agent',{ids:[w.id],timeout_ms:2000})).content[0].text) as any;
 assert.equal(read.additional_results?.[0]?.output,'ECHO:unread A');
 assert.equal(read.agents[0].result_id,null,'unfinished work must not claim the earlier completion ID');
});

for(const trackWorkers of [false,true]) for(const trackMain of [false,true]) {
  it(`independently configures worker=${trackWorkers} and main=${trackMain} accounting`,async()=>{
    const h=await harness(0,{metricsWorkers:trackWorkers,metricsMain:trackMain}); await h.start();
    await h.event({type:'agent_start'});await h.event({type:'turn_start'});
    const msg={role:'assistant',timestamp:1,provider:'openai',model:'test',stopReason:'stop',usage:{input:1,output:2},content:[{text:'DO_NOT_STORE'}]};
    await h.event({type:'message_start',message:msg});await h.event({type:'message_end',message:msg});await h.event({type:'agent_end'});
    const w=(await h.call('spawn_agent',{task:'DO_NOT_STORE'})).details;
    await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});await h.shutdown();
    const path=join(h.root,'persistent-subagents','metrics.sqlite');
    if(!trackWorkers&&!trackMain){assert.equal(existsSync(path),false);return;}
    const store=new MetricsStore(path);const report=store.report({from:0,to:Date.now()+1000});store.close();
    assert.equal(report.calls.filter(c=>c.role==='main').length,Number(trackMain));
    assert.equal(report.calls.filter(c=>c.role==='worker').length,Number(trackWorkers));
    assert.doesNotMatch(await readFile(path,'utf8'),/DO_NOT_STORE/);
  });
}

it('toggles tracking without killing workers and persists the setting',async()=>{
  const h=await harness(0,{metricsWorkers:false,metricsMain:false});await h.start();
  const w=(await h.call('spawn_agent',{task:'first'})).details;await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  await h.command('workers on');
  const second=(await h.call('send_input',{id:w.id,message:'second'})).details;assert.equal(second.pid,w.pid);
  await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  await h.command('workers off');await h.call('send_input',{id:w.id,message:'third'});await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  assert.equal(JSON.parse(await readFile(join(h.root,'.pi','persistent-subagents.json'),'utf8')).metricsWorkers,false);
  await h.shutdown();const s=new MetricsStore(join(h.root,'persistent-subagents','metrics.sqlite'));
  assert.equal(s.report({from:0,to:Date.now()+1000}).calls.length,1);s.close();
});

for(const enabled of [false,true])it(`records main compactions only with tracking enabled=${enabled}`,async()=>{
  const h=await harness(0,{metricsWorkers:false,metricsMain:enabled});await h.start();
  await h.event({type:'session_before_compact',reason:'manual'});
  await h.event({type:'session_compact',reason:'manual',fromExtension:false,compactionEntry:{id:'compact1',usage:{input:5,output:3,cacheRead:2,cacheWrite:0},summary:'PRIVATE_SUMMARY'}});
  await h.shutdown();const path=join(h.root,'persistent-subagents','metrics.sqlite');
  if(!enabled){assert.equal(existsSync(path),false);return;}
  const s=new MetricsStore(path);const r=s.report({from:0,to:Date.now()+1000});s.close();
  assert.equal(r.compactions.length,1);assert.equal(r.compactions[0].usage.output,3);
  assert.doesNotMatch(await readFile(path,'utf8'),/PRIVATE_SUMMARY/);
});

it('applies global defaults live while honoring project overrides and inherit',async()=>{
  const h=await harness(0,{metricsWorkers:false,metricsMain:false});await h.start();
  await h.command('global workers on');
  assert.equal(JSON.parse(await readFile(join(h.root,'persistent-subagents','config.json'),'utf8')).metricsWorkers,true);
  const w=(await h.call('spawn_agent',{task:'first'})).details;await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  await h.command('project workers off');await h.command('global workers on');
  await h.call('send_input',{id:w.id,message:'untracked'});await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});
  await h.command('project workers inherit');
  const next=(await h.call('send_input',{id:w.id,message:'tracked'})).details;assert.equal(next.pid,w.pid);
  await h.call('wait_agent',{ids:[w.id],timeout_ms:2000});await h.shutdown();
  const store=new MetricsStore(join(h.root,'persistent-subagents','metrics.sqlite'));
  assert.equal(store.report({from:0,to:Date.now()+1000}).calls.length,2);store.close();
  assert.equal('metricsWorkers' in JSON.parse(await readFile(join(h.root,'.pi','persistent-subagents.json'),'utf8')),false);
});


it('shows wait progress only through UI updates and stops updating after timeout', async () => {
  const h = await harness();
  const worker = (await h.call('spawn_agent', {task:'__SLOW__'})).details;
  const updates: any[] = [];
  const result = await h.call('wait_agent', {ids:[worker.id], timeout_ms:100}, value => updates.push(value));
  assert.ok(updates.length > 0, 'waiting must show immediate UI progress');
  assert.match(updates[0].content[0].text, /Waiting/);
  assert.match(updates[0].content[0].text, new RegExp(worker.id));
  assert.match(updates[0].content[0].text, /activity/);
  assert.equal(result.details.timedOut, true);
  assert.doesNotMatch(result.content[0].text, /Waiting|activity/);
  const count = updates.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(updates.length, count, 'finished waits must release their update timer');
});


it('refreshes elapsed wait time and releases the timer when a worker settles', async () => {
  const h = await harness();
  const worker = (await h.call('spawn_agent', {task:'__WAIT_UI__'})).details;
  const updates: any[] = [];
  const result = await h.call('wait_agent', {ids:[worker.id], timeout_ms:3000}, value => updates.push(value));
  assert.ok(updates.length >= 2);
  assert.match(updates[0].content[0].text, /Waiting 0s/);
  assert.match(updates[1].content[0].text, /Waiting 1s/);
  assert.equal(result.details.timedOut, false);
  assert.match(result.content[0].text, /ECHO:__WAIT_UI__/);
  assert.doesNotMatch(result.content[0].text, /Waiting|activity/);
  const count = updates.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(updates.length, count);
});
