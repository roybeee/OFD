'use strict';

const fs = require('node:fs');
const path = require('node:path');

const databasePath = path.join('/tmp', `ofd_v2_e2e_${process.pid}_${Date.now()}.sqlite`);

process.env.DB_PATH = databasePath;
process.env.PORT = '4100';
process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';
process.env.SECURE_COOKIES = '0';
process.env.POS_AUTOSYNC = '0';
process.env.POS_BACKFILL_RUNNER = '0';
process.env.ALLOW_DEMO_SEED = '0';
process.env.ALLOW_MOCK_POS = '0';

const { server, db } = require('../server/server.js');

server.listen(4100, '127.0.0.1', () => {
  console.log(`[OFD E2E] production-like SQLite server listening on ${databasePath}`);
});

function close() {
  if (close.started) return;
  close.started = true;
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
    process.exit(0);
  });
}
close.started = false;

process.once('SIGTERM', close);
process.once('SIGINT', close);
server.once('error', () => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
  process.exit(1);
});
