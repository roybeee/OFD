import { createOdaDemoRepository, DEMO_IDS, type RepositoryReadiness } from "@ofd/db";
import type { FastifyInstance } from "fastify";
import { MockObjectStorage } from "@ofd/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const origin = "https://oda.example.com";
const env = { NODE_ENV: "production", APP_MODE: "production", WORKSTATION_BRAND: "oda", REPOSITORY_MODE: "postgres",
  ODA_SETTLEMENT_ONLY: "true", PROVIDER_MODE: "disabled", STORAGE_MODE: "postgres", EMAIL_PROVIDER: "disabled",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused", WEB_ORIGIN: origin, PUBLIC_APP_URL: origin,
  SESSION_COOKIE_SECURE: "true", SESSION_SECRET: "test-oda-production-session-32characters", ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  LOG_LEVEL: "silent" };
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));
async function open() {
  const repository = createOdaDemoRepository();
  const app = await buildApp({ env, repository, logger: false });
  apps.push(app);
  return { app, repository };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({ method: "POST", url: "/api/v2/auth/login", headers: { origin },
    payload: { email: "hq_master@oda.local", password: "ODA-local-demo-2026!" } });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers["set-cookie"]);
  expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
  return { origin, cookie: cookie.split(";")[0]! };
}
function readiness(): RepositoryReadiness {
  return { ok: false, database: { ok: true, mode: "postgres" }, migrations: { ok: true, expected: 4, applied: 4, missing: [], drifted: [], unexpected: [] },
    worker: { ok: false, code: "WORKER_HEARTBEAT_MISSING" } };
}

describe("ODA settlement-only production", () => {
  it("requires real authentication and rejects unsafe origins before mutation", async () => {
    const { app } = await open();
    const unauth = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers: { "x-demo-actor-id": DEMO_IDS.master } });
    expect(unauth.statusCode).toBe(401);
    for (const headers of [{}, { origin: "https://other.example.com" }, { origin, "sec-fetch-site": "cross-site" }]) {
      const response = await app.inject({ method: "POST", url: "/api/v2/auth/login", headers, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    const headers = await login(app);
    const boot = await app.inject({ method: "GET", url: "/api/v2/bootstrap", headers });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().meta).toMatchObject({ appMode: "production", providerMode: "disabled", odaSettlementOnly: true, evidenceStorage: "postgres" });
    expect(boot.json().capabilities).toContain("oda.finance.read");
    expect(boot.json().capabilities).not.toContain("hq.orders.read");
  });

  it("blocks all unrelated business and mock endpoints even for a logged-in master", async () => {
    const { app, repository } = await open();
    const headers = await login(app);
    const before = (await repository.listAudit(1000)).length;
    for (const path of ["/orders", "/webhooks/tossplace", "/webhooks/popbill", "/mock-uploads", "/mock-files", "/admin/access-policy", "/pos/stores", "/auth/anything-new"]) {
      const response = await app.inject({ method: "POST", url: `/api/v2${path}`, headers, payload: {} });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("ODA_ROUTE_UNAVAILABLE");
    }
    expect((await repository.listAudit(1000)).length).toBe(before);
    expect((await repository.claimOutbox(10)).length).toBe(0);
  });

  it("persists uploaded original bytes with the month and returns them only to authorized users", async () => {
    const { app, repository } = await open();
    const headers = await login(app);
    const base = `/api/v2/oda/${DEMO_IDS.storeDoksan}/2026-08`;
    const content = "날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,매출,월 마감,33000000,3000000,매출,pos,S-01";
    const response = await app.inject({ method: "POST", url: `${base}/import`, headers,
      payload: { expectedVersion: 0, filename: "sales.csv", kind: "pos", content } });
    expect(response.statusCode, response.body).toBe(200);
    const source = response.json().data.sources[0];
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body).not.toContain("evidenceBytes");
    const download = await app.inject({ method: "GET", url: `${base}/evidence/${source.id}`, headers });
    expect(download.statusCode).toBe(200); expect(download.body).toBe(content);
    expect((await app.inject({ method: "GET", url: `${base}/evidence/${source.id}` })).statusCode).toBe(401);
    expect((await repository.claimOutbox(10)).length).toBe(0);
  });

  it("keeps OFD production dependent on worker readiness and verified S3 storage", async () => {
    const repository = createOdaDemoRepository();
    repository.checkReadiness = async () => readiness();
    const storage = new MockObjectStorage();
    storage.checkReadiness = async () => ({ ok: true, mode: "s3", reachable: true, versioning: "Enabled" });
    const app = await buildApp({ repository, storage, logger: false, env: { ...env,
      ODA_SETTLEMENT_ONLY: undefined, WORKSTATION_BRAND: "ofd", PROVIDER_MODE: "mock", STORAGE_MODE: "s3", EMAIL_PROVIDER: "smtp",
      S3_REGION: "ap-northeast-2", S3_BUCKET: "ofd-test", S3_KMS_KEY_ID: "test-kms", SMTP_HOST: "smtp.example.com",
      EMAIL_FROM: "test@example.com", KOREA_HOLIDAYS: "2026-01-01" } });
    apps.push(app);
    const missingWorker = await app.inject({ method: "GET", url: "/api/v2/ready" });
    expect(missingWorker.statusCode).toBe(503);
    expect(missingWorker.json().components.worker.notRequired).not.toBe(true);
    repository.checkReadiness = async () => ({ ...readiness(), ok: true, worker: { ok: true } });
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(200);
    storage.checkReadiness = async () => ({ ok: true, mode: "mock", reachable: true, versioning: "NotRequired" });
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(503);
  });

  it("readiness needs real PostgreSQL, correct migrations and a verified evidence store, but no worker", async () => {
    const { app, repository } = await open();
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(503);
    repository.checkReadiness = async () => readiness();
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(503);
    Object.assign(repository, { checkOdaEvidenceReadiness: async () => ({ ok: true }) });
    const ready = await app.inject({ method: "GET", url: "/api/v2/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().components).toMatchObject({ worker: { ok: true, notRequired: true }, storage: { ok: true, mode: "postgres" } });
    Object.assign(repository, { checkOdaEvidenceReadiness: async () => ({ ok: false, code: "ODA_EVIDENCE_STORAGE_NOT_WRITABLE" }) });
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(503);
    Object.assign(repository, { checkOdaEvidenceReadiness: async () => ({ ok: true }) });
    repository.checkReadiness = async () => ({ ...readiness(), migrations: { ...readiness().migrations, ok: false, missing: ["005"] } });
    expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(503);
  });
});
