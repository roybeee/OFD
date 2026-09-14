import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

if (process.env.APP_MODE !== 'test' || !process.send || !process.env.ODA_TEST_DATA_DIR) {
  throw new Error('This engine is only started by the isolated ODA durability test harness.');
}

const db = await PGlite.create({
  dataDir: process.env.ODA_TEST_DATA_DIR,
  extensions: { btree_gist, citext, pgcrypto },
});
// Allow the closing pg socket and the next pool's startup handshake to overlap.
// The scenario still uses a one-connection pool and runs all queries serially.
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: Number(process.env.ODA_TEST_DB_PORT), maxConnections: 2 });
await server.start();
process.send({ ready: true, version: (await db.query('SELECT version()')).rows[0].version });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await db.close();
  process.exit(0);
}
process.on('message', (message) => { if (message === 'stop') void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
