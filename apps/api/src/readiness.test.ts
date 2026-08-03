import { createDemoRepository } from "@ofd/db";
import { MockObjectStorage } from "@ofd/integrations";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("API readiness", () => {
  it("is unauthenticated and dependency-free for memory/demo mode", async () => {
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v2/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, components: {
      database: { ok: true, mode: "memory" },
      migrations: { ok: true, notRequired: true },
      worker: { ok: true, notRequired: true },
      storage: { ok: true, mode: "mock", versioning: "NotRequired" },
      projections: { ok: true, mode: "synchronous", lag: 0 },
    } });
    expect(JSON.stringify(response.json())).not.toContain("DATABASE_URL");
  });

  it("returns a structured 503 without authentication when a component fails", async () => {
    const repository = createDemoRepository();
    repository.checkReadiness = async () => ({
      ok: false,
      database: { ok: true, mode: "postgres" },
      migrations: { ok: false, expected: 4, applied: 3, missing: ["004_legacy_import_control"],
        drifted: [], unexpected: [], code: "MIGRATION_LEDGER_MISMATCH" },
      worker: { ok: false, code: "WORKER_HEARTBEAT_STALE" },
    });
    const app = await buildApp({ env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" },
      repository, storage: new MockObjectStorage(), logger: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v2/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, components: {
      migrations: { ok: false, code: "MIGRATION_LEDGER_MISMATCH" },
      worker: { ok: false, code: "WORKER_HEARTBEAT_STALE" },
    } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
