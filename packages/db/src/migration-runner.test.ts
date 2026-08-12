import assert from "node:assert/strict";
import test from "node:test";

import { calculateMigrationChecksum, discoverMigrations, runMigrations, type Migration } from "./migration-runner.ts";

const ORIGINAL_001_CHECKSUM = "e7a32f38905977126bc7b55fe6d8466f8e8e441e65ce0a4e3e207f048bbb3da5";

test("discovers every numbered SQL migration in deterministic order", async () => {
  const migrations = await discoverMigrations(new URL("../migrations/", import.meta.url));
  assert.deepEqual(migrations.map((migration) => migration.version), [
    "001_v2_core",
    "002_phase3_finance_documents",
    "003_outbox_leases",
    "004_legacy_import_control",
    "005_pos_ingestion",
    "006_product_aliases",
    "007_store_openings",
    "008_field_operations",
    "009_pos_discovery",
    "010_remove_mfa",
    "011_pos_alias_backfill",
  ]);
  for (const migration of migrations) {
    assert.match(migration.checksumSha256, /^[0-9a-f]{64}$/);
    assert.equal(migration.checksumSha256, calculateMigrationChecksum(migration.sql));
  }
  assert.equal(migrations[0]?.checksumSha256, ORIGINAL_001_CHECKSUM, "001_v2_core.sql must remain immutable");
});

test("accepts the original 001 ledger checksum and applies every later upgrade", async () => {
  const migrations = await discoverMigrations(new URL("../migrations/", import.meta.url));
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/SELECT version,checksum_sha256 FROM schema_migrations/.test(sql)) {
        return {
          rows: [{ version: "001_v2_core", checksum_sha256: ORIGINAL_001_CHECKSUM }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await runMigrations(client, migrations, () => undefined);

  assert.deepEqual(result.alreadyApplied, ["001_v2_core"]);
  assert.deepEqual(result.applied, migrations.slice(1).map((item) => item.version));
  assert.equal(calls.some((call) => call.sql === migrations[0]?.sql), false);
  assert.equal(calls.some((call) => call.sql === migrations[1]?.sql), true);
  assert.match(migrations[1]?.sql ?? "", /ALTER TABLE settlements ADD COLUMN IF NOT EXISTS kind text/);
  assert.match(migrations[1]?.sql ?? "", /DROP CONSTRAINT IF EXISTS settlements_store_id_period_start_period_end_key/);
  assert.match(migrations[1]?.sql ?? "", /WHERE kind = 'monthly'/);
});

function migration(version: string, sql = `SELECT '${version}'`): Migration {
  return { version, filename: `${version}.sql`, sql, checksumSha256: calculateMigrationChecksum(sql) };
}

test("applies all pending migrations in one advisory-locked transaction", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/SELECT version,checksum_sha256 FROM schema_migrations/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  const logs: string[] = [];
  const migrations = [migration("001_first"), migration("002_second"), migration("003_third")];

  const result = await runMigrations(client, migrations, (message) => logs.push(message));

  assert.deepEqual(result, { applied: ["001_first", "002_second", "003_third"], alreadyApplied: [] });
  assert.equal(calls[0]?.sql, "BEGIN");
  assert.ok(calls.some((call) => /pg_advisory_xact_lock/.test(call.sql)));
  assert.deepEqual(calls.filter((call) => /^SELECT '\d{3}_/.test(call.sql)).map((call) => call.sql), migrations.map((item) => item.sql));
  assert.deepEqual(calls.filter((call) => /INSERT INTO schema_migrations/.test(call.sql)).map((call) => call.params?.[0]), migrations.map((item) => item.version));
  assert.equal(calls.at(-1)?.sql, "COMMIT");
  assert.deepEqual(logs, migrations.map((item) => `Applied migration ${item.version}`));
});

test("verifies all applied checksums before executing pending SQL and fails closed", async () => {
  const first = migration("001_first");
  const pending = migration("002_second", "CREATE TABLE must_not_run(id int)");
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (/SELECT version,checksum_sha256 FROM schema_migrations/.test(sql)) {
        return { rows: [{ version: first.version, checksum_sha256: "0".repeat(64) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  await assert.rejects(() => runMigrations(client, [first, pending]), /001_first checksum mismatch/);
  assert.equal(calls.includes(pending.sql), false);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("exact re-run performs no SQL migration writes", async () => {
  const migrations = [migration("001_first"), migration("002_second")];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/SELECT version,checksum_sha256 FROM schema_migrations/.test(sql)) {
        return {
          rows: migrations.map((item) => ({ version: item.version, checksum_sha256: item.checksumSha256 })),
          rowCount: migrations.length,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await runMigrations(client, migrations, () => undefined);
  assert.deepEqual(result, { applied: [], alreadyApplied: ["001_first", "002_second"] });
  assert.equal(calls.some((call) => migrations.some((item) => call.sql === item.sql)), false);
  assert.equal(calls.some((call) => /INSERT INTO schema_migrations/.test(call.sql)), false);
  assert.equal(calls.at(-1)?.sql, "COMMIT");
});
