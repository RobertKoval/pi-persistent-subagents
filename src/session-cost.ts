import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerRegistry } from './registry.ts';

/**
 * Pi's own session total, as AgentSession.getSessionStats().cost computes it in Pi 1.6: every entry of the
 * session file, not only the active branch, counting assistant and tool-result usage, compaction and branch
 * summaries, and standalone usage entries such as cache-warming refreshes. The e2e suite checks this against
 * Pi's get_session_stats so that drift in Pi fails a test instead of the footer.
 */
export function sessionCost(entries: Iterable<unknown>): number {
  let total = 0;
  for (const entry of entries) total += entryCost(entry);
  return total;
}

function entryCost(entry: unknown): number {
  if (!entry || typeof entry !== 'object') return 0;
  const e = entry as { type?: unknown; usage?: unknown; message?: { role?: unknown; usage?: unknown } };
  if (e.type === 'usage' || e.type === 'compaction' || e.type === 'branch_summary') return usageCost(e.usage);
  if (e.type === 'message' && (e.message?.role === 'assistant' || e.message?.role === 'toolResult')) return usageCost(e.message.usage);
  return 0;
}

function usageCost(usage: unknown): number {
  const total = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

export interface CostTotal {
  cost: number;
  /** Some contributing session could not be read, so cost is a lower bound. */
  partial: boolean;
  workers: number;
}

interface SessionFileCost { size: number; mtimeMs: number; cost: number; sessionId?: string }

/** Sums worker session files below a parent session, recursing into nested workers' own registries. */
export class WorkerCostLedger {
  private readonly cache = new Map<string, SessionFileCost>();
  private readonly storageRoot: string;
  private readonly scope: (sessionId: string) => string;

  constructor(storageRoot: string, scope: (sessionId: string) => string) {
    this.storageRoot = storageRoot;
    this.scope = scope;
  }

  async workersOf(parentSessionId: string, visited = { sessions: new Set<string>(), files: new Set<string>() }): Promise<CostTotal> {
    const total: CostTotal = { cost: 0, partial: false, workers: 0 };
    if (visited.sessions.has(parentSessionId)) return total;
    visited.sessions.add(parentSessionId);
    const registry = new WorkerRegistry(join(this.storageRoot, 'parents', this.scope(parentSessionId), 'registry.json'));
    try {
      await registry.load();
    } catch {
      return { ...total, partial: true };
    }
    for (const record of registry.list()) {
      // Each session file is one ledger; charging it twice would invent cost.
      if (visited.files.has(record.sessionFile)) continue;
      visited.files.add(record.sessionFile);
      total.workers++;
      const file = await this.read(record.sessionFile);
      if (file === 'missing') {
        // Pi writes a session file with the first assistant message; before that there is nothing to charge.
        if (record.usage.turns > 0) total.partial = true;
        continue;
      }
      if (file === 'unreadable') { total.partial = true; continue; }
      total.cost += file.cost;
      if (file.sessionId) {
        const nested = await this.workersOf(file.sessionId, visited);
        total.cost += nested.cost;
        total.workers += nested.workers;
        total.partial ||= nested.partial;
      }
    }
    return total;
  }

  private async read(path: string): Promise<SessionFileCost | 'missing' | 'unreadable'> {
    try {
      const info = await stat(path);
      const cached = this.cache.get(path);
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
      const entries = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
      const header = entries[0] as { type?: unknown; id?: unknown } | undefined;
      const result: SessionFileCost = {
        size: info.size,
        mtimeMs: info.mtimeMs,
        cost: sessionCost(entries),
        ...(header?.type === 'session' && typeof header.id === 'string' ? { sessionId: header.id } : {}),
      };
      this.cache.set(path, result);
      return result;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }
}

export function formatCost(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** Footer text: API-equivalent estimates from Pi's own session ledgers, never a provider bill. */
export function costStatus(main: number, workers: CostTotal): string | undefined {
  if (workers.workers === 0) return undefined;
  const mark = workers.partial ? '+?' : '';
  return `Σ ${formatCost(main + workers.cost)}${mark} · main ${formatCost(main)} · workers ${formatCost(workers.cost)}${mark}`;
}
