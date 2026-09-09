import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type WorkerStatus = 'starting' | 'running' | 'idle' | 'closed' | 'crashed';
export type CacheContinuity = 'warm_process' | 'cold_process';

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
}

export interface WorkerRecord {
  id: string;
  name?: string;
  role?: string;
  status: WorkerStatus;
  sessionFile: string;
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  taskPreview: string;
  lastOutput: string | null;
  completionId?: string;
  usage: WorkerUsage;
  cacheContinuity: CacheContinuity;
  depth: number;
}

interface RegistryFile {
  version: 1;
  workers: WorkerRecord[];
}

export class WorkerRegistry {
  private readonly path: string;
  private readonly records = new Map<string, WorkerRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Worker registry is invalid JSON at ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as any).version !== 1 || !Array.isArray((parsed as any).workers)) {
      throw new Error(`Worker registry is invalid at ${this.path}: expected { version: 1, workers: [] }`);
    }

    this.records.clear();
    for (const raw of (parsed as RegistryFile).workers) {
      const record = sanitizeRecord(raw);
      if (this.records.has(record.id)) throw new Error(`Worker registry is invalid at ${this.path}: duplicate worker id ${record.id}`);
      this.records.set(record.id, record);
    }
    this.loaded = true;
  }

  get(id: string): WorkerRecord | undefined {
    this.ensureLoaded();
    const value = this.records.get(id);
    return value ? cloneRecord(value) : undefined;
  }

  list(): WorkerRecord[] {
    this.ensureLoaded();
    return [...this.records.values()].map(cloneRecord);
  }

  async upsert(record: WorkerRecord): Promise<void> {
    this.ensureLoaded();
    this.records.set(record.id, sanitizeRecord(record));
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.ensureLoaded();
    this.records.delete(id);
    await this.persist();
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('WorkerRegistry.load() must be called before use');
  }

  private async persist(): Promise<void> {
    const snapshot: RegistryFile = {
      version: 1,
      workers: [...this.records.values()].map(sanitizeRecord),
    };
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;

    this.writeChain = this.writeChain.then(async () => {
      const dir = dirname(this.path);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, this.path);
      } catch (error) {
        throw new Error(`Failed to persist worker registry ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return this.writeChain;
  }
}

function sanitizeRecord(raw: WorkerRecord): WorkerRecord {
  if (!raw || typeof raw !== 'object') throw new Error('Worker registry contains a non-object record');
  const id = requiredString(raw.id, 'id');
  const status = raw.status;
  if (!['starting', 'running', 'idle', 'closed', 'crashed'].includes(status)) throw new Error(`Worker registry record ${id} has invalid status`);
  const cacheContinuity = raw.cacheContinuity;
  if (!['warm_process', 'cold_process'].includes(cacheContinuity)) throw new Error(`Worker registry record ${id} has invalid cacheContinuity`);
  const usage = raw.usage;
  if (!usage || typeof usage !== 'object') throw new Error(`Worker registry record ${id} has invalid usage`);

  return {
    id,
    ...(optionalString(raw.name) ? { name: optionalString(raw.name) } : {}),
    ...(optionalString(raw.role) ? { role: optionalString(raw.role) } : {}),
    status,
    sessionFile: requiredString(raw.sessionFile, 'sessionFile'),
    ...(optionalString(raw.provider) ? { provider: optionalString(raw.provider) } : {}),
    ...(optionalString(raw.model) ? { model: optionalString(raw.model) } : {}),
    ...(optionalString(raw.thinking) ? { thinking: optionalString(raw.thinking) } : {}),
    cwd: requiredString(raw.cwd, 'cwd'),
    createdAt: finiteNumber(raw.createdAt, 'createdAt'),
    updatedAt: finiteNumber(raw.updatedAt, 'updatedAt'),
    lastUsedAt: finiteNumber(raw.lastUsedAt, 'lastUsedAt'),
    ...(optionalString(raw.completionId) ? { completionId: optionalString(raw.completionId) } : {}),
    taskPreview: typeof raw.taskPreview === 'string' ? raw.taskPreview : '',
    lastOutput: raw.lastOutput === null ? null : (typeof raw.lastOutput === 'string' ? raw.lastOutput : null),
    usage: {
      input: nonNegative(usage.input, 'usage.input'),
      output: nonNegative(usage.output, 'usage.output'),
      cacheRead: nonNegative(usage.cacheRead, 'usage.cacheRead'),
      cacheWrite: nonNegative(usage.cacheWrite, 'usage.cacheWrite'),
      turns: nonNegative(usage.turns, 'usage.turns'),
    },
    cacheContinuity,
    depth: nonNegative(raw.depth, 'depth'),
  };
}

function cloneRecord(record: WorkerRecord): WorkerRecord {
  return { ...record, usage: { ...record.usage } };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Worker registry field ${name} must be a non-empty string`);
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Worker registry field ${name} must be finite`);
  return value;
}
function nonNegative(value: unknown, name: string): number {
  const n = finiteNumber(value, name);
  if (n < 0) throw new Error(`Worker registry field ${name} must be non-negative`);
  return n;
}
