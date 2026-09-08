import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type PersistentSubagentConfig } from '../src/config.ts';
import { WorkerPool, type PiInvocationFactory, type PiLaunchSpec } from '../src/pool.ts';

const fakeCli = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));
const pools: WorkerPool[] = [];

function config(patch: Partial<PersistentSubagentConfig> = {}): PersistentSubagentConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...patch, roles: patch.roles ?? {} };
}

async function makePool(options: {
  config?: PersistentSubagentConfig;
  depth?: number;
  env?: NodeJS.ProcessEnv;
  capture?: (spec: PiLaunchSpec) => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-pool-'));
  const log = join(root, 'rpc-log.jsonl');
  const invocationFactory: PiInvocationFactory = (spec) => {
    options.capture?.(spec);
    const args = [fakeCli, '--mode', 'rpc', '--session', spec.sessionFile];
    if (spec.provider) args.push('--provider', spec.provider);
    if (spec.model) args.push('--model', spec.model);
    if (spec.thinking) args.push('--thinking', spec.thinking);
    return {
      command: process.execPath,
      args,
      cwd: spec.cwd,
      env: { ...spec.env, FAKE_RPC_LOG: log },
    };
  };
  const pool = new WorkerPool({
    config: options.config ?? config(),
    storageRoot: join(root, 'storage'),
    parentSessionId: 'parent/session:1',
    parent: { provider: 'work-account', model: 'manager-strong', thinking: 'high', cwd: root },
    currentDepth: options.depth ?? 0,
    env: options.env ?? { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent-dir'), WORK_ACCOUNT_MARKER: 'selected' },
    invocationFactory,
  });
  await pool.initialize();
  pools.push(pool);
  return { pool, root, log };
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((p) => p.cleanup()));
});

