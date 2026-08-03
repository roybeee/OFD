import { MemoryRepository } from "@ofd/db";
import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime, type RuntimeWorker } from "./runtime.ts";

const result = { claimed: 0, completed: 0, failed: 0, fenced: 0 };

describe("WorkerRuntime failure isolation", () => {
  it("continues outbox processing when heartbeat and scheduler fail during startup", async () => {
    const domains: string[] = [];
    let processed = 0;
    const worker: RuntimeWorker = {
      heartbeat: async () => { throw new Error("heartbeat unavailable"); },
      runScheduled: async () => { throw new Error("scheduler unavailable"); },
      processOnce: async () => { processed += 1; return result; },
    };
    const repository = new MemoryRepository();
    const runtime = new WorkerRuntime(worker, repository, {
      pollMs: 60_000,
      batchSize: 20,
      onError: (domain) => domains.push(domain),
      setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearIntervalFn: vi.fn(),
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(processed).toBe(1);
    expect(domains).toEqual(["heartbeat", "scheduler"]);
    await runtime.stop();
  });

  it("contains startup outbox errors instead of rejecting start", async () => {
    const domains: string[] = [];
    const worker: RuntimeWorker = {
      heartbeat: async () => undefined,
      runScheduled: async () => undefined,
      processOnce: async () => { throw new Error("outbox unavailable"); },
    };
    const runtime = new WorkerRuntime(worker, new MemoryRepository(), {
      pollMs: 60_000,
      batchSize: 20,
      onError: (domain) => domains.push(domain),
      setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearIntervalFn: vi.fn(),
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(domains).toEqual(["outbox"]);
    await runtime.stop();
  });

  it("waits for the active tick before recording stop and closing the repository", async () => {
    let resolveProcessing!: () => void;
    const processing = new Promise<void>((resolve) => { resolveProcessing = resolve; });
    let processingStarted!: () => void;
    const started = new Promise<void>((resolve) => { processingStarted = resolve; });
    const heartbeatStates: string[] = [];
    const worker: RuntimeWorker = {
      heartbeat: async (state = "running") => { heartbeatStates.push(state); },
      runScheduled: async () => undefined,
      processOnce: async () => { processingStarted(); await processing; return result; },
    };
    const repository = new MemoryRepository();
    let closed = false;
    repository.close = async () => { closed = true; };
    const runtime = new WorkerRuntime(worker, repository, {
      pollMs: 60_000,
      batchSize: 20,
      setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearIntervalFn: vi.fn(),
    });

    const starting = runtime.start();
    await started;
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveProcessing();
    await Promise.all([starting, stopping]);
    expect(closed).toBe(true);
    expect(heartbeatStates).toEqual(["running", "stopping"]);
  });
});
