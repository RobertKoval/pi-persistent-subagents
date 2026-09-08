import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRegistry, type WorkerRecord } from '../src/registry.ts';

function record(id = 'a1'): WorkerRecord {
  return {
    id,
    name: 'coder',
    role: 'coder',
    status: 'idle',
    sessionFile: `/tmp/${id}.jsonl`,
    provider: 'work',
    model: 'cheap',
    thinking: 'medium',
    cwd: '/repo',
    createdAt: 100,
    updatedAt: 200,
    lastUsedAt: 200,
    taskPreview: 'implement feature',
    lastOutput: 'done',
    usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 0, turns: 1 },
    cacheContinuity: 'warm_process',
    depth: 1,
  };
}

describe('WorkerRegistry', () => {
  it('persists records atomically and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-registry-'));
    const path = join(dir, 'registry.json');
    const registry = new WorkerRegistry(path);
    await registry.load();
    await registry.upsert(record());

    const second = new WorkerRegistry(path);
    await second.load();
    assert.deepEqual(second.get('a1'), record());
    assert.deepEqual(await readdir(dir), ['registry.json']);
  });

  it('updates one record without dropping siblings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-registry-'));
    const registry = new WorkerRegistry(join(dir, 'registry.json'));
    await registry.load();
    await registry.upsert(record('a1'));
    await registry.upsert(record('a2'));
    await registry.upsert({ ...record('a1'), status: 'closed', updatedAt: 300 });
    assert.equal(registry.list().length, 2);
    assert.equal(registry.get('a1')?.status, 'closed');
    assert.equal(registry.get('a2')?.status, 'idle');
  });

  it('does not serialize unknown secret-bearing fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-registry-'));
    const path = join(dir, 'registry.json');
    const registry = new WorkerRegistry(path);
    await registry.load();
    await registry.upsert({ ...record(), apiKey: 'DO_NOT_PERSIST', oauthToken: 'NOPE' } as WorkerRecord);
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes('DO_NOT_PERSIST'), false);
    assert.equal(text.includes('NOPE'), false);
  });

  it('fails loudly on corrupt registry data rather than inventing state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-registry-'));
    const path = join(dir, 'registry.json');
    await writeFile(path, '{broken');
    const registry = new WorkerRegistry(path);
    await assert.rejects(() => registry.load(), /registry.*invalid|JSON/i);
  });
});
