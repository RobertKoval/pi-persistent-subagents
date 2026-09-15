import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SpawnAgentInput, WorkerSnapshot } from '../src/pool.ts';
import type { CandidateWorktree, CapturedCandidate, WorkspaceSnapshot } from '../src/swarm-git.ts';
import { SwarmManager, type SwarmWorkspaceOps } from '../src/swarm-manager.ts';

class FakePool {
  readonly spawned: Array<{ id: string; input: SpawnAgentInput }> = [];
  readonly closed: string[] = [];
  private readonly listeners = new Set<(snapshot: WorkerSnapshot) => void>();
  private serial = 0;
  private readonly settleDuringSpawn: boolean;

  constructor(settleDuringSpawn = false) {
    this.settleDuringSpawn = settleDuringSpawn;
  }

  onSettled(listener: (snapshot: WorkerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async spawnAgent(input: SpawnAgentInput): Promise<WorkerSnapshot> {
    const id = `w${++this.serial}`;
    this.spawned.push({ id, input });
    if (!this.settleDuringSpawn) return snapshot(id, 'running', input.cwd ?? '/workspace');
    const settled = {
      ...snapshot(id, 'idle', input.cwd ?? '/workspace'),
      lastOutput: 'settled before spawn returned',
      completionId: `r-${id}`,
    };
    for (const listener of this.listeners) listener(settled);
    return settled;
  }

  async closeAgent(id: string): Promise<WorkerSnapshot> {
    this.closed.push(id);
    const cwd = this.spawned.find((entry) => entry.id === id)?.input.cwd ?? '/workspace';
    return snapshot(id, 'closed', cwd);
  }

  settle(id: string, output = 'short final candidate summary'): void {
    const cwd = this.spawned.find((entry) => entry.id === id)?.input.cwd ?? '/workspace';
    const settled = { ...snapshot(id, 'idle', cwd), lastOutput: output, completionId: `r-${id}` };
    for (const listener of this.listeners) listener(settled);
  }
}

function snapshot(id: string, status: WorkerSnapshot['status'], cwd: string): WorkerSnapshot {
  return {
    id,
    status,
    sessionFile: `/sessions/${id}.jsonl`,
    cwd,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    taskPreview: 'task',
    lastOutput: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 },
    cacheContinuity: 'warm_process',
    depth: 1,
    alive: status !== 'closed' && status !== 'crashed',
  };
}

function fakeSnapshot(root = '/repo'): WorkspaceSnapshot {
  return {
    repoRoot: root,
    parentCwd: root,
    head: 'head',
    commit: 'snapshot',
    rootDir: '/artifacts/job',
    worktreesDir: '/artifacts/job/worktrees',
    artifactsDir: '/artifacts/job/artifacts',
  };
}

function workspaceOps(options: { snapshotGate?: Promise<void>; verify?: boolean; emptyPatch?: boolean } = {}): SwarmWorkspaceOps {
  return {
    async createSnapshot(cwd) {
      await options.snapshotGate;
      return fakeSnapshot(cwd);
    },
    async createWorktree(_snapshot, candidateId) {
      return { id: candidateId, path: join('/workspace', candidateId) };
    },
    async capture(_snapshot, worktree): Promise<CapturedCandidate> {
      return {
        candidateId: worktree.id,
        commit: `commit-${worktree.id}`,
        patchPath: `/artifacts/${worktree.id}.diff`,
        changedFiles: options.emptyPatch ? [] : [`src/${worktree.id}.ts`],
      };
    },
    async removeWorktree(_snapshot: WorkspaceSnapshot, _worktree: CandidateWorktree) {},
    async removeSnapshot(_snapshot: WorkspaceSnapshot) {},
    async applyPatch(_cwd: string, _patch: string) { return { applied: true }; },
    async verify(_cwd: string, commands: string[]) {
      return commands.map(command => ({
        command,
        passed: options.verify !== false,
        exitCode: options.verify === false ? 1 : 0,
        stdout: 'large verifier stdout must stay internal',
        stderr: 'large verifier stderr must stay internal',
      }));
    },
  };
}

const managers: SwarmManager[] = [];
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.cleanup()));
});

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, message);
}

