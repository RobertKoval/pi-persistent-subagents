import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDiagnostic } from '../scripts/diagnose.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('diagnose', () => {
  it('checks the package and Pi version without invoking a model prompt', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await buildDiagnostic({
      root,
      run: (command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0, stdout: '0.85.1\n', stderr: '' };
      },
      nodeVersion: 'v22.19.0',
    });
    assert.equal(result.node.ok, true);
    assert.equal(result.pi.found, true);
    assert.equal(result.pi.version, '0.85.1');
    assert.equal(result.files.missing.length, 0);
    assert.deepEqual(calls, [{ command: 'pi', args: ['--version'] }]);
    assert.equal(calls.some((call) => call.args.some((arg) => /prompt|message/i.test(arg))), false);
  });

  it('reports an old/missing Pi rather than trying to install or repair it', async () => {
    const old = await buildDiagnostic({
      root,
      run: () => ({ status: 0, stdout: '0.83.0\n', stderr: '' }),
      nodeVersion: 'v22.19.0',
    });
    assert.equal(old.pi.compatible, false);

    const missing = await buildDiagnostic({
      root,
      run: () => ({ status: 127, stdout: '', stderr: 'not found' }),
      nodeVersion: 'v22.19.0',
    });
    assert.equal(missing.pi.found, false);
  });
});
