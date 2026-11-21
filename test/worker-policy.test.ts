import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, MAX_CONTEXT_BUDGET_TOKENS, MIN_CONTEXT_BUDGET_TOKENS, loadConfig, type PersistentSubagentConfig } from '../src/config.ts';
import { WorkerPool, type PiInvocationFactory, type PiLaunchSpec } from '../src/pool.ts';

const fakeCli = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));
const pools: WorkerPool[] = [];
afterEach(async () => { await Promise.allSettled(pools.splice(0).map(p => p.cleanup())); });

async function makePool(patch: Partial<PersistentSubagentConfig> = {}, env: NodeJS.ProcessEnv = {}, fakeEnv: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-policy-'));
  const log = join(root, 'rpc-log.jsonl');
  const specs: PiLaunchSpec[] = [];
  const invocationFactory: PiInvocationFactory = (spec) => {
    specs.push(spec);
    return { command: process.execPath, args: [fakeCli, '--mode', 'rpc', '--session', spec.sessionFile], cwd: spec.cwd, env: { ...spec.env, FAKE_RPC_LOG: log, ...fakeEnv } };
  };
  const pool = new WorkerPool({
    config: { ...structuredClone(DEFAULT_CONFIG), ...patch, roles: patch.roles ?? {} },
    storageRoot: join(root, 'storage'),
    parentSessionId: 'parent',
    parent: { provider: 'p', model: 'm', thinking: 'low', cwd: root },
    currentDepth: 0,
    env: { PATH: process.env.PATH, ...env },
    invocationFactory,
  });
  await pool.initialize();
  pools.push(pool);
  const commands = async () => (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l).command);
  return { pool, specs, commands };
}

async function idle(pool: WorkerPool, id: string) {
  const r = await pool.waitForAgents({ ids: [id], until: 'all', timeoutMs: 2_000 });
  assert.equal(r.timedOut, false);
}

describe('context budget', () => {
  const budget = 50_000;
  for (const [tokens, compacts] of [[budget - 1, false], [budget, false], [budget + 1, true]] as const) {
    it(`compacts an idle worker before new input only above its budget (${tokens} tokens)`, async () => {
      const { pool, commands } = await makePool();
      const w = await pool.spawnAgent({ task: 'first', contextBudgetTokens: budget });
      await idle(pool, w.id);
      await pool.sendInput(w.id, `__SET_CONTEXT__:${tokens}`);
      const sent = await pool.sendInput(w.id, 'next');
      assert.equal(sent.compaction !== undefined, compacts);
      if (compacts) assert.deepEqual(sent.compaction, { tokensBefore: tokens, budget, tokensAfter: 500, cost: 0.01 });
      const compactIndex = (await commands()).findIndex(c => c.type === 'compact');
      const promptIndex = (await commands()).findIndex(c => c.type === 'prompt' && c.message === 'next');
      assert.equal(compactIndex >= 0, compacts);
      if (compacts) assert.ok(compactIndex < promptIndex, 'compaction must precede the new prompt');
      await idle(pool, w.id);
      assert.equal(pool.getAgent(w.id)?.lastOutput, 'ECHO:next');
    });
  }

  it('leaves Pi in charge when the native window is not larger than the budget', async () => {
    const { pool, commands } = await makePool({}, {}, { FAKE_CONTEXT_WINDOW: '60000' });
    const w = await pool.spawnAgent({ task: 'first', contextBudgetTokens: 60_000 });
    await idle(pool, w.id);
    await pool.sendInput(w.id, '__SET_CONTEXT__:59000');
    await pool.sendInput(w.id, 'next');
    assert.ok(!(await commands()).some(c => c.type === 'compact'));
  });

  it('never compacts a running worker, because Pi compaction aborts the active run', async () => {
    const { pool, commands } = await makePool({}, {}, { FAKE_CONTEXT_TOKENS: '900000' });
    const w = await pool.spawnAgent({ task: '__SLOW__', contextBudgetTokens: budget });
    await pool.sendInput(w.id, 'steer while running');
    await idle(pool, w.id);
    assert.ok(!(await commands()).some(c => c.type === 'compact' || c.type === 'get_session_stats'));
  });

  it('still delivers the input when compaction fails, and reports why', async () => {
    const { pool } = await makePool({}, {}, { FAKE_CONTEXT_TOKENS: '900000' });
    const w = await pool.spawnAgent({ task: '/handled-so-history-stays-empty', contextBudgetTokens: budget });
    const sent = await pool.sendInput(w.id, 'next');
    assert.match(sent.compaction?.error ?? '', /Nothing to compact/);
    await idle(pool, w.id);
    assert.equal(pool.getAgent(w.id)?.lastOutput, 'ECHO:next');
  });

  it('takes explicit over role over config, and persists the budget for resume', async () => {
    const { pool } = await makePool({ contextBudgetTokens: 100_000, roles: { r: { model: 'x', contextBudgetTokens: 80_000 } } });
    const configured = await pool.spawnAgent({ task: 'a' });
    const role = await pool.spawnAgent({ task: 'a', role: 'r' });
    const explicit = await pool.spawnAgent({ task: 'a', role: 'r', contextBudgetTokens: 60_000 });
    assert.deepEqual([configured, role, explicit].map(s => s.contextBudgetTokens), [100_000, 80_000, 60_000]);
    await idle(pool, explicit.id);
    await pool.closeAgent(explicit.id);
    assert.equal((await pool.resumeAgent(explicit.id)).contextBudgetTokens, 60_000);
  });

  for (const [value, ok] of [[MIN_CONTEXT_BUDGET_TOKENS - 1, false], [MIN_CONTEXT_BUDGET_TOKENS, true], [MAX_CONTEXT_BUDGET_TOKENS, true], [MAX_CONTEXT_BUDGET_TOKENS + 1, false]] as const) {
    it(`${ok ? 'accepts' : 'rejects'} a spawn budget of ${value}`, async () => {
      const { pool } = await makePool();
      const spawn = pool.spawnAgent({ task: 'a', contextBudgetTokens: value });
      if (ok) await spawn; else await assert.rejects(spawn, /context budget must be an integer/);
    });
  }
});

