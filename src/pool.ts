import { access, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PersistentSubagentConfig } from './config.ts';
import { PersistentPiRpcClient, type RpcEvent } from './rpc-client.ts';
import { WorkerRegistry, type WorkerRecord, type WorkerStatus, type WorkerUsage } from './registry.ts';
import { resolveWorkerSelection, type ParentSelection, type WorkerSelectionInput } from './selection.ts';

export type SendMode = 'auto' | 'steer' | 'follow_up' | 'interrupt';
export type WaitMode = 'any' | 'all';

export interface PiLaunchSpec {
  sessionFile: string;
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PiInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type PiInvocationFactory = (spec: PiLaunchSpec) => PiInvocation;

export interface WorkerPoolOptions {
  config: PersistentSubagentConfig;
  storageRoot: string;
  parentSessionId: string;
  parent: ParentSelection;
  currentDepth: number;
  env: NodeJS.ProcessEnv;
  invocationFactory: PiInvocationFactory;
}

export interface SpawnAgentInput extends WorkerSelectionInput {
  task: string;
  name?: string;
}

export interface WorkerSnapshot extends WorkerRecord {
  pid?: number;
  alive: boolean;
  error?: string;
}

export interface WaitResult {
  timedOut: boolean;
  statuses: Record<string, WorkerSnapshot>;
}

interface ManagedWorker {
  record: WorkerRecord;
  client: PersistentPiRpcClient;
  commandChain: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  error?: string;
  intentionallyClosing: boolean;
}

type WorkerListener = (snapshot: WorkerSnapshot) => void;

export class WorkerPool {
  private readonly config: PersistentSubagentConfig;
  private readonly storageRoot: string;
  private readonly parentSessionId: string;
  private parent: ParentSelection;
  private readonly currentDepth: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly invocationFactory: PiInvocationFactory;
  private readonly active = new Map<string, ManagedWorker>();
  private readonly updateListeners = new Set<WorkerListener>();
  private readonly settledListeners = new Set<WorkerListener>();
  private readonly stateListeners = new Set<() => void>();
  private registry!: WorkerRegistry;
  private sessionDir!: string;
  private initialized = false;
  private shuttingDown = false;
  private cleanupPromise: Promise<void> | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();

  constructor(options: WorkerPoolOptions) {
    this.config = options.config;
    this.storageRoot = options.storageRoot;
    this.parentSessionId = options.parentSessionId;
    this.parent = options.parent;
    this.currentDepth = options.currentDepth;
    this.env = options.env;
    this.invocationFactory = options.invocationFactory;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const scope = parentScope(this.parentSessionId);
    const parentDir = join(this.storageRoot, 'parents', scope);
    this.sessionDir = join(parentDir, 'sessions');
    await mkdir(this.sessionDir, { recursive: true });
    this.registry = new WorkerRegistry(join(parentDir, 'registry.json'));
    await this.registry.load();

    const now = Date.now();
    for (const record of this.registry.list()) {
      if (record.status === 'starting' || record.status === 'running' || record.status === 'idle') {
        await this.registry.upsert({
          ...record,
          status: 'closed',
          cacheContinuity: 'cold_process',
          updatedAt: now,
        });
      }
    }
    this.initialized = true;
  }

  updateParent(parent: ParentSelection): void {
    this.parent = { ...parent };
  }

  onUpdate(listener: WorkerListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onSettled(listener: WorkerListener): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  getAgent(id: string): WorkerSnapshot | undefined {
    this.ensureInitialized();
    const active = this.active.get(id);
    if (active) return this.snapshot(active);
    const record = this.registry.get(id);
    return record ? { ...record, alive: false } : undefined;
  }

  listAgents(): WorkerSnapshot[] {
    this.ensureInitialized();
    return this.registry.list().map((record) => {
      const active = this.active.get(record.id);
      return active ? this.snapshot(active) : { ...record, alive: false };
    });
  }

  spawnAgent(input: SpawnAgentInput): Promise<WorkerSnapshot> {
    return this.enqueueLifecycle(() => this.spawnWorker(input));
  }

  private async spawnWorker(input: SpawnAgentInput): Promise<WorkerSnapshot> {
    this.ensureInitialized();
    this.assertCanStartAnother();
    const task = input.task.trim();
    if (!task) throw new Error('Agent task must be non-empty');

    const role = input.role ? this.config.roles[input.role] : undefined;
    if (input.role && !role) throw new Error(`Unknown persistent subagent role "${input.role}"`);
    const selection = resolveWorkerSelection(input, this.parent, this.config, role);
    const id = randomBytes(4).toString('hex');
    const sessionFile = join(this.sessionDir, `${id}.jsonl`);
    const now = Date.now();
    const record: WorkerRecord = {
      id,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.role ? { role: input.role } : {}),
      status: 'starting',
      sessionFile,
      ...(selection.provider ? { provider: selection.provider } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.thinking ? { thinking: selection.thinking } : {}),
      cwd: selection.cwd,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      taskPreview: preview(task),
      lastOutput: null,
      usage: zeroUsage(),
      cacheContinuity: 'warm_process',
      depth: this.currentDepth + 1,
    };

    const worker = await this.launch(record);
    try {
      worker.record.status = 'running';
      worker.record.updatedAt = Date.now();
      await this.registry.upsert(worker.record);
      await worker.client.prompt(task);
      this.emitUpdate(worker);
      return this.snapshot(worker);
    } catch (error) {
      worker.error = error instanceof Error ? error.message : String(error);
      worker.record.status = this.shuttingDown ? 'closed' : 'crashed';
      worker.record.cacheContinuity = 'cold_process';
      worker.record.updatedAt = Date.now();
      await this.registry.upsert(worker.record);
      await worker.client.stop().catch(() => undefined);
      this.active.delete(id);
      this.emitStateChange();
      throw error;
    }
  }

