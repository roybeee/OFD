# Legacy → V2 authority cutover runbook

The authority change is a controlled operational event, not a side effect of importing data. Use one cohort at a time. The allowed progression is `legacy` → `shadow` → `v2`.

## Roles and evidence

Assign an incident commander, legacy operator, V2 operator, finance reconciler, and rollback approver. Store the signed manifest, dry-run report, apply report, database backup identifier, deployment version, approval record, and timestamps in the change ticket. Do not store the signing key or database URL in the ticket.

## T-24 hours

1. Confirm the core and `004_legacy_import_control` migrations in `schema_migrations`.
2. Provision and record the active PostgreSQL system actor UUID.
3. Produce a database-consistent SQLite snapshot and signed dry-run manifest.
4. Reconcile source counts, order gross amounts, table hashes, and every quarantine row.
5. Back up PostgreSQL and perform a restore rehearsal.
6. Verify health checks, queues, object storage, bank integration, and tax invoice provider credentials.
7. Announce the write-freeze window and rollback deadline.

## Freeze and import

1. Stop or fence every legacy write path: web/API writes, cron, workers, manual SQLite access, and POS ingestion.
2. Record the last accepted legacy write and take the final SQLite snapshot.
3. Re-export it. If its manifest hash differs from the approved snapshot, repeat review; do not apply an unreviewed hash.
4. Apply with `--authority legacy --confirm-write-freeze`.
5. Run the database-backed reconciliation:

```powershell
npm run legacy:migrate:cutover-check -- `
  --batch 00000000-0000-0000-0000-000000000000 `
  --cohort pilot-a `
  --out C:\secure\artifacts\pilot-a.cutover-check.json
```

Exit code `0` means the batch is applied, authority is still `legacy` or `shadow`, the write freeze is recorded, and applied row counts/order gross match the signed plan. Exit code `2` means stop and investigate. The report also carries the manifest SHA-256, source table hashes, and reconciliation hash.

## Shadow verification

Change the cohort control to `shadow` through the approved operations change, append the same decision to `legacy_cutover_control_events`, and keep all V2 business writes disabled. Compare read models and manually verify:

- store/product identity and pricing;
- order number, requested date, line quantities, gross/supply/VAT;
- no shipment, receipt, payment request, settlement, or invoice was created for a `legacy_unverified` order;
- store owners and drivers see only their authorized stores/routes;
- audit and outbox processing remain healthy.

Any mismatch returns authority to `legacy` while the freeze remains active. Correct the source/profile decision and create a newly reviewed batch; never edit imported evidence.

## Promote to V2

Promotion requires two-person approval after the cutover check and shadow checklist pass. In one transaction:

1. lock the cohort control row;
2. verify it still points at the approved batch and remains frozen;
3. set authority to `v2` with approver/reason/time;
4. append an immutable `legacy_cutover_control_events` row;
5. enable V2 writers for only that cohort;
6. leave legacy writers fenced permanently.

Unfreeze V2 traffic gradually. Validate a native test order through approval, shipment, delivery proof, receipt, payment matching, settlement, and tax invoice generation. A `legacy_unverified` order remains historical/read-only and must not enter financial automation.

## Rollback boundary

Before changing anything, run:

```powershell
npm run legacy:migrate:rollback-check -- `
  --batch 00000000-0000-0000-0000-000000000000 `
  --cohort pilot-a `
  --out C:\secure\artifacts\pilot-a.rollback-check.json
```

Logical rollback is allowed only when all conditions are true:

- batch status is `applied`;
- authority has not become `v2`;
- the write freeze is still confirmed;
- imported orders/stores have no shipments, receipts, payments, settlements, or invoices;
- there are no native V2 order writes for the cohort after import.

Exit code `2` means logical deletion is forbidden. Once authority is V2 or any downstream/native write exists, use forward recovery or restore the rehearsed full database backup in an incident window. Never delete individual imported aggregates, row mappings, or quarantine evidence.

If rollback is still eligible, keep both writer sets fenced, take a fresh backup, obtain the rollback approver's sign-off, remove the batch-created projections/snapshots in a separately reviewed transaction ordered by foreign keys, mark the batch `rolled_back`, and append a control event. Re-run count/hash checks before reopening legacy authority.

## Completion

Close the change only after:

- V2 native lifecycle smoke test passes;
- queues and integrations are current;
- finance signs counts and amounts;
- access/audit sampling passes;
- backup and artifacts are retained under policy;
- the legacy SQLite file is archived read-only and its writers cannot restart.