async function commandLog(path: string): Promise<any[]> {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('WorkerPool persistent actor lifecycle', () => {
  it('settles to idle without killing the child and reuses the same PID for later work', async () => {
    const { pool } = await makePool();
    const spawned = await pool.spawnAgent({ task: 'first', name: 'coder' });
    const pid = spawned.pid;
    assert.ok(pid);

    await pool.waitForAgents({ ids: [spawned.id], until: 'all', timeoutMs: 2_000 });
    let snapshot = pool.getAgent(spawned.id)!;
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.pid, pid);
    assert.equal(snapshot.lastOutput, 'ECHO:first');

    await pool.sendInput(spawned.id, 'second', 'auto');
    await pool.waitForAgents({ ids: [spawned.id], until: 'all', timeoutMs: 2_000 });
    snapshot = pool.getAgent(spawned.id)!;
    assert.equal(snapshot.pid, pid);
    assert.equal(snapshot.lastOutput, 'ECHO:second');
    assert.equal(snapshot.cacheContinuity, 'warm_process');
    assert.ok(snapshot.usage.cacheRead > 0);
  });

  it('auto sends steer instead of an illegal prompt while the worker is running', async () => {
    const { pool, log } = await makePool();
    const worker = await pool.spawnAgent({ task: '__SLOW__' });
    await pool.sendInput(worker.id, 'redirect', 'auto');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    const commands = (await commandLog(log)).map((entry) => entry.command);
    assert.ok(commands.some((c) => c.type === 'steer' && c.message === 'redirect'));
    assert.equal(pool.getAgent(worker.id)?.lastOutput, 'STEER:redirect');
  });

  it('queues follow_up while running', async () => {
    const { pool, log } = await makePool();
    const worker = await pool.spawnAgent({ task: '__SLOW__' });
    await pool.sendInput(worker.id, 'after-current', 'follow_up');
    const commands = (await commandLog(log)).map((entry) => entry.command);
    assert.ok(commands.some((c) => c.type === 'follow_up' && c.message === 'after-current'));
  });

  it('interrupt aborts current work before sending a fresh prompt', async () => {
    const { pool, log } = await makePool();
    const worker = await pool.spawnAgent({ task: '__SLOW__' });
    await pool.sendInput(worker.id, 'replacement', 'interrupt');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    const commands = (await commandLog(log)).map((entry) => entry.command);
    const abortIndex = commands.findIndex((c) => c.type === 'abort');
    const promptIndex = commands.findIndex((c, i) => i > abortIndex && c.type === 'prompt' && c.message === 'replacement');
    assert.ok(abortIndex >= 0, 'abort command must be sent');
    assert.ok(promptIndex > abortIndex, 'replacement prompt must follow abort');
    assert.equal(pool.getAgent(worker.id)?.lastOutput, 'ECHO:replacement');
  });

  it('wait timeout never kills a worker', async () => {
    const { pool } = await makePool();
    const worker = await pool.spawnAgent({ task: '__SLOW__' });
    const result = await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 25 });
    assert.equal(result.timedOut, true);
    assert.equal(pool.getAgent(worker.id)?.alive, true);
    assert.equal(pool.getAgent(worker.id)?.status, 'running');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
  });

  it('close/resume keeps the session but intentionally starts a new cold process', async () => {
    const { pool } = await makePool();
    const worker = await pool.spawnAgent({ task: 'before-close' });
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    const originalPid = pool.getAgent(worker.id)?.pid;
    const sessionFile = pool.getAgent(worker.id)?.sessionFile;

    const closed = await pool.closeAgent(worker.id);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.alive, false);

    const resumed = await pool.resumeAgent(worker.id);
    assert.notEqual(resumed.pid, originalPid);
    assert.equal(resumed.sessionFile, sessionFile);
    assert.equal(resumed.cacheContinuity, 'cold_process');

    await pool.sendInput(worker.id, '__REMEMBER__', 'auto');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    assert.equal(pool.getAgent(worker.id)?.lastOutput, 'ECHO:before-close');
  });

  it('marks a crashed worker and wakes waiters', async () => {
    const { pool } = await makePool();
    const worker = await pool.spawnAgent({ task: '__CRASH__' });
    const result = await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    assert.equal(result.timedOut, false);
    assert.equal(pool.getAgent(worker.id)?.status, 'crashed');
    assert.equal(pool.getAgent(worker.id)?.alive, false);
    assert.match(pool.getAgent(worker.id)?.error ?? '', /exited/i);
  });

  it('can resume an unexpectedly crashed worker from its saved session', async () => {
    const { pool } = await makePool();
    const worker = await pool.spawnAgent({ task: 'seed' });
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    await pool.sendInput(worker.id, '__CRASH__', 'auto');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    assert.equal(pool.getAgent(worker.id)?.status, 'crashed');
    const resumed = await pool.resumeAgent(worker.id);
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.cacheContinuity, 'cold_process');
    await pool.sendInput(worker.id, '__REMEMBER__', 'auto');
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    assert.equal(pool.getAgent(worker.id)?.lastOutput, 'ECHO:seed');
  });

  it('applies role model/thinking while inheriting the selected parent provider and environment', async () => {
    let captured: PiLaunchSpec | undefined;
    const cfg = config({ roles: { coder: { model: 'worker-cheap', thinking: 'medium' } } });
    const { pool } = await makePool({ config: cfg, capture: (spec) => { captured = spec; } });
    const worker = await pool.spawnAgent({ task: 'work', role: 'coder' });
    assert.equal(worker.provider, 'work-account');
    assert.equal(worker.model, 'worker-cheap');
    assert.equal(worker.thinking, 'medium');
    assert.equal(captured?.env.WORK_ACCOUNT_MARKER, 'selected');
    assert.equal(captured?.env.PI_PERSISTENT_SUBAGENT_DEPTH, '1');
  });

  it('uses the latest parent provider/model context for agents spawned after an account/model switch', async () => {
    const cfg = config({ inheritParentModel: true });
    const { pool, root } = await makePool({ config: cfg });
    pool.updateParent({ provider: 'new-work-account', model: 'new-manager', thinking: 'medium', cwd: root });
    const worker = await pool.spawnAgent({ task: 'new-context' });
    assert.equal(worker.provider, 'new-work-account');
    assert.equal(worker.model, 'new-manager');
    assert.equal(worker.thinking, 'medium');
    assert.equal(worker.cwd, root);
  });

  it('enforces max depth and max active agent count including idle persistent workers', async () => {
    const atDepth = await makePool({ config: config({ maxDepth: 1 }), depth: 1 });
    await assert.rejects(() => atDepth.pool.spawnAgent({ task: 'no' }), /depth/i);

    const limited = await makePool({ config: config({ maxAgents: 1 }) });
    const first = await limited.pool.spawnAgent({ task: 'one' });
    await limited.pool.waitForAgents({ ids: [first.id], until: 'all', timeoutMs: 2_000 });
    await assert.rejects(() => limited.pool.spawnAgent({ task: 'two' }), /agent limit/i);
  });

  it('cleanup terminates live processes but leaves them resumable in persistent metadata', async () => {
    const { pool } = await makePool();
    const worker = await pool.spawnAgent({ task: 'work' });
    await pool.waitForAgents({ ids: [worker.id], until: 'all', timeoutMs: 2_000 });
    await pool.cleanup();
    const snapshot = pool.getAgent(worker.id)!;
    assert.equal(snapshot.status, 'closed');
    assert.equal(snapshot.alive, false);
    assert.equal(snapshot.sessionFile, worker.sessionFile);
  });
});

