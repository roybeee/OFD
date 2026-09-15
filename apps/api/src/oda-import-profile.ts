import { createHash } from 'node:crypto';
import type { StateRepository } from '@ofd/db';
import { DomainError, normalizeOdaChannel, type Actor, type OdaSourceKind } from '@ofd/domain';
import { audit } from './events.ts';

export type ImportProfile = { headerRow: number; sheetName: string; headers: string[]; columnMap: Record<string, string> };
type ProfileRecord = { id: string; storeId: string; kind: OdaSourceKind; channel: string; version: number;
  profile: ImportProfile | null; updatedAt: string; updatedBy: string };
export function profileIdentity(storeId: string, kind: OdaSourceKind, channel = '') {
  const normalized = normalizeOdaChannel(channel || (kind === 'pos' ? 'pos' : ''));
  return { id: createHash('sha256').update(JSON.stringify([storeId, kind, normalized])).digest('hex'), storeId, kind, channel: normalized };
}
export async function getImportProfile(repository: StateRepository, storeId: string, kind: OdaSourceKind, channel = '') {
  const record = await repository.get<ProfileRecord>('oda_import_profile', profileIdentity(storeId, kind, channel).id);
  return { version: record?.version ?? 0, profile: record?.profile ?? null };
}
/** Called inside the import transaction: rejected imports cannot change a shared format. */
export async function saveImportProfile(repository: StateRepository, actor: Actor, storeId: string, kind: OdaSourceKind,
  channel: string | undefined, profile: ImportProfile | null, expectedVersion?: number) {
  const identity = profileIdentity(storeId, kind, channel);
  return repository.exclusiveTransaction(`oda:import-profile:${identity.id}`, async tx => {
    const before = await tx.get<ProfileRecord>('oda_import_profile', identity.id);
    if (expectedVersion !== undefined && expectedVersion !== (before?.version ?? 0))
      throw new DomainError('VERSION_CONFLICT', '다른 사용자가 엑셀 설정을 변경했습니다. 설정을 다시 불러와 주세요.', 409);
    const value: ProfileRecord = { ...identity, profile, version: (before?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(), updatedBy: actor.id };
    await tx.commit({ changes: [{ type: 'oda_import_profile', id: identity.id, storeId, expectedVersion: before?.version ?? null, value }],
      audits: [audit(actor, 'oda_import_profile', identity.id, profile ? 'ODA 엑셀 양식 기억' : 'ODA 엑셀 양식 초기화', storeId,
        before ? { version: before.version, profile: before.profile } : undefined, { version: value.version, profile }, { kind, channel: identity.channel })] });
    return { version: value.version, profile };
  });
}
