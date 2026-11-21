import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistentPiRpcClient, type RpcEvent } from '../../src/rpc-client.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const probeExtension = fileURLToPath(new URL('./probe-extension.ts', import.meta.url));
const mockServer = fileURLToPath(new URL('./mock-openai-server.mjs', import.meta.url));

/** Prices per million tokens; large enough that every turn has a visible, exactly computable cost. */
export const MOCK_COST = { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 };

/**
 * The installed Pi runtime against a local OpenAI-compatible mock: real RPC, sessions, compaction and
 * cost accounting with no paid model call. Workers load this working tree through the isolated settings.
 */
export async function startMockPi(options: { contextWindow?: number; project?: Record<string, unknown> } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'pi-mock-work-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-mock-agent-'));
  const llmLog = join(work, 'llm.jsonl');
  const server: ChildProcess = spawn(process.execPath, [mockServer], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_LLM_LOG: llmLog } });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.stdout!.once('data', d => resolve(JSON.parse(String(d)).port));
  });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'mock-key',
    models: [{ id: 'mock-1', name: 'Mock 1', reasoning: false, input: ['text'], contextWindow: options.contextWindow ?? 200_000, maxTokens: 4096, cost: MOCK_COST }],
  } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', packages: [], extensions: [root] }));
  await mkdir(join(work, '.pi'), { recursive: true });
  await writeFile(join(work, '.pi', 'persistent-subagents.json'), JSON.stringify({ notifyOnSettled: false, metricsWorkers: false, ...options.project }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
  delete env.PI_PERSISTENT_SUBAGENT_DEPTH;
  const parent = new PersistentPiRpcClient({
    command: 'pi',
    // The parent loads the plugin through the probe only; workers get it from settings.extensions.
    args: ['--no-extensions', '-e', probeExtension, '--mode', 'rpc', '--session', join(work, 'parent.jsonl')],
    cwd: work, env, startupTimeoutMs: 30_000, commandTimeoutMs: 60_000, shutdownGraceMs: 10_000,
  });
  const events: RpcEvent[] = [];
  parent.onEvent(e => events.push(e));
  await parent.start();
  let seq = 0;
  const probe = async (tool: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = `probe-${++seq}`;
    await parent.prompt('/probe ' + JSON.stringify({ id, tool, params }));
    const messages = ((await parent.request({ type: 'get_messages' })).data as any).messages;
    const message = messages.filter((m: any) => m.customType === 'probe-result').at(-1);
    const result = JSON.parse(message.content);
    if (result.id !== id) throw new Error(`probe result mismatch: ${result.id} != ${id}`);
    if (result.error) throw new Error(result.error);
    return result.result;
  };
  /** A separate Pi process over a stored session, to read Pi's own numbers for it. */
  const sessionStats = async (sessionFile: string) => {
    const reader = new PersistentPiRpcClient({ command: 'pi', args: ['--no-extensions', '--mode', 'rpc', '--session', sessionFile], cwd: work, env, startupTimeoutMs: 30_000 });
    await reader.start();
    try { return (await reader.request({ type: 'get_session_stats' })).data as any; } finally { await reader.stop(); }
  };
  const llmRequests = async () => (await readFile(llmLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const close = async () => {
    await parent.stop();
    server.kill('SIGTERM');
    await rm(work, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  };
  return { parent, events, probe, sessionStats, llmRequests, close, work };
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

export async function sessionEntries(file: string): Promise<unknown[]> {
  return (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
}
