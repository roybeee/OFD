import { createOdaDemoRepository, createRepository, type RepositoryReadiness } from "@ofd/db";
import { MockObjectStorage } from "@ofd/integrations";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const localOrigin = "http://127.0.0.1:4175";
const headers = { host: "127.0.0.1:4175", origin: localOrigin };
const env = {
  NODE_ENV: "production", APP_MODE: "local", WORKSTATION_BRAND: "oda", REPOSITORY_MODE: "postgres", ODA_LOCAL_ENABLED: "true",
  WEB_ORIGIN: localOrigin, PUBLIC_APP_URL: localOrigin, LOG_LEVEL: "silent",
  // Unused auxiliary pools are constructed but no network I/O occurs in these injected-repository unit tests.
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  SESSION_SECRET: "local-runtime-test-session-secret-32characters", ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
  ODA_SETUP_TOKEN: "local-runtime-tests-setup-token-32characters",
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
async function localApp() {
  const repository = createOdaDemoRepository();
  const app = await buildApp({ env, repository, storage: new MockObjectStorage(), logger: false });
  apps.push(app);
  return { app, repository };
}
function readiness(migrationsOk = true, databaseOk = true): RepositoryReadiness {
  return { ok: false, database: { ok: databaseOk, mode: "postgres", ...(databaseOk ? {} : { code: "DATABASE_UNREACHABLE" }) },
    migrations: { ok: migrationsOk, expected: 4, applied: migrationsOk ? 4 : 3, missing: migrationsOk ? [] : ["004"], drifted: [], unexpected: [] },
    worker: { ok: false, code: "WORKER_HEARTBEAT_MISSING" } };
}

describe("secure local ODA runtime", () => {
  it("never falls back to seeded memory for a local repository", () => {
    expect(() => createRepository({ APP_MODE: "local" })).toThrow(/PostgreSQL/);
    expect(() => createRepository({ ...env, REPOSITORY_MODE: "memory" })).toThrow(/PostgreSQL/);
    expect(() => createRepository({ ...env, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("requires a real session and ignores demo impersonation", async () => {
    const { app } = await localApp();
    const response = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { ...headers, "x-demo-actor-id": "actor-hq-master" } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("logs in with an httpOnly strict cookie and returns only local capabilities", async () => {
    const { app } = await localApp();
    const login = await app.inject({ method: "POST", url: "/api/v2/auth/login", headers,
      payload: { email: "hq_master@oda.local", password: "ODA-local-demo-2026!" } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    const response = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { ...headers, cookie: cookie.split(";")[0]! } });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.appMode).toBe("local");
    expect(response.json().availableActors).toEqual([]);
    expect(response.json().capabilities).toContain("oda.finance.read");
    expect(response.json().capabilities).not.toContain("hq.orders.read");
  });

  it("rejects missing or foreign unsafe origins, cross-site requests and hostile hosts", async () => {
    const { app } = await localApp();
    for (const requestHeaders of [
      { host: headers.host }, { ...headers, origin: "https://attacker.example" },
      { ...headers, "sec-fetch-site": "cross-site" }, { ...headers, host: "attacker.example" },
      { ...headers, host: "localhost:4175" }, { ...headers, "x-forwarded-host": headers.host, host: "attacker.example" },
    ]) {
      const result = await app.inject({ method: "POST", url: "/api/v2/auth/login", headers: requestHeaders,
        payload: { email: "hq_master@oda.local", password: "ODA-local-demo-2026!" } });
      expect(result.statusCode).toBe(403);
      expect(["LOCAL_ORIGIN_REJECTED", "LOCAL_HOST_REJECTED"]).toContain(result.json().error.code);
    }
  });

  it("blocks all OFD and mocked business routes before their handlers run", async () => {
    const { app } = await localApp();
    for (const path of ["/orders", "/webhooks/tossplace", "/webhooks/popbill", "/mock-uploads", "/mock-files", "/admin/access-policy", "/pos/stores"]) {
      const result = await app.inject({ method: "POST", url: `/api/v2${path}`, headers, payload: {} });
      expect(result.statusCode).toBe(404);
      expect(result.json().error.code).toBe("LOCAL_UNAVAILABLE");
    }
  });

  it("internal health is unauthenticated and readiness needs database and migrations but no worker", async () => {
    const { app, repository } = await localApp();
    const health = await app.inject({ method: "GET", url: "/api/v2/health", headers: { host: "127.0.0.1:4100" } });
    expect(health.statusCode).toBe(200);
    repository.checkReadiness = async () => readiness();
    const ready = await app.inject({ method: "GET", url: "/api/v2/ready", headers: { host: "localhost:4100" } });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().components.worker).toEqual({ ok: true, notRequired: true });
    repository.checkReadiness = async () => readiness(false);
    expect((await app.inject({ method: "GET", url: "/api/v2/ready", headers })).statusCode).toBe(503);
    repository.checkReadiness = async () => readiness(true, false);
    expect((await app.inject({ method: "GET", url: "/api/v2/ready", headers })).statusCode).toBe(503);
  });

  it("does not falsely report durable readiness for an injected memory repository", async () => {
    const { app } = await localApp();
    const response = await app.inject({ method: "GET", url: "/api/v2/ready", headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().components.database.code).toBe("LOCAL_POSTGRES_REQUIRED");
  });
});
