import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL이 필요합니다.");
const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  const sql = await readFile(new URL("../migrations/001_v2_core.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ofd_schema_migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum_sha256 text, applied_at timestamptz NOT NULL DEFAULT now())");
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 text");
  const applied = await client.query<{ checksum_sha256: string | null }>("SELECT checksum_sha256 FROM schema_migrations WHERE version='001_v2_core'");
  if (applied.rowCount === 0) {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version,checksum_sha256) VALUES ('001_v2_core',$1)", [checksum]);
    process.stdout.write("Applied migration 001_v2_core\n");
  } else {
    if (applied.rows[0]?.checksum_sha256 !== checksum) throw new Error("Migration 001_v2_core checksum mismatch: applied SQL is immutable");
    process.stdout.write("Migration 001_v2_core already applied\n");
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
