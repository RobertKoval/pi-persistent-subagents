import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { encode } from '@toon-format/toon';
import { Type } from 'typebox';
import { seedAccountSelection } from './account-selection.ts';
import { loadConfig, type PersistentSubagentConfig } from './config.ts';
import { MetricsAdapter, inheritedMetricsIdentity } from './metrics-adapter.ts';
import { buildPiRpcArgs, resolvePiInvocation } from './pi-invocation.ts';
import { WorkerPool, type PiInvocationFactory } from './pool.ts';
import { SwarmManager } from './swarm-manager.ts';

const THINKING_SCHEMA = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);

const ACTION_SCHEMA = Type.Union([
  Type.Literal('start'),
  Type.Literal('status'),
  Type.Literal('collect'),
  Type.Literal('cancel'),
  Type.Literal('apply'),
]);

interface SwarmBundle {
  sessionId: string;
  pool: WorkerPool;
  manager: SwarmManager;
  metrics: MetricsAdapter;
  config: PersistentSubagentConfig;
}

export default function swarmExtension(pi: ExtensionAPI) {
  if (parseDepth(process.env.PI_PERSISTENT_SUBAGENT_DEPTH) > 0) return;

  let bundlePromise: Promise<SwarmBundle> | null = null;
  let bundleSessionId: string | null = null;

  const currentParent = (ctx: ExtensionContext) => ({
    models: ctx.modelRegistry?.getAll().map(({ provider, id }) => ({ provider, id })),
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinking: ctx.thinkingLevel,
    cwd: ctx.cwd,
  });

  const createBundle = async (ctx: ExtensionContext): Promise<SwarmBundle> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const agentDir = getAgentDir();
    const loaded = await loadConfig(ctx.cwd, agentDir);
    for (const warning of loaded.warnings) ctx.ui.notify(`persistent-subagents swarm: ${warning}`, 'warning');

    const invocationFactory: PiInvocationFactory = (spec) => {
      seedAccountSelection(spec.sessionFile, spec.cwd, ctx.sessionManager);
      const resolved = resolvePiInvocation(buildPiRpcArgs(spec));
      return { ...resolved, cwd: spec.cwd, env: spec.env };
    };

    const metrics = new MetricsAdapter(
      metricsPath(agentDir),
      ctx.cwd,
      sessionId,
      loaded.config,
      0,
      () => ctx.ui.notify(
        'persistent-subagents swarm: metrics recording failed; this session has a telemetry gap. Check database permissions and disk space.',
        'warning',
      ),
      inheritedMetricsIdentity(process.env.PI_PERSISTENT_METRICS_IDENTITY),
    );

    const pool = new WorkerPool({
      workerEnv: record => ({
        PI_PERSISTENT_METRICS_IDENTITY: JSON.stringify(metrics.childIdentity(record)),
      }),
      observeWorker: (record, workerSession, api) => metrics.worker(record, workerSession, api),
      config: loaded.config,
      storageRoot: join(agentDir, 'persistent-subagents', 'swarm-workers'),
      parentSessionId: `${sessionId}:local-swarm`,
      parent: currentParent(ctx),
      currentDepth: 0,
      env: process.env,
      invocationFactory,
    });
    await pool.initialize();

    const sessionScope = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    const manager = new SwarmManager({
      pool,
      storageRoot: join(agentDir, 'persistent-subagents', 'swarms', `parent-${sessionScope}`),
    });
    return { sessionId, pool, manager, metrics, config: loaded.config };
  };

  const ensureBundle = async (ctx: ExtensionContext): Promise<SwarmBundle> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!bundlePromise || bundleSessionId !== sessionId) {
      if (bundlePromise) {
        const old = await bundlePromise.catch(() => null);
        await old?.manager.cleanup().catch(() => undefined);
        await old?.pool.cleanup().catch(() => undefined);
        old?.metrics.close();
      }
      bundleSessionId = sessionId;
      bundlePromise = createBundle(ctx);
    }
    const bundle = await bundlePromise;
    bundle.pool.updateParent(currentParent(ctx));
    return bundle;
  };

  const cleanup = async (): Promise<void> => {
    const current = bundlePromise;
    bundlePromise = null;
    bundleSessionId = null;
    if (!current) return;
    const bundle = await current.catch(() => null);
    await bundle?.manager.cleanup().catch(() => undefined);
    await bundle?.pool.cleanup().catch(() => undefined);
    bundle?.metrics.close();
  };

  pi.registerTool({
    name: 'swarm',
    label: 'Local speculative swarm',
    description:
      'Run cheap/local coding candidates speculatively under the current frontier orchestrator. start is asynchronous; status/collect inspect job-level evidence; cancel stops remaining candidates; apply explicitly applies one captured patch.',
    promptSnippet: 'Offload parallelizable repository exploration and verifiable patch search to cheap/local workers while you continue frontier work.',
    promptGuidelines: [
      'Use swarm start for non-trivial, executable-verifiable coding work where parallel local exploration can save frontier effort.',
      'Do not wait immediately after start when you have independent frontier work to continue; collect at the natural dependency point.',
      'Treat verified as execution evidence, not a substitute for final frontier judgment on high-risk changes.',
      'Prefer collect top_k=1; request more candidates only when the best result is ambiguous.',
    ],
    executionMode: 'parallel',
    parameters: Type.Object({
      action: ACTION_SCHEMA,
      task: Type.Optional(Type.String({ minLength: 1, description: 'Required for start.' })),
      job_id: Type.Optional(Type.String({ minLength: 1, description: 'Required except for start.' })),
      candidate_id: Type.Optional(Type.String({ minLength: 1, description: 'Optional candidate to apply.' })),
      role: Type.Optional(Type.String({ minLength: 1, description: 'Persistent-subagents role for local workers; defaults to local-swarm when configured.' })),
      provider: Type.Optional(Type.String({ minLength: 1 })),
      model: Type.Optional(Type.String({ minLength: 1, description: 'Explicit cheap/local model. Required when no local-swarm role is configured.' })),
      thinking: Type.Optional(THINKING_SCHEMA),
      max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      max_active: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      min_completed: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      acceptance_commands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensureBundle(ctx);
      if (params.action === 'start') {
        if (!params.task?.trim()) throw new Error('swarm start requires task');
        const defaultRole = bundle.config.roles['local-swarm'] ? 'local-swarm' : undefined;
        const role = params.role ?? defaultRole;
        if (!role && !params.model) {
          throw new Error('swarm start requires an explicit cheap/local model or a configured roles.local-swarm profile; refusing to fall back to the frontier/default model');
        }
        if (role && !bundle.config.roles[role]) throw new Error(`Unknown persistent subagent role "${role}"`);
        const maxCandidates = params.max_candidates ?? 6;
        const requestedActive = params.max_active ?? Math.min(3, maxCandidates);
        const maxActive = Math.min(requestedActive, maxCandidates, bundle.config.maxAgents);
        const status = bundle.manager.start({
          task: params.task,
          cwd: ctx.cwd,
          ...(role ? { role } : {}),
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.thinking ? { thinking: params.thinking } : {}),
          maxCandidates,
          maxActive,
          minCompleted: Math.min(params.min_completed ?? Math.min(2, maxCandidates), maxCandidates),
          acceptanceCommands: params.acceptance_commands ?? [],
        });
        return toolResult(encode({ ...status, max_candidates: maxCandidates, max_active: maxActive }), status);
      }

      const jobId = params.job_id?.trim();
      if (!jobId) throw new Error(`swarm ${params.action} requires job_id`);
      if (params.action === 'status') {
        const status = bundle.manager.status(jobId);
        return toolResult(encode(status), status);
      }
      if (params.action === 'collect') {
        const result = bundle.manager.collect(jobId, params.top_k ?? 1);
        return toolResult(encode(result), result);
      }
      if (params.action === 'cancel') {
        const result = await bundle.manager.cancel(jobId);
        return toolResult(encode(result), result);
      }
      const result = await bundle.manager.apply(jobId, params.candidate_id);
      return toolResult(encode({ job_id: jobId, candidate_id: params.candidate_id ?? null, ...result }), result);
    },
  });

  pi.registerCommand('pswarms', {
    description: 'Show speculative local swarm jobs for this Pi session',
    handler: async (_args, ctx) => {
      const bundle = await ensureBundle(ctx);
      const jobs = bundle.manager.list();
      const text = jobs.length
        ? jobs.map(job => `${job.id}  ${job.state}  active=${job.active} queued=${job.queued} completed=${job.completed} verified=${job.verified}`).join('\n')
        : 'No local swarm jobs for this Pi session.';
      ctx.ui.notify(text, 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    await cleanup();
  });
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: 'text' as const, text }], details };
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
}

function metricsPath(agentDir: string): string {
  return process.env.PI_PERSISTENT_SUBAGENTS_METRICS_DB?.trim()
    || join(agentDir, 'persistent-subagents', 'metrics.sqlite');
}

function parseDepth(value: string | undefined): number {
  const parsed = Number(value ?? '0');
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
