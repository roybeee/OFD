import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createOdaMonth, calculateOdaMonth } from "@ofd/domain";
import { createRepository, PostgresRepository } from "./index.ts";
import { discoverMigrations, runMigrations } from "./migration-runner.ts";

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL repository applies and exercises the complete durable contract", { skip: !databaseUrl }, async () => {
  const migrations = await discoverMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [
    "001_v2_core", "002_phase3_finance_documents", "003_outbox_leases", "004_legacy_import_control",
    "005_pos_ingestion", "006_product_aliases", "007_store_openings", "008_field_operations",
    "009_pos_discovery", "010_remove_mfa", "011_pos_alias_backfill",
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
    const odaStore = randomUUID();
    const odaMonth = { ...createOdaMonth(odaStore, "2026-08"), version: 1 };
    const frozen = { ...calculateOdaMonth(odaMonth), revenue: 1234567 };
    odaMonth.history.push({ id: randomUUID(), version: 1, reason: "월 정산 확정", summary: frozen,
      at: new Date().toISOString(), actorId: "test", actorName: "test", lines: [], sources: [], policy: odaMonth.policy });
    await repository.commit({ changes: [{ type: "oda_month", id: odaMonth.id, storeId: odaStore, expectedVersion: null,
      value: { ...odaMonth, evidenceBytes: { private: "original-file-must-not-be-selected" } } }] });
    const overview = await repository.listOdaOverviewMonths("2026-08", [odaStore]);
    assert.equal(overview.length, 1);
    assert.equal(overview[0]?.frozenSummary?.revenue, 1234567);
    assert.equal("history" in overview[0]!, false);
    assert.equal("evidenceBytes" in overview[0]!, false);
    assert.deepEqual(await repository.listOdaOverviewMonths("2026-07", [odaStore]), []);
    assert.deepEqual(await repository.listOdaOverviewMonths("2026-08", [randomUUID()]), []);
    assert.deepEqual(await repository.listOdaOverviewMonths("2026-08", []), []);

    const profileId = randomUUID();
    const profile = { id: profileId, storeId: odaStore, version: 1, profile: { headerRow: 2, headers: ["날짜", "금액"], sheetName: "", columnMap: {} } };
    await repository.commit({ changes: [{ type: "oda_import_profile", id: profileId, storeId: odaStore, expectedVersion: null, value: profile }] });
    assert.deepEqual(await repository.get("oda_import_profile", profileId), profile);
    assert.deepEqual(await repository.list("oda_import_profile", [randomUUID()]), []);
    await assert.rejects(repository.exclusiveTransaction(`oda:profile-test:${profileId}`, async tx => {
      await tx.commit({ changes: [{ type: "oda_import_profile", id: profileId, storeId: odaStore, expectedVersion: 1, value: { ...profile, version: 2, profile: null } }] });
      throw new Error("rollback monthly import");
    }), /rollback monthly import/);
    assert.deepEqual(await repository.get("oda_import_profile", profileId), profile);

    const rulesId = randomUUID();
    const rules = { id: rulesId, storeId: odaStore, version: 1, rules: [{ id: 'rule-1', description: 'ABC 식자재', category: 'ingredients' }] };
    await repository.commit({ changes: [{ type: 'oda_expense_rules', id: rulesId, storeId: odaStore, expectedVersion: null, value: rules }] });
    assert.deepEqual(await repository.get('oda_expense_rules', rulesId), rules);
    assert.deepEqual(await repository.list('oda_expense_rules', [randomUUID()]), []);
    await assert.rejects(repository.exclusiveTransaction(`oda:rules-test:${rulesId}`, async tx => {
      await tx.commit({ changes: [{ type: 'oda_expense_rules', id: rulesId, storeId: odaStore, expectedVersion: 1, value: { ...rules, version: 2, rules: [] } }] });
      throw new Error('rollback cost classification');
    }), /rollback cost classification/);
    assert.deepEqual(await repository.get('oda_expense_rules', rulesId), rules);

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
