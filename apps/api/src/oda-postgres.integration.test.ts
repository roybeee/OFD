import { createHash, randomUUID } from "node:crypto";
import {
  createOdaDemoRepository, DEMO_IDS, discoverMigrations, PostgresRepository, runMigrations,
  type AggregateChange, type AggregateType,
} from "@ofd/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { expect, it } from "vitest";
import { buildApp } from "./app.ts";

/**
 * Opt-in integration gate. This NEVER falls back to MemoryRepository.
 * Prepare a disposable LOCAL PostgreSQL database named oda_integration_test, then:
 * ODA_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/oda_integration_test \
 *   npm exec -w @ofd/api -- vitest run src/oda-postgres.integration.test.ts
 *
 * The test migrates a random private schema, closes/recreates all repository pools,
 * and removes only that schema. Extensions are installed in the dedicated test DB.
 * Test authentication/provider adapters are used; production authentication and an
 * actual server process/host restart remain separate deployment checks.
 */
const databaseUrl = process.env.ODA_TEST_DATABASE_URL;
const storeId = DEMO_IDS.storeDoksan;
const month = "2026-08";
const base = `/api/v2/oda/${storeId}/${month}`;
const owner = { "x-demo-actor-id": DEMO_IDS.owner };
const partner = { "x-demo-actor-id": DEMO_IDS.finance };
const salesCsv = "날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,매출,월 마감,33000000,3000000,매출,pos,S-01";
const expenseCsv = "날짜,유형,내용,금액,부가세,분류,채널,거래ID\n2026-08-31,비용,8월 임차료,11000000,1000000,임차료,manual,E-01";

function requireDisposableLocalDatabase(value: string): string {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.pathname !== "/oda_integration_test" || url.search || url.hash) {
    throw new Error("ODA_TEST_DATABASE_URL must target a local disposable database named oda_integration_test without URL query overrides; production/external databases are refused.");
  }
  return value;
}

