import pg from "pg";
import { discoverMigrations, runMigrations } from "./migration-runner.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await runMigrations(client, await discoverMigrations());
} finally {
  client.release();
  await pool.end();
}
