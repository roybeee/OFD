import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  applyMigrationPlan,
  buildMigrationPlan,
  buildSignedExport,
  evaluateRollbackPreconditions,
  verifySignedExport,
} from "./legacy-migration-lib.mjs";

const SIGNING_KEY = "phase-five-test-signing-key-is-at-least-32-bytes";
const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function legacyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ofd-legacy-migration-"));
  const sqlitePath = join(directory, "legacy.db");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE stores (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, region TEXT,
      addr TEXT, phone TEXT, open_date TEXT, code_hash TEXT, mt INTEGER, del INTEGER DEFAULT 0
    );
    CREATE TABLE skus (
      id TEXT PRIMARY KEY, name TEXT, price INTEGER, supply INTEGER,
      mt INTEGER, del INTEGER DEFAULT 0
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, store_id TEXT, date TEXT, status TEXT, memo TEXT,
      items TEXT, mt INTEGER, del INTEGER DEFAULT 0, deliver_date TEXT
    );
    CREATE TABLE v2_order_details (
      order_id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      lines_snapshot TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      submitted_at INTEGER, approved_by TEXT, approved_at INTEGER, change_reason TEXT,
      change_requested_by TEXT, change_requested_at INTEGER, cancelled_by TEXT,
      cancelled_at INTEGER, cancellation_reason TEXT, version INTEGER DEFAULT 1
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, pw_hash TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token TEXT);
  `);

  db.prepare("INSERT INTO stores VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("s-1", "을지점", "franchise", "seoul", "서울 중구", "010-1234-5678", "2024-01-01", "do-not-export", 1, 0);
  db.prepare("INSERT INTO skus VALUES (?,?,?,?,?,?)").run("sku-1", "OFD 소스", 1100, 1000, 1, 0);
  db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)")
    .run("o-complete", "s-1", "2026-07-01", "승인", "완전 주문", JSON.stringify([{ skuId: "sku-1", qty: 2 }]), 1, 0, "2026-07-03");
  db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)")
    .run("o-incomplete", "s-1", "2026-07-02", "대기", "상세 없음", JSON.stringify([{ skuId: "sku-1", qty: 1 }]), 1, 0, "2026-07-04");
  db.prepare("INSERT INTO v2_order_details VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "o-complete",
    "LEG-20260701-001",
    "native",
    JSON.stringify([{
      id: "line-1",
      snapshot: { productId: "sku-1", sku: "sku-1", name: "OFD 소스", unit: "박스", unitGross: 1100, taxable: true, taxRate: 10 },
      quantity: 2,
      gross: 2200,
      supply: 2000,
      vat: 200,
    }]),
    "legacy-user",
    Date.parse("2026-07-01T00:00:00Z"),
    Date.parse("2026-07-01T00:01:00Z"),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    1,
  );
  db.prepare("INSERT INTO users VALUES (?,?,?)").run("legacy-user", "owner@example.com", "SECRET_PASSWORD_HASH");
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("session-1", "legacy-user", "SECRET_SESSION_TOKEN");
  db.close();
  return { directory, sqlitePath };
}

const profiles = {
  stores: {
    "s-1": {
      code: "STORE-EULJI",
      businessNumber: "1234567890",
      legalName: "을지점 주식회사",
      representativeName: "김점주",
      address: "서울 중구",
      businessType: "음식점업",
      businessCategory: "분식",
      email: "eulji@example.com",
      billingCycle: "monthly",
      paymentMethod: "monthly_credit",
      notificationPhone: "010-1234-5678",
    },
  },
};

test("SQLite export is deterministic, signed, allowlisted, and excludes credentials", async (t) => {
  const fixture = await legacyFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const first = buildSignedExport({ sqlitePath: fixture.sqlitePath, signingKey: SIGNING_KEY, keyId: "test-key" });
  const second = buildSignedExport({ sqlitePath: fixture.sqlitePath, signingKey: SIGNING_KEY, keyId: "test-key" });

  assert.deepEqual(first, second);
  assert.equal(verifySignedExport(first, SIGNING_KEY), true);
  assert.deepEqual(Object.keys(first.rows), ["stores", "products", "orders", "orderDetails"]);
  assert.equal(first.rows.stores[0].row.code_hash, undefined);
  assert.doesNotMatch(JSON.stringify(first), /SECRET_PASSWORD_HASH|SECRET_SESSION_TOKEN|pw_hash|sessions/i);

  const tampered = structuredClone(first);
  tampered.rows.products[0].row.price = 999999;
  assert.throws(() => verifySignedExport(tampered, SIGNING_KEY), /signature|hash/i);
});

test("planning imports only complete legacy_unverified orders and quarantines incomplete rows", async (t) => {
  const fixture = await legacyFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const manifest = buildSignedExport({ sqlitePath: fixture.sqlitePath, signingKey: SIGNING_KEY, keyId: "test-key" });

  const plan = buildMigrationPlan({ manifest, signingKey: SIGNING_KEY, profiles, actorId: ACTOR_ID, cohort: "pilot-a" });

  assert.equal(plan.imports.stores.length, 1);
  assert.equal(plan.imports.products.length, 1);
  assert.equal(plan.imports.orders.length, 1);
  assert.equal(plan.imports.orders[0].aggregate.source, "legacy_unverified");
  assert.equal(plan.imports.orders[0].aggregate.gross, 2200);
  assert.equal(plan.imports.orders[0].aggregate.createdBy, ACTOR_ID);
  assert.deepEqual(plan.report.sourceCounts, { stores: 1, products: 1, orders: 2, orderDetails: 1 });
  assert.deepEqual(plan.report.importableCounts, { stores: 1, products: 1, orders: 1 });
  assert.equal(plan.report.amounts.importableOrderGross, 2200);
  assert.equal(plan.report.amounts.quarantinedOrderGross, 1100);
  assert.ok(plan.quarantine.some((row) => row.sourceId === "o-incomplete" && row.reasons.includes("ORDER_DETAIL_MISSING")));
});

test("apply uses one serializable transaction, records controls, and exact replay is idempotent", async (t) => {
  const fixture = await legacyFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const manifest = buildSignedExport({ sqlitePath: fixture.sqlitePath, signingKey: SIGNING_KEY, keyId: "test-key" });
  const plan = buildMigrationPlan({ manifest, signingKey: SIGNING_KEY, profiles, actorId: ACTOR_ID, cohort: "pilot-a" });
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/FROM legacy_import_batches.+plan_sha256/s.test(String(sql))) return { rows: [], rowCount: 0 };
      if (/FROM users WHERE id/.test(String(sql))) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await applyMigrationPlan(client, plan, {
    authority: "legacy",
    cohort: "pilot-a",
    writeFreezeConfirmed: true,
  });
  assert.equal(result.status, "applied");
  assert.equal(calls.filter((call) => /^BEGIN ISOLATION LEVEL SERIALIZABLE$/.test(call.sql)).length, 1);
  assert.equal(calls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.equal(calls.filter((call) => call.sql === "ROLLBACK").length, 0);
  assert.ok(calls.some((call) => /INSERT INTO legacy_cutover_controls/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO aggregate_snapshots/.test(call.sql)));
  assert.doesNotMatch(calls.map((call) => call.sql).join("\n"), /INSERT INTO (users|sessions)|password_hash|pw_hash/i);

  const replayCalls = [];
  const replayClient = {
    async query(sql, params = []) {
      replayCalls.push({ sql: String(sql), params });
      if (/FROM legacy_import_batches.+plan_sha256/s.test(String(sql))) {
        return { rows: [{ id: plan.batchId, status: "applied", report: plan.report }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const replay = await applyMigrationPlan(replayClient, plan, {
    authority: "legacy",
    cohort: "pilot-a",
    writeFreezeConfirmed: true,
  });
  assert.equal(replay.status, "replayed");
  assert.equal(replayCalls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.equal(replayCalls.some((call) => /INSERT INTO (stores|products|purchase_orders)/.test(call.sql)), false);
});

test("apply rolls back a failed batch and refuses unsafe authority controls", async (t) => {
  const fixture = await legacyFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const manifest = buildSignedExport({ sqlitePath: fixture.sqlitePath, signingKey: SIGNING_KEY, keyId: "test-key" });
  const plan = buildMigrationPlan({ manifest, signingKey: SIGNING_KEY, profiles, actorId: ACTOR_ID, cohort: "pilot-a" });

  await assert.rejects(() => applyMigrationPlan({ query: async () => ({ rows: [], rowCount: 1 }) }, plan, {
    authority: "v2",
    cohort: "pilot-a",
    writeFreezeConfirmed: true,
  }), /authority/i);

  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (/FROM legacy_import_batches.+plan_sha256/s.test(String(sql))) return { rows: [], rowCount: 0 };
      if (/FROM users WHERE id/.test(String(sql))) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      if (/INSERT INTO products/.test(String(sql))) throw new Error("database failure");
      return { rows: [], rowCount: 1 };
    },
  };
  await assert.rejects(() => applyMigrationPlan(client, plan, {
    authority: "legacy",
    cohort: "pilot-a",
    writeFreezeConfirmed: true,
  }), /database failure/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("rollback is allowed only before v2 authority and downstream effects", () => {
  assert.deepEqual(evaluateRollbackPreconditions({
    batchStatus: "applied",
    authority: "legacy",
    writeFreezeConfirmed: true,
    downstreamCounts: { shipments: 0, receipts: 0, settlements: 0, invoices: 0, payments: 0 },
    nativeWritesAfterBatch: 0,
  }), { ready: true, blockers: [] });

  const unsafe = evaluateRollbackPreconditions({
    batchStatus: "applied",
    authority: "v2",
    writeFreezeConfirmed: false,
    downstreamCounts: { shipments: 1, receipts: 0, settlements: 0, invoices: 0, payments: 0 },
    nativeWritesAfterBatch: 2,
  });
  assert.equal(unsafe.ready, false);
  assert.deepEqual(unsafe.blockers, ["AUTHORITY_ALREADY_V2", "WRITE_FREEZE_NOT_CONFIRMED", "DOWNSTREAM_EFFECTS_EXIST", "NATIVE_WRITES_EXIST"]);
});

test("control migration defines immutable quarantine, replay mapping, and cutover controls", async () => {
  const sql = await readFile(new URL("../../packages/db/migrations/004_legacy_import_control.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE legacy_import_batches/i);
  assert.match(sql, /CREATE TABLE legacy_import_row_mappings/i);
  assert.match(sql, /CREATE TABLE legacy_import_quarantine/i);
  assert.match(sql, /CREATE TABLE legacy_cutover_controls/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON legacy_import_quarantine/i);
  assert.match(sql, /plan_sha256 varchar\(64\) NOT NULL UNIQUE/i);
  assert.match(sql, /UNIQUE\s*\(batch_id, source_system, entity, source_id, source_row_sha256\)/i);
});
