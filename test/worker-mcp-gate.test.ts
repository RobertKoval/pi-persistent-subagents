import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildPiRpcArgs } from '../src/pi-invocation.ts';
import workerMcpGate, {
  WORKER_MCP_ALLOWLIST_ENV,
  WORKER_MCP_GATE_PATH,
  compileWorkerMcpAllowlist,
  decideWorkerToolCall,
  policyFromEnv,
  validateWorkerMcpAllowlist,
  workerAllowlistForChildren,
} from '../src/worker-mcp-gate.ts';

const HINDSIGHT = { hindsight: ['recall', 'search_pages', 'get_*', 'list_*'] };
const allowed = (allowlist: Record<string, string[]>, tool: string) =>
  decideWorkerToolCall(compileWorkerMcpAllowlist(validateWorkerMcpAllowlist(allowlist)), tool).allowed;

describe('worker MCP allowlist decisions', () => {
  it('lets workers read a listed server and blocks its writes', () => {
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__recall'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__search_pages'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__get_document'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__list_tags'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__retain'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__sync_retain'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__reflect'), false);
  });

  it('blocks a tool the server adds later unless the allowlist names it', () => {
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__delete_document'), false);
  });

  it('matches whole tool names, not prefixes or substrings', () => {
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__recal'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__recall_x'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__x_recall'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__get'), false);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight__get_'), true);
  });

  it('leaves non-MCP tools, other servers and look-alike server names untouched', () => {
    assert.equal(allowed(HINDSIGHT, 'bash'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__other__retain'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsight2__retain'), true);
    assert.equal(allowed(HINDSIGHT, 'mcp__hindsigh__retain'), true);
  });

  it('closes every tool of a server listed with no patterns', () => {
    assert.equal(allowed({ hindsight: [] }, 'mcp__hindsight__recall'), false);
  });

  it('applies Pi naming to server names and patterns', () => {
    assert.equal(allowed({ 'dev-radius': ['read'] }, 'mcp__dev_radius__write'), false);
    assert.equal(allowed({ 'dev-radius': ['read'] }, 'mcp__dev_radius__read'), true);
    assert.equal(allowed({ docs: ['get-page'] }, 'mcp__docs__get_page'), true);
  });

  it('requires every server a tool name could belong to to allow it', () => {
    // mcp__a__b__c is server "a" tool "b__c", or server "a__b" tool "c".
    assert.equal(allowed({ a: ['b__c'], a__b: [] }, 'mcp__a__b__c'), false);
    assert.equal(allowed({ a: ['b__c'], a__b: ['c'] }, 'mcp__a__b__c'), true);
  });

  it('tells the worker which tools remain and where its result belongs', () => {
    const verdict = decideWorkerToolCall(compileWorkerMcpAllowlist(HINDSIGHT), 'mcp__hindsight__retain');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.allowed ? '' : verdict.reason, /recall, search_pages, get_\*, list_\*.*parent agent/);
  });
});

describe('worker MCP allowlist validation', () => {
  it('rejects malformed allowlists with the offending field', () => {
    assert.throws(() => validateWorkerMcpAllowlist([]), /must be an object/);
    assert.throws(() => validateWorkerMcpAllowlist({ 'bad name': [] }), /server "bad name"/);
    assert.throws(() => validateWorkerMcpAllowlist({ hindsight: 'recall' }), /hindsight must be an array/);
    assert.throws(() => validateWorkerMcpAllowlist({ hindsight: ['recall', ' '] }), /hindsight\[1\] must be a non-empty string/);
    assert.throws(() => validateWorkerMcpAllowlist({ hindsight: [7] }), /hindsight\[0\]/);
    assert.throws(() => validateWorkerMcpAllowlist({ 'dev-radius': [], dev_radius: [] }), /name the same Pi server/);
  });
});

