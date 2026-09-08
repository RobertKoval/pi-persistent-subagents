import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiRpcArgs, resolvePiInvocation } from '../src/pi-invocation.ts';

describe('Pi invocation', () => {
  it('builds current RPC CLI flags without putting credentials on argv', () => {
    const args = buildPiRpcArgs({
      sessionFile: '/sessions/a.jsonl',
      provider: 'work-account',
      model: 'worker',
      thinking: 'medium',
    });
    assert.deepEqual(args, [
      '--mode', 'rpc', '--session', '/sessions/a.jsonl',
      '--provider', 'work-account', '--model', 'worker', '--thinking', 'medium',
    ]);
    assert.equal(args.some((x) => /token|api.?key|oauth/i.test(x)), false);
  });

  it('reuses the current Pi script when running under node/bun with a real argv[1]', () => {
    const resolved = resolvePiInvocation(['--mode', 'rpc'], {
      currentScript: '/opt/pi/cli.js',
      execPath: '/usr/bin/node',
      exists: (path) => path === '/opt/pi/cli.js',
    });
    assert.deepEqual(resolved, { command: '/usr/bin/node', args: ['/opt/pi/cli.js', '--mode', 'rpc'] });
  });

  it('uses the executable itself for a compiled Pi binary', () => {
    const resolved = resolvePiInvocation(['--mode', 'rpc'], {
      currentScript: '/$bunfs/root/cli.js',
      execPath: '/usr/local/bin/pi',
      exists: () => false,
    });
    assert.deepEqual(resolved, { command: '/usr/local/bin/pi', args: ['--mode', 'rpc'] });
  });

  it('falls back to pi on PATH for a generic runtime without a usable current script', () => {
    const resolved = resolvePiInvocation(['--mode', 'rpc'], {
      currentScript: undefined,
      execPath: '/usr/bin/node',
      exists: () => false,
    });
    assert.deepEqual(resolved, { command: 'pi', args: ['--mode', 'rpc'] });
  });
});
