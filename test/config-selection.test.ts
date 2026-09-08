import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { resolveWorkerSelection } from '../src/selection.ts';

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'pi-persistent-config-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(join(agentDir, 'persistent-subagents'), { recursive: true });
  return { root, cwd, agentDir };
}

describe('loadConfig', () => {
  it('returns safe cache-friendly defaults with no files', async () => {
    const { cwd, agentDir } = await dirs();
    const result = await loadConfig(cwd, agentDir);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.config.idleTtlMs, 0);
    assert.equal(result.config.maxDepth, 1);
  });

  it('merges project values over global values and roles by key', async () => {
    const { cwd, agentDir } = await dirs();
    await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify({
      maxAgents: 3,
      notificationMaxChars: 2000,
      roles: {
        coder: { provider: 'work', model: 'cheap', thinking: 'medium' },
        reviewer: { model: 'strong' }
      }
    }));
    await writeFile(join(cwd, '.pi', 'persistent-subagents.json'), JSON.stringify({
      maxAgents: 5,
      roles: { coder: { model: 'cheaper' } }
    }));

    const result = await loadConfig(cwd, agentDir);
    assert.equal(result.config.maxAgents, 5);
    assert.equal(result.config.notificationMaxChars, 2000);
    assert.deepEqual(result.config.roles.coder, { provider: 'work', model: 'cheaper', thinking: 'medium' });
    assert.deepEqual(result.config.roles.reviewer, { model: 'strong' });
  });

  it('ignores an invalid project file as a whole and reports a warning', async () => {
    const { cwd, agentDir } = await dirs();
    await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify({ maxAgents: 4 }));
    await writeFile(join(cwd, '.pi', 'persistent-subagents.json'), JSON.stringify({ maxAgents: 0, maxDepth: 99 }));

    const result = await loadConfig(cwd, agentDir);
    assert.equal(result.config.maxAgents, 4);
    assert.equal(result.config.maxDepth, DEFAULT_CONFIG.maxDepth);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /project.*invalid|maxAgents/i);
  });

  it('rejects unknown top-level fields instead of silently accepting typos', async () => {
    const { cwd, agentDir } = await dirs();
    await writeFile(join(cwd, '.pi', 'persistent-subagents.json'), JSON.stringify({ maxAgnts: 7 }));
    const result = await loadConfig(cwd, agentDir);
    assert.equal(result.config.maxAgents, DEFAULT_CONFIG.maxAgents);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /unknown.*maxAgnts/i);
  });
});

describe('resolveWorkerSelection', () => {
  const parent = {
    provider: 'work-account',
    model: 'manager-strong',
    thinking: 'high',
    cwd: '/repo',
  };

  it('inherits provider/thinking/cwd but not the parent model by default', () => {
    const result = resolveWorkerSelection({}, parent, DEFAULT_CONFIG, undefined);
    assert.deepEqual(result, {
      provider: 'work-account',
      model: undefined,
      thinking: 'high',
      cwd: '/repo',
    });
  });

  it('lets a role choose a cheaper worker while retaining the parent provider', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.roles = { coder: { model: 'worker-cheap', thinking: 'medium' } };
    const result = resolveWorkerSelection({ role: 'coder' }, parent, config, config.roles.coder);
    assert.equal(result.provider, 'work-account');
    assert.equal(result.model, 'worker-cheap');
    assert.equal(result.thinking, 'medium');
  });

  it('parses provider/model override and lets explicit fields beat the role', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const role = { provider: 'role-provider', model: 'role-model', thinking: 'low' as const };
    const result = resolveWorkerSelection({
      provider: 'explicit-provider',
      model: 'other-provider/explicit-model',
      thinking: 'xhigh',
      cwd: '/other',
    }, parent, config, role);
    assert.equal(result.provider, 'explicit-provider');
    assert.equal(result.model, 'explicit-model');
    assert.equal(result.thinking, 'xhigh');
    assert.equal(result.cwd, '/other');
  });

  it('uses the provider embedded in model when provider is not explicitly supplied', () => {
    const result = resolveWorkerSelection({ model: 'openai-codex/worker' }, parent, DEFAULT_CONFIG, undefined);
    assert.equal(result.provider, 'openai-codex');
    assert.equal(result.model, 'worker');
  });

  it('can inherit the parent model when configured', () => {
    const config = { ...DEFAULT_CONFIG, inheritParentModel: true };
    const result = resolveWorkerSelection({}, parent, config, undefined);
    assert.equal(result.model, 'manager-strong');
  });
});
