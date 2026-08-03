# Legacy SQLite → PostgreSQL deterministic migration

This migration imports only operational master/order data that can be proven complete. It is not a database copy. Legacy identities, passwords, sessions, tokens, POS credentials, configuration secrets, and `stores.code_hash` are never selected.

## Import contract

The exporter reads this fixed logical allowlist:

| Logical entity | Legacy table | Target |
| --- | --- | --- |
| Store | `stores` | `legal_entities`, `stores`, `aggregate_snapshots` |
| Product | `products`, or `skus` as fallback | `products`, `supply_price_versions`, `aggregate_snapshots` |
| Order | `orders` + matching `v2_order_details` | `purchase_orders`, `purchase_order_lines`, `aggregate_snapshots` |

Rows marked `del=1` are excluded. Every exported row has canonical JSON and a SHA-256 hash. The ordered table hashes form a deterministic dataset hash. The manifest content hash is authenticated with HMAC-SHA-256. Re-exporting an unchanged database with the same key and key ID produces byte-equivalent JSON content.

Only orders with a matching detail row, valid delivery date, resolvable store/products, matching item/line quantities, and internally consistent gross/supply/VAT amounts become `source=legacy_unverified`. The V2 application treats that source as read-only. Incomplete, ambiguous, or changed-source-identity rows are placed in `legacy_import_quarantine`; its update/delete trigger makes the evidence immutable.

Legacy users are not mapped. Before import, provision one active PostgreSQL `system` user and pass its UUID as `--actor`. That actor records provenance; no legacy password or session is accepted.

## Store profile file

The legacy store table has no trustworthy legal entity, settlement policy, or payment policy. Supply those values in a reviewed JSON file:

```json
{
  "stores": {
    "legacy-store-id": {
      "code": "STORE-EULJI",
      "businessNumber": "1234567890",
      "legalName": "을지점 주식회사",
      "representativeName": "김점주",
      "address": "서울 중구 ...",
      "businessType": "음식점업",
      "businessCategory": "분식",
      "email": "owner@example.com",
      "billingCycle": "monthly",
      "paymentMethod": "monthly_credit",
      "notificationPhone": "010-1234-5678"
    }
  }
}
```

`businessNumber` must be ten digits. Allowed billing cycles are `monthly` and `per_delivery`; payment methods are `prepaid` and `monthly_credit`. Missing profiles and duplicate store codes/business numbers are quarantined, never guessed.

## Prepare and dry-run

Use a read-only filesystem snapshot of the SQLite file. Keep the signing key outside command history and migration artifacts.

```powershell
$env:LEGACY_EXPORT_SIGNING_KEY = '<at-least-32-byte-secret-from-secret-manager>'
$env:LEGACY_EXPORT_KEY_ID = 'ofd-legacy-2026-08'

npm run legacy:migrate:dry-run -- `
  --sqlite C:\secure\snapshot\ofd.db `
  --profiles C:\secure\reviewed-store-profiles.json `
  --actor aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa `
  --cohort pilot-a `
  --manifest-out C:\secure\artifacts\pilot-a.manifest.json `
  --report-out C:\secure\artifacts\pilot-a.dry-run.json
```

Artifacts use exclusive creation and are not overwritten. Review all of the following before approval:

- `sourceCounts` against SQLite counts;
- `tableHashes`, manifest hash, and `reconciliationSha256`;
- imported and quarantined counts per entity;
- importable and quarantined order gross totals;
- every quarantine reason and sanitized payload;
- store legal/policy profiles with the store owner and finance owner.

`report` verifies the manifest signature again and reconstructs the same plan without database writes:

```powershell
npm run legacy:migrate:report -- `
  --manifest C:\secure\artifacts\pilot-a.manifest.json `
  --profiles C:\secure\reviewed-store-profiles.json `
  --actor aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa `
  --cohort pilot-a
```

## Install controls and apply

Run the canonical database migrator. It discovers all numbered SQL files, verifies the checksums of already-applied versions, and applies pending migrations (including `004_legacy_import_control.sql`) in filename order under one transaction and advisory lock:

```powershell
$env:DATABASE_URL = '<postgres-connection-string>'
npm run migrate -w @ofd/db
```

Start the documented write freeze, verify no legacy writer is active, then apply. `apply` refuses a missing confirmation, a cohort mismatch, or V2 authority. A batch holds a PostgreSQL advisory lock and runs in one `SERIALIZABLE` transaction. Any error rolls back the batch.

```powershell
npm run legacy:migrate:apply -- `
  --manifest C:\secure\artifacts\pilot-a.manifest.json `
  --profiles C:\secure\reviewed-store-profiles.json `
  --actor aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa `
  --cohort pilot-a `
  --authority legacy `
  --confirm-write-freeze `
  --out C:\secure\artifacts\pilot-a.apply.json
```

Replaying the exact manifest with the same reviewed profiles, actor, and cohort returns the already-applied plan without rewriting business rows. A different reviewed profile produces a different plan hash while retaining the signed source manifest hash. Unchanged source rows already imported by an earlier plan are recorded as `replayed`; if the same legacy entity ID has a different canonical source row hash, the changed row is quarantined as `SOURCE_ID_HASH_CONFLICT`.

## Quarantine reason families

- `STORE_*`: missing store identity/profile or ambiguous code/business number;
- `PRODUCT_*`: missing SKU/name, invalid gross price, or ambiguous SKU;
- `ORDER_DETAIL_MISSING`, `ORDER_LINES_INVALID`, `ORDER_LINE_COUNT_MISMATCH`;
- `ORDER_STORE_UNRESOLVED`, `ORDER_PRODUCT_UNRESOLVED:n`;
- `ORDER_QUANTITY_MISMATCH:n`, `ORDER_AMOUNT_MISMATCH:n`, `ORDER_VAT_ALLOCATION_MISMATCH:n`, `ORDER_PRODUCT_SNAPSHOT_MISMATCH:n`;
- `DELIVERY_DATE_INVALID`, `ORDER_DETAIL_ID_MISMATCH`;
- `ORDER_MISSING`: an orphan detail row has no active source order;
- `SOURCE_ID_HASH_CONFLICT`: the source identity was previously seen with different content.

Quarantine resolution is a new reviewed source snapshot and new migration decision. Never update or delete a quarantine row.
