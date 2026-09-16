import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository } from './memory-repository.ts';

test('completed contract file bytes cannot be replaced and a failed replacement rolls back the transaction', async () => {
  const repository = new MemoryRepository();
  const artifact = { id: 'c1:pdf', version: 1, contentBase64: 'b3JpZ2luYWw=', sha256: 'original' };
  await repository.commit({ changes: [{ type: 'oda_contract_artifact', id: artifact.id, storeId: 'store-1', expectedVersion: null, value: artifact }] });
  await assert.rejects(() => repository.transaction(async tx => {
    await tx.commit({ changes: [{ type: 'oda_contract', id: 'c2', storeId: 'store-1', expectedVersion: null, value: { id: 'c2', version: 1 } }] });
    await tx.commit({ changes: [{ type: 'oda_contract_artifact', id: artifact.id, storeId: 'store-1', expectedVersion: 1,
      value: { ...artifact, version: 2, contentBase64: 'changed' } }] });
  }), { code: 'CONTRACT_ARTIFACT_IMMUTABLE' });
  assert.deepEqual(await repository.get('oda_contract_artifact', artifact.id), artifact);
  assert.equal(await repository.get('oda_contract', 'c2'), undefined);
  assert.deepEqual(await repository.list('oda_contract_artifact', ['other-store']), []);
});
