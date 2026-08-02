import { createRepository } from "@ofd/db";
import { createIntegrationProviders, loadPopbillSdkServices, readProviderConfig } from "@ofd/integrations";
import { OfdWorker } from "./worker.ts";

const config = readProviderConfig(process.env);
const repository = createRepository(process.env);
const sdk = config.providerMode === "production" ? await loadPopbillSdkServices(config) : undefined;
const providers = createIntegrationProviders(config, sdk);
const worker = new OfdWorker(repository, providers.popbill, providers.email, config,
  process.env.WORKER_ID ?? `worker-${process.pid}`, Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 12));

let stopping = false;
let running = false;
const tick = async (): Promise<void> => {
  if (stopping || running) return;
  running = true;
  try {
    await worker.runScheduled();
    const result = await worker.processOnce(Number(process.env.WORKER_BATCH_SIZE ?? 20));
    if (result.claimed > 0) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  } finally {
    running = false;
  }
};

await tick();
const interval = setInterval(() => void tick().catch((error) => process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)),
  Number(process.env.WORKER_POLL_MS ?? 2_000));

const shutdown = async (): Promise<void> => {
  stopping = true;
  clearInterval(interval);
  await repository.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
