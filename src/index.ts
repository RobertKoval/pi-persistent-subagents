import { seedAccountSelection } from './account-selection.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadConfig, type PersistentSubagentConfig } from './config.ts';
import { buildPiRpcArgs, resolvePiInvocation } from './pi-invocation.ts';
import {
  WorkerPool,
  type PiInvocationFactory,
  type SendMode,
  type WorkerSnapshot,
} from './pool.ts';

const TOOL_NAMES = ['spawn_agent', 'send_input', 'wait_agent', 'list_agents', 'close_agent', 'resume_agent'] as const;
const SEND_MODES = ['auto', 'steer', 'follow_up', 'interrupt'] as const;
const THINKING_SCHEMA = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);
const SEND_MODE_SCHEMA = Type.Union([
  Type.Literal('auto'),
  Type.Literal('steer'),
  Type.Literal('follow_up'),
  Type.Literal('interrupt'),
]);

interface PoolBundle {
  sessionId: string;
  pool: WorkerPool;
  config: PersistentSubagentConfig;
  depth: number;
}

export default function persistentSubagentsExtension(pi: ExtensionAPI) {
  let bundlePromise: Promise<PoolBundle> | null = null;
  let bundleSessionId: string | null = null;

  const currentParent = (ctx: ExtensionContext) => ({
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinking: ctx.thinkingLevel,
    cwd: ctx.cwd,
  });

  const createBundle = async (ctx: ExtensionContext): Promise<PoolBundle> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const agentDir = getAgentDir();
    const loaded = await loadConfig(ctx.cwd, agentDir);
    for (const warning of loaded.warnings) ctx.ui.notify(`persistent-subagents: ${warning}`, 'warning');

    const depth = parseDepth(process.env.PI_PERSISTENT_SUBAGENT_DEPTH);
    const invocationFactory: PiInvocationFactory = (spec) => {
      seedAccountSelection(spec.sessionFile, spec.cwd, ctx.sessionManager);
      const resolved = resolvePiInvocation(buildPiRpcArgs(spec));
      return { ...resolved, cwd: spec.cwd, env: spec.env };
    };

    const pool = new WorkerPool({
      config: loaded.config,
      storageRoot: join(agentDir, 'persistent-subagents'),
      parentSessionId: sessionId,
      parent: currentParent(ctx),
      currentDepth: depth,
      env: process.env,
      invocationFactory,
    });
    await pool.initialize();

    if (loaded.config.notifyOnSettled) {
      pool.onSettled((snapshot) => {
        const content = completionNotification(snapshot);
        pi.sendMessage(
          {
            customType: 'persistent-subagent-notification',
            content,
            display: true,
            details: {
              agentId: snapshot.id,
              name: snapshot.name,
              role: snapshot.role,
              status: snapshot.status,
            },
          },
          { triggerTurn: false },
        );
      });
    }

    return { sessionId, pool, config: loaded.config, depth };
  };

  const ensurePool = async (ctx: ExtensionContext): Promise<PoolBundle> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!bundlePromise || bundleSessionId !== sessionId) {
      if (bundlePromise) {
        const previous = await bundlePromise.catch(() => null);
        await previous?.pool.cleanup().catch(() => undefined);
      }
      bundleSessionId = sessionId;
      bundlePromise = createBundle(ctx);
    }

    try {
      const bundle = await bundlePromise;
      bundle.pool.updateParent(currentParent(ctx));
      return bundle;
    } catch (error) {
      bundlePromise = null;
      bundleSessionId = null;
      throw error;
    }
  };

  const cleanupCurrent = async (): Promise<void> => {
    const current = bundlePromise;
    bundlePromise = null;
    bundleSessionId = null;
    if (!current) return;
    const bundle = await current.catch(() => null);
    await bundle?.pool.cleanup().catch(() => undefined);
  };

  pi.registerTool({
    name: 'spawn_agent',
    label: 'Spawn persistent agent',
    description:
      'Start a long-lived Pi RPC worker. The process remains alive after it finishes so related work can reuse the same agent/session. Prefer send_input on an existing worker instead of spawning a new one for related tasks.',
    promptSnippet: 'Start one persistent worker actor for a distinct ongoing role or workstream.',
    promptGuidelines: [
      'Reuse existing persistent workers with send_input for related follow-up work; do not respawn merely to issue a new task.',
      'Use list_agents before spawning when you may already have a suitable worker.',
      'Use wait_agent when you need worker results before deciding the next action.',
    ],
    executionMode: 'parallel',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: 'Initial task/instruction.' }),
      name: Type.Optional(Type.String({ minLength: 1, description: 'Human-readable stable worker name.' })),
      role: Type.Optional(Type.String({ minLength: 1, description: 'Configured role profile from persistent-subagents config.' })),
      provider: Type.Optional(Type.String({ minLength: 1, description: 'Provider override. Usually omit to inherit current account/provider.' })),
      model: Type.Optional(Type.String({ minLength: 1, description: 'Model ID or provider/model override.' })),
      thinking: Type.Optional(THINKING_SCHEMA),
      cwd: Type.Optional(Type.String({ minLength: 1, description: 'Worker working directory; defaults to parent cwd.' })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const snapshot = await bundle.pool.spawnAgent({
        task: params.task,
        name: params.name,
        role: params.role,
        provider: params.provider,
        model: params.model,
        thinking: params.thinking,
        cwd: params.cwd,
      });
      return toolResult(snapshotSummary(snapshot), snapshot);
    },
  });

  pi.registerTool({
    name: 'send_input',
    label: 'Send input to persistent agent',
    description:
      'Talk to an existing persistent worker without restarting it. auto sends a normal prompt when idle and steer when running; follow_up queues work; interrupt aborts current work before a fresh prompt.',
    promptSnippet: 'Continue or steer an already-running persistent worker.',
    promptGuidelines: ['Keep the same worker for the same code area/role when continuity is useful.'],
    executionMode: 'parallel',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Worker ID from spawn_agent/list_agents.' }),
      message: Type.String({ minLength: 1, description: 'Instruction to deliver.' }),
      mode: Type.Optional(SEND_MODE_SCHEMA),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const snapshot = await bundle.pool.sendInput(params.id, params.message, (params.mode ?? 'auto') as SendMode);
      return toolResult(snapshotSummary(snapshot), snapshot);
    },
  });

  pi.registerTool({
    name: 'wait_agent',
    label: 'Wait for persistent agents',
    description: 'Wait until any or all selected workers settle, close, or crash. A timeout reports state and never kills workers.',
    promptSnippet: 'Wait for one or more persistent workers to finish their current turn.',
    executionMode: 'parallel',
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
      until: Type.Optional(Type.Union([Type.Literal('any'), Type.Literal('all')])),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const result = await bundle.pool.waitForAgents({
        ids: params.ids,
        until: params.until ?? 'any',
        timeoutMs: params.timeout_ms ?? 30_000,
        signal,
      });
      return toolResult(JSON.stringify({ timed_out: result.timedOut, agents: simplifySnapshots(Object.values(result.statuses)) }, null, 2), result);
    },
  });

  pi.registerTool({
    name: 'list_agents',
    label: 'List persistent agents',
    description: 'List live and resumable persistent workers, including PID, lifecycle, model/provider, session, usage, and latest output.',
    promptSnippet: 'Inspect persistent worker state before spawning redundant workers.',
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const agents = bundle.pool.listAgents();
      return toolResult(JSON.stringify(simplifySnapshots(agents), null, 2), agents);
    },
  });

  pi.registerTool({
    name: 'close_agent',
    label: 'Close persistent agent',
    description: 'Stop a persistent worker process while preserving its Pi session for later resume. This intentionally loses process-local cache continuity.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const snapshot = await bundle.pool.closeAgent(params.id);
      return toolResult(snapshotSummary(snapshot), snapshot);
    },
  });

  pi.registerTool({
    name: 'resume_agent',
    label: 'Resume persistent agent',
    description: 'Restart a closed/crashed worker from its saved Pi session. Transcript continuity is retained, but the new process begins cache-cold relative to the previous process.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const snapshot = await bundle.pool.resumeAgent(params.id);
      return toolResult(snapshotSummary(snapshot), snapshot);
    },
  });

  pi.registerCommand('pworkers', {
    description: 'Show persistent worker processes and resumable sessions',
    handler: async (_args, ctx) => {
      const bundle = await ensurePool(ctx);
      const agents = bundle.pool.listAgents();
      ctx.ui.notify(agents.length ? humanAgentList(agents) : 'No persistent workers for this Pi session.', 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const bundle = await ensurePool(ctx);
    if (bundle.depth >= bundle.config.maxDepth) {
      const active = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]));
      pi.setActiveTools(active);
    }
  });

  pi.on('session_shutdown', async () => {
    await cleanupCurrent();
  });
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), '.pi', 'agent');
}

