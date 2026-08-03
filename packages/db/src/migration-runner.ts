import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

export interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksumSha256: string;
}

export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_FILENAME = /^(\d{3}_[a-z0-9][a-z0-9_]*)\.sql$/;

export function calculateMigrationChecksum(sql: string): string {
  // Git checks SQL out with CRLF on some developer machines and LF in Linux production.
  // Line endings are not a schema change, so keep the ledger stable across platforms.
  return createHash("sha256").update(sql.replace(/\r\n?/g, "\n")).digest("hex");
}

export async function discoverMigrations(directory = new URL("../migrations/", import.meta.url)): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
  if (sqlFiles.length === 0) throw new Error("No SQL migrations were discovered");

  const prefixes = new Set<string>();
  const migrations: Migration[] = [];
  for (const filename of sqlFiles) {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    const prefix = match[1]!;
    if (prefixes.has(prefix)) throw new Error(`Duplicate migration sequence: ${prefix}`);
    prefixes.add(prefix);
    const sql = await readFile(new URL(filename, directory), "utf8");
    migrations.push({
      version: filename.slice(0, -4),
      filename,
      sql,
      checksumSha256: calculateMigrationChecksum(sql),
    });
  }
  return migrations;
}

export async function runMigrations(
  client: MigrationClient,
  migrations: Migration[],
  log: (message: string) => void = (message) => process.stdout.write(`${message}\n`),
): Promise<MigrationResult> {
  if (migrations.length === 0) throw new Error("At least one migration is required");
  const ordered = [...migrations].sort((left, right) => left.filename.localeCompare(right.filename));
  if (ordered.some((migration, index) => migration !== migrations[index])) {
    throw new Error("Migrations must be supplied in deterministic filename order");
  }

  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ofd_schema_migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum_sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 text");
    const appliedResult = await client.query("SELECT version,checksum_sha256 FROM schema_migrations ORDER BY version FOR UPDATE");
    const applied = new Map(appliedResult.rows.map((row) => [String(row.version), row.checksum_sha256 === null ? null : String(row.checksum_sha256)]));
    const local = new Map(ordered.map((migration) => [migration.version, migration]));

    for (const [version, checksum] of applied) {
      const migration = local.get(version);
      if (!migration) throw new Error(`Applied migration ${version} is missing from this release`);
      if (checksum !== migration.checksumSha256) throw new Error(`Migration ${version} checksum mismatch: applied SQL is immutable`);
    }
    await client.query("ALTER TABLE schema_migrations ALTER COLUMN checksum_sha256 SET NOT NULL");

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const migration of ordered) {
      if (applied.has(migration.version)) {
        result.alreadyApplied.push(migration.version);
        log(`Migration ${migration.version} already applied`);
        continue;
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations(version,checksum_sha256) VALUES ($1,$2)", [migration.version, migration.checksumSha256]);
      result.applied.push(migration.version);
      log(`Applied migration ${migration.version}`);
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration failure; the connection is discarded by the caller.
      }
    }
    throw error;
  }
}
