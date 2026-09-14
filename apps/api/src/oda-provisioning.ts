import { randomUUID } from 'node:crypto';
import { DomainError, hashPassword, type Actor, type Store, type UserCredential } from '@ofd/domain';
import type { StateRepository } from '@ofd/db';
import { z } from 'zod';
import { audit } from './events.ts';

const business = z.object({
  businessNumber: z.string().trim().regex(/^\d{10}$/, '사업자등록번호는 숫자 10자리입니다.'),
  legalName: z.string().trim().min(1).max(200), representativeName: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(500), businessType: z.string().trim().min(1).max(100),
  businessCategory: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254),
}).strict();
const person = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '실제 개업일을 확인해 주세요.');
export const odaProvisionSchema = z.object({
  headquarters: business,
  store: z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(200), business, openDate: date.optional() }).strict(),
  master: person, operatorA: person, partnerB: person,
}).strict().refine(config => new Set([config.master.email, config.operatorA.email, config.partnerB.email].map(x => x.toLowerCase())).size === 3,
  '관리자, A, B는 서로 다른 이메일의 본인 계정이어야 합니다.');
export type OdaProvisionInput = z.infer<typeof odaProvisionSchema>;

export async function odaAlreadyInitialized(repository: StateRepository): Promise<boolean> {
  const types = ['store', 'actor', 'legal_entity', 'credential'] as const;
  const records = await Promise.all(types.map(type => repository.list(type)));
  return records.some(items => items.length > 0);
}

export async function provisionOda(repository: StateRepository, input: unknown, passwords: readonly string[]) {
  const config = odaProvisionSchema.parse(input);
  if (passwords.length !== 3 || passwords.some(password => typeof password !== 'string' || password.length < 12 || password.length > 200 || !/\d/.test(password) || !/[^A-Za-z0-9\s]/.test(password)))
    throw new DomainError('ODA_PASSWORD_REQUIRED', '계정마다 숫자·특수문자가 포함된 12자 이상의 비밀번호가 필요합니다.', 422);
  // Hash before obtaining the database lock; weak passwords cannot create partial accounts.
  const hashes = passwords.map(password => hashPassword(password));
  return repository.exclusiveTransaction('oda:initial-provisioning', async tx => {
    if (await odaAlreadyInitialized(tx)) throw new DomainError('ODA_ALREADY_INITIALIZED', '이미 등록된 워크스테이션입니다. 기존 자료와 계정을 유지합니다.', 409);
    const store: Store = { id: randomUUID(), code: config.store.code, name: config.store.name, business: config.store.business,
      billingCycle: 'monthly', paymentMethod: 'monthly_credit', notificationPhone: '', active: true, version: 1,
      roadAddress: config.store.business.address, ...(config.store.openDate ? { openDate: config.store.openDate } : {}) };
    const roles = ['hq_master', 'store_owner', 'hq_finance'] as const;
    const people = [config.master, config.operatorA, config.partnerB];
    const actors: Actor[] = people.map((person, i) => ({ id: randomUUID(), name: person.name, role: roles[i]!,
      storeIds: i === 0 ? [] : [store.id], active: true, authVersion: 1 }));
    const credentials: UserCredential[] = actors.map((actor, i) => ({ id: randomUUID(), actorId: actor.id,
      email: people[i]!.email.toLowerCase(), passwordHash: hashes[i]!, failedAttempts: 0, mustChangePassword: true, version: 1 }));
    const headquarters = { ...config.headquarters, id: randomUUID(), isHeadquarters: true };
    await tx.commit({ changes: [
      { type: 'legal_entity', id: headquarters.id, expectedVersion: null, value: headquarters },
      { type: 'store', id: store.id, storeId: store.id, expectedVersion: null, value: store },
      ...actors.map(actor => ({ type: 'actor' as const, id: actor.id, expectedVersion: null, value: actor })),
      ...credentials.map(credential => ({ type: 'credential' as const, id: credential.id, expectedVersion: null, value: credential })),
    ], audits: [audit(actors[0]!, 'system', store.id, 'oda.initial_provisioning', store.id, undefined,
      { storeId: store.id, actorIds: actors.map(actor => actor.id) })] });
    return { created: true as const, storeName: store.name };
  });
}
