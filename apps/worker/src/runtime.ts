import type { StateRepository } from "@ofd/db";

export interface RuntimeWorker {
  heartbeat(state?: "running" | "stopping", now?: Date): Promise<void>;
  runScheduled(now?: Date): Promise<void>;
  processOnce(limit?: number): Promise<{ claimed: number; completed: number; failed: number; fenced: number }>;
}

export interface WorkerRuntimeOptions {
  pollMs: number;
  batchSize: number;
  onError?: (domain: "heartbeat" | "scheduler" | "outbox" | "shutdown", error: unknown) => void;
  onResult?: (result: Awaited<ReturnType<RuntimeWorker["processOnce"]>>) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class WorkerRuntime {
  private stopping = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private activeTick: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly worker: RuntimeWorker,
    private readonly repository: StateRepository,
    private readonly options: WorkerRuntimeOptions,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    if (this.stopping) return;
    const schedule = this.options.setIntervalFn ?? setInterval;
    this.interval = schedule(() => void this.tick(), this.options.pollMs);
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.activeTick) return this.activeTick;
    const running = this.runCycle().finally(() => {
      if (this.activeTick === running) this.activeTick = undefined;
    });
    this.activeTick = running;
    return running;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopGracefully();
    return this.stopPromise;
  }

  private async runCycle(): Promise<void> {
    try {
      await this.worker.heartbeat("running");
    } catch (error) {
      this.report("heartbeat", error);
    }
    try {
      await this.worker.runScheduled();
    } catch (error) {
      this.report("scheduler", error);
    }
    try {
      const result = await this.worker.processOnce(this.options.batchSize);
      this.options.onResult?.(result);
    } catch (error) {
      this.report("outbox", error);
    }
  }

  private async stopGracefully(): Promise<void> {
    this.stopping = true;
    if (this.interval !== undefined) {
      const cancel = this.options.clearIntervalFn ?? clearInterval;
      cancel(this.interval);
      this.interval = undefined;
    }
    await this.activeTick;
    try {
      await this.worker.heartbeat("stopping");
    } catch (error) {
      this.report("shutdown", error);
    }
    await this.repository.close();
  }

  private report(domain: "heartbeat" | "scheduler" | "outbox" | "shutdown", error: unknown): void {
    try {
      this.options.onError?.(domain, error);
    } catch {
      // Reporting must never become another worker failure domain.
    }
  }
}
