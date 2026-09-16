// Synthetic, isolated PostgreSQL migration/persistence verification. Never uses DATABASE_URL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../testing/pglite/package.json', import.meta.url));
const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);
const dir = await mkdtemp(join(tmpdir(), 'oda-esign-persistence-'));
let db;
try {
  db = new PGlite(dir);
  await db.exec(`CREATE TABLE aggregate_snapshots (
    aggregate_type text NOT NULL, aggregate_id text NOT NULL, store_id text,
    version integer NOT NULL CHECK (version >= 0), payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (aggregate_type,aggregate_id));`);
  await db.exec(await readFile(new URL('../../packages/db/migrations/012_oda_native_contracts.sql', import.meta.url), 'utf8'));
  const insert = (type, id, store, value) => db.query('INSERT INTO aggregate_snapshots VALUES ($1,$2,$3,1,$4::jsonb,now())', [type,id,store,JSON.stringify(value)]);
  await insert('oda_employer','employer-a','store-a',{businessNumber:'1234567891'});
  await insert('oda_employer','employer-b','store-a',{businessNumber:'1234567884'});
  await insert('oda_employer','employer-a-other-store','store-b',{businessNumber:'1234567891'});
  await assert.rejects(() => insert('oda_employer','duplicate','store-a',{businessNumber:'1234567891'}), error => error.code === '23505');
  const pending = { id:'contract-a',status:'pending',version:1,documentText:'검증용 원문',documentHash:'fixed-hash',employeeActorId:'employee-a',signatures:[],audit:[],deliveries:[] };
  await insert('oda_contract','contract-a','store-a',pending);
  await assert.rejects(() => db.query("UPDATE aggregate_snapshots SET payload=jsonb_set(payload,'{documentText}', '\"변조\"') WHERE aggregate_id='contract-a'"), error => error.code === '23514');
  await assert.rejects(() => db.query("UPDATE aggregate_snapshots SET store_id='store-b' WHERE aggregate_id='contract-a'"), error => error.code === '23514');
  await db.query("UPDATE aggregate_snapshots SET version=2,payload=payload || $1::jsonb WHERE aggregate_id='contract-a'", [JSON.stringify({status:'completed',version:2,completedAt:'2026-09-16T01:00:00Z',signatures:[{role:'employee'},{role:'employer'}],artifacts:{contract:{id:'contract-a:contract',sha256:'synthetic'},evidence:{id:'contract-a:evidence',sha256:'synthetic'}}})]);
  for (const change of [{artifacts:{}},{signatures:[]},{signatures:[{role:'employee',name:'tampered'},{role:'employer'}]},{status:'pending'},{completedAt:'2027-01-01'}]) {
    await assert.rejects(() => db.query("UPDATE aggregate_snapshots SET payload=payload || $1::jsonb WHERE aggregate_id='contract-a'", [JSON.stringify(change)]), error => error.code === '23514');
  }
  const artifact = { id:'contract-a:contract',version:1,base64:Buffer.from('Synthetic immutable Korean contract 원본').toString('base64') };
  await insert('oda_contract_artifact',artifact.id,'store-a',artifact);
  await assert.rejects(() => db.query("UPDATE aggregate_snapshots SET payload='{}' WHERE aggregate_id='contract-a:contract'"), error => error.code === '23514');
  await assert.rejects(() => db.query("DELETE FROM aggregate_snapshots WHERE aggregate_id='contract-a:contract'"), error => error.code === '23514');
  await assert.rejects(() => db.query("DELETE FROM aggregate_snapshots WHERE aggregate_id='contract-a'"), error => error.code === '23514');
  await db.query("UPDATE aggregate_snapshots SET version=3,payload=payload || $1::jsonb WHERE aggregate_id='contract-a'", [JSON.stringify({version:3,deliveries:[{method:'manual_handover',evidenceNote:'합성 테스트'}]})]);
  await assert.rejects(() => db.query("UPDATE aggregate_snapshots SET payload=payload || $1::jsonb WHERE aggregate_id='contract-a'", [JSON.stringify({deliveries:[]})]), error => error.code === '23514');
  await db.close();
  db = new PGlite(dir);
  const files = await db.query("SELECT payload FROM aggregate_snapshots WHERE aggregate_type='oda_contract_artifact' AND store_id='store-a'");
  assert.deepEqual(files.rows[0].payload,artifact);
  assert.equal((await db.query("SELECT payload FROM aggregate_snapshots WHERE aggregate_type='oda_contract_artifact' AND store_id='store-b'")).rows.length,0);
  const stored = (await db.query("SELECT payload FROM aggregate_snapshots WHERE aggregate_id='contract-a'")).rows[0].payload;
  assert.equal(stored.documentText,pending.documentText);
  assert.equal(stored.status,'completed');
  assert.equal(stored.deliveries[0].method,'manual_handover');
  console.log('ODA native contract SQL migration, employer uniqueness, immutable artifacts, frozen contents, scoped reads and disk restart: passed.');
} finally {
  if (db) await db.close();
  await rm(dir,{recursive:true,force:true});
}
