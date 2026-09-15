import { exec as execCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpawnAgentInput, WorkerSnapshot } from './pool.ts';
import {
  applyCandidatePatch,
  captureCandidate,
  createCandidateWorktree,
  createWorkspaceSnapshot,
  removeCandidateWorktree,
  removeWorkspaceSnapshot,
  type ApplyCandidateResult,
  type CandidateWorktree,
  type CapturedCandidate,
  type WorkspaceSnapshot,
} from './swarm-git.ts';

const exec = promisify(execCallback);

export type SwarmJobState = 'queued' | 'preparing' | 'running' | 'completed' | 'cancelling' | 'cancelled' | 'failed';
export type SwarmCandidateStatus = 'queued' | 'starting' | 'running' | 'verifying' | 'verified' | 'partial' | 'rejected' | 'cancelled';

export interface SwarmCommandResult {
  command: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SwarmWorkspaceOps {
  createSnapshot(cwd: string, storageRoot: string): Promise<WorkspaceSnapshot>;
  createWorktree(snapshot: WorkspaceSnapshot, candidateId: string): Promise<CandidateWorktree>;
  capture(snapshot: WorkspaceSnapshot, worktree: CandidateWorktree): Promise<CapturedCandidate>;
  removeWorktree(snapshot: WorkspaceSnapshot, worktree: CandidateWorktree): Promise<void>;
  removeSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  applyPatch(cwd: string, patchPath: string): Promise<ApplyCandidateResult>;
  verify(cwd: string, commands: string[]): Promise<SwarmCommandResult[]>;
}

export interface SwarmPoolLike {
  onSettled(listener: (snapshot: WorkerSnapshot) => void): () => void;
  spawnAgent(input: SpawnAgentInput): Promise<WorkerSnapshot>;
  closeAgent(id: string): Promise<WorkerSnapshot>;
}

export interface StartSwarmInput {
  task: string;
  cwd: string;
  role?: string;
  provider?: string;
  model?: string;
  thinking?: SpawnAgentInput['thinking'];
  maxCandidates?: number;
  maxActive?: number;
  minCompleted?: number;
  acceptanceCommands?: string[];
}

export interface SwarmStatus {
  id: string;
  state: SwarmJobState;
  active: number;
  queued: number;
  completed: number;
  cancelled: number;
  verified: number;
  error?: string;
}

export interface CollectedVerification {
  command: string;
  passed: boolean;
  exitCode: number;
}

export interface CollectedCandidate {
  id: string;
  status: Extract<SwarmCandidateStatus, 'verified' | 'partial' | 'rejected'>;
  strategy: string;
  summary?: string;
  patchPath?: string;
  changedFiles: string[];
  verification: CollectedVerification[];
  error?: string;
}

export interface SwarmCollection {
  id: string;
  state: SwarmJobState;
  recommendation?: string;
  candidates: CollectedCandidate[];
  error?: string;
}

interface CandidateRecord {
  id: string;
  strategy: string;
  status: SwarmCandidateStatus;
  workerId?: string;
  worktree?: CandidateWorktree;
  patchPath?: string;
  changedFiles: string[];
  verification: SwarmCommandResult[];
  summary?: string;
  error?: string;
}

interface JobRecord {
  id: string;
  state: SwarmJobState;
  task: string;
  cwd: string;
  role?: string;
  provider?: string;
  model?: string;
  thinking?: SpawnAgentInput['thinking'];
  maxCandidates: number;
  maxActive: number;
  minCompleted: number;
  acceptanceCommands: string[];
  candidates: CandidateRecord[];
  snapshot?: WorkspaceSnapshot;
  error?: string;
}

export interface SwarmManagerOptions {
  pool: SwarmPoolLike;
  storageRoot: string;
  workspace?: SwarmWorkspaceOps;
}

const STRATEGIES = [
  'Execution-first: reproduce the failure before editing and follow runtime evidence to the smallest fix.',
  'Static-flow: trace callers, callees, state ownership and data flow before choosing the fix site.',
  'Test-first: identify or create a focused regression test, then implement only enough code to satisfy it safely.',
  'Minimal-patch: prefer the smallest local change that preserves existing behavior and APIs.',
  'Boundary-focused: inspect edge cases, invalid states, lifecycle boundaries and cleanup paths related to the task.',
  'Alternative-root-cause: actively challenge the obvious explanation and look for a distinct causal path.',
  'Regression-focused: optimize for compatibility with surrounding behavior and search for likely regressions.',
  'Dependency-focused: inspect interactions across module/API/dependency boundaries before patching.',
];

export class SwarmManager {
  private readonly pool: SwarmPoolLike;
  private readonly storageRoot: string;
  private readonly workspace: SwarmWorkspaceOps;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly workerToCandidate = new Map<string, { jobId: string; candidateId: string }>();
  private readonly unsubscribeSettled: () => void;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: SwarmManagerOptions) {
    this.pool = options.pool;
    this.storageRoot = options.storageRoot;
    this.workspace = options.workspace ?? defaultWorkspaceOps();
    this.unsubscribeSettled = this.pool.onSettled(snapshot => {
      const owned = this.workerToCandidate.get(snapshot.id);
      if (!owned) return;
      this.enqueue(async () => this.handleSettled(owned.jobId, owned.candidateId, snapshot));
    });
  }

