# Operational state and readiness

## Canonical operational state

`aggregate_snapshots` is the synchronous canonical operational read model used by the API. Every command writes the
aggregate snapshot, business-key claims, audit entries, and outbox records in the same PostgreSQL transaction. There is
no asynchronous projector between an accepted command and an API read, so operational projection lag is zero by
construction.

The normalized business tables are offline export and reporting surfaces until a separately specified and monitored
projector is implemented. API handlers must not read those tables as though they were current operational state. This
decision supersedes the historical projection comments embedded in the immutable `001_v2_core.sql` migration; applied
migration SQL must not be edited because its checksum is part of the deployment ledger.

## Readiness contract

`GET /api/v2/ready` is unauthenticated and returns no credentials or connection details. It returns HTTP 200 only when:

- a PostgreSQL query succeeds;
- every numbered SQL migration on disk is applied with the exact ledger checksum;
- at least one persisted worker heartbeat is in `running` state and its lease has not expired; and
- the production S3 bucket is reachable and reports versioning status `Enabled`.

Any failed component produces HTTP 503 with a structured, non-secret status. Memory/demo mode has no external
dependencies and reports migrations, worker heartbeat, and external storage as not required. Production and PostgreSQL
CI tests must set `REPOSITORY_MODE=postgres`; production rejects `REPOSITORY_MODE=memory`.
