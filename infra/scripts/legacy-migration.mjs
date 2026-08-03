#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  applyMigrationPlan,
  buildMigrationPlan,
  buildSignedExport,
  evaluateRollbackPreconditions,
  verifySignedExport,
} from "./legacy-migration-lib.mjs";

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawKey, inline] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inline !== undefined) flags[key] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags[key] = rest[++index];
    else flags[key] = true;
  }
  return { mode, flags };
}

function required(value, name) {
  if (value === undefined || value === true || value === "") throw new Error(`${name} is required`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function emitJson(value, path) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(resolve(path), text, { encoding: "utf8", flag: "wx" });
  else process.stdout.write(text);
}

function signingKey() {
  return required(process.env.LEGACY_EXPORT_SIGNING_KEY, "LEGACY_EXPORT_SIGNING_KEY (minimum 32 bytes)");
}

async function loadPlan(flags) {
  const manifest = await readJson(required(flags.manifest, "--manifest"));
  const profiles = await readJson(required(flags.profiles, "--profiles"));
  return buildMigrationPlan({
    manifest,
    signingKey: signingKey(),
    profiles,
    actorId: required(flags.actor, "--actor"),
    cohort: flags.cohort ?? "default",
  });
}

async function withPostgres(run) {
  const connectionString = required(process.env.DATABASE_URL, "DATABASE_URL");
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function operationalReport(client, batchId, cohort) {
  const batchResult = await client.query(
    `SELECT id,status,manifest_sha256,source_counts,source_amounts,applied_counts,quarantine_counts,report,started_at,completed_at
     FROM legacy_import_batches WHERE id=$1`,
    [batchId],
  );
  if (!batchResult.rows[0]) throw new Error(`Legacy import batch not found: ${batchId}`);
  const controlResult = await client.query(
    `SELECT cohort,authority,write_freeze_confirmed,active_batch_id,changed_at
     FROM legacy_cutover_controls WHERE cohort=$1`,
    [cohort],
  );
  if (!controlResult.rows[0]) throw new Error(`Cutover control not found for cohort: ${cohort}`);
  const countsResult = await client.query(
    `SELECT entity,outcome,count(*)::integer AS count
     FROM legacy_import_row_mappings WHERE batch_id=$1 GROUP BY entity,outcome ORDER BY entity,outcome`,
    [batchId],
  );
  const amountResult = await client.query(
    `SELECT COALESCE(sum(po.gross_amount),0)::text AS gross,
            COALESCE(sum(po.supply_amount),0)::text AS supply,
            COALESCE(sum(po.vat_amount),0)::text AS vat
     FROM legacy_import_row_mappings m JOIN purchase_orders po ON po.id=m.target_id
     WHERE m.batch_id=$1 AND m.entity='order' AND m.outcome IN ('imported','replayed')`,
    [batchId],
  );
  const batch = batchResult.rows[0];
  const expected = batch.report?.importableCounts ?? batch.applied_counts;
  const actual = Object.fromEntries(["stores", "products", "orders"].map((name) => [name, 0]));
  const names = { store: "stores", product: "products", order: "orders" };
  for (const row of countsResult.rows) {
    if (["imported", "replayed"].includes(row.outcome)) actual[names[row.entity]] += Number(row.count);
  }
  const actualGross = Number(amountResult.rows[0]?.gross ?? 0);
  const expectedGross = Number(batch.report?.amounts?.importableOrderGross ?? 0);
  return {
    batch,
    control: controlResult.rows[0],
    reconciliation: {
      manifestSha256: batch.manifest_sha256,
      sourceTableHashes: batch.report?.tableHashes ?? {},
      reconciliationSha256: batch.report?.reconciliationSha256,
      expectedCounts: expected,
      actualCounts: actual,
      countsMatch: ["stores", "products", "orders"].every((name) => Number(expected[name]) === actual[name]),
      expectedImportableOrderGross: expectedGross,
      actualImportableOrderGross: actualGross,
      amountsMatch: expectedGross === actualGross,
      quarantined: countsResult.rows.filter((row) => row.outcome === "quarantined"),
    },
  };
}

async function rollbackReport(client, batchId, cohort) {
  const operational = await operationalReport(client, batchId, cohort);
  const downstream = await client.query(
    `WITH imported_orders AS (
       SELECT target_id FROM legacy_import_row_mappings
       WHERE batch_id=$1 AND entity='order' AND outcome IN ('imported','replayed')
     ), imported_stores AS (
       SELECT target_id FROM legacy_import_row_mappings
       WHERE batch_id=$1 AND entity='store' AND outcome IN ('imported','replayed')
     )
     SELECT
       (SELECT count(*)::integer FROM shipments WHERE order_id IN (SELECT target_id FROM imported_orders)) AS shipments,
       (SELECT count(*)::integer FROM goods_receipts WHERE order_id IN (SELECT target_id FROM imported_orders)) AS receipts,
       (SELECT count(*)::integer FROM payment_requests WHERE order_id IN (SELECT target_id FROM imported_orders)) AS payments,
       (SELECT count(*)::integer FROM settlements WHERE store_id IN (SELECT target_id FROM imported_stores)) AS settlements,
       (SELECT count(*)::integer FROM tax_invoices WHERE store_id IN (SELECT target_id FROM imported_stores)) AS invoices,
       (SELECT count(*)::integer FROM aggregate_snapshots
        WHERE aggregate_type='order' AND store_id IN (SELECT target_id::text FROM imported_stores)
          AND payload->>'source'='native' AND updated_at > $2) AS native_writes`,
    [batchId, operational.batch.completed_at],
  );
  const row = downstream.rows[0];
  const downstreamCounts = {
    shipments: Number(row.shipments), receipts: Number(row.receipts), payments: Number(row.payments),
    settlements: Number(row.settlements), invoices: Number(row.invoices),
  };
  return {
    ...operational,
    rollback: evaluateRollbackPreconditions({
      batchStatus: operational.batch.status,
      authority: operational.control.authority,
      writeFreezeConfirmed: operational.control.write_freeze_confirmed,
      downstreamCounts,
      nativeWritesAfterBatch: Number(row.native_writes),
    }),
    downstreamCounts,
    nativeWritesAfterBatch: Number(row.native_writes),
  };
}

function usage() {
  return `Usage:
  legacy-migration.mjs export --sqlite FILE --out MANIFEST
  legacy-migration.mjs dry-run --sqlite FILE --profiles FILE --actor UUID --cohort NAME [--manifest-out FILE] [--report-out FILE]
  legacy-migration.mjs report --manifest FILE --profiles FILE --actor UUID --cohort NAME [--out FILE]
  legacy-migration.mjs apply --manifest FILE --profiles FILE --actor UUID --cohort NAME --authority legacy|shadow --confirm-write-freeze [--out FILE]
  legacy-migration.mjs cutover-check --batch UUID --cohort NAME [--out FILE]
  legacy-migration.mjs rollback-check --batch UUID --cohort NAME [--out FILE]

Secrets are read only from LEGACY_EXPORT_SIGNING_KEY and DATABASE_URL.
Output files use exclusive creation and will never overwrite an existing artifact.`;
}

async function main() {
  const { mode, flags } = parseArguments(process.argv.slice(2));
  if (!mode || ["help", "--help", "-h"].includes(mode)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (mode === "export") {
    const manifest = buildSignedExport({
      sqlitePath: resolve(required(flags.sqlite, "--sqlite")),
      signingKey: signingKey(),
      keyId: process.env.LEGACY_EXPORT_KEY_ID ?? "legacy-export",
    });
    await emitJson(manifest, required(flags.out, "--out"));
    process.stdout.write(`${JSON.stringify({ status: "exported", manifest: resolve(flags.out), manifestSha256: manifest.signature.contentHashSha256 })}\n`);
    return;
  }
  if (mode === "dry-run") {
    const manifest = buildSignedExport({
      sqlitePath: resolve(required(flags.sqlite, "--sqlite")), signingKey: signingKey(),
      keyId: process.env.LEGACY_EXPORT_KEY_ID ?? "legacy-export",
    });
    const profiles = await readJson(required(flags.profiles, "--profiles"));
    const plan = buildMigrationPlan({ manifest, signingKey: signingKey(), profiles, actorId: required(flags.actor, "--actor"), cohort: flags.cohort ?? "default" });
    if (flags.manifest_out) await emitJson(manifest, flags.manifest_out);
    await emitJson({ mode: "dry-run", batchId: plan.batchId, report: plan.report, quarantine: plan.quarantine }, flags.report_out);
    return;
  }
  if (mode === "report") {
    const plan = await loadPlan(flags);
    await emitJson({ mode: "report", batchId: plan.batchId, report: plan.report, quarantine: plan.quarantine }, flags.out);
    return;
  }
  if (mode === "apply") {
    if (!flags.confirm_write_freeze) throw new Error("--confirm-write-freeze is required for apply");
    const plan = await loadPlan(flags);
    const result = await withPostgres((client) => applyMigrationPlan(client, plan, {
      authority: required(flags.authority, "--authority"), cohort: flags.cohort ?? "default", writeFreezeConfirmed: true,
    }));
    await emitJson(result, flags.out);
    return;
  }
  if (mode === "cutover-check") {
    const report = await withPostgres((client) => operationalReport(client, required(flags.batch, "--batch"), required(flags.cohort, "--cohort")));
    const ready = report.batch.status === "applied" && ["legacy", "shadow"].includes(report.control.authority)
      && report.control.write_freeze_confirmed && report.reconciliation.countsMatch && report.reconciliation.amountsMatch;
    await emitJson({ ...report, cutover: { ready } }, flags.out);
    if (!ready) process.exitCode = 2;
    return;
  }
  if (mode === "rollback-check") {
    const report = await withPostgres((client) => rollbackReport(client, required(flags.batch, "--batch"), required(flags.cohort, "--cohort")));
    await emitJson(report, flags.out);
    if (!report.rollback.ready) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown mode: ${mode}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`legacy-migration: ${error.message}\n`);
  process.exitCode = 1;
});
