import { hashPassword, type Actor, type LegalEntitySnapshot, type Store, type UserCredential } from '@ofd/domain';
import { DEMO_IDS } from './demo-seed.ts';
import { MemoryRepository } from './memory-repository.ts';
import type { AggregateChange } from './repository.ts';

/** Isolated, explicitly labelled development data. Never called by production. */
export function createOdaDemoRepository(): MemoryRepository {
  const store: Store = {
    id: DEMO_IDS.storeDoksan, code: 'ODA-PILOT', name: 'ODA 외대점 · 테스트',
    business: { businessNumber: '0000000000', legalName: 'ODA 테스트 매장', representativeName: '테스트 A',
      address: '서울시 동대문구 휘경동 377 107호', businessType: '음식점업', businessCategory: '피자', email: 'store@oda.example.invalid' },
    billingCycle: 'monthly', paymentMethod: 'monthly_credit', notificationPhone: '', active: true, version: 1,
  };
  const actors: Actor[] = [
    { id: DEMO_IDS.owner, name: '매장 운영자 A · 테스트', role: 'store_owner', storeIds: [store.id], active: true, authVersion: 1 },
    { id: DEMO_IDS.finance, name: '지원 파트너 B · 테스트', role: 'hq_finance', storeIds: [store.id], active: true, authVersion: 1 },
    { id: DEMO_IDS.master, name: 'ODA 관리자 · 테스트', role: 'hq_master', storeIds: [], active: true, authVersion: 1 },
    { id: DEMO_IDS.auditor, name: '열람 담당 · 테스트', role: 'auditor', storeIds: [store.id], active: true, authVersion: 1 },
  ];
  const headquarters: LegalEntitySnapshot & {id:string; isHeadquarters:boolean} = { ...store.business, id: DEMO_IDS.hq, isHeadquarters: true };
  const seed: AggregateChange[] = [
    { type: 'legal_entity', id: headquarters.id, expectedVersion: null, value: headquarters },
    { type: 'store', id: store.id, storeId: store.id, expectedVersion: null, value: store },
    ...actors.map(actor => ({type:'actor' as const, id:actor.id, expectedVersion:null, value:actor})),
  ];
  const passwordHash = hashPassword('ODA-local-demo-2026!', Buffer.alloc(16, 9));
  for (const actor of actors) {
    const credential: UserCredential = {id:`oda-demo-credential-${actor.role}`,actorId:actor.id,
      email:`${actor.role}@oda.local`,passwordHash,failedAttempts:0,version:1};
    seed.push({type:'credential',id:credential.id,expectedVersion:null,value:credential});
  }
  return new MemoryRepository(seed);
}
