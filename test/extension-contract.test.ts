import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../src/index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

async function harness(depth = 0) {
  const root = await mkdtemp(join(tmpdir(), 'pi-adapter-'));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldScript = process.argv[1];
  const oldDepth = process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
  process.env.PI_PERSISTENT_SUBAGENT_DEPTH = String(depth);
  process.env.PI_CODING_AGENT_DIR = root;
  process.argv[1] = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const notifications: any[] = [];
  let entries: any[] = [];
  let active: string[] | undefined;
  const ctx: any = { cwd: root, model: { provider: 'openai-codex', id: 'fake' }, thinkingLevel: 'low',
    sessionManager: { getSessionId: () => 'parent', getEntries: () => entries }, ui: { notify() {} } };
  extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {},
    on: (name: string, fn: any) => events.set(name, fn), sendMessage(message: any, options: any) { notifications.push({message,options}); },
    getActiveTools: () => active ?? [...tools.keys()], setActiveTools(names: string[]) { active = names; } } as any);
  cleanups.push(async () => {
    await events.get('session_shutdown')?.({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    process.argv[1] = oldScript;
    if (oldDepth === undefined) delete process.env.PI_PERSISTENT_SUBAGENT_DEPTH; else process.env.PI_PERSISTENT_SUBAGENT_DEPTH = oldDepth;
    await rm(root, { recursive: true, force: true });
  });
  const call = (name: string, params: any) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  return { notifications, call, start: () => events.get('session_start')({},ctx), active: () => active ?? [...tools.keys()], shutdown: () => events.get('session_shutdown')({},ctx), select(account: string) { entries = [{ type: 'custom', customType: 'pi-accounts-selection', data: { version: 1, sessionId: 'parent', providers: { 'openai-codex': account } } }]; } };
}

it('lists the same session path exposed by spawn after settling', async () => {
  const h = await harness();
  const spawned = (await h.call('spawn_agent', { task: 'hello' })).details;
  await h.call('wait_agent', { ids: [spawned.id], timeout_ms: 2000 });
  const listed = JSON.parse((await h.call('list_agents', {})).content[0].text)[0];
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
  it(`sends a short passive completion signal (${task === '__PROVIDER_ERROR__' ? 'error' : 'success'}) and keeps results available on demand`, async () => {
    const h = await harness();
    const worker = (await h.call('spawn_agent', {task})).details;
    await h.call('wait_agent', {ids:[worker.id],timeout_ms:2000});
    assert.equal(h.notifications.length,1);
    const {message,options} = h.notifications[0];
    assert.equal(message.content, `Worker ${worker.id}: ${task === '__PROVIDER_ERROR__' ? 'error' : 'idle'}. Use wait_agent for its result.`);
    assert.deepEqual(options,{triggerTurn:false});
    const result=(await h.call('wait_agent',{ids:[worker.id],timeout_ms:2000})).details.statuses[worker.id];
    if(task==='__PROVIDER_ERROR__') assert.match(result.error,/usage limit/);
    else assert.equal(result.lastOutput,`ECHO:${task}`);
  });
}