  async sendInput(id: string, message: string, mode: SendMode = 'auto'): Promise<WorkerSnapshot> {
    this.ensureInitialized();
    const worker = this.requireLive(id);
    const text = message.trim();
    if (!text) throw new Error('Agent input must be non-empty');
    if (!['auto', 'steer', 'follow_up', 'interrupt'].includes(mode)) throw new Error(`Unknown send mode ${mode}`);
    this.clearIdleTimer(worker);

    await this.enqueue(worker, async () => {
      const state = await worker.client.getState();
      const running = Boolean(state.isStreaming);

      if (mode === 'interrupt') {
        if (running) await worker.client.abort();
        await worker.client.prompt(text);
      } else if (mode === 'follow_up') {
        if (running) await worker.client.followUp(text);
        else await worker.client.prompt(text);
      } else if (mode === 'steer' || mode === 'auto') {
        if (running) await worker.client.steer(text);
        else await worker.client.prompt(text);
      }

      worker.record.status = 'running';
      worker.record.taskPreview = preview(text);
      worker.record.updatedAt = Date.now();
      worker.record.lastUsedAt = worker.record.updatedAt;
      await this.registry.upsert(worker.record);
      this.emitUpdate(worker);
    });

    return this.snapshot(worker);
  }

  async waitForAgents(options: {
    ids: string[];
    until?: WaitMode;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<WaitResult> {
    this.ensureInitialized();
    const ids = [...new Set(options.ids)];
    if (ids.length === 0) throw new Error('wait_agent ids must be non-empty');
    for (const id of ids) {
      if (!this.getAgent(id)) throw new Error(`Agent ${id} not found`);
    }
    const until = options.until ?? 'any';
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('wait timeout must be positive');

    const isDone = () => {
      const terminal = ids.map((id) => isTurnTerminal(this.getAgent(id)!.status));
      return until === 'all' ? terminal.every(Boolean) : terminal.some(Boolean);
    };

    if (!isDone()) {
      await new Promise<void>((resolve) => {
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          this.stateListeners.delete(onState);
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onState = () => { if (isDone()) finish(); };
        const onAbort = () => finish();
        this.stateListeners.add(onState);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(finish, timeoutMs);
        onState();
      });
    }

    const statuses = Object.fromEntries(ids.map((id) => [id, this.getAgent(id)!]));
    const done = until === 'all'
      ? Object.values(statuses).every((s) => isTurnTerminal(s.status))
      : Object.values(statuses).some((s) => isTurnTerminal(s.status));
    return { timedOut: !done, statuses };
  }

  closeAgent(id: string): Promise<WorkerSnapshot> {
    return this.enqueueLifecycle(() => this.closeWorker(id));
  }

  private async closeWorker(id: string): Promise<WorkerSnapshot> {
    this.ensureInitialized();
    const worker = this.active.get(id);
    if (!worker) {
      const existing = this.registry.get(id);
      if (!existing) throw new Error(`Agent ${id} not found`);
      if (existing.status === 'closed') return { ...existing, alive: false };
      const closed = { ...existing, status: 'closed' as WorkerStatus, cacheContinuity: 'cold_process' as const, updatedAt: Date.now() };
      await this.registry.upsert(closed);
      this.emitStateChange();
      return { ...closed, alive: false };
    }

    this.clearIdleTimer(worker);
    worker.intentionallyClosing = true;
    await worker.client.stop();
    worker.record.status = 'closed';
    worker.record.cacheContinuity = 'cold_process';
    worker.record.updatedAt = Date.now();
    await this.registry.upsert(worker.record);
    this.active.delete(id);
    const snapshot = { ...worker.record, usage: { ...worker.record.usage }, alive: false };
    this.emitSnapshot(snapshot);
    this.emitStateChange();
    return snapshot;
  }

  resumeAgent(id: string): Promise<WorkerSnapshot> {
    return this.enqueueLifecycle(() => this.resumeWorker(id));
  }

  private async resumeWorker(id: string): Promise<WorkerSnapshot> {
    this.ensureInitialized();
    this.assertCanStartAnother();
    const stale = this.active.get(id);
    let record: WorkerRecord | undefined;
    if (stale) {
      if (stale.client.isAlive()) throw new Error(`Agent ${id} is already live`);
      this.active.delete(id);
      await stale.client.stop().catch(() => undefined);
      record = { ...stale.record, usage: { ...stale.record.usage } };
      await this.registry.upsert(record);
    } else {
      record = this.registry.get(id);
    }
    if (!record) throw new Error(`Agent ${id} not found`);
    if (record.status !== 'closed' && record.status !== 'crashed') throw new Error(`Agent ${id} cannot be resumed from status ${record.status}`);
    try {
      await access(record.sessionFile);
    } catch {
      throw new Error(`Agent ${id} session file is missing: ${record.sessionFile}`);
    }

    const resumedRecord: WorkerRecord = {
      ...record,
      status: 'starting',
      cacheContinuity: 'cold_process',
      updatedAt: Date.now(),
    };
    const worker = await this.launch(resumedRecord);
    worker.record.status = 'idle';
    worker.record.updatedAt = Date.now();
    await this.registry.upsert(worker.record);
    this.emitUpdate(worker);
    this.scheduleIdleClose(worker);
    this.emitStateChange();
    return this.snapshot(worker);
  }

  cleanup(): Promise<void> {
    this.shuttingDown = true;
    return this.cleanupPromise ??= this.cleanupWorkers();
  }

  private async cleanupWorkers(): Promise<void> {
    if (!this.initialized) return;
    // Interrupt startup/prompt waits before draining serialized lifecycle work.
    const stopping = await Promise.allSettled([...this.active.values()].map(worker => {
      worker.intentionallyClosing = true;
      return worker.client.stop();
    }));
    await this.lifecycleChain;
    const closing = await Promise.allSettled([...this.active.keys()].map(id => this.closeWorker(id)));
    const errors = [...stopping, ...closing].filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed to clean up workers');
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(operation);
    this.lifecycleChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async launch(record: WorkerRecord): Promise<ManagedWorker> {
    if (this.shuttingDown) throw new Error('Worker pool is shutting down');
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      PI_PERSISTENT_SUBAGENT_DEPTH: String(this.currentDepth + 1),
    };
    const invocation = this.invocationFactory({
      sessionFile: record.sessionFile,
      provider: record.provider,
      model: record.model,
      thinking: record.thinking,
      cwd: record.cwd,
      env,
    });
    const client = new PersistentPiRpcClient({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd ?? record.cwd,
      env: invocation.env ?? env,
      startupTimeoutMs: this.config.startupTimeoutMs,
      commandTimeoutMs: this.config.commandTimeoutMs,
      shutdownGraceMs: this.config.shutdownGraceMs,
    });
    const worker: ManagedWorker = {
      record: { ...record, usage: { ...record.usage } },
      client,
      commandChain: Promise.resolve(),
      intentionallyClosing: false,
    };
    this.active.set(record.id, worker);

    client.onEvent((event) => this.handleEvent(worker, event));
    client.onExit((error) => {
      if (worker.intentionallyClosing) return;
      worker.error = error.message;
      worker.record.status = 'crashed';
      worker.record.cacheContinuity = 'cold_process';
      worker.record.updatedAt = Date.now();
      void this.registry.upsert(worker.record).catch(() => undefined);
      this.emitUpdate(worker);
      this.emitStateChange();
    });

    try {
      const state = await client.start();
      if (state.model && typeof state.model === 'object') {
        worker.record.provider = state.model.provider ?? worker.record.provider;
        worker.record.model = state.model.id ?? worker.record.model;
      }
      if (typeof state.thinkingLevel === 'string') worker.record.thinking = state.thinkingLevel;
      await this.registry.upsert(worker.record);
      return worker;
    } catch (error) {
      this.active.delete(record.id);
      throw error;
    }
  }

  private handleEvent(worker: ManagedWorker, event: RpcEvent): void {
    if (event.type === 'agent_start') {
      worker.record.completionId = undefined;
      worker.error = undefined;
      worker.record.lastOutput = null;
      worker.record.status = 'running';
      worker.record.updatedAt = Date.now();
      void this.registry.upsert(worker.record).catch(() => undefined);
      this.emitUpdate(worker);
      this.emitStateChange();
      return;
    }

    if (event.type === 'message_end') {
      const message = event.message as any;
      if (message?.role === 'assistant') {
        if (message.stopReason === 'error') {
          worker.error = typeof message.errorMessage === 'string' ? message.errorMessage : 'Provider request failed';
          worker.record.lastOutput = null;
        }
        const text = Array.isArray(message.content)
          ? message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n')
          : '';
        if (text) worker.record.lastOutput = text;
        const usage = message.usage;
        if (usage && typeof usage === 'object') addUsage(worker.record.usage, usage);
        worker.record.updatedAt = Date.now();
        void this.registry.upsert(worker.record).catch(() => undefined);
        this.emitUpdate(worker);
      }
      return;
    }

    if (event.type === 'agent_settled') {
      if (worker.intentionallyClosing || worker.record.status !== 'running') return;
      worker.record.completionId = randomUUID();
      worker.record.status = 'idle';
      worker.record.cacheContinuity = 'warm_process';
      worker.record.updatedAt = Date.now();
      worker.record.lastUsedAt = worker.record.updatedAt;
      void this.registry.upsert(worker.record).catch(() => undefined);
      const snapshot = this.snapshot(worker);
      for (const listener of [...this.settledListeners]) listener(snapshot);
      this.emitUpdate(worker);
      this.emitStateChange();
      this.scheduleIdleClose(worker);
    }
  }

  private enqueue(worker: ManagedWorker, operation: () => Promise<void>): Promise<void> {
    const result = worker.commandChain.then(operation);
    worker.commandChain = result.catch(() => undefined);
    return result;
  }

  private requireLive(id: string): ManagedWorker {
    const worker = this.active.get(id);
    if (!worker) {
      const record = this.registry.get(id);
      if (record) throw new Error(`Agent ${id} is ${record.status}; resume it before sending input`);
      throw new Error(`Agent ${id} not found`);
    }
    if (worker.record.status === 'crashed' || !worker.client.isAlive()) throw new Error(`Agent ${id} is crashed`);
    return worker;
  }

  private assertCanStartAnother(): void {
    if (this.shuttingDown) throw new Error('Worker pool is shutting down');
    if (this.currentDepth >= this.config.maxDepth) {
      throw new Error(`Persistent subagent depth limit reached (${this.currentDepth}/${this.config.maxDepth})`);
    }
    const liveCount = [...this.active.values()].filter((w) => w.client.isAlive()).length;
    if (liveCount >= this.config.maxAgents) {
      throw new Error(`Persistent subagent agent limit reached (${liveCount}/${this.config.maxAgents}); close an existing agent first`);
    }
  }

  private snapshot(worker: ManagedWorker): WorkerSnapshot {
    return {
      ...worker.record,
      usage: { ...worker.record.usage },
      pid: worker.client.pid(),
      alive: worker.client.isAlive(),
      ...(worker.error ? { error: worker.error } : {}),
    };
  }

  private emitUpdate(worker: ManagedWorker): void {
    const snapshot = this.snapshot(worker);
    this.emitSnapshot(snapshot);
  }

  private emitSnapshot(snapshot: WorkerSnapshot): void {
    for (const listener of [...this.updateListeners]) listener(snapshot);
  }

  private emitStateChange(): void {
    for (const listener of [...this.stateListeners]) listener();
  }

  private scheduleIdleClose(worker: ManagedWorker): void {
    this.clearIdleTimer(worker);
    if (this.config.idleTtlMs <= 0 || worker.record.status !== 'idle') return;
    worker.idleTimer = setTimeout(() => {
      void this.closeAgent(worker.record.id).catch(() => undefined);
    }, this.config.idleTtlMs);
  }

  private clearIdleTimer(worker: ManagedWorker): void {
    if (!worker.idleTimer) return;
    clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error('WorkerPool.initialize() must be called before use');
  }
}

function parentScope(sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return `parent-${hash}`;
}

function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function zeroUsage(): WorkerUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

function addUsage(total: WorkerUsage, usage: any): void {
  total.input += numeric(usage.input);
  total.output += numeric(usage.output);
  total.cacheRead += numeric(usage.cacheRead);
  total.cacheWrite += numeric(usage.cacheWrite);
  total.turns += 1;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isTurnTerminal(status: WorkerStatus): boolean {
  return status === 'idle' || status === 'closed' || status === 'crashed';
}
