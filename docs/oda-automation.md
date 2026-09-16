# ODA automation integration

ODA supports scoped server credentials, immutable collection previews and explicit approval followed by direct posting to its existing monthly sales/expense records. ORBIT can relay ASIDE collection results or schedule its configured Hermes runner on the existing ODA API. ASIDE itself is not hosted by this change.

## Operator setup

1. Open `/hq/oda-settlement?tab=automation` (store owners: `/store/oda-settlement?tab=automation`). Select the store and month.
2. Under **ORBIT 연결 관리**, select sales, expenses and/or server scheduling, then issue the connection credential. The UI issues 30-day credentials; the API supports 1–90 days.
3. Copy the one-time credential into ORBIT's server-side ODA connection. It must never be used in browser JavaScript, committed to source, or shared through chat.
4. Review collected transactions in **자동화 연결**. **승인 후 반영** approves the exact digest and adds new rows to the real monthly settlement atomically.
5. Revoke a connection in the same screen. Issuer deactivation, auth-version change or scope removal also invalidates it.

Tokens use `oda_int_<UUID>.<32-byte base64url secret>`. Only SHA-256 of the secret is stored. The server never returns hashes in API lists or audit entries. Each token has explicit store IDs, permitted kinds and a routines flag. Session cookies cannot access integration routes; integration tokens cannot approve financial postings.

## Integration HTTP contract

All machine endpoints are under `/api/v2/oda/integration`, require the bearer credential, and reject `Origin` headers. All user endpoints are under `/api/v2/oda/automation` and require ordinary ODA session authentication and store authorization.

- `GET /integration/capabilities`: `{version:1,storeIds,stores:[{id,name}],kinds,routines,batchPreview:true,approvedCommit:true,currency:'KRW',maxLines:200,expiresAt}`.
- `POST /integration/batches/preview`: payload below; returns immutable batch plus current preview. Same batch ID and same normalized payload returns the existing batch. Changed payload or token conflicts.
- `GET /integration/batches?storeId=...&month=YYYY-MM`: recent batches owned by this token.
- `GET /integration/batches/:id`: full batch and current preview.
- `POST /integration/batches/:id/commit`: `{digest}`. Requires an existing unexpired ODA user approval; otherwise 409.
- `GET /automation/batches?storeId=...&month=YYYY-MM`, `GET /automation/batches/:id`: review UI.
- `POST /automation/batches/:id/approve`: `{digest,commit:true}` approves and immediately posts. `commit:false` leaves the exact batch ready for machine commit for 30 minutes.
- `POST /automation/batches/:id/reject`: rejects an uncommitted batch.
- `GET /automation/tokens?storeId=...`, `POST /automation/tokens`, `POST /automation/tokens/:id/revoke`: owner/master connection management.

Preview payload:

```json
{
  "batchId": "00000000-0000-4000-8000-000000000001",
  "storeId": "authorized-store-id",
  "month": "2026-08",
  "source": {
    "system": "ASIDE",
    "accountRef": "source-account-reference",
    "url": "https://example.com/reports",
    "capturedAt": "2026-09-16T00:00:00.000Z"
  },
  "lines": [{
    "externalRef": "source-stable-transaction-id",
    "date": "2026-08-31",
    "kind": "revenue",
    "channel": "baemin",
    "category": "sales",
    "description": "Example sale",
    "amountKrw": 11000,
    "vatKrw": 1000
  }]
}
```

All objects reject unknown fields. Dates must exist and fall in the month. KRW amounts are integers with absolute value at most 1 trillion; negative revenue means refund and negative expense means credit. VAT is explicit, zero, or null for unknown; it must have the same sign and fit within gross amount. Channels: `pos`, `baemin`, `coupang`, `yogiyo`, `ddangyo`, `manual`. Revenue requires `sales` category and a non-manual channel. Expense categories: `ingredients`, `labor`, `rent`, `utilities`, `fees`, `marketing`, `supplies`, `other`. HTTPS provenance URLs cannot contain credentials, queries or fragments. Maximum 200 rows per batch.

## Posting invariants

- Collection and approval do not overwrite existing money, clear confirmations or reopen accounting periods.
- Duplicate key is store + channel + kind + original external reference, independent of batch, month and refreshed credential. Identical replays are skipped; changed date, amount, VAT, category or description conflicts. Existing CSV-imported rows with the same identity are also checked.
- Never invent a different external reference merely to bypass a conflict. Corrections should use the existing month review workflow with an actual source record.
- A store-month distributed lock, aggregate CAS and per-reference claims ensure an atomic transaction. Token revocation participates in the commit fence. Partial month updates are rolled back on conflict.
- Finalized/paid months reject imports at preview and again at commit. Active store, current issuer and approver rights are checked again.
- An immutable provenance JSON file is attached as a downloadable source. It records the source address, capture time, exact submitted lines, batch ID and digest. It is a collection record, not a tax invoice or independent proof of source authenticity.
- Imported lines remain `reviewed:false`; missing VAT or original evidence must be resolved in the normal settlement workflow. Automatic posting is not automatic settlement approval or payment.

## Verification

`npm run test -w @ofd/api -- oda-automation` exercises scope, credential handling, session isolation, exact approval, real posting, duplicate/concurrent replay, changed identity, revocation, locked months and malformed money/date validation. `npm run test -w @ofd/web -- OdaAutomation OdaSettlementPage` covers preview-before-approval, digest binding, conflict blocking, error visibility and existing settlement workflows. The repository's full `npm run test:ci` and `npm run build:oda` gates still apply before release.