it('reports provider failure without claiming prior output succeeded, and recovers in the same process', async () => {
  const {pool} = await makePool();
  const w = await pool.spawnAgent({task:'first'});
  await pool.waitForAgents({ids:[w.id],timeoutMs:2000});
  await pool.sendInput(w.id,'__PROVIDER_ERROR__');
  await pool.waitForAgents({ids:[w.id],timeoutMs:2000});
  const failed=pool.getAgent(w.id)!;
  assert.match(failed.error ?? '', /usage limit/);
  assert.equal(failed.lastOutput,null);
  assert.equal(failed.alive,true);
  await pool.sendInput(w.id,'recovered');
  await pool.waitForAgents({ids:[w.id],timeoutMs:2000});
  assert.equal(pool.getAgent(w.id)?.error,undefined);
  assert.equal(pool.getAgent(w.id)?.pid,w.pid);
  assert.equal(pool.getAgent(w.id)?.lastOutput,'ECHO:recovered');
});

it('serializes concurrent resumes so one logical worker owns exactly one process', async () => {
  const {pool}=await makePool({config:config({maxAgents:1})});
  const w=await pool.spawnAgent({task:'seed'});
  await pool.waitForAgents({ids:[w.id],timeoutMs:2000});
  await pool.closeAgent(w.id);
  const results=await Promise.allSettled([pool.resumeAgent(w.id),pool.resumeAgent(w.id)]);
  const live=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  try {
    assert.equal(live.length,1,'duplicate resume must not create a second process');
    await pool.cleanup();
    for(const worker of live) assert.throws(()=>process.kill(worker.pid!,0),{code:'ESRCH'});
  } finally {
    await pool.cleanup();
    for(const worker of live) {try {process.kill(worker.pid!,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
  }
});

it('cleanup preempts an unacknowledged spawn instead of waiting for its command timeout', async () => {
  const {pool}=await makePool({config:config({commandTimeoutMs:2000})});
  const spawning=pool.spawnAgent({task:'__WAIT_FOR_ACK__'}).catch(e=>e);
  const deadline=Date.now()+1000;
  while(pool.listAgents().length===0 && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
  const pid=pool.listAgents()[0]?.pid;
  assert.ok(pid);
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([pool.cleanup(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup waited for the RPC timeout')),400);})]);
    assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});
    assert.ok((await spawning) instanceof Error);
  } finally {clearTimeout(timer!);await spawning;}
});