describe('worker launch identity and environment', () => {
  it('tells each worker who it is without leaking the parent worker identity to nested workers', async () => {
    const { pool, specs } = await makePool({ roles: { reviewer: { model: 'x' } } }, {
      PI_PERSISTENT_SUBAGENT_ROLE: 'inherited-role', PI_PERSISTENT_SUBAGENT_NAME: 'inherited-name', PI_PERSISTENT_SUBAGENT_REUSE: 'long_lived',
    });
    const named = await pool.spawnAgent({ task: 'a', name: 'alice', role: 'reviewer', reuse: 'one_shot' });
    const plain = await pool.spawnAgent({ task: 'a' });
    const [a, b] = specs.map(s => s.env);
    assert.deepEqual([a.PI_PERSISTENT_SUBAGENT_ID, a.PI_PERSISTENT_SUBAGENT_NAME, a.PI_PERSISTENT_SUBAGENT_ROLE, a.PI_PERSISTENT_SUBAGENT_REUSE, a.PI_PERSISTENT_SUBAGENT_DEPTH],
      [named.id, 'alice', 'reviewer', 'one_shot', '1']);
    assert.deepEqual([b.PI_PERSISTENT_SUBAGENT_ID, b.PI_PERSISTENT_SUBAGENT_NAME, b.PI_PERSISTENT_SUBAGENT_ROLE, b.PI_PERSISTENT_SUBAGENT_REUSE],
      [plain.id, undefined, undefined, undefined]);
  });

  for (const [retention, inherited, expected] of [[undefined, 'long', 'long'], ['long', undefined, 'long'], ['default', 'long', undefined], [undefined, undefined, undefined]] as const) {
    it(`maps cache retention ${retention} with inherited ${inherited} to PI_CACHE_RETENTION=${expected}`, async () => {
      const { pool, specs } = await makePool({}, inherited ? { PI_CACHE_RETENTION: inherited } : {});
      await pool.spawnAgent({ task: 'a', ...(retention ? { cacheRetention: retention } : {}) });
      assert.equal(specs[0].env.PI_CACHE_RETENTION, expected);
    });
  }

  it('loads global and role extensions once each and relaunches resumed workers with the same set', async () => {
    const { pool, specs } = await makePool({ workerExtensions: ['/ext/shared.ts'], roles: { math: { model: 'x', extensions: ['/ext/math.ts', '/ext/shared.ts'] } } });
    const w = await pool.spawnAgent({ task: 'a', role: 'math' });
    assert.deepEqual(specs[0].extensions, ['/ext/shared.ts', '/ext/math.ts']);
    await idle(pool, w.id);
    await pool.closeAgent(w.id);
    await pool.resumeAgent(w.id);
    assert.deepEqual(specs[1].extensions, ['/ext/shared.ts', '/ext/math.ts']);
  });

  it('names the configured roles when a spawn asks for an unknown one', async () => {
    const { pool } = await makePool({ roles: { advisor: { model: 'a' }, explorer: { model: 'b' } } });
    await assert.rejects(pool.spawnAgent({ task: 'a', role: 'nope' }), /Unknown persistent subagent role "nope"\. Configured roles: advisor, explorer\./);
    const { pool: empty } = await makePool();
    await assert.rejects(empty.spawnAgent({ task: 'a', role: 'nope' }), /No roles are configured/);
  });
});