describe('SwarmManager', () => {
  it('returns a job immediately while snapshot preparation continues in the background', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pool = new FakePool();
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps({ snapshotGate: gate }) });
    managers.push(manager);

    const started = manager.start({ task: 'fix it', cwd: '/repo', maxCandidates: 4, maxActive: 2 });
    assert.equal(started.state, 'queued');
    assert.equal(pool.spawned.length, 0);

    release();
    await eventually(() => pool.spawned.length === 2, 'two workers should start after preparation');
    assert.equal(manager.status(started.id).active, 2);
    assert.equal(manager.status(started.id).queued, 2);
  });

  it('recovers a completion that settles before spawnAgent returns', async () => {
    const pool = new FakePool(true);
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps() });
    managers.push(manager);
    const job = manager.start({
      task: 'tiny local fix',
      cwd: '/repo',
      maxCandidates: 1,
      maxActive: 1,
      minCompleted: 1,
      acceptanceCommands: ['npm test -- target'],
    });
    await eventually(() => manager.status(job.id).state === 'completed', 'fast-settling worker must not leave the job stuck running');
    assert.equal(manager.status(job.id).verified, 1);
    assert.equal(manager.collect(job.id).candidates[0]?.summary, 'settled before spawn returned');
  });

  it('separates logical width from active concurrency and early-stops after enough verified candidates', async () => {
    const pool = new FakePool();
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps() });
    managers.push(manager);

    const job = manager.start({
      task: 'fix it',
      cwd: '/repo',
      maxCandidates: 5,
      maxActive: 2,
      minCompleted: 2,
      acceptanceCommands: ['npm test -- target'],
    });

    await eventually(() => pool.spawned.length === 2, 'initial active window should fill');
    assert.equal(manager.status(job.id).active, 2);

    pool.settle('w1');
    await eventually(() => pool.spawned.length === 3, 'a queued candidate should backfill the freed slot');
    assert.ok(manager.status(job.id).active <= 2);

    pool.settle('w2');
    await eventually(() => manager.status(job.id).state === 'completed', 'second verified result should trigger early stop');
    const status = manager.status(job.id);
    assert.equal(status.verified, 2);
    assert.equal(status.completed, 2);
    assert.equal(status.queued, 0);
    assert.ok(pool.closed.includes('w3'), 'running straggler should be cancelled');

    const collected = manager.collect(job.id, 1);
    assert.equal(collected.candidates.length, 1);
    assert.equal(collected.candidates[0]?.status, 'verified');
    assert.match(collected.candidates[0]?.patchPath ?? '', /\.diff$/);
    assert.equal(collected.candidates[0]?.changedFiles.length, 1);
    assert.deepEqual(collected.candidates[0]?.verification, [
      { command: 'npm test -- target', passed: true, exitCode: 0 },
    ], 'collect must not inject verifier stdout/stderr into frontier context');
  });

  it('marks candidates partial when no acceptance evidence exists instead of claiming verification', async () => {
    const pool = new FakePool();
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps() });
    managers.push(manager);
    const job = manager.start({ task: 'investigate', cwd: '/repo', maxCandidates: 1, maxActive: 1 });
    await eventually(() => pool.spawned.length === 1, 'worker should start');
    pool.settle('w1');
    await eventually(() => manager.status(job.id).completed === 1, 'candidate should finish');
    const result = manager.collect(job.id, 1).candidates[0]!;
    assert.equal(result.status, 'partial');
  });

  it('refuses to apply a rejected candidate', async () => {
    const pool = new FakePool();
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps({ emptyPatch: true }) });
    managers.push(manager);
    const job = manager.start({
      task: 'fix',
      cwd: '/repo',
      maxCandidates: 1,
      maxActive: 1,
      acceptanceCommands: ['npm test'],
    });
    await eventually(() => pool.spawned.length === 1, 'worker should start');
    pool.settle('w1');
    await eventually(() => manager.status(job.id).completed === 1, 'candidate should finish');
    const result = manager.collect(job.id, 1).candidates[0]!;
    assert.equal(result.status, 'rejected');
    const applied = await manager.apply(job.id, result.id);
    assert.equal(applied.applied, false);
    assert.match(applied.reason ?? '', /rejected|not eligible/i);
  });

  it('cancels active and queued candidates without waiting for them to settle', async () => {
    const pool = new FakePool();
    const manager = new SwarmManager({ pool, storageRoot: '/storage', workspace: workspaceOps() });
    managers.push(manager);
    const job = manager.start({ task: 'fix', cwd: '/repo', maxCandidates: 4, maxActive: 2 });
    await eventually(() => pool.spawned.length === 2, 'workers should start');

    await manager.cancel(job.id);
    const status = manager.status(job.id);
    assert.equal(status.state, 'cancelled');
    assert.equal(status.active, 0);
    assert.equal(status.queued, 0);
    assert.deepEqual(pool.closed.sort(), ['w1', 'w2']);
  });
});
