# ODA server routines

The existing ODA API process owns a bounded 15-second scheduler. It starts only
with PostgreSQL and an existing encryption key of at least 32 characters. No
additional paid worker or PC relay is provisioned. Enabled user-created routines
survive API restarts in `oda_routines`; invocation and admission state live in
`oda_routine_runs`. Apply migration `013_oda_routines` before starting this API.

## Authorization and runner

Every machine route uses the scoped `oda_int_` bearer credential and rejects
browser Origin headers. Current issuer role, auth version, expiry, revocation,
routine permission and store scope are checked again before each scheduled run.
Temporary database/auth-store failures retry; definitive revocation pauses the
routine. Runner credentials are encrypted with the existing ENCRYPTION_KEY and
never appear in model input, public DTOs or the source repository.

The HTTPS Hermes endpoint must provide authenticated native `/v1/runs`, status,
stop and durable idempotency capabilities. DNS is validated and pinned per
connection; private/metadata addresses and redirects are rejected. A desktop
ASIDE session or ASIDE paid-plan login is **not** copied to Hermes. Only tools,
logins and data actually available on that server can run while a PC is off.
Unavailable sources are reported as blockers rather than invented results.

The runner's native approval events can be surfaced and answered with exactly
`once` or `deny` for the current request ID. This is native approval passthrough,
not a new enforceable tool policy for upstream tools that do not emit approval
events. The scheduled work-order instructions require drafts and owner approval
before external actions and do not change upstream permissions. Do not market
this as guaranteed interception of every external action or automatic payment.

## Scheduling and recovery

- `weekdays`: Sunday=0 through Saturday=6; `time`: local HH:mm; `timeZone`: IANA.
- Each routine has at most one unresolved invocation. PostgreSQL locks and a
  partial unique index enforce this across multiple API instances.
- Missed occurrences coalesce into at most one catch-up run; there is no backlog
  burst. Repeated DST wall time runs once per local date; missing time is skipped.
- Invocation ID and immutable request are durable before native submission.
  Response loss retries the same key/body only within the native retention
  window. Unknown admission pauses the routine and blocks replacement jobs.
- Native approval waits do not time out into fake success or auto-approval.
- An owner may resolve only an `unknown` run, confirming the execution actually
  stopped and entering a note. If a native run ID is known, its status must also
  verify terminal. An append-only resolution row records the actor and note.
  Resolution unlocks future work; it does not roll back previous external work.
- The existing API and Hermes host must stay running. API downtime is recovered
  by the coalescing policy, not represented as execution during downtime.

## Financial result staging

`mode: "oda_batch"` requests exact structured source/transaction data. The
adapter owns batchId and storeId; model output cannot choose either. It validates
real dates, KRW integer amounts, references, category/channel, month and token
scope through `previewOdaBatch`. A valid result creates an awaiting-approval ODA
batch and links `batchId` to the run. Invalid/missing evidence becomes
`needs_review` with original output preserved. The scheduler never approves or
commits books; ODA's exact-batch review and posting flow remains authoritative.

## Machine endpoints

All paths below are under `/api/v2/oda/integration`:

- GET `/routines`: routine summaries, newest 20 run summaries, runner availability.
- GET `/routines/:id`: full routine prompt; GET `/runs/:id`: full result.
- POST `/routines`: `{id,title,prompt,storeId,timeZone,time,weekdays,enabled,mode,
  runner:{endpoint,token},expectedVersion?}`. Updates require expectedVersion;
  an exact repeated create after a lost response returns the original record.
- POST `/routines/:id/pause` or `/resume`: `{expectedVersion}`.
- POST `/routines/:id/run`: `{id}` with a caller-generated UUID reused on retries.
- GET `/runs`: newest 20 run summaries. Summaries truncate output to 1,000 chars
  with `outputTruncated`; routine summaries similarly expose `promptTruncated`.
- POST `/runs/:id/stop`: `{}`; external effects are not rolled back.
- POST `/runs/:id/approval`: `{requestId,choice:"once"|"deny"}`.
- POST `/runs/:id/resolve`: `{confirmedStopped:true,note}` (10–2,000 chars).

## Verification

`npm exec -w @ofd/api -- vitest run src/oda-routines.test.ts` covers timezones,
DST, SSRF checks, durable admission identity, expiry, permission revocation and
transient retry, exact approval response, uncertainty, financial staging and DTO
redaction. `node --import tsx infra/scripts/oda-routines-durable-smoke.mjs` uses a
temporary disk-backed PGlite engine with real SQL to verify restart recovery,
claims, missed schedules, no-overlap, version checks and resolution immutability.
It does not read DATABASE_URL or contact a real runner/account. Install the
isolated `infra/testing/pglite` dependencies for that gate.