function parseDepth(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: 'text' as const, text }], details };
}

function snapshotSummary(snapshot: WorkerSnapshot): string {
  return JSON.stringify({
    id: snapshot.id,
    name: snapshot.name,
    role: snapshot.role,
    status: snapshot.status,
    pid: snapshot.pid,
    alive: snapshot.alive,
    provider: snapshot.provider,
    model: snapshot.model,
    thinking: snapshot.thinking,
    cwd: snapshot.cwd,
    session_file: snapshot.sessionFile,
    cache_continuity: snapshot.cacheContinuity,
    usage: snapshot.usage,
    last_output: snapshot.lastOutput,
    error: snapshot.error,
  }, null, 2);
}

function simplifySnapshots(snapshots: WorkerSnapshot[]) {
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    name: snapshot.name,
    role: snapshot.role,
    status: snapshot.status,
    pid: snapshot.pid,
    alive: snapshot.alive,
    provider: snapshot.provider,
    model: snapshot.model,
    thinking: snapshot.thinking,
    cache_continuity: snapshot.cacheContinuity,
    session_file: snapshot.sessionFile,
    task: snapshot.taskPreview,
    usage: snapshot.usage,
    last_output: snapshot.lastOutput,
    error: snapshot.error,
  }));
}

function humanAgentList(agents: WorkerSnapshot[]): string {
  return agents.map((a) => {
    const identity = [a.id, a.name, a.role].filter(Boolean).join(' · ');
    const process = a.pid ? `pid=${a.pid}` : 'no-process';
    const model = [a.provider, a.model].filter(Boolean).join('/');
    return `${identity} — ${a.status} — ${process}${model ? ` — ${model}` : ''} — ${a.cacheContinuity}`;
  }).join('\n');
}

function completionNotification(snapshot: WorkerSnapshot): string {
  return `Worker ${snapshot.id}: ${snapshot.error ? 'error' : snapshot.status}. Use wait_agent for its result.`;
}
