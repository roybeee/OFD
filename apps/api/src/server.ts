import { buildApp } from "./app.ts";

const app = await buildApp();
const port = Number(process.env.API_PORT ?? 4100);
const host = process.env.API_HOST ?? "0.0.0.0";
await app.listen({ port, host });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
