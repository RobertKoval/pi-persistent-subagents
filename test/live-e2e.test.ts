import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';
import { PersistentPiRpcClient } from '../src/rpc-client.ts';
import { sessionCost, formatCost } from '../src/session-cost.ts';
import { alive, sessionEntries, startMockPi } from './fakes/mock-pi-runtime.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.env.PI_PERSISTENT_SUBAGENTS_E2E === '1';
const text = (result: any) => decode(result.content[0].text) as any;

it('loads and executes the extension command in installed Pi without a model call', {skip: !enabled}, async () => {
  const client = new PersistentPiRpcClient({command:'pi',args:['--no-extensions','-e',root,'--mode','rpc','--no-session','--offline'],cwd:root});
  const errors: unknown[] = [];
  client.onEvent(e=>{if(e.type==='extension_error') errors.push(e);});
  try {
    await client.start();
    const response = await client.request({type:'get_commands'});
    assert.ok((response.data as any).commands.some((c:any)=>c.name==='pworkers'));
    await client.prompt('/pworkers');
    assert.deepEqual(errors,[]);
  } finally {await client.stop();}
});

describe('installed Pi runtime with a local mock model (no paid calls)', {skip: !enabled}, () => {
  it('keeps one process per live worker across turns, steers, interrupts without a phantom result, and resumes the transcript', async () => {
    const pi = await startMockPi();
    try {
      // Default selection: the parent's provider paired with Pi's default model; Pi 1.x rejects a bare --provider.
      const spawned = (await pi.probe('spawn_agent', { task: 'remember MARKER=orchid', name: 'keeper' })).details;
      assert.equal(spawned.model, 'mock-1');
      let waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.deepEqual(waited.agents[0], { id: spawned.id, status: 'idle', outcome: 'completed', result_id: waited.agents[0].result_id, error: null, output: 'ECHO:remember MARKER=orchid' });

      const recall = await pi.probe('send_input', { id: spawned.id, message: 'RECALL' });
      assert.equal(recall.details.disposition, 'started');
      waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].output, 'RECALLED:orchid');
      assert.equal((await pi.probe('list_agents')).details[0].pid, spawned.pid, 'the same process serves later turns');

      await pi.probe('send_input', { id: spawned.id, message: 'DELAY=1500 long task' });
      const steer = await pi.probe('send_input', { id: spawned.id, message: 'steered RECALL', mode: 'steer' });
      assert.equal(steer.details.disposition, 'queued');
      waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].output, 'RECALLED:orchid');

      await pi.probe('send_input', { id: spawned.id, message: 'DELAY=5000 doomed' });
      await new Promise(r => setTimeout(r, 300));
      const before = (await pi.probe('list_agents')).details[0].completionId;
      await pi.probe('send_input', { id: spawned.id, message: 'after interrupt', mode: 'interrupt' });
      waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].output, 'ECHO:after interrupt');
      assert.equal(waited.agents[0].outcome, 'completed');
      assert.notEqual(waited.agents[0].result_id, before);
      assert.equal(waited.additional_results, undefined, 'the aborted run must not surface as a result');

      const failing = await pi.probe('send_input', { id: spawned.id, message: 'FAIL=400 bad request' });
      assert.equal(failing.details.disposition, 'started');
      waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].outcome, 'error');
      assert.match(waited.agents[0].error, /400/);

      const closed = (await pi.probe('close_agent', { id: spawned.id })).details;
      assert.equal(closed.status, 'closed');
      assert.equal(alive(spawned.pid), false);
      const resumed = (await pi.probe('resume_agent', { id: spawned.id })).details;
      assert.notEqual(resumed.pid, spawned.pid);
      assert.equal(resumed.sessionFile, spawned.sessionFile);
      await pi.probe('send_input', { id: spawned.id, message: 'RECALL again' });
      waited = text(await pi.probe('wait_agent', { ids: [spawned.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].output, 'RECALLED:orchid', 'resume keeps the transcript');

      await pi.parent.stop();
      assert.equal(alive(resumed.pid), false, 'parent shutdown leaves no worker process');
    } finally { await pi.close(); }
  });

  it('computes the same session cost as Pi and shows main plus workers in the footer', async () => {
    const pi = await startMockPi();
    try {
      const w = (await pi.probe('spawn_agent', { task: 'cost probe one', reuse: 'one_shot' })).details;
      await pi.probe('wait_agent', { ids: [w.id], timeout_ms: 30_000 });
      await pi.probe('send_input', { id: w.id, message: 'cost probe two' });
      await pi.probe('wait_agent', { ids: [w.id], timeout_ms: 30_000 });
      const closed = (await pi.probe('close_agent', { id: w.id })).details;
      const assistant = (await sessionEntries(w.sessionFile) as any[]).filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message.usage);
      const sum = (key: string) => assistant.reduce((n, u) => n + u[key], 0);
      assert.deepEqual(closed.usage, { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), turns: assistant.length },
        'worker usage counters must equal the usage Pi stored for the session');
      const piWorker = await pi.sessionStats(w.sessionFile);
      const ours = sessionCost(await sessionEntries(w.sessionFile));
      assert.ok(piWorker.cost > 0);
      assert.ok(Math.abs(ours - piWorker.cost) < 1e-12, `ours ${ours} vs Pi ${piWorker.cost}`);

      await pi.parent.prompt('parent turn so main has a cost');
      await pi.parent.waitForIdle(30_000);
      await new Promise(r => setTimeout(r, 600));
      const main = ((await pi.parent.request({ type: 'get_session_stats' })).data as any).cost;
      assert.ok(main > 0);
      const statuses = pi.events.filter((e: any) => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === 'persistent-subagents');
      assert.equal(statuses.at(-1)?.statusText, `Σ ${formatCost(main + piWorker.cost)} · main ${formatCost(main)} · workers ${formatCost(piWorker.cost)}`);
    } finally { await pi.close(); }
  });

  it('compacts an idle worker above its context budget before delivering new input', async () => {
    const pi = await startMockPi();
    try {
      const w = (await pi.probe('spawn_agent', { task: 'small start', context_budget_tokens: 32_768 })).details;
      await pi.probe('wait_agent', { ids: [w.id], timeout_ms: 30_000 });
      await pi.probe('send_input', { id: w.id, message: 'bulk ' + 'x'.repeat(150_000) });
      await pi.probe('wait_agent', { ids: [w.id], timeout_ms: 30_000 });
      const listed = text(await pi.probe('list_agents', { verbose: true })).agents[0];
      assert.ok(listed.context.tokens > 32_768, JSON.stringify(listed.context));
      assert.equal(listed.context.budget, 32_768);
      const sent = await pi.probe('send_input', { id: w.id, message: 'after budget' });
      assert.equal(sent.details.budgetCompaction?.error, undefined, JSON.stringify(sent.details.budgetCompaction));
      assert.ok(sent.details.budgetCompaction.tokensBefore > 32_768);
      const waited = text(await pi.probe('wait_agent', { ids: [w.id], timeout_ms: 30_000 }));
      assert.equal(waited.agents[0].output, 'ECHO:after budget');
      const entries = await sessionEntries(w.sessionFile) as any[];
      assert.equal(entries.filter(e => e.type === 'compaction').length, 1);
    } finally { await pi.close(); }
  });
});
