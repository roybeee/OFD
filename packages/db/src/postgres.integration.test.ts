import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createRepository, PostgresRepository } from "./index.ts";
import { discoverMigrations, runMigrations } from "./migration-runner.ts";

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL repository applies and exercises the complete durable contract", { skip: !databaseUrl }, async () => {
  const migrations = await discoverMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [
    "001_v2_core", "002_phase3_finance_documents", "003_outbox_leases", "004_legacy_import_control",
    "005_pos_ingestion", "006_product_aliases", "007_store_openings", "008_field_operations",
    "009_pos_discovery", "010_remove_mfa",
  ]);
  const migrationPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const migrationClient = await migrationPool.connect();
  try {
    await runMigrations(migrationClient, migrations, () => undefined);
  } finally {
    migrationClient.release();
  }

  const repository = createRepository({ APP_MODE: "test", REPOSITORY_MODE: "postgres", DATABASE_URL: databaseUrl });
  assert.ok(repository instanceof PostgresRepository, "REPOSITORY_MODE=postgres must select PostgreSQL even in tests");
  try {
    const aggregateId = randomUUID();
    await repository.commit({ changes: [{ type: "product", id: aggregateId, expectedVersion: null,
      value: { id: aggregateId, name: "integration product", version: 1 } }] });
    assert.deepEqual(await repository.get("product", aggregateId), { id: aggregateId, name: "integration product", version: 1 });
    await repository.commit({ changes: [{ type: "product", id: aggregateId, expectedVersion: 1,
      value: { id: aggregateId, name: "updated integration product", version: 2 } }] });
    assert.ok((await repository.list<{ id: string }>("product")).some((item) => item.id === aggregateId));

    const routeKey = randomUUID();
    const firstShipment = randomUUID();
    await repository.commit({ changes: [{ type: "shipment", id: firstShipment, storeId: randomUUID(), expectedVersion: null,
      value: { id: firstShipment, orderId: randomUUID(), driverId: routeKey, plannedDate: "2026-08-04", routeSequence: 1, version: 1 } }] });
    await assert.rejects(repository.commit({ changes: [{ type: "shipment", id: randomUUID(), storeId: randomUUID(), expectedVersion: null,
      value: { id: randomUUID(), orderId: randomUUID(), driverId: routeKey, plannedDate: "2026-08-04", routeSequence: 1, version: 1 } }] }),
    (error: unknown) => (error as { code?: string }).code === "BUSINESS_KEY_CONFLICT");

    let active = 0;
    let maximumActive = 0;
    await Promise.all([1, 2].map(() => repository.exclusiveTransaction(`integration:${routeKey}`, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    })));
    assert.equal(maximumActive, 1);

    const eventId = randomUUID();
    const now = new Date();
    await repository.commit({ changes: [], outbox: [{ id: eventId, topic: "integration.test", aggregateId,
      payload: {}, status: "pending", attempts: 0, availableAt: now.toISOString(), createdAt: now.toISOString() }] });
    const firstClaim = (await repository.claimOutbox(1, "integration-worker-a", 3, 10)).find((event) => event.id === eventId);
    assert.ok(firstClaim?.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondClaim = (await repository.claimOutbox(10, "integration-worker-b", 3, 1_000)).find((event) => event.id === eventId);
    assert.ok(secondClaim?.leaseToken);
    assert.equal(await repository.completeOutbox(eventId, "integration-worker-a", firstClaim.leaseToken!), false);
    assert.equal(await repository.completeOutbox(eventId, "integration-worker-b", secondClaim.leaseToken!), true);

    await repository.recordWorkerHeartbeat({ workerId: `integration-${routeKey}`, state: "running",
      observedAt: now.toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    const readiness = await repository.checkReadiness(migrations, new Date());
    assert.equal(readiness.ok, true);
    assert.equal(readiness.migrations.applied, migrations.length);

    const drifted = migrations.map((migration, index) => index === 0 ? { ...migration, checksumSha256: "0".repeat(64) } : migration);
    const driftClient = await migrationPool.connect();
    try {
      await assert.rejects(runMigrations(driftClient, drifted, () => undefined), /checksum mismatch/);
    } finally {
      driftClient.release();
    }
  } finally {
    await repository.close();
    await migrationPool.end();
  }
});
