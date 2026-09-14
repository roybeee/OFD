import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import type { Actor, AuditEvent } from '@ofd/domain';
import { MockObjectStorage } from '@ofd/integrations';
import { describe, expect, it } from 'vitest';
import { ProcurementService } from './service.ts';
import { audit } from './events.ts';

async function fixture(role: 'hq_master' | 'auditor') {
  const repository = createDemoRepository();
  const original = (await repository.get<Actor>('actor', role === 'hq_master' ? DEMO_IDS.master : DEMO_IDS.auditor))!;
  const actor = { ...original, storeIds: [DEMO_IDS.storeHapjeong] };
  await repository.commit({ changes: [], audits: [
    audit(original, 'oda_month', 'assigned-month', 'assigned-oda-history', DEMO_IDS.storeHapjeong,
      undefined, { profit: 100 }),
    audit(original, 'oda_month', 'other-month', 'other-oda-history', DEMO_IDS.storeDoksan,
      undefined, { profit: 900 }),
  ] });
  return { repository, actor, service: new ProcurementService(repository, new MockObjectStorage(), 'production') };
}

describe('ODA bootstrap scope for existing assigned headquarters identities', () => {
  it.each(['hq_master', 'auditor'] as const)('limits %s collections and audit history to its assigned stores', async (role) => {
    const { actor, service } = await fixture(role);
    const data = await service.bootstrap(actor, { odaWorkspace: true });
    expect(data.stores).toEqual([expect.objectContaining({ id: DEMO_IDS.storeHapjeong })]);
    for (const key of ['orders', 'shipments', 'receipts', 'paymentRequests', 'settlements', 'taxInvoices', 'documents']) {
      const rows = data[key] as Array<{ storeId: string }>;
      expect(rows.every(row => row.storeId === DEMO_IDS.storeHapjeong), key).toBe(true);
    }
    const events = data.auditEvents as AuditEvent[];
    expect(events.some(event => event.action === 'assigned-oda-history')).toBe(true);
    expect(events.every(event => event.storeId === DEMO_IDS.storeHapjeong)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('other-oda-history');
    expect(data.bankTransactions).toEqual([]);
    expect(data.manualMatchCandidates).toEqual([]);
    expect(data.driverDirectory).toEqual([]);
  });

  it.each(['hq_master', 'auditor'] as const)('preserves global ODA %s access and the existing OFD policy', async (role) => {
    const { repository, actor, service } = await fixture(role);
    for (const data of [await service.bootstrap({ ...actor, storeIds: [] }, { odaWorkspace: true }),
      await service.bootstrap(actor)]) {
      expect((data.stores as unknown[]).length).toBeGreaterThan(1);
      expect((data.auditEvents as AuditEvent[]).some(event => event.action === 'other-oda-history')).toBe(true);
      expect(data.bankTransactions).toHaveLength((await repository.list('bank_transaction')).length);
    }
  });
});
