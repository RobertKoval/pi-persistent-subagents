import type { WorkerSnapshot } from './pool.ts';

interface InboxOptions {
  ready: () => boolean;
  deliver: (snapshots: WorkerSnapshot[]) => void;
  notify: boolean;
}

/** Delivery bookkeeping only. It never chooses work, models, or acceptance. */
export class CompletionInbox {
  private readonly pending = new Map<string, { snapshot: WorkerSnapshot; announced: boolean }>();
  private readonly seen = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  private readonly options: InboxOptions;
  constructor(options: InboxOptions) { this.options = options; }

  publish(snapshot: WorkerSnapshot): void {
    const key = snapshot.completionId;
    if (this.disposed || !key || this.seen.has(key)) return;
    this.seen.add(key);
    this.pending.set(key, { snapshot: structuredClone(snapshot), announced: false });
    this.schedule();
  }

  /** Remove only results the caller actually returns to the manager. */
  consume(snapshots: WorkerSnapshot[], includeEarlier: boolean): WorkerSnapshot[] {
    const byId = new Map(snapshots.map(s => [s.id, s]));
    const results: WorkerSnapshot[] = [];
    for (const [key, entry] of this.pending) {
      const current = byId.get(entry.snapshot.id);
      if (!current) continue;
      if (!includeEarlier && (current.status === 'running' || current.completionId !== key)) continue;
      results.push(entry.snapshot);
      this.pending.delete(key);
    }
    if (![...this.pending.values()].some(e => !e.announced)) this.cancelTimer();
    return results;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.pending.clear();
    this.seen.clear();
  }

  private schedule(): void {
    if (this.disposed || !this.options.notify || this.timer || ![...this.pending.values()].some(e => !e.announced)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      if (!this.options.ready()) { this.schedule(); return; }
      const entries = [...this.pending.values()].filter(e => !e.announced);
      if (!entries.length) return;
      for (const entry of entries) entry.announced = true;
      this.options.deliver(entries.map(e => structuredClone(e.snapshot)));
    }, 50);
    this.timer.unref();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
