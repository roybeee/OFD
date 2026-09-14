import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@ofd/domain';
import type { StateRepository } from '@ofd/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { odaAlreadyInitialized, provisionMasterOda, provisionOda } from './oda-provisioning.ts';

const initialAccount = z.object({ name: z.string(), email: z.string(), password: z.string().min(12).max(200) }).strict();
const detailsSchema = z.object({ headquarters: z.unknown(), store: z.unknown(),
  master: initialAccount, operatorA: initialAccount, partnerB: initialAccount }).strict();
const masterOnlySchema = z.object({ mode: z.literal('master-only'), master: initialAccount }).strict();
const setupDetailsSchema = z.union([detailsSchema, masterOnlySchema]);
const localTokenSchema = z.object({ token: z.string().min(32).max(256) });
const localRequestSchema = z.union([
  detailsSchema.extend({ token: z.string().min(32).max(256) }).strict(),
  masterOnlySchema.extend({ token: z.string().min(32).max(256) }).strict(),
]);
const digest = (value: string) => createHash('sha256').update(value).digest();
const setupPath = '/api/v2/oda-setup';
const setupHeader = 'x-oda-setup-token';

export function isOdaSetupEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORKSTATION_BRAND === 'oda' && ((env.APP_MODE === 'local' && env.ODA_LOCAL_ENABLED === 'true')
    || (env.APP_MODE === 'production' && env.ODA_SETTLEMENT_ONLY === 'true' && Boolean(env.ODA_SETUP_TOKEN)));
}

function onlineConfiguration(env: NodeJS.ProcessEnv, token: string) {
  // A cryptographically generated 32-byte base64url token is 43 characters. Reject obvious placeholder/repeated keys too.
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token) || new Set(token).size < 16)
    throw new DomainError('ODA_SETUP_CONFIG', '온라인 최초 설정에 안전하게 생성한 일회성 키가 필요합니다.', 503);
  const expiresAt = env.ODA_SETUP_EXPIRES_AT ?? '';
  const expires = Date.parse(expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) || !Number.isFinite(expires)
    || new Date(expires).toISOString() !== (expiresAt.includes('.') ? expiresAt : expiresAt.replace(/Z$/, '.000Z')))
    throw new DomainError('ODA_SETUP_CONFIG', '온라인 최초 설정 키의 UTC 만료 시각이 필요합니다.', 503);
  let url: URL;
  try { url = new URL(env.WEB_ORIGIN ?? ''); }
  catch { throw new DomainError('ODA_SETUP_CONFIG', '온라인 최초 설정의 HTTPS 접속 주소가 필요합니다.', 503); }
  if (url.protocol !== 'https:' || url.origin !== env.WEB_ORIGIN || env.PUBLIC_APP_URL !== env.WEB_ORIGIN)
    throw new DomainError('ODA_SETUP_CONFIG', '온라인 최초 설정의 HTTPS 접속 주소가 일치해야 합니다.', 503);
  return { expires, expiresAt };
}

/** Registration requires a deployment-issued secret and an empty database, with serialization in provisionOda. */
export function registerOdaSetup(app: FastifyInstance, repository: StateRepository, env: NodeJS.ProcessEnv) {
  if (!isOdaSetupEnabled(env)) return;
  const online = env.APP_MODE === 'production';
  const token = env.ODA_SETUP_TOKEN;
  if (!token || token.length < 32 || token.length > 256) throw new DomainError('ODA_SETUP_CONFIG', '안전한 최초 설정 키가 필요합니다. 실행 프로그램으로 시작해 주세요.', 503);
  const configuration = online ? onlineConfiguration(env, token) : undefined;
  app.get(setupPath, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const initialized = await odaAlreadyInitialized(repository);
    return { enabled: true, initialized, ...(configuration ? { setupMode: 'online', expiresAt: configuration.expiresAt,
      expired: !initialized && Date.now() >= configuration.expires } : {}) };
  });
  app.post(setupPath, { bodyLimit: 24 * 1024, logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== env.WEB_ORIGIN || (online && request.protocol !== 'https'))
      throw new DomainError('ODA_SETUP_ORIGIN', online ? '등록된 HTTPS ODA 화면에서 설정해 주세요.' : '이 컴퓨터의 ODA 화면에서 등록해 주세요.', 403);
    if (request.url.includes('?')) throw new DomainError('ODA_SETUP_URL', '설정 키는 주소의 쿼리 문자열로 전달할 수 없습니다.', 400);
    const providedToken = online ? request.headers[setupHeader] : localTokenSchema.parse(request.body).token;
    // Online secrets never enter the URL, parsed request body, error details, or persistent state.
    delete request.headers[setupHeader];
    if (typeof providedToken !== 'string' || providedToken.length > 256 || !timingSafeEqual(digest(token), digest(providedToken)))
      throw new DomainError('ODA_SETUP_TOKEN', online ? '일회성 설정 키를 확인해 주세요.' : '최초 설정 키가 올바르지 않습니다. 실행 프로그램을 다시 열어 주세요.', 403);
    if (await odaAlreadyInitialized(repository)) throw new DomainError('ODA_ALREADY_INITIALIZED', '이미 등록된 워크스테이션입니다. 등록한 계정으로 로그인해 주세요.', 409);
    if (configuration && Date.now() >= configuration.expires)
      throw new DomainError('ODA_SETUP_EXPIRED', '설정 키가 만료됐습니다. 운영 관리자에게 새 설정 키를 요청해 주세요.', 403);
    const body = online ? setupDetailsSchema.parse(request.body) : localRequestSchema.parse(request.body);
    const { password: masterPassword, ...master } = body.master;
    if ('mode' in body) {
      const result = await provisionMasterOda(repository, master, masterPassword);
      return reply.code(201).send(result);
    }
    const { password: operatorPassword, ...operatorA } = body.operatorA;
    const { password: partnerPassword, ...partnerB } = body.partnerB;
    const result = await provisionOda(repository, { headquarters: body.headquarters, store: body.store, master, operatorA, partnerB },
      [masterPassword, operatorPassword, partnerPassword]);
    return reply.code(201).send(result);
  });
}
