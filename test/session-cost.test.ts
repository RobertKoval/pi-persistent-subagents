import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerCostLedger, costStatus, sessionCost } from '../src/session-cost.ts';
import { parentScope } from '../src/pool.ts';

const usage = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total } });

describe('sessionCost', () => {
  it('counts exactly the usage Pi counts in its session total, across all branches', () => {
    const entries = [
      { type: 'session', id: 's' },
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'assistant', usage: usage(0.5) } },
      { type: 'message', message: { role: 'toolResult', usage: usage(0.25) } },
      { type: 'message', message: { role: 'toolResult' } },
      { type: 'compaction', usage: usage(0.125) },
      { type: 'branch_summary', usage: usage(0.0625) },
      { type: 'usage', usage: usage(0.03125) },
      { type: 'custom', customType: 'x', usage: usage(100) },
      { type: 'message', message: { role: 'assistant', usage: { cost: { total: Number.NaN } } } },
    ];
    assert.equal(sessionCost(entries), 0.96875);
  });
});

async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'pi-cost-'));
  const writeRegistry = async (parentSessionId: string, workers: { id: string; file: string; turns?: number }[]) => {
    const dir = join(root, 'parents', parentScope(parentSessionId));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 1, workers: workers.map(w => ({
      id: w.id, status: 'closed', sessionFile: w.file, cwd: root, createdAt: 0, updatedAt: 0, lastUsedAt: 0, taskPreview: '', lastOutput: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: w.turns ?? 1 }, cacheContinuity: 'cold_process', depth: 1,
    })) }));
  };
  const writeSession = async (name: string, id: string, costs: number[]) => {
    const file = join(root, name);
    await writeFile(file, [{ type: 'session', id }, ...costs.map(c => ({ type: 'message', message: { role: 'assistant', usage: usage(c) } }))].map(e => JSON.stringify(e)).join('\n') + '\n');
    return file;
  };
  return { root, writeRegistry, writeSession };
}

describe('WorkerCostLedger', () => {
  it('sums direct and nested workers, including closed ones, without visiting a session twice', async () => {
    const s = await storage();
    const a = await s.writeSession('a.jsonl', 'a-session', [100, 50]);
    const b = await s.writeSession('b.jsonl', 'b-session', [25]);
    const nested = await s.writeSession('n.jsonl', 'n-session', [20, 5]);
    await s.writeRegistry('parent', [{ id: 'a', file: a }, { id: 'b', file: b }]);
    await s.writeRegistry('a-session', [{ id: 'n', file: nested }]);
    await s.writeRegistry('n-session', [{ id: 'loop', file: a }]);
    const ledger = new WorkerCostLedger(s.root, parentScope);
    const total = await ledger.workersOf('parent');
    // The loop entry names a session already charged; it is neither counted again nor recursed into.
    assert.deepEqual(total, { cost: 100 + 50 + 25 + 20 + 5, partial: false, workers: 3 });
  });

  it('marks the total partial when a worker that ran has no readable session', async () => {
    const s = await storage();
    const corrupt = join(s.root, 'corrupt.jsonl');
    await writeFile(corrupt, '{not json');
    await s.writeRegistry('parent', [{ id: 'new', file: join(s.root, 'never-written.jsonl'), turns: 0 }]);
    assert.equal((await new WorkerCostLedger(s.root, parentScope).workersOf('parent')).partial, false, 'no session file before the first reply is not a gap');
    await s.writeRegistry('parent', [{ id: 'gone', file: join(s.root, 'deleted.jsonl'), turns: 3 }]);
    assert.equal((await new WorkerCostLedger(s.root, parentScope).workersOf('parent')).partial, true);
    await s.writeRegistry('parent', [{ id: 'bad', file: corrupt }]);
    assert.equal((await new WorkerCostLedger(s.root, parentScope).workersOf('parent')).partial, true);
  });

  it('rereads a session file only after it changes', async () => {
    const s = await storage();
    const a = await s.writeSession('a.jsonl', 'a-session', [1]);
    await s.writeRegistry('parent', [{ id: 'a', file: a }]);
    const ledger = new WorkerCostLedger(s.root, parentScope);
    assert.equal((await ledger.workersOf('parent')).cost, 1);
    await s.writeSession('a.jsonl', 'a-session', [1, 2]);
    assert.equal((await ledger.workersOf('parent')).cost, 3);
  });
});

describe('costStatus', () => {
  it('shows nothing without workers and labels a partial total as a lower bound', () => {
    assert.equal(costStatus(14, { cost: 0, partial: false, workers: 0 }), undefined);
    assert.equal(costStatus(14, { cost: 200, partial: false, workers: 2 }), 'Σ $214.00 · main $14.00 · workers $200.00');
    assert.equal(costStatus(0.004, { cost: 0.5, partial: true, workers: 1 }), 'Σ $0.504+? · main $0.004 · workers $0.500+?');
  });
});