it.skipIf(!databaseUrl)("persists ODA evidence, policy, concurrent updates, immutable audit, finalized snapshots and payment through PostgreSQL reconnections", async () => {
  const connectionString = requireDisposableLocalDatabase(databaseUrl!);
  const schema = `oda_test_${randomUUID().replaceAll("-", "")}`;
  const control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000 });
  const apps = new Set<FastifyInstance>();
  let schemaCreated = false;
  const scopedPool = () => new pg.Pool({
    connectionString, options: `-c search_path=${schema},public`, max: 4,
    connectionTimeoutMillis: 3_000, query_timeout: 10_000,
  });
  async function openApp() {
    const repository = new PostgresRepository(scopedPool());
    try {
      const app = await buildApp({ repository, env: { APP_MODE: "test", PROVIDER_MODE: "mock", LOG_LEVEL: "silent" }, logger: false });
      apps.add(app);
      return { app, repository };
    } catch (error) {
      await repository.close();
      throw error;
    }
  }
  async function closeApp(app: FastifyInstance) {
    await app.close(); // buildApp's onClose closes this repository's real pool.
    apps.delete(app);
  }
  const post = (app: FastifyInstance, suffix: string, payload: Record<string, unknown>, headers: Record<string, string> = owner) =>
    app.inject({ method: "POST", url: `${base}${suffix}`, payload, headers });
  const get = (app: FastifyInstance) => app.inject({ method: "GET", url: base, headers: owner });

  try {
    expect((await control.query("SELECT current_database() AS name")).rows[0].name).toBe("oda_integration_test");
    // Extensions live outside the disposable schema so its cleanup is self-contained.
    for (const extension of ["pgcrypto", "citext", "btree_gist"]) {
      await control.query(`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA public`);
    }
    await control.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const migrationPool = scopedPool();
    try {
      const client = await migrationPool.connect();
      try {
        const migrations = await discoverMigrations();
        const result = await runMigrations(client, migrations, () => undefined);
        expect(result.applied).toHaveLength(migrations.length);
      } finally { client.release(); }
    } finally { await migrationPool.end(); }

    const first = await openApp();
    expect(await first.repository.checkOdaEvidenceReadiness()).toEqual({ ok: true });
    // MemoryRepository is only a fixture factory; all application reads/writes use PG.
    const fixture = createOdaDemoRepository();
    const seed: AggregateChange[] = [];
    for (const type of ["actor", "store", "legal_entity", "credential"] as AggregateType[]) {
      for (const value of await fixture.list<{ id: string }>(type)) {
        seed.push({ type, id: value.id, ...(type === "store" ? { storeId: value.id } : {}), expectedVersion: null, value });
      }
    }
    await first.repository.commit({ changes: seed });
    const initial = (await get(first.app)).json();
    const { acknowledgements: _acknowledgements, ...policy } = initial.data.policy;
    const saved = await post(first.app, "/save", { expectedVersion: 0, policy: {
      ...policy, attributionBasis: "accrual", vatBasis: "net", posDeliveryScope: "excluded", bVatPolicy: "add10",
      agreementNote: "갑·을은 발생월 및 실제 부가세 제외 손익과 을 지급액 부가세 10% 가산에 합의함.",
    } });
    expect(saved.statusCode, saved.body).toBe(200);
    for (const [version, headers] of [[1, owner], [2, partner]] as const) {
      const signed = await post(first.app, "/confirm-policy", { expectedVersion: version }, headers);
      expect(signed.statusCode, signed.body).toBe(200);
    }
    const invalid = await post(first.app, "/import", {
      expectedVersion: 3, filename: "wrong-month.csv", kind: "pos", content: salesCsv.replace("2026-08-31", "2026-09-01"),
    });
    expect(invalid.statusCode).toBe(422);
    expect((await get(first.app)).json()).toMatchObject({ version: 3, data: { lines: [], sources: [] } });
    const imported = await post(first.app, "/import", {
      expectedVersion: 3, filename: "original-sales.csv", kind: "pos", contentBase64: Buffer.from(salesCsv).toString("base64"),
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const evidenceId = imported.json().evidence[0].id;
    expect(imported.json().evidence[0].sha256).toBe(createHash("sha256").update(salesCsv).digest("hex"));
    const expenses = await post(first.app, "/import", { expectedVersion: 4, filename: "expenses.csv", kind: "expense", content: expenseCsv });
    expect(expenses.statusCode, expenses.body).toBe(200);
    expect(expenses.json().summary).toMatchObject({ revenue: 30000000, expenses: 10000000, profit: 20000000, shareA: 11500000, shareB: 8500000, payableB: 9350000, canFinalize: true });
    const initialAuditIds = (await first.repository.listAudit(100, [storeId])).map(event => event.id);
    expect(initialAuditIds).toHaveLength(5);
    await closeApp(first.app);

    const second = await openApp();
    expect(await second.repository.checkOdaEvidenceReadiness()).toEqual({ ok: true });
    const restored = (await get(second.app)).json();
    expect(restored.version).toBe(5);
    expect(restored.data.lines).toHaveLength(2);
    expect(restored.data.policy.acknowledgements.A.actorId).toBe(DEMO_IDS.owner);
    expect(restored.data.policy.acknowledgements.B.actorId).toBe(DEMO_IDS.finance);
    expect((await second.repository.listAudit(100, [storeId])).map(event => event.id)).toEqual(initialAuditIds);
    const download = await second.app.inject({ method: "GET", url: `${base}/evidence/${evidenceId}`, headers: owner });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(Buffer.from(salesCsv))).toBe(true);
    expect((await post(second.app, "/import", { expectedVersion: 5, filename: "renamed.csv", kind: "pos", content: salesCsv })).statusCode).toBe(409);

    // Separate apps/pools exercise PG's distributed lock, not an in-process queue.
    const concurrent = await openApp();
    const replies = await Promise.all([
      post(second.app, "/comment", { expectedVersion: 5, text: "운영자 확인" }),
      post(concurrent.app, "/comment", { expectedVersion: 5, text: "지원자 확인" }, partner),
    ]);
    expect(replies.map(reply => reply.statusCode).sort()).toEqual([200, 409]);
    expect((await second.repository.listAudit(100, [storeId]))).toHaveLength(6);
    await closeApp(concurrent.app);
    const finalized = await post(second.app, "/finalize", { expectedVersion: 6 });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const snapshot = finalized.json().history[0];
    await closeApp(second.app);

    const third = await openApp();
    const finalState = (await get(third.app)).json();
    expect(finalState).toMatchObject({ version: 7, data: { status: "finalized" } });
    expect(finalState.history[0]).toEqual(snapshot);
    expect((await post(third.app, "/import", { expectedVersion: 7, filename: "extra.csv", kind: "pos", content: salesCsv })).statusCode).toBe(409);
    const paid = await post(third.app, "/paid", { expectedVersion: 7, date: "2026-09-10", reference: "검증용 이체기록 0001", amount: 9350000 });
    expect(paid.statusCode, paid.body).toBe(200);
    await closeApp(third.app);

    const fourth = await openApp();
    expect((await get(fourth.app)).json()).toMatchObject({ version: 8, data: { status: "paid" }, payment: {
      date: "2026-09-10", reference: "검증용 이체기록 0001", amount: 9350000,
    } });
    expect((await post(fourth.app, "/reopen", { expectedVersion: 8, reason: "지급 후 변경 시도 검증" })).statusCode).toBe(409);
    const audits = await fourth.repository.listAudit(100, [storeId]);
    expect(audits).toHaveLength(8);
    expect(JSON.stringify(audits)).not.toContain("evidenceBytes");
    expect(JSON.stringify(audits)).not.toContain(Buffer.from(salesCsv).toString("base64"));
    const raw = await control.query(`SELECT id, previous_hash, event_hash FROM ${schema}.audit_ledger ORDER BY sequence`);
    expect(raw.rows).toHaveLength(8);
    expect(raw.rows[0].previous_hash).toBeNull();
    for (let i = 1; i < raw.rows.length; i += 1) expect(raw.rows[i].previous_hash).toBe(raw.rows[i - 1].event_hash);
    await expect(control.query(`UPDATE ${schema}.audit_ledger SET action = 'tamper' WHERE id = $1`, [raw.rows[0].id])).rejects.toThrow();
    await expect(control.query(`DELETE FROM ${schema}.audit_ledger WHERE id = $1`, [raw.rows[0].id])).rejects.toThrow();
    await closeApp(fourth.app);
  } finally {
    try {
      await Promise.all([...apps].map(app => app.close()));
    } finally {
      try { if (schemaCreated) await control.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await control.end(); }
    }
  }
}, 30_000);