  start(input: StartSwarmInput): SwarmStatus {
    this.ensureLive();
    const task = input.task.trim();
    if (!task) throw new Error('Swarm task must be non-empty');
    const maxCandidates = integerRange(input.maxCandidates ?? 6, 'maxCandidates', 1, 32);
    const maxActive = integerRange(input.maxActive ?? Math.min(3, maxCandidates), 'maxActive', 1, maxCandidates);
    const minCompleted = integerRange(input.minCompleted ?? Math.min(2, maxCandidates), 'minCompleted', 1, maxCandidates);
    const id = `sw_${randomBytes(4).toString('hex')}`;
    const job: JobRecord = {
      id,
      state: 'queued',
      task,
      cwd: input.cwd,
      ...(input.role ? { role: input.role } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      maxCandidates,
      maxActive,
      minCompleted,
      acceptanceCommands: (input.acceptanceCommands ?? []).map(command => command.trim()).filter(Boolean),
      candidates: Array.from({ length: maxCandidates }, (_, index) => ({
        id: `c${index + 1}`,
        strategy: strategyFor(index),
        status: 'queued' as const,
        changedFiles: [],
        verification: [],
      })),
    };
    this.jobs.set(id, job);
    this.enqueue(async () => this.prepare(job));
    return this.status(id);
  }

  status(id: string): SwarmStatus {
    return statusOf(this.requireJob(id));
  }

  list(): SwarmStatus[] {
    return [...this.jobs.values()].map(statusOf);
  }

  collect(id: string, topK = 1): SwarmCollection {
    const job = this.requireJob(id);
    const limit = integerRange(topK, 'topK', 1, 8);
    const candidates = job.candidates.filter(isCollectable).sort(compareCandidates).slice(0, limit).map(toCollectedCandidate);
    return {
      id: job.id,
      state: job.state,
      ...(candidates[0] ? { recommendation: candidates[0].id } : {}),
      candidates,
      ...(job.error ? { error: job.error } : {}),
    };
  }

  async cancel(id: string): Promise<SwarmStatus> {
    await this.enqueue(async () => this.cancelJob(this.requireJob(id)));
    return this.status(id);
  }

  async apply(id: string, candidateId?: string): Promise<ApplyCandidateResult> {
    const job = this.requireJob(id);
    const candidate = candidateId
      ? job.candidates.find(item => item.id === candidateId)
      : job.candidates.filter(item => item.status === 'verified' || item.status === 'partial').sort(compareCandidates)[0];
    if (!candidate) return { applied: false, reason: 'No verified or partial candidate is available' };
    if (candidate.status !== 'verified' && candidate.status !== 'partial') {
      return { applied: false, reason: `Candidate ${candidate.id} is ${candidate.status} and is not eligible for apply` };
    }
    if (!candidate.patchPath) return { applied: false, reason: `Candidate ${candidate.id} has no patch artifact` };
    return this.workspace.applyPatch(job.cwd, candidate.patchPath);
  }

  async cleanup(): Promise<void> {
    if (this.disposed) return;
    const ids = [...this.jobs.values()].filter(job => !['completed', 'cancelled', 'failed'].includes(job.state)).map(job => job.id);
    for (const id of ids) await this.cancel(id).catch(() => undefined);
    this.unsubscribeSettled();
    this.disposed = true;
    await this.chain;
  }

  private async prepare(job: JobRecord): Promise<void> {
    if (job.state !== 'queued') return;
    job.state = 'preparing';
    try {
      const jobRoot = join(this.storageRoot, job.id);
      job.snapshot = await this.workspace.createSnapshot(job.cwd, jobRoot);
      job.state = 'running';
      await this.fillActive(job);
      this.completeIfExhausted(job);
    } catch (error) {
      job.state = 'failed';
      job.error = message(error);
    }
  }

  private async fillActive(job: JobRecord): Promise<void> {
    if (job.state !== 'running' || !job.snapshot) return;
    while (activeCount(job) < job.maxActive) {
      const candidate = job.candidates.find(item => item.status === 'queued');
      if (!candidate) return;
      candidate.status = 'starting';
      try {
        const worktree = await this.workspace.createWorktree(job.snapshot, candidate.id);
        candidate.worktree = worktree;
        const worker = await this.pool.spawnAgent({
          task: candidatePrompt(job, candidate.strategy),
          ...(job.role ? { role: job.role } : {}),
          ...(job.provider ? { provider: job.provider } : {}),
          ...(job.model ? { model: job.model } : {}),
          ...(job.thinking ? { thinking: job.thinking } : {}),
          cwd: worktree.path,
        });
        candidate.workerId = worker.id;
        candidate.status = 'running';
        this.workerToCandidate.set(worker.id, { jobId: job.id, candidateId: candidate.id });

        // A very fast local worker can settle between prompt acceptance and spawnAgent()
        // returning. Its onSettled event then arrives before the mapping above exists. The
        // returned pool snapshot is authoritative, so recover that completion here.
        if (workerTurnTerminal(worker.status)) {
          await this.handleSettled(job.id, candidate.id, worker);
          if (job.state !== 'running') return;
        }
      } catch (error) {
        candidate.status = 'rejected';
        candidate.error = `Candidate startup failed: ${message(error)}`;
        if (candidate.worktree) await this.workspace.removeWorktree(job.snapshot, candidate.worktree).catch(() => undefined);
      }
    }
  }

  private async handleSettled(jobId: string, candidateId: string, snapshot: WorkerSnapshot): Promise<void> {
    const job = this.jobs.get(jobId);
    const candidate = job?.candidates.find(item => item.id === candidateId);
    if (!job || !candidate || candidate.status !== 'running' || !job.snapshot || !candidate.worktree) return;
    candidate.status = 'verifying';
    candidate.summary = compact(snapshot.lastOutput ?? '', 1_200) || undefined;
    if (snapshot.error) candidate.error = snapshot.error;

    try {
      const captured = await this.workspace.capture(job.snapshot, candidate.worktree);
      candidate.patchPath = captured.patchPath;
      candidate.changedFiles = captured.changedFiles;
      candidate.verification = await this.workspace.verify(candidate.worktree.path, job.acceptanceCommands);
      if (candidate.changedFiles.length === 0) {
        candidate.status = 'rejected';
        candidate.error ??= 'Candidate produced no repository changes';
      } else if (candidate.verification.length > 0 && candidate.verification.every(result => result.passed)) {
        candidate.status = 'verified';
      } else {
        candidate.status = 'partial';
      }
    } catch (error) {
      candidate.status = 'rejected';
      candidate.error = `Candidate verification failed: ${message(error)}`;
    } finally {
      if (candidate.workerId) {
        this.workerToCandidate.delete(candidate.workerId);
        await this.pool.closeAgent(candidate.workerId).catch(() => undefined);
      }
      await this.workspace.removeWorktree(job.snapshot, candidate.worktree).catch(() => undefined);
    }

    if (shouldEarlyStop(job)) {
      await this.finishEarly(job);
      return;
    }
    await this.fillActive(job);
    this.completeIfExhausted(job);
  }

  private async finishEarly(job: JobRecord): Promise<void> {
    job.state = 'completed';
    for (const candidate of job.candidates) if (candidate.status === 'queued') candidate.status = 'cancelled';
    for (const candidate of job.candidates.filter(item => ['starting', 'running', 'verifying'].includes(item.status))) {
      candidate.status = 'cancelled';
      if (candidate.workerId) {
        this.workerToCandidate.delete(candidate.workerId);
        await this.pool.closeAgent(candidate.workerId).catch(() => undefined);
      }
      if (candidate.worktree && job.snapshot) await this.workspace.removeWorktree(job.snapshot, candidate.worktree).catch(() => undefined);
    }
  }

  private completeIfExhausted(job: JobRecord): void {
    if (job.state === 'running' && job.candidates.every(item => terminalCandidate(item.status))) job.state = 'completed';
  }

  private async cancelJob(job: JobRecord): Promise<void> {
    if (['completed', 'cancelled', 'failed'].includes(job.state)) return;
    job.state = 'cancelling';
    for (const candidate of job.candidates) if (candidate.status === 'queued') candidate.status = 'cancelled';
    for (const candidate of job.candidates.filter(item => ['starting', 'running', 'verifying'].includes(item.status))) {
      candidate.status = 'cancelled';
      if (candidate.workerId) {
        this.workerToCandidate.delete(candidate.workerId);
        await this.pool.closeAgent(candidate.workerId).catch(() => undefined);
      }
      if (candidate.worktree && job.snapshot) await this.workspace.removeWorktree(job.snapshot, candidate.worktree).catch(() => undefined);
    }
    job.state = 'cancelled';
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.chain.then(operation);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Swarm job ${id} not found`);
    return job;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('SwarmManager is disposed');
  }
}

function defaultWorkspaceOps(): SwarmWorkspaceOps {
  return {
    createSnapshot: createWorkspaceSnapshot,
    createWorktree: createCandidateWorktree,
    capture: captureCandidate,
    removeWorktree: removeCandidateWorktree,
    removeSnapshot: removeWorkspaceSnapshot,
    applyPatch: applyCandidatePatch,
    verify: verifyCommands,
  };
}

async function verifyCommands(cwd: string, commands: string[]): Promise<SwarmCommandResult[]> {
  const results: SwarmCommandResult[] = [];
  for (const command of commands) {
    try {
      const { stdout, stderr } = await exec(command, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      results.push({ command, passed: true, exitCode: 0, stdout: compact(stdout, 4_000), stderr: compact(stderr, 4_000) });
    } catch (error) {
      const value = error as any;
      results.push({
        command,
        passed: false,
        exitCode: typeof value?.code === 'number' ? value.code : 1,
        stdout: compact(typeof value?.stdout === 'string' ? value.stdout : '', 4_000),
        stderr: compact(typeof value?.stderr === 'string' ? value.stderr : message(error), 4_000),
      });
    }
  }
  return results;
}

function candidatePrompt(job: JobRecord, strategy: string): string {
  const acceptance = job.acceptanceCommands.length
    ? `\nAcceptance commands the harness will independently run after you finish:\n${job.acceptanceCommands.map(command => `- ${command}`).join('\n')}`
    : '';
  return `You are one independent candidate in a speculative local coding swarm. Work only in the current repository. Investigate the task, make actual repository edits when a fix is justified, and validate them with available tools. Do not merely describe a hypothetical patch. Keep your final message under 1000 characters and summarize root cause, files changed, tests run, and remaining risk. The harness captures the actual filesystem diff and does not trust claims about test success.\n\nTask:\n${job.task}${acceptance}\n\nSearch strategy for this independent attempt:\n${strategy}`;
}

function strategyFor(index: number): string {
  const base = STRATEGIES[index % STRATEGIES.length]!;
  return index < STRATEGIES.length ? base : `${base} Seek a distinct solution from likely earlier attempts (variant ${index + 1}).`;
}

function statusOf(job: JobRecord): SwarmStatus {
  return {
    id: job.id,
    state: job.state,
    active: activeCount(job),
    queued: job.candidates.filter(item => item.status === 'queued').length,
    completed: job.candidates.filter(item => isCollectable(item)).length,
    cancelled: job.candidates.filter(item => item.status === 'cancelled').length,
    verified: job.candidates.filter(item => item.status === 'verified').length,
    ...(job.error ? { error: job.error } : {}),
  };
}

function activeCount(job: JobRecord): number {
  return job.candidates.filter(item => ['starting', 'running', 'verifying'].includes(item.status)).length;
}

function shouldEarlyStop(job: JobRecord): boolean {
  return job.candidates.filter(isCollectable).length >= job.minCompleted && job.candidates.some(item => item.status === 'verified');
}

function terminalCandidate(status: SwarmCandidateStatus): boolean {
  return ['verified', 'partial', 'rejected', 'cancelled'].includes(status);
}

function workerTurnTerminal(status: WorkerSnapshot['status']): boolean {
  return status === 'idle' || status === 'closed' || status === 'crashed';
}

function isCollectable(candidate: CandidateRecord): candidate is CandidateRecord & { status: 'verified' | 'partial' | 'rejected' } {
  return ['verified', 'partial', 'rejected'].includes(candidate.status);
}

function compareCandidates(a: CandidateRecord, b: CandidateRecord): number {
  const rank = (candidate: CandidateRecord) => candidate.status === 'verified' ? 0 : candidate.status === 'partial' ? 1 : 2;
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  const failedA = a.verification.filter(result => !result.passed).length;
  const failedB = b.verification.filter(result => !result.passed).length;
  if (failedA !== failedB) return failedA - failedB;
  return a.changedFiles.length - b.changedFiles.length || a.id.localeCompare(b.id);
}

function toCollectedCandidate(candidate: CandidateRecord & { status: 'verified' | 'partial' | 'rejected' }): CollectedCandidate {
  return {
    id: candidate.id,
    status: candidate.status,
    strategy: candidate.strategy,
    ...(candidate.summary ? { summary: candidate.summary } : {}),
    ...(candidate.patchPath ? { patchPath: candidate.patchPath } : {}),
    changedFiles: [...candidate.changedFiles],
    verification: candidate.verification.map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
    ...(candidate.error ? { error: candidate.error } : {}),
  };
}

function integerRange(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function compact(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
