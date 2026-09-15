import { execFile as execFileCallback } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import swarmExtension from '../src/swarm-extension.ts';
import { MetricsStore } from '../src/metrics.ts';

const execFile = promisify(execFileCallback);
const originalDepth = process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (originalDepth === undefined) delete process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
  else process.env.PI_PERSISTENT_SUBAGENT_DEPTH = originalDepth;
});

function fakePi() {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();
  return {
    tools,
    commands,
    events,
    api: {
      registerTool(tool: any) { tools.push(tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) {
        const list = events.get(name) ?? [];
        list.push(handler);
        events.set(name, list);
      },
    } as any,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function swarmHarness() {
  const root = await mkdtemp(join(tmpdir(), 'pi-swarm-extension-'));
  const agentDir = join(root, 'agent');
  const project = join(root, 'project');
  await mkdir(join(agentDir, 'persistent-subagents'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify({
    metricsWorkers: true,
    maxAgents: 4,
    roles: {
      'local-swarm': { provider: 'fake-provider', model: 'fake-local', thinking: 'low' },
    },
  }));
  await git(project, 'init');
  await git(project, 'config', 'user.name', 'Swarm Test');
  await git(project, 'config', 'user.email', 'swarm@example.invalid');
  await writeFile(join(project, 'base.txt'), 'base\n');
  await git(project, 'add', 'base.txt');
  await git(project, 'commit', '-m', 'base');

  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldScript = process.argv[1];
  const oldDepth = process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PERSISTENT_SUBAGENT_DEPTH = '0';
  process.argv[1] = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));

  const pi = fakePi();
  const notifications: string[] = [];
  const ctx: any = {
    cwd: project,
    model: { provider: 'openai-codex', id: 'frontier-model' },
    thinkingLevel: 'high',
    sessionManager: { getSessionId: () => 'frontier-session', getEntries: () => [] },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  swarmExtension(pi.api);
  const tool = pi.tools.find(item => item.name === 'swarm');
  assert.ok(tool);

  cleanups.push(async () => {
    for (const handler of pi.events.get('session_shutdown') ?? []) await handler({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldDepth === undefined) delete process.env.PI_PERSISTENT_SUBAGENT_DEPTH; else process.env.PI_PERSISTENT_SUBAGENT_DEPTH = oldDepth;
    process.argv[1] = oldScript;
    await rm(root, { recursive: true, force: true });
  });

  const call = (params: any) => tool.execute('swarm-test', params, undefined, undefined, ctx);
  return { root, agentDir, project, notifications, call, shutdown: async () => {
    for (const handler of pi.events.get('session_shutdown') ?? []) await handler({}, ctx);
  } };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 10));
    value = await read();
  }
  assert.equal(done(value), true, 'condition did not become true');
  return value;
}

describe('swarm extension contract', () => {
  it('registers one high-level swarm tool and one human status command at the root depth', () => {
    process.env.PI_PERSISTENT_SUBAGENT_DEPTH = '0';
    const pi = fakePi();
    swarmExtension(pi.api);
    assert.deepEqual(pi.tools.map(tool => tool.name), ['swarm']);
    assert.equal(pi.commands.has('pswarms'), true);
    assert.equal(pi.events.has('session_shutdown'), true);
    const swarm = pi.tools[0];
    assert.equal(swarm.executionMode, 'parallel');
    assert.match(swarm.description, /speculative|local/i);
  });

  it('does not expose recursive swarm tools inside child workers', () => {
    process.env.PI_PERSISTENT_SUBAGENT_DEPTH = '1';
    const pi = fakePi();
    swarmExtension(pi.api);
    assert.equal(pi.tools.length, 0);
    assert.equal(pi.commands.size, 0);
  });

  it('runs an isolated local candidate end-to-end, verifies it, applies it explicitly, and records worker metrics', async () => {
    const h = await swarmHarness();
    const started = await h.call({
      action: 'start',
      task: 'Create the requested candidate file. __WRITE_FILE__(candidate.txt,hello-from-local)',
      max_candidates: 1,
      max_active: 1,
      min_completed: 1,
      acceptance_commands: ['node -e "require(\'node:fs\').accessSync(\'candidate.txt\')"'],
    });
    assert.equal(started.details.state, 'queued');
    assert.equal(existsSync(join(h.project, 'candidate.txt')), false, 'candidate edits must remain isolated before apply');

    const status = await eventually(
      async () => (await h.call({ action: 'status', job_id: started.details.id })).details,
      (value) => value.state === 'completed',
    );
    assert.equal(status.verified, 1);

    const collected = (await h.call({ action: 'collect', job_id: started.details.id, top_k: 1 })).details;
    assert.equal(collected.candidates[0].status, 'verified');
    assert.deepEqual(collected.candidates[0].changedFiles, ['candidate.txt']);
    assert.deepEqual(collected.candidates[0].verification, [
      { command: 'node -e "require(\'node:fs\').accessSync(\'candidate.txt\')"', passed: true, exitCode: 0 },
    ]);
    assert.equal(existsSync(join(h.project, 'candidate.txt')), false);

    const applied = (await h.call({ action: 'apply', job_id: started.details.id, candidate_id: collected.candidates[0].id })).details;
    assert.equal(applied.applied, true);
    assert.equal(await readFile(join(h.project, 'candidate.txt'), 'utf8'), 'hello-from-local');

    await h.shutdown();
    const metricsPath = join(h.agentDir, 'persistent-subagents', 'metrics.sqlite');
    assert.equal(existsSync(metricsPath), true, 'swarm worker calls should use the existing local metrics store');
    const store = new MetricsStore(metricsPath);
    const report = store.report({ from: 0, to: Date.now() + 1000 });
    store.close();
    assert.ok(report.calls.some(call => call.role === 'worker' && call.model === 'fake-local'));
  });
});
