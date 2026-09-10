import { startMetricsPanel, type MetricsPanel } from './metrics-web.ts';
import { saveMetricsSetting } from './metrics-settings.ts';
import { MetricsAdapter, inheritedMetricsIdentity } from './metrics-adapter.ts';
import { CompletionInbox } from './completion-inbox.ts';
import { seedAccountSelection } from './account-selection.ts';
import { encode } from '@toon-format/toon';
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
  inbox: CompletionInbox;
  metrics: MetricsAdapter;
  panel?: MetricsPanel;
}

export default function persistentSubagentsExtension(pi: ExtensionAPI) {
  let bundlePromise: Promise<PoolBundle> | null = null;
  let bundleSessionId: string | null = null;

  const currentParent = (ctx: ExtensionContext) => ({
    models: ctx.modelRegistry?.getAll().map(({provider, id}) => ({provider, id})),
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

    const metrics = new MetricsAdapter(metricsPath(agentDir),ctx.cwd,sessionId,loaded.config,depth,()=>ctx.ui.notify('persistent-subagents: metrics recording failed; this session has a telemetry gap. Check database permissions and disk space.', 'warning'),inheritedMetricsIdentity(process.env.PI_PERSISTENT_METRICS_IDENTITY));
    const pool = new WorkerPool({
      workerEnv: record => ({PI_PERSISTENT_METRICS_IDENTITY:JSON.stringify(metrics.childIdentity(record))}),
      observeWorker: (record, workerSession, api) => metrics.worker(record,workerSession,api),
      config: loaded.config,
      storageRoot: join(agentDir, 'persistent-subagents'),
      parentSessionId: sessionId,
      parent: currentParent(ctx),
      currentDepth: depth,
      env: process.env,
      invocationFactory,
    });
    await pool.initialize();

    const inbox = new CompletionInbox({
      ready: () => ctx.isIdle() && !ctx.hasPendingMessages(),
      notify: loaded.config.notifyOnSettled,
      deliver: (snapshots) => pi.sendMessage({
        customType: 'persistent-subagent-notification',
        content: completionNotification(snapshots),
        display: true,
        details: { completions: snapshots.map(s => ({agentId:s.id,resultId:s.completionId})) },
      }, { triggerTurn: true }),
    });
    pool.onSettled(snapshot => inbox.publish(snapshot));
    return { sessionId, pool, config: loaded.config, depth, inbox, metrics };
  };

  const ensurePool = async (ctx: ExtensionContext): Promise<PoolBundle> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!bundlePromise || bundleSessionId !== sessionId) {
      if (bundlePromise) {
        const previous = await bundlePromise.catch(() => null);
        previous?.inbox.dispose();
        await previous?.pool.cleanup().catch(() => undefined);
        previous?.metrics.close();
        await previous?.panel?.close();
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
    bundle?.inbox.dispose();
    await bundle?.pool.cleanup().catch(() => undefined);
    bundle?.metrics.close();
    await bundle?.panel?.close();
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
      return toolResult(acknowledgement(snapshot, 'spawn'), snapshot);
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
      return toolResult(acknowledgement(snapshot, 'input'), snapshot);
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
      verbose: Type.Optional(Type.Boolean({ description: 'Include full diagnostic metadata and usage.' })),
    }),
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const started = Date.now();
      const update = () => {
        const now = Date.now();
        const workers = [...new Set(params.ids)].map(id => {
          const worker = bundle.pool.getAgent(id);
          const activity = bundle.pool.getLastActivityAt(id);
          return `${id}: ${worker?.status ?? 'unknown'}; last activity ${activity === undefined ? 'unknown' : `${Math.max(0, Math.floor((now - activity) / 1000))}s ago`}`;
        });
        onUpdate?.(toolResult(`Waiting ${Math.max(0, Math.floor((now - started) / 1000))}s\n${workers.join('\n')}`, {}));
      };
      // Pi renders partial updates; only the returned result enters model context.
      update();
      const timer = onUpdate ? setInterval(update, 1000) : undefined;
      let result;
      try {
        result = await bundle.pool.waitForAgents({
          ids: params.ids,
          until: params.until ?? 'any',
          timeoutMs: params.timeout_ms ?? 30_000,
          signal,
        });
      } finally {
        clearInterval(timer);
      }
      const snapshots = Object.values(result.statuses);
      const consumed = bundle.inbox.consume(snapshots, true);
      const additional = consumed.filter(s => {
        const current = result.statuses[s.id];
        return current.status !== 'idle' || current.completionId !== s.completionId;
      });
      return toolResult(encode({
        timed_out: result.timedOut,
        agents: params.verbose ? simplifySnapshots(snapshots) : snapshots.map(resultSummary),
        ...(additional.length ? {additional_results: additional.map(resultSummary)} : {}),
      }), {...result, ...(additional.length ? {additionalResults: additional} : {})});
    },
  });

  pi.registerTool({
    name: 'list_agents',
    label: 'List persistent agents',
    description: 'List worker IDs, names, states, PIDs, models and errors in compact TOON. Use wait_agent for selected results; verbose adds full diagnostics and latest output.',
    promptSnippet: 'Inspect persistent worker state before spawning redundant workers.',
    parameters: Type.Object({verbose: Type.Optional(Type.Boolean({description: 'Include full metadata, usage and latest output.'}))}),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const bundle = await ensurePool(ctx);
      const agents = bundle.pool.listAgents();
      if (params.verbose) bundle.inbox.consume(agents, false);
      return toolResult(encode({agents: params.verbose ? simplifySnapshots(agents) : agents.map(s => ({id:s.id,name:s.name ?? s.role ?? null,status:s.status,pid:s.pid ?? null,model:modelLabel(s),error:s.error ?? null}))}), agents);
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
      return toolResult(acknowledgement(snapshot, 'close'), snapshot);
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
      return toolResult(acknowledgement(snapshot, 'resume'), snapshot);
    },
  });

  pi.registerCommand('pmetrics', {
    description: 'Open metrics; pmetrics [global|project] workers|main on|off|inherit changes tracking',
    handler: async (args, ctx) => {
      const bundle = await ensurePool(ctx);
      const setTracking = async (role:'workers'|'main', enabled:boolean|null, scope:'project'|'global'='project') => {
        await saveMetricsSetting(scope==='global'?{scope,agentDir:getAgentDir()}:{scope,cwd:ctx.cwd},role,enabled);
        const loaded=await loadConfig(ctx.cwd,getAgentDir());
        for(const warning of loaded.warnings)ctx.ui.notify(warning,'warning');
        bundle.metrics.setTracking(role==='workers'?'worker':'main',role==='workers'?loaded.config.metricsWorkers:loaded.config.metricsMain);
      };
      const parts=args.trim().split(/\s+/);
      if(args.trim()){
        const scope=parts[0]==='global'||parts[0]==='project'?parts.shift() as 'global'|'project':'project';
        if(parts.length!==2||!['workers','main'].includes(parts[0])||!['on','off','inherit'].includes(parts[1])||(scope==='global'&&parts[1]==='inherit')){
          ctx.ui.notify('Usage: /pmetrics [global|project] workers|main on|off (project also accepts inherit)','warning');return;
        }
        await setTracking(parts[0] as 'workers'|'main',parts[1]==='inherit'?null:parts[1]==='on',scope);
        const effective=parts[0]==='workers'?bundle.config.metricsWorkers:bundle.config.metricsMain;
        ctx.ui.notify(`${parts[0]} metrics ${parts[1]}; saved ${scope==='global'?'globally (project overrides take precedence)':'for this project'}. Current session: ${effective?'on':'off'}. Other running Pi sessions retain their settings.`,'info');return;
      }
      bundle.panel ??= await startMetricsPanel(metricsPath(getAgentDir()),{
        getSettings:()=>({workers:bundle.config.metricsWorkers,main:bundle.config.metricsMain}),setTracking,
      });
      ctx.ui.notify(`Metrics dashboard: ${bundle.panel.url}`,'info');
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

  const track = async (data: {type:string}, ctx: ExtensionContext) => { (await ensurePool(ctx)).metrics.mainEvent(data,{provider:ctx.model?.provider,model:ctx.model?.id,api:ctx.model?.api}); };
  pi.on('session_before_compact', track);
  pi.on('session_compact', track);
  pi.on('session_compact_failed', track);
  pi.on('agent_settled', track);
  pi.on('agent_start', track);
  pi.on('agent_end', track);
  pi.on('turn_start', track);
  pi.on('message_start', track);
  pi.on('message_update', track);
  pi.on('message_end', track);
  pi.on('tool_execution_start', track);
  pi.on('tool_execution_end', track);

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

function modelLabel(snapshot: WorkerSnapshot): string | null {
  return snapshot.model ? [snapshot.provider, snapshot.model].filter(Boolean).join('/') : null;
}

function acknowledgement(snapshot: WorkerSnapshot, operation: 'spawn' | 'input' | 'close' | 'resume'): string {
  return encode({
    id: snapshot.id,
    status: snapshot.status,
    ...(snapshot.pid !== undefined ? {pid:snapshot.pid} : {}),
    ...(operation === 'spawn' ? {model:modelLabel(snapshot)} : {}),
    ...(operation === 'resume' ? {cache_continuity:snapshot.cacheContinuity} : {}),
    ...(snapshot.error ? {error:snapshot.error} : {}),
  });
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
    result_id: snapshot.completionId,
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

function resultSummary(snapshot: WorkerSnapshot) {
  return {id:snapshot.id,status:snapshot.status,result_id:snapshot.completionId ?? null,error:snapshot.error ?? null,output:snapshot.lastOutput};
}

function completionNotification(snapshots: WorkerSnapshot[]): string {
  return snapshots.map(s => `Worker ${s.id}: ${s.error ? 'error' : s.status} (result ${s.completionId}).`).join('\n') + '\nUse wait_agent for unread results.';
}

function metricsPath(agentDir:string):string {
  return process.env.PI_PERSISTENT_SUBAGENTS_METRICS_DB || join(agentDir,'persistent-subagents','metrics.sqlite');
}
