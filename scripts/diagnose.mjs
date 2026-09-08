#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(scriptDir, '..');

export async function buildDiagnostic(options = {}) {
  const root = options.root ?? defaultRoot;
  const run = options.run ?? ((command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
    return {
      status: result.status ?? (result.error ? 127 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
    };
  });
  const nodeVersion = options.nodeVersion ?? process.version;
  const node = parseVersion(nodeVersion);
  const nodeOk = node ? compare(node, [22, 19, 0]) >= 0 : false;

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const required = [
    'package.json', 'docs/architecture.md', 'src/index.ts', 'src/rpc-client.ts', 'src/pool.ts',
    'src/registry.ts', 'src/config.ts', 'src/selection.ts', 'src/pi-invocation.ts',
  ];
  const missing = [];
  for (const relative of required) {
    try { await access(join(root, relative)); }
    catch { missing.push(relative); }
  }

  let piResult;
  try { piResult = run('pi', ['--version']); }
  catch (error) { piResult = { status: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
  const piText = String(piResult.stdout ?? '').trim();
  const piVersion = parseVersionString(piText);
  const piFound = piResult.status === 0 && Boolean(piVersion);
  const piCompatible = piFound && piVersion[0] === 0 && piVersion[1] === 85;

  return {
    package: { name: packageJson.name, version: packageJson.version, targetPi: '0.85.x' },
    node: { version: nodeVersion, ok: nodeOk, required: '>=22.19.0' },
    pi: {
      found: piFound,
      version: piVersion ? piVersion.join('.') : null,
      compatible: Boolean(piCompatible),
      expected: '0.85.x',
      stderr: String(piResult.stderr ?? '').trim() || null,
    },
    files: { missing },
    safe: {
      modelInvocations: 0,
      checkedCommand: 'pi --version',
    },
    next: {
      offlineTests: 'npm test',
      realTypecheck: 'npm install --ignore-scripts && npm run typecheck',
      loadSmoke: 'pi -e . --mode rpc --no-session --offline',
    },
  };
}

function parseVersionString(text) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function parseVersion(text) { return parseVersionString(text); }
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const diagnostic = await buildDiagnostic();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(diagnostic, null, 2));
  } else {
    console.log(`pi-persistent-subagents ${diagnostic.package.version}`);
    console.log(`Node ${diagnostic.node.version}: ${diagnostic.node.ok ? 'OK' : `NEEDS ${diagnostic.node.required}`}`);
    console.log(`Pi: ${diagnostic.pi.found ? diagnostic.pi.version : 'not found'} (${diagnostic.pi.compatible ? 'target-compatible' : 'verify/update required'})`);
    console.log(`Files: ${diagnostic.files.missing.length ? `missing ${diagnostic.files.missing.join(', ')}` : 'OK'}`);
    console.log('No model/provider request was made by this diagnostic.');
  }
}