describe('inherited worker policy', () => {
  it('imposes nothing when no allowlist was handed down', () => {
    assert.equal(decideWorkerToolCall(policyFromEnv(undefined), 'mcp__hindsight__retain').allowed, true);
  });

  it('fails closed for every MCP tool when the inherited value is unreadable', () => {
    for (const raw of ['', 'not json', '[]', '{"hindsight":"recall"}']) {
      const policy = policyFromEnv(raw);
      assert.equal(decideWorkerToolCall(policy, 'mcp__hindsight__recall').allowed, false, raw);
      assert.equal(decideWorkerToolCall(policy, 'mcp__other__anything').allowed, false, raw);
      assert.equal(decideWorkerToolCall(policy, 'bash').allowed, true, raw);
    }
  });

  it('passes the root allowlist down unchanged, so a worker cannot loosen it', () => {
    const root = JSON.stringify(HINDSIGHT);
    assert.equal(workerAllowlistForChildren(root, { hindsight: ['*'] }), root);
    assert.equal(workerAllowlistForChildren(undefined, HINDSIGHT), root);
    assert.equal(workerAllowlistForChildren(undefined, {}), undefined);
  });
});

describe('worker gate extension', () => {
  const previous = process.env[WORKER_MCP_ALLOWLIST_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[WORKER_MCP_ALLOWLIST_ENV];
    else process.env[WORKER_MCP_ALLOWLIST_ENV] = previous;
  });
  const load = () => {
    const handlers = new Map<string, (event: { toolName: string }) => unknown>();
    workerMcpGate({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
    return handlers.get('tool_call');
  };

  it('blocks disallowed calls in a worker that inherited an allowlist', () => {
    process.env[WORKER_MCP_ALLOWLIST_ENV] = JSON.stringify(HINDSIGHT);
    const gate = load();
    assert.ok(gate);
    assert.deepEqual(Object.keys(gate({ toolName: 'mcp__hindsight__retain' }) as object), ['block', 'reason']);
    assert.equal(gate({ toolName: 'mcp__hindsight__recall' }), undefined);
  });

  it('stays out of the way when nothing was inherited', () => {
    delete process.env[WORKER_MCP_ALLOWLIST_ENV];
    assert.equal(load(), undefined);
  });
});

describe('worker launch', () => {
  it('loads the gate explicitly so enforcement does not depend on package discovery', () => {
    const args = buildPiRpcArgs({ sessionFile: '/s.jsonl', extensions: [WORKER_MCP_GATE_PATH] });
    assert.deepEqual(args.slice(-2), ['-e', WORKER_MCP_GATE_PATH]);
    assert.match(WORKER_MCP_GATE_PATH, /worker-mcp-gate\.ts$/);
  });

  it('reads the allowlist from config, with project entries replacing global ones per server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-persistent-gate-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await mkdir(join(agentDir, 'persistent-subagents'), { recursive: true });
    await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify({
      workerMcpAllowlist: { hindsight: ['recall'], 'dev-radius': ['read'] },
    }));
    await writeFile(join(cwd, '.pi', 'persistent-subagents.json'), JSON.stringify({
      workerMcpAllowlist: { dev_radius: [] },
    }));
    const { config, warnings } = await loadConfig(cwd, agentDir);
    assert.deepEqual(warnings, []);
    assert.deepEqual(config.workerMcpAllowlist, { hindsight: ['recall'], dev_radius: [] });
  });

  it('rejects a config file whose allowlist is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-persistent-gate-'));
    const agentDir = join(root, 'agent');
    await mkdir(join(agentDir, 'persistent-subagents'), { recursive: true });
    await writeFile(join(agentDir, 'persistent-subagents', 'config.json'), JSON.stringify({ workerMcpAllowlist: { hindsight: 'recall' } }));
    const { config, warnings } = await loadConfig(root, agentDir);
    assert.deepEqual(config.workerMcpAllowlist, {});
    assert.match(warnings.join('\n'), /workerMcpAllowlist\.hindsight must be an array/);
  });
});
