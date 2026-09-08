import fs from 'node:fs';
import path from 'node:path';

export interface PiRpcArgSpec {
  sessionFile: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface InvocationRuntime {
  currentScript?: string;
  execPath: string;
  exists: (path: string) => boolean;
}

export function buildPiRpcArgs(spec: PiRpcArgSpec): string[] {
  const args = ['--mode', 'rpc', '--session', spec.sessionFile];
  if (spec.provider) args.push('--provider', spec.provider);
  if (spec.model) args.push('--model', spec.model);
  if (spec.thinking) args.push('--thinking', spec.thinking);
  return args;
}

export function resolvePiInvocation(
  args: string[],
  runtime: InvocationRuntime = {
    currentScript: process.argv[1],
    execPath: process.execPath,
    exists: fs.existsSync,
  },
): { command: string; args: string[] } {
  const currentScript = runtime.currentScript;
  const bunVirtual = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !bunVirtual && runtime.exists(currentScript)) {
    return { command: runtime.execPath, args: [currentScript, ...args] };
  }

  const executable = path.basename(runtime.execPath).toLowerCase();
  const genericRuntime = /^(node|bun)(\.exe)?$/.test(executable);
  if (!genericRuntime) return { command: runtime.execPath, args };
  return { command: 'pi', args };
}
