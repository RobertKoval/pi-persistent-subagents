import { spawn, type ChildProcess } from 'node:child_process';
import { attachStrictJsonlReader, serializeJsonLine } from './jsonl.ts';

export interface RpcState {
  model?: { provider: string; id: string; api?: string } | null;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string | null;
  sessionId?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PersistentPiRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxStderrBytes?: number;
  maxJsonlBufferBytes?: number;
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventListener = (event: RpcEvent) => void;
type ExitListener = (error: Error) => void;

export class PersistentPiRpcClient {
  private readonly options: PersistentPiRpcClientOptions;
  private process: ChildProcess | null = null;
  private stopReading: (() => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private nextRequestId = 0;
  private stderr = '';
  private exitError: Error | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: PersistentPiRpcClientOptions) {
    this.options = options;
  }

  async start(): Promise<RpcState> {
    if (this.process) throw new Error('RPC client already started');

    this.exitError = null;
    this.stopping = false;
    this.stopPromise = null;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.process = child;

    this.stopReading = attachStrictJsonlReader(
      child.stdout!,
      (line) => this.handleLine(line),
      {
        maxBufferBytes: this.options.maxJsonlBufferBytes,
        onError: (error) => this.failProcess(error),
      },
    );

    const maxStderrBytes = this.options.maxStderrBytes ?? 64 * 1024;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderr += chunk.toString();
      if (Buffer.byteLength(this.stderr, 'utf8') > maxStderrBytes) {
        this.stderr = this.stderr.slice(-Math.floor(maxStderrBytes / 2));
      }
    });

    child.once('error', (error) => {
      this.failProcess(new Error(`Pi RPC process error: ${error.message}. ${this.stderrSummary()}`));
    });
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.failProcess(
        new Error(`Pi RPC process exited (code=${String(code)}, signal=${String(signal)}). ${this.stderrSummary()}`),
      );
    });
    child.stdin?.on('error', (error) => {
      if (this.stopping) return;
      this.failProcess(new Error(`Pi RPC stdin closed: ${error.message}. ${this.stderrSummary()}`));
    });

    const startupTimeoutMs = this.options.startupTimeoutMs ?? 15_000;
    try {
      return await withTimeout(this.getState(), startupTimeoutMs, `Timed out waiting ${startupTimeoutMs}ms for Pi RPC get_state handshake`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    return Boolean(this.process && this.process.exitCode === null && !this.exitError);
  }

  getStderr(): string {
    return this.stderr;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    if (this.exitError) {
      queueMicrotask(() => listener(this.exitError!));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async request(command: Record<string, unknown>): Promise<RpcResponse> {
    if (this.stopping) throw new Error('Pi RPC client is stopping');
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin) throw new Error('RPC client not started');
    if (this.exitError) throw this.exitError;
    if (child.exitCode !== null || stdin.destroyed || !stdin.writable) {
      throw new Error(`Pi RPC process is closed. ${this.stderrSummary()}`);
    }

    const id = `req_${++this.nextRequestId}`;
    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout waiting for ${String(command.type)} after ${timeoutMs}ms. ${this.stderrSummary()}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(serializeJsonLine({ ...command, id }));
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (!response.success) {
      throw new Error(response.error ?? `RPC ${response.command} failed without an error message`);
    }
    return response;
  }

  async prompt(message: string): Promise<void> {
    await this.request({ type: 'prompt', message });
  }

  async steer(message: string): Promise<void> {
    await this.request({ type: 'steer', message });
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: 'follow_up', message });
  }

  async abort(): Promise<void> {
    await this.request({ type: 'abort' });
  }

  async getState(): Promise<RpcState> {
    const response = await this.request({ type: 'get_state' });
    return (response.data ?? {}) as RpcState;
  }

  async getLastAssistantText(): Promise<string | null> {
    const response = await this.request({ type: 'get_last_assistant_text' });
    return ((response.data as { text?: string | null } | undefined)?.text ?? null);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: 'set_thinking_level', level });
  }

  async waitForIdle(timeoutMs = 60_000): Promise<void> {
    if (this.exitError) throw this.exitError;
    const state = await this.getState();
    if (!state.isStreaming) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        offEvent();
        this.exitListeners.delete(onExit);
        return true;
      };
      const onExit = (error: Error) => {
        if (cleanup()) reject(error);
      };
      const offEvent = this.onEvent((event) => {
        if (event.type === 'agent_settled' && cleanup()) resolve();
      });
      timer = setTimeout(() => {
        if (cleanup()) reject(new Error(`Timeout waiting ${timeoutMs}ms for agent_settled`));
      }, timeoutMs);
      this.exitListeners.add(onExit);
    });
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    this.stopReading?.();
    this.stopReading = null;
    this.rejectPending(new Error('Pi RPC client is stopping'));

    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const grace = this.options.shutdownGraceMs ?? 1_500;
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve();
        };
        child.once('exit', finish);
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          // Resolve only on exit: sending a signal is not proof of termination.
        }, grace);
      });
    }

    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.process = null;
    this.stopping = false;
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (error) {
      this.failProcess(new Error(`Invalid JSON from Pi RPC stdout: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    if (!data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      pending.resolve(record as unknown as RpcResponse);
      return;
    }

    for (const listener of [...this.eventListeners]) listener(record as RpcEvent);
  }

  private failProcess(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    this.rejectPending(error);
    void this.stop();
    for (const listener of [...this.exitListeners]) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrSummary(): string {
    const text = this.stderr.trim();
    return text ? `stderr: ${text}` : 'stderr: (empty)';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
