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
        return { status: 0, stdout: '1.6.0\n', stderr: '' };
      },
      nodeVersion: 'v22.19.0',
    });
    assert.equal(result.node.ok, true);
    assert.equal(result.pi.found, true);
    assert.equal(result.pi.version, '1.6.0');
    assert.equal(result.pi.compatible, true);
    assert.equal(result.files.missing.length, 0);
    assert.deepEqual(calls, [{ command: 'pi', args: ['--version'] }]);
    assert.equal(calls.some((call) => call.args.some((arg) => /prompt|message/i.test(arg))), false);
  });

  for (const [version, compatible] of [['1.5.2', false], ['1.6.0', true], ['1.7.3', true], ['2.0.0', false], ['0.85.1', false]] as const) {
    it(`treats Pi ${version} as ${compatible ? 'inside' : 'outside'} the tested peer range`, async () => {
      const result = await buildDiagnostic({ root, run: () => ({ status: 0, stdout: `${version}\n`, stderr: '' }), nodeVersion: 'v22.19.0' });
      assert.equal(result.pi.compatible, compatible);
    });
  }

  it('reports a missing Pi rather than trying to install or repair it', async () => {

    const missing = await buildDiagnostic({
      root,
      run: () => ({ status: 127, stdout: '', stderr: 'not found' }),
      nodeVersion: 'v22.19.0',
    });
    assert.equal(missing.pi.found, false);
  });
});