describe('policy config', () => {
  async function load(globalConfig: unknown, projectConfig?: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'pi-policy-config-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    await mkdir(join(agentDir, 'persistent-subagents'), { recursive: true });
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify(globalConfig));
    if (projectConfig) await writeFile(join(cwd, '.pi', 'persistent-subagents.json'), JSON.stringify(projectConfig));
    return loadConfig(cwd, agentDir);
  }

  it('accepts worker extensions only from the global config, because workers run them', async () => {
    const ok = await load({ workerExtensions: ['/abs/ext.ts', 'builtin:mcp'], roles: { math: { model: 'm', extensions: ['/abs/math.ts'], description: 'Math helper' } } });
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(ok.config.workerExtensions, ['/abs/ext.ts', 'builtin:mcp']);
    assert.deepEqual(ok.config.roles.math, { model: 'm', extensions: ['/abs/math.ts'], description: 'Math helper' });
    for (const project of [{ workerExtensions: ['/abs/evil.ts'] }, { roles: { r: { extensions: ['/abs/evil.ts'] } } }]) {
      const rejected = await load({}, project);
      assert.deepEqual(rejected.config.workerExtensions, []);
      assert.equal(rejected.config.roles.r, undefined);
      assert.match(rejected.warnings.join('\n'), /only be set in the global config/);
    }
    const relative = await load({ workerExtensions: ['./ext.ts'] });
    assert.match(relative.warnings.join('\n'), /absolute path or builtin/);
  });

  for (const [value, ok] of [[MIN_CONTEXT_BUDGET_TOKENS - 1, false], [MIN_CONTEXT_BUDGET_TOKENS, true], [MIN_CONTEXT_BUDGET_TOKENS + 1, true], [MAX_CONTEXT_BUDGET_TOKENS + 1, false]] as const) {
    it(`${ok ? 'accepts' : 'rejects'} contextBudgetTokens=${value} in config`, async () => {
      const r = await load({ contextBudgetTokens: value });
      assert.equal(r.config.contextBudgetTokens, ok ? value : undefined);
      assert.equal(r.warnings.length, ok ? 0 : 1);
    });
  }

  it('rejects unknown reuse and cache retention values instead of guessing', async () => {
    assert.equal((await load({ reuse: 'one_shot', cacheRetention: 'long' })).config.reuse, 'one_shot');
    assert.match((await load({ reuse: 'sometimes' })).warnings.join(''), /reuse must be one of one_shot, likely_soon, long_lived/);
    assert.match((await load({ roles: { r: { cacheRetention: '1h' } } })).warnings.join(''), /roles\.r\.cacheRetention must be one of default, long/);
  });
});
