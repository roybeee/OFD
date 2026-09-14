# ODA durable database integration

This is an isolated **test dependency**, excluded from the production application
dependency graph. The API still uses its unmodified `PostgresRepository` and the
`pg` TCP driver. No in-memory repository is used for the assertions.

## Run without a PostgreSQL installation

From the repository root:

```sh
npm ci
npm run build:packages
npm ci --prefix infra/testing/pglite --ignore-scripts
node --import tsx infra/scripts/oda-durable-smoke.mjs
```

The harness creates a temporary filesystem database and starts a separate PGlite
process on a dynamically selected loopback port. It applies all 11 original SQL
migrations, including `pgcrypto`, `citext`, and `btree_gist`, without replacing or
removing SQL. Database files and processes are cleaned up afterward.

It exercises real ODA API routes through Fastify's injection interface:

- A and B confirm the settlement policy; sales and expense CSVs are imported.
- The application and its pg pool close, the database process stops cleanly,
  and a new database process opens the same files. The API response, original
  evidence bytes, SHA-256 hashes, approvals, and calculated amounts must match.
- Stale writes and an auditor's write attempt are rejected.
- Finalization survives a second database restart, including its snapshot and
  evidence; the finalized month rejects another import.
- Reopening preserves the first snapshot; refinalization and the exact payment
  survive a third database restart. The paid month rejects reopening.
- Audit events remain identical and persisted hash-chain links remain intact.

The example uses ₩33,000,000 gross sales and ₩11,000,000 gross expenses, with
explicit actual VAT and a mutually agreed VAT policy. It expects ₩20,000,000
profit and a ₩9,350,000 payment to B. These are test fixtures, not store records.

## Native PostgreSQL CI

Use an **empty disposable database**, before tests that seed other aggregates:

```sh
APP_MODE=test DATABASE_URL=postgresql://user:password@localhost/oda_test \
  node --import tsx infra/scripts/oda-durable-smoke.mjs --postgres
```

This mode needs no PGlite dependencies. It runs the same application checks and
closes/recreates the API and pg pools three times. It does **not** restart the
externally managed PostgreSQL service. The script refuses a database containing
application aggregates and never deletes native database records. Use the
existing `packages/db/src/postgres.integration.test.ts` afterward for native
transaction/advisory-lock, outbox-lease, readiness, and migration-drift checks.

## Scope and limitations

PGlite is a PostgreSQL build compiled to WebAssembly. Its socket implementation
uses a single underlying connection; this harness sets the pool size to one.
Passing this test demonstrates SQL execution and persistence after **clean
shutdown and restart**. It does not establish native PostgreSQL multi-session
locking, production throughput, TLS, crash recovery, backups, or failover.
The existing native PostgreSQL integration and deployment gates remain required.

References: [PGlite socket documentation](https://pglite.dev/docs/pglite-socket)
and [extension catalog](https://pglite.dev/extensions/).
