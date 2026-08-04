import { createRepository } from "@ofd/db";
import { parseHolidayCalendar } from "@ofd/domain";
import { createIntegrationProviders, loadPopbillSdkServices, readProviderConfig } from "@ofd/integrations";
import { WorkerRuntime } from "./runtime.ts";
import { OfdWorker } from "./worker.ts";

const config = readProviderConfig(process.env);
const repository = createRepository(process.env);
const sdk = config.providerMode === "production" ? await loadPopbillSdkServices(config) : undefined;
const providers = createIntegrationProviders(config, sdk);
const holidayCalendar = parseHolidayCalendar(process.env.KOREA_HOLIDAYS, config.appMode === "production");
const worker = new OfdWorker(repository, providers.popbill, providers.email, config, providers.storage, holidayCalendar,
  process.env.WORKER_ID ?? `worker-${process.pid}`, Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 12),
  Number(process.env.OUTBOX_LEASE_MS ?? 10 * 60_000), Number(process.env.PROVIDER_CALL_TIMEOUT_MS ?? 30_000),
  Number(process.env.WORKER_HEARTBEAT_TTL_MS ?? 60_000));
const runtime = new WorkerRuntime(worker, repository, {
  pollMs: Number(process.env.WORKER_POLL_MS ?? 2_000),
  batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 20),
  onError: (domain, error) => process.stderr.write(`${domain}: ${error instanceof Error ? error.stack : String(error)}\n`),
  onResult: (result) => {
    if (result.claimed > 0) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  },
});

const shutdown = (): void => {
  void runtime.stop().then(() => { process.exitCode = 0; },
    (error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
await runtime.start();
