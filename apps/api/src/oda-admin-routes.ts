import { randomUUID } from 'node:crypto';
import type { StateRepository } from '@ofd/db';
import { assertRecentStepUp, assertRole, assertVersion, DomainError, type Actor, type Store } from '@ofd/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from './events.ts';
import { idempotentMutation } from './idempotency.ts';
import { emptyOdaBusiness, odaBusinessSchema, odaOpenDateSchema } from './oda-provisioning.ts';

const path = '/api/v2/oda/admin/stores';
const codeSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, '매장 코드는 영문·숫자·밑줄·하이픈으로 입력해 주세요.');
const storeFields = {
  name: z.string().trim().min(1).max(200), code: codeSchema.optional(), business: odaBusinessSchema.optional(),
  openDate: odaOpenDateSchema.nullable().optional(),
};
const createSchema = z.object(storeFields).strict();
const patchSchema = z.object({ ...storeFields, name: storeFields.name.optional(), active: z.boolean().optional(),
  id: z.string().min(1).max(120), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(body => Object.keys(body).some(key => !['id', 'expectedVersion'].includes(key)), '수정할 항목을 입력해 주세요.');

function requireMaster(request: FastifyRequest, mutation = false): Actor {
  const actor = request.actor;
  if (!actor) throw new DomainError('AUTH_REQUIRED', '로그인이 필요합니다.', 401);
  if (!actor.active) throw new DomainError('ODA_ADMIN_FORBIDDEN', '활성 마스터 계정만 매장을 관리할 수 있습니다.', 403);
  assertRole(actor, ['hq_master']);
  if (actor.storeIds.length > 0) throw new DomainError('ODA_ADMIN_FORBIDDEN', '전체 작업공간 관리자만 매장을 관리할 수 있습니다.', 403);
  if (mutation) assertRecentStepUp(actor);
  return actor;
}

async function uniqueCode(repository: StateRepository, code: string, excludeId?: string) {
  const stores = await repository.list<Store>('store');
  if (stores.some(store => store.id !== excludeId && store.code.toLowerCase() === code.toLowerCase()))
    throw new DomainError('ODA_STORE_CODE_EXISTS', '같은 매장 코드가 이미 있습니다. 다른 코드를 입력해 주세요.', 409);
}

/** Register only for the explicitly enabled ODA local/settlement production profile. */
export function registerOdaAdminRoutes(app: FastifyInstance, repository: StateRepository) {
  app.get(path, async request => {
    requireMaster(request);
    return { stores: await repository.list<Store>('store') };
  });
  app.post(path, { bodyLimit: 24 * 1024 }, async (request, reply) => {
    const actor = requireMaster(request, true);
    const body = createSchema.parse(request.body);
    return idempotentMutation(request, reply, repository, actor, 201, scoped => scoped.exclusiveTransaction('oda:store-administration', async tx => {
      const code = body.code ?? `ODA_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
      await uniqueCode(tx, code);
      const store: Store = { id: randomUUID(), code, name: body.name, business: body.business ?? emptyOdaBusiness(),
        odaWorkspace: !body.business, billingCycle: 'monthly', paymentMethod: 'monthly_credit', notificationPhone: '', active: true, version: 1,
        ...(body.business ? { roadAddress: body.business.address } : {}), ...(body.openDate !== undefined ? { openDate: body.openDate } : {}) };
      await tx.commit({ changes: [{ type: 'store', id: store.id, storeId: store.id, expectedVersion: null, value: store }],
        audits: [audit(actor, 'store', store.id, 'oda.store_created', store.id, undefined, store)] });
      return { store };
    }));
  });
  app.patch(path, { bodyLimit: 24 * 1024 }, async (request, reply) => {
    const actor = requireMaster(request, true);
    const body = patchSchema.parse(request.body);
    return idempotentMutation(request, reply, repository, actor, 200, scoped => scoped.exclusiveTransaction('oda:store-administration', async tx => {
      const previous = await tx.get<Store>('store', body.id);
      if (!previous) throw new DomainError('ODA_STORE_NOT_FOUND', '매장을 찾을 수 없습니다.', 404);
      assertVersion(previous.version, body.expectedVersion);
      if (body.code !== undefined) await uniqueCode(tx, body.code, body.id);
      const store: Store = { ...previous, version: previous.version + 1,
        ...(body.name !== undefined ? { name: body.name } : {}), ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}), ...(body.openDate !== undefined ? { openDate: body.openDate } : {}),
        ...(body.business ? { business: body.business, odaWorkspace: false, roadAddress: body.business.address } : {}) };
      await tx.commit({ changes: [{ type: 'store', id: store.id, storeId: store.id, expectedVersion: previous.version, value: store }],
        audits: [audit(actor, 'store', store.id, 'oda.store_updated', store.id, previous, store)] });
      return { store };
    }));
  });
}
