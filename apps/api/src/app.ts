import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { createRepository, discoverMigrations, type RepositoryReadiness, type StateRepository } from "@ofd/db";
import { assertEncryptionKey, DomainError, parseHolidayCalendar } from "@ofd/domain";
import {
  createObjectStorage,
  readProviderConfig,
  type ObjectStorage,
  type StorageReadiness,
} from "@ofd/integrations";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { resolveActor } from "./auth.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { AuthService } from "./auth-service.ts";
import { idempotentMutation } from "./idempotency.ts";
import { ProcurementService } from "./service.ts";
import { createOpeningStore, createPosStore, OPENING_PHASES, type OpeningPhase, type OpeningStage } from "@ofd/db";
import { DomainError as PosDomainError } from "@ofd/domain";
import { decryptPosSecret, encryptPosSecret, fetchTossDailyItems } from "@ofd/integrations";
import { randomUUID as posRandomUUID } from "node:crypto";
import type { Actor as PosActor, GoodsReceipt, PurchaseOrder, Settlement, Shipment, Store as PosStoreRecord, TaxInvoice } from "@ofd/domain";
import { buildMonthlySettlementSummary } from "./monthly-settlement.ts";
import { audit as posAudit } from "./events.ts";

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  repository?: StateRepository;
  storage?: ObjectStorage;
  logger?: boolean;
  readinessNow?: () => Date;
}

const idParams = z.object({ id: z.string().min(1) });
const expectedVersion = z.object({ expectedVersion: z.number().int().positive() });
const processSessionSecret = randomBytes(32).toString("base64url");
const provisionableRole = z.enum(["store_owner", "store_staff", "driver", "hq_ops", "hq_finance", "hq_master", "auditor"]);
const mfaSecret = z.string().trim().min(16).max(128).regex(/^[A-Za-z2-7]+=*$/);

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config = readProviderConfig(env);
  const holidayCalendar = parseHolidayCalendar(env.KOREA_HOLIDAYS, config.appMode === "production");
  const repository = options.repository ?? createRepository(env);
  const requiredMigrations = await discoverMigrations();
  let storage = options.storage;
  if (!storage) {
    storage = createObjectStorage(config);
  }
  if (config.appMode === "production" && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new DomainError("SESSION_CONFIG_ERROR", "production SESSION_SECRET은 32자 이상이어야 합니다.", 503);
  }
  if (config.appMode === "production") assertEncryptionKey(env.ENCRYPTION_KEY ?? "");
  if (config.appMode === "production" && !env.WEB_ORIGIN) throw new DomainError("WEB_ORIGIN_REQUIRED", "production WEB_ORIGIN이 필요합니다.", 503);
  const service = new ProcurementService(repository, storage, config.appMode, env.RECONCILIATION_ACCOUNT_ID ?? "ofd-main",
    config.providerMode, config.providerMode === "production" && config.taxInvoiceEnabled, () => new Date(), holidayCalendar);
  const sessionSecret = env.SESSION_SECRET ?? processSessionSecret;
  const authService = new AuthService(repository, sessionSecret, config.appMode, env.ENCRYPTION_KEY);
  const app = Fastify({ logger: options.logger ?? env.LOG_LEVEL !== "silent", bodyLimit: config.uploadMaxBytes, trustProxy: true });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.appMode === "production" ? (env.WEB_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean) : true,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-api-key", "pb-webhook-mid", "pb-webhook-corpnum",
      ...(config.appMode === "production" ? [] : ["x-demo-actor-id"])],
  });
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0];
    if (path === "/api/v2/health" || path === "/api/v2/ready" || path === "/api/v2/auth/login" || path === "/api/v2/auth/mfa"
      || path === "/api/v2/webhooks/popbill" || path === "/api/v2/webhooks/tossplace" || path === "/api/v2/mock-uploads" || path === "/api/v2/mock-files") return;
    request.actor = await resolveActor(request, repository, config.appMode, sessionSecret, env.TEST_AUTH_REQUIRED === "true");
  });

  app.get("/api/v2/health", async () => ({ ok: true, mode: config.appMode, providerMode: config.providerMode,
    now: new Date().toISOString(), commit: (env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null }));
  app.get("/api/v2/ready", async (_request, reply) => {
    const checkedAt = (options.readinessNow?.() ?? new Date());
    const expectedMigrations = requiredMigrations.map(({ version, checksumSha256 }) => ({ version, checksumSha256 }));
    let repositoryStatus: RepositoryReadiness;
    try {
      repositoryStatus = await repository.checkReadiness(expectedMigrations, checkedAt);
    } catch {
      repositoryStatus = {
        ok: false,
        database: { ok: false, mode: config.appMode === "production" ? "postgres" : "memory", code: "READINESS_CHECK_FAILED" },
        migrations: { ok: false, expected: expectedMigrations.length, applied: 0,
          missing: expectedMigrations.map((migration) => migration.version), drifted: [], unexpected: [], code: "READINESS_CHECK_FAILED" },
        worker: { ok: false, code: "READINESS_CHECK_FAILED" },
      };
    }
    let storageStatus: StorageReadiness;
    try {
      storageStatus = await storage.checkReadiness();
    } catch {
      storageStatus = { ok: false, mode: config.storageMode, reachable: false, versioning: "Unknown", code: "STORAGE_READINESS_FAILED" };
    }
    if (config.appMode === "production" && (storageStatus.mode !== "s3" || storageStatus.versioning !== "Enabled")) {
      storageStatus = { ...storageStatus, ok: false, code: storageStatus.code ?? "S3_VERSIONING_NOT_ENABLED" };
    }
    const projections = { ok: true, mode: "synchronous" as const, lag: 0 };
    const ok = repositoryStatus.ok && storageStatus.ok && projections.ok;
    const { ok: _repositoryOk, ...repositoryComponents } = repositoryStatus;
    return reply.code(ok ? 200 : 503).send({
      ok,
      mode: config.appMode,
      checkedAt: checkedAt.toISOString(),
      components: { ...repositoryComponents, storage: storageStatus, projections },
    });
  });
  app.post("/api/v2/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).parse(request.body);
    const result = await authService.login(body.email, body.password, request.ip);
    if (result.token) setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: Boolean(result.token), mfaRequired: result.mfaRequired, challengeToken: result.challengeToken, actor: result.actor };
  });
  app.post("/api/v2/auth/mfa", async (request, reply) => {
    const body = z.object({ challengeToken: z.string().min(20), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const result = await authService.completeMfa(body.challengeToken, body.code, request.ip);
    setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: true, actor: result.actor };
  });
  app.post("/api/v2/auth/step-up", async (request, reply) => {
    const body = z.object({ password: z.string().min(1).max(200), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const result = await authService.stepUp(request.actor, body.password, body.code, request.ip);
    setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: true, mfaVerifiedAt: new Date().toISOString(), actor: result.actor };
  });
  app.post("/api/v2/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
  app.get("/api/v2/bootstrap", async (request) => service.bootstrap(request.actor));

  /**
   * Identity administration contract (hq_master + recent step-up only):
   * GET returns { actors: AdminActorSummary[] }.
   * POST creates one actor/credential pair and returns only { actor: AdminActorSummary }.
   * PATCH accepts a deactivate/reset action and returns only { actor: AdminActorSummary }.
   * Password hashes and TOTP material are never serialized by these handlers.
   */
  app.get("/api/v2/admin/actors", async (request) => authService.listActorAccounts(request.actor));
  app.post("/api/v2/admin/actors", async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(2).max(100), role: provisionableRole,
      storeIds: z.array(z.string().min(1)).max(100).default([]),
      email: z.string().email().max(254), password: z.string().min(12).max(200), mfaSecret: mfaSecret.optional(),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => new AuthService(scoped, sessionSecret, config.appMode, env.ENCRYPTION_KEY).provisionActor(request.actor, body));
  });
  app.patch("/api/v2/admin/actors", async (request, reply) => {
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("deactivate"), actorId: z.string().min(1), expectedVersion: z.number().int().positive() }),
      z.object({ action: z.literal("reset"), actorId: z.string().min(1), expectedVersion: z.number().int().positive(),
        newPassword: z.string().min(12).max(200), mfaSecret: mfaSecret.optional() }),
    ]).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200, (scoped) => {
      const scopedAuth = new AuthService(scoped, sessionSecret, config.appMode, env.ENCRYPTION_KEY);
      return body.action === "deactivate"
        ? scopedAuth.deactivateActor(request.actor, body.actorId, body.expectedVersion)
        : scopedAuth.resetActor(request.actor, body.actorId, body.expectedVersion, body.newPassword, body.mfaSecret);
    });
  });

  /** Active driver directory contract: { drivers: Array<{ id, name }> }; hq_ops/hq_master only. */
  app.get("/api/v2/directory/drivers", async (request) => authService.listActiveDrivers(request.actor));

  app.post("/api/v2/orders", async (request, reply) => {
    const body = z.object({
      storeId: z.string().min(1), requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(500).optional(),
      items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().max(10_000) })).min(1).max(99),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createOrder(request.actor, body));
  });

  app.post("/api/v2/orders/submit-new", async (request, reply) => {
    const body = z.object({
      storeId: z.string().min(1), requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(500).optional(),
      items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().max(10_000) })).min(1).max(99),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createSubmittedOrder(request.actor, body));
  });

  app.post("/api/v2/orders/:id/submit", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).submitOrder(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/orders/:id/change-request", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({ reason: z.string().min(3).max(500) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).requestOrderChange(request.actor, id, body.expectedVersion, body.reason));
  });
  app.post("/api/v2/orders/:id/resubmit", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({
      requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(500).optional(),
      items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().max(10_000) })).min(1).max(99),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).resubmitOrder(request.actor, id, body));
  });
  app.post("/api/v2/orders/:id/cancel", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({ reason: z.string().min(3).max(500) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).cancelOrder(request.actor, id, body.expectedVersion, body.reason));
  });
  app.post("/api/v2/orders/:id/reject", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({ reason: z.string().min(3).max(500) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).rejectOrder(request.actor, id, body.expectedVersion, body.reason));
  });
  app.post("/api/v2/orders/:id/approve", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).approveOrder(request.actor, id, body.expectedVersion));
  });

  app.post("/api/v2/shipments", async (request, reply) => {
    const body = z.object({
      orderId: z.string().min(1), driverId: z.string().min(1), plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      routeSequence: z.number().int().min(1).max(9_999),
      deliveryWindow: z.object({
        start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      }),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createShipment(request.actor, body.orderId, body.driverId, body.plannedDate,
        body.routeSequence, body.deliveryWindow));
  });
  app.post("/api/v2/shipments/:id/dispatch", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).dispatchShipment(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/shipments/:id/proof-upload", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createDeliveryUpload(request.actor, id, body.contentType));
  });
  app.post("/api/v2/shipments/:id/deliver", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({
      photoKey: z.string().min(1), recipientName: z.string().min(1).max(100), note: z.string().max(300).optional(),
      latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
    }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).completeDelivery(request.actor, id, body));
  });

  app.put("/api/v2/mock-uploads", async (request, reply) => {
    if (config.storageMode !== "mock" || !storage.recordMockUpload) throw new DomainError("NOT_FOUND", "경로를 찾을 수 없습니다.", 404);
    const { key } = z.object({ key: z.string().min(1) }).parse(request.query);
    const contentType = request.headers["content-type"]?.split(";")[0] ?? "";
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw new DomainError("PHOTO_BODY_REQUIRED", "사진 파일 본문이 필요합니다.", 400);
    await storage.recordMockUpload(key, contentType, body);
    return reply.code(204).send();
  });
  app.get("/api/v2/mock-files", async (request, reply) => {
    if (config.storageMode !== "mock") throw new DomainError("NOT_FOUND", "경로를 찾을 수 없습니다.", 404);
    z.object({ key: z.string().min(1) }).parse(request.query);
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl9sAAAAASUVORK5CYII=", "base64");
    return reply.header("Content-Type", "image/png").send(pixel);
  });

  app.post("/api/v2/payments/auto-match", async (request, reply) =>
    idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).autoMatchPayments(request.actor)));
  app.post("/api/v2/payments/:id/manual-match", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({ bankTransactionId: z.string().min(1) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).manualMatchPayment(request.actor, id, body.bankTransactionId, body.expectedVersion));
  });
  app.post("/api/v2/payments/:id/reverse-match", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = expectedVersion.extend({ reason: z.string().min(3).max(500) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).reversePaymentMatch(request.actor, id, body.expectedVersion, body.reason));
  });
  app.post("/api/v2/bank-sync", async (request, reply) => {
    const body = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 202,
      (scoped) => service.withRepository(scoped).requestBankSync(request.actor, body.from, body.to));
  });

  app.post("/api/v2/settlements", async (request, reply) => {
    const body = z.object({ storeId: z.string().min(1), periodStart: z.string(), periodEnd: z.string(), receiptIds: z.array(z.string()).optional() }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).draftSettlement(request.actor, body));
  });
  app.post("/api/v2/settlements/:id/review", async (request, reply) => {
    const { id } = idParams.parse(request.params); const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).reviewSettlement(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/settlements/:id/approve", async (request, reply) => {
    const { id } = idParams.parse(request.params); const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).approveSettlement(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/invoices", async (request, reply) => {
    const body = z.object({ settlementId: z.string().min(1) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createInvoiceDraft(request.actor, body.settlementId));
  });
  app.post("/api/v2/invoices/:id/review", async (request, reply) => {
    const { id } = idParams.parse(request.params); const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).reviewInvoice(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/invoices/:id/modify", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ reasonCode: z.enum(["01", "02", "03", "04", "05", "06"]) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createModifiedInvoice(request.actor, id, body.reasonCode));
  });
  app.post("/api/v2/invoices/:id/approve", async (request, reply) => {
    const { id } = idParams.parse(request.params); const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).approveInvoice(request.actor, id, body.expectedVersion));
  });
  app.post("/api/v2/invoices/:id/retry", async (request, reply) => {
    const { id } = idParams.parse(request.params); const body = expectedVersion.parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).retryInvoice(request.actor, id, body.expectedVersion));
  });
  app.get("/api/v2/documents/:id/download", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.downloadDocument(request.actor, id);
  });
  app.post("/api/v2/admin/outbox/:id/requeue", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).requeueDeadLetter(request.actor, id));
  });

  /* ── POS 수집 (V1 이식 1단계) ───────────────────────── */
  const posStore = createPosStore(env);
  app.addHook("onClose", async () => { await posStore.close(); });
  const assertPosRole = (actor: { role?: string } | undefined) => {
    const role = actor?.role ?? "";
    /* 실제 V2 역할은 hq_* 접두 — 접두 없는 값은 메모리 모드 테스트 하위호환 */
    if (!["hq_master", "hq_finance", "hq_ops", "master", "finance", "admin"].includes(role)) {
      throw new PosDomainError("FORBIDDEN", "POS 연동 권한이 없습니다.", 403);
    }
  };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  /* 초기 구축용 매장 등록 — 새 DB에는 매장이 없어 레거시 이관 없이도 시작할 수 있어야 한다 */
  app.post("/api/v2/pos/stores", async (request, reply) => {
    const role = String(request.actor?.role ?? "");
    if (role !== "hq_master" && role !== "master") {
      throw new PosDomainError("FORBIDDEN", "마스터만 매장을 등록할 수 있습니다.", 403);
    }
    const body = request.body as { code?: string; name?: string; billingCycle?: string; paymentMethod?: string; notificationPhone?: string; storeKind?: string };
    const name = body?.name?.trim() ?? "";
    if (name.length < 2) throw new PosDomainError("STORE_NAME_REQUIRED", "매장명(2자 이상)이 필요합니다.", 422);
    const entities = await repository.list<{ id: string; isHeadquarters?: boolean; businessNumber: string; legalName: string; representativeName: string; address: string; businessType: string; businessCategory: string; email: string }>("legal_entity");
    const headquarters = entities.find((entity) => entity.isHeadquarters);
    if (!headquarters) {
      throw new PosDomainError("HQ_REQUIRED", "본사 정보가 없습니다. bootstrap-admin을 먼저 실행해 주세요.", 409);
    }
    const stores = await repository.list<PosStoreRecord>("store");
    const code = (body.code?.trim() || `ST${String(stores.length + 1).padStart(3, "0")}`).toUpperCase();
    if (stores.some((store) => store.code === code)) {
      throw new PosDomainError("STORE_CODE_DUP", "이미 사용 중인 매장 코드입니다.", 409);
    }
    const store: PosStoreRecord = {
      id: posRandomUUID(), code, name,
      business: {
        businessNumber: headquarters.businessNumber, legalName: headquarters.legalName,
        representativeName: headquarters.representativeName, address: headquarters.address,
        businessType: headquarters.businessType, businessCategory: headquarters.businessCategory,
        email: headquarters.email,
      },
      billingCycle: body.billingCycle === "per_delivery" ? "per_delivery" : "monthly",
      paymentMethod: body.paymentMethod === "prepaid" ? "prepaid" : "monthly_credit",
      notificationPhone: (body.notificationPhone ?? "").replace(/[^0-9]/g, "") || "01000000000",
      active: true, version: 1,
      ...(body.storeKind === "직영" || body.storeKind === "가맹" ? { storeKind: body.storeKind } : {}),
    };
    await repository.commit({
      changes: [{ type: "store", id: store.id, expectedVersion: null, value: store }],
      audits: [posAudit(request.actor as PosActor, "system", store.id, "store.created", undefined, undefined, { code, name })],
    });
    reply.code(201);
    return { store: { id: store.id, code, name } };
  });

  /* ── 월별 정산 집계 (V1 정산 탭 이식) ──
   * 공급 = 검수 확정 입고(KST 월 귀속), 매장 매출 = POS 실측, 로스 = 입고−판매(상품 매칭).
   * 조회 전용이라 메이커-체커와 무관하게 마스터·재무·감사인이 본다. */
  app.get("/api/v2/settlements/monthly", async (request) => {
    const role = String(request.actor?.role ?? "");
    if (!["hq_master", "hq_finance", "auditor", "master", "finance", "admin"].includes(role)) {
      throw new PosDomainError("FORBIDDEN", "정산 집계 조회 권한이 없습니다.", 403);
    }
    const query = request.query as { month?: string };
    const kstMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" })
      .format(new Date()).slice(0, 7);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month ?? "") ? query.month! : kstMonth;
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const from = `${month}-01`;
    const to = `${month}-${String(monthEnd).padStart(2, "0")}`;
    const [stores, receipts, shipments, orders, settlements, invoices, posDaily, posProductQty] = await Promise.all([
      repository.list<PosStoreRecord>("store"),
      repository.list<GoodsReceipt>("receipt"),
      repository.list<Shipment>("shipment"),
      repository.list<PurchaseOrder>("order"),
      repository.list<Settlement>("settlement"),
      repository.list<TaxInvoice>("tax_invoice"),
      posStore.dailyTotals(from, to),
      posStore.productTotals(from, to),
    ]);
    return buildMonthlySettlementSummary(month, {
      stores, receipts, shipments, orders, settlements, invoices,
      posTotals: posDaily.map(({ storeId, qty, amount }) => ({ storeId, qty, amount })),
      posProductQty,
    });
  });

  app.get("/api/v2/pos/links", async (request) => {
    assertPosRole(request.actor);
    const links = await posStore.listLinks();
    return { links: links.map(({ accessKeyEnc: _a, secretKeyEnc: _s, ...safe }) => safe) };
  });

  app.post("/api/v2/pos/links", async (request, reply) => {
    assertPosRole(request.actor);
    const body = request.body as { storeId?: string; merchantId?: string; accessKey?: string; secretKey?: string };
    if (!body?.storeId || !body.merchantId || !body.accessKey || !body.secretKey) {
      throw new PosDomainError("POS_LINK_FIELDS", "storeId, merchantId, accessKey, secretKey가 필요합니다.", 422);
    }
    const encryptionKey = env.ENCRYPTION_KEY ?? "";
    const link = await posStore.upsertLink({
      storeId: body.storeId, merchantId: body.merchantId, status: "active",
      accessKeyEnc: encryptPosSecret(body.accessKey, encryptionKey),
      secretKeyEnc: encryptPosSecret(body.secretKey, encryptionKey),
    });
    reply.code(201);
    return { id: link.id, storeId: link.storeId, merchantId: link.merchantId, status: link.status };
  });

  app.post("/api/v2/pos/sync", async (request) => {
    assertPosRole(request.actor);
    const body = (request.body ?? {}) as { from?: string; to?: string; merchantId?: string };
    const to = dateOnly.test(body.to ?? "") ? body.to! : seoulToday();
    const from = dateOnly.test(body.from ?? "") ? body.from! : to;
    if (from > to) throw new PosDomainError("POS_RANGE", "from은 to보다 늦을 수 없습니다.", 422);
    const encryptionKey = env.ENCRYPTION_KEY ?? "";
    const links = (await posStore.listLinks()).filter((l) => l.status === "active" && (!body.merchantId || l.merchantId === body.merchantId));
    const results: Array<{ merchantId: string; rows: number; status: string; error?: string }> = [];
    for (const link of links) {
      try {
        const items = await fetchTossDailyItems({
          merchantId: link.merchantId,
          accessKey: decryptPosSecret(link.accessKeyEnc, encryptionKey),
          secretKey: decryptPosSecret(link.secretKeyEnc, encryptionKey),
          from, to,
        });
        const rows = await posStore.recordSales(link.storeId, items, from === to ? "sync" : "backfill");
        await posStore.resolveUnmatched(link.storeId);
        await posStore.touchLinkSynced(link.id, new Date());
        await posStore.recordRun({ storeId: link.storeId, from, to, rows, status: "ok" });
        results.push({ merchantId: link.merchantId, rows, status: "ok" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await posStore.recordRun({ storeId: link.storeId, from, to, rows: 0, status: "error", error: message });
        results.push({ merchantId: link.merchantId, rows: 0, status: "error", error: message });
      }
    }
    return { from, to, results };
  });

  app.get("/api/v2/pos/daily", async (request) => {
    assertPosRole(request.actor);
    const query = request.query as { from?: string; to?: string };
    const to = dateOnly.test(query.to ?? "") ? query.to! : seoulToday();
    const from = dateOnly.test(query.from ?? "") ? query.from! : to;
    return { from, to, totals: await posStore.dailyTotals(from, to) };
  });

  /* ── 상품·별칭 (V1 이식 2단계) ── */
  app.get("/api/v2/pos/products", async (request) => {
    assertPosRole(request.actor);
    const query = request.query as { from?: string; to?: string };
    const to = dateOnly.test(query.to ?? "") ? query.to! : seoulToday();
    const from = dateOnly.test(query.from ?? "") ? query.from! : to;
    const [products, deviations] = await Promise.all([
      posStore.listProducts(), posStore.priceDeviations(from, to, 3),
    ]);
    return { products, deviations, from, to };
  });

  app.post("/api/v2/pos/products", async (request, reply) => {
    assertPosRole(request.actor);
    const body = request.body as { name?: string; category?: string; storeId?: string | null; consumerPrice?: number | null; rawName?: string };
    if (!body?.name?.trim()) throw new PosDomainError("PRODUCT_NAME_REQUIRED", "상품명이 필요합니다.", 422);
    const category = ["도넛", "링도넛", "음료", "굿즈", "서비스", "세트", "기타"].includes(body.category ?? "") ? body.category! : "기타";
    const product = await posStore.createProduct({
      name: body.name.trim(), category, storeId: body.storeId ?? null,
      consumerPrice: typeof body.consumerPrice === "number" ? body.consumerPrice : null,
    });
    /* 미매칭 승격: 원본 품목명이 오면 별칭까지 걸어 소급 매칭 */
    const promoted = body.rawName?.trim() ? await posStore.upsertAlias(body.rawName, product.id) : null;
    await posStore.resolveUnmatched();
    reply.code(201);
    return { product, promoted };
  });

  app.patch("/api/v2/pos/products/:id", async (request) => {
    assertPosRole(request.actor);
    const body = request.body as { category?: string; storeId?: string | null; consumerPrice?: number | null };
    const patch: Record<string, unknown> = {};
    if (body.category !== undefined) {
      if (!["도넛", "링도넛", "음료", "굿즈", "서비스", "세트", "기타"].includes(body.category)) {
        throw new PosDomainError("BAD_CATEGORY", "허용되지 않는 카테고리입니다.", 422);
      }
      patch.category = body.category;
    }
    if (Object.hasOwn(body, "storeId")) patch.storeId = body.storeId ?? null;
    if (Object.hasOwn(body, "consumerPrice")) patch.consumerPrice = body.consumerPrice ?? null;
    const product = await posStore.updateProduct((request.params as { id: string }).id, patch);
    if (!product) throw new PosDomainError("PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.", 404);
    return { product };
  });

  app.get("/api/v2/pos/unmatched", async (request) => {
    assertPosRole(request.actor);
    const query = request.query as { from?: string; to?: string };
    const to = dateOnly.test(query.to ?? "") ? query.to! : seoulToday();
    const from = dateOnly.test(query.from ?? "") ? query.from! : to;
    return { from, to, items: await posStore.listUnmatched(from, to) };
  });

  app.get("/api/v2/pos/aliases", async (request) => {
    assertPosRole(request.actor);
    return { aliases: await posStore.listAliases() };
  });

  app.post("/api/v2/pos/aliases", async (request, reply) => {
    assertPosRole(request.actor);
    const body = request.body as { rawName?: string; productId?: string };
    if (!body?.rawName?.trim() || !body.productId) {
      throw new PosDomainError("ALIAS_FIELDS", "rawName, productId가 필요합니다.", 422);
    }
    try {
      const result = await posStore.upsertAlias(body.rawName, body.productId);
      reply.code(201);
      return result; /* scopeStoreId가 있으면 해당 매장에만 적용됐다는 뜻 */
    } catch (error) {
      if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") {
        throw new PosDomainError("PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.", 404);
      }
      throw error;
    }
  });

  app.delete("/api/v2/pos/aliases/:id", async (request) => {
    assertPosRole(request.actor);
    const result = await posStore.removeAlias((request.params as { id: string }).id);
    if (!result) throw new PosDomainError("ALIAS_NOT_FOUND", "별칭을 찾을 수 없습니다.", 404);
    return result; /* reverted = 미매칭으로 소급 원복된 행 수 */
  });

  app.get("/api/v2/pos/report", async (request) => {
    assertPosRole(request.actor);
    const query = request.query as { from?: string; to?: string; unit?: string; stores?: string; products?: string };
    const to = dateOnly.test(query.to ?? "") ? query.to! : seoulToday();
    const from = dateOnly.test(query.from ?? "") ? query.from! : to;
    const unit = query.unit === "week" || query.unit === "month" ? query.unit : "day";
    const csv = (value?: string) => value?.split(",").map((v) => v.trim()).filter(Boolean);
    const filter: import("@ofd/db").PosReportFilter = {};
    const storeIds = csv(query.stores);
    const productIds = csv(query.products);
    if (storeIds?.length) filter.storeIds = storeIds;
    if (productIds?.length) filter.productIds = productIds;
    return posStore.report(from, to, unit, filter);
  });

  app.get("/api/v2/pos/waste", async (request) => {
    assertPosRole(request.actor);
    const query = request.query as { storeId?: string; date?: string };
    if (!query.storeId) throw new PosDomainError("STORE_REQUIRED", "storeId가 필요합니다.", 422);
    const date = dateOnly.test(query.date ?? "") ? query.date! : seoulToday();
    return posStore.wasteReport(query.storeId, date);
  });

  /* ── 오픈 프로세스 (V1 이식 5단계) ── */
  const openingStore = createOpeningStore(env);
  app.addHook("onClose", async () => { await openingStore.close(); });
  const STAGES: OpeningStage[] = ["상담중", "진행", "보류", "완료"];

  app.get("/api/v2/openings", async (request) => {
    assertPosRole(request.actor);
    const openings = await openingStore.list();
    const board: Record<string, unknown[]> = { 상담중: [], 진행: [], 보류: [], 완료: [] };
    for (const opening of openings) (board[opening.stage] ??= []).push(opening);
    return {
      openings, board,
      kpi: {
        active: openings.filter((o) => o.stage === "진행").length,
        overdue: openings.reduce((acc, o) => acc + o.overdue, 0),
        within30Days: openings.filter((o) => o.stage === "진행" && o.dDay >= 0 && o.dDay <= 30).length,
      },
    };
  });

  app.post("/api/v2/openings", async (request, reply) => {
    assertPosRole(request.actor);
    const body = request.body as {
      name?: string; region?: string | null; openDate?: string;
      mode?: string; storeType?: string; stage?: string; memo?: string;
    };
    if (!body?.name?.trim()) throw new PosDomainError("OPENING_NAME_REQUIRED", "매장명이 필요합니다.", 422);
    if (!dateOnly.test(body.openDate ?? "")) throw new PosDomainError("OPENING_DATE_REQUIRED", "오픈일(YYYY-MM-DD)이 필요합니다.", 422);
    const opening = await openingStore.create({
      name: body.name.trim(), region: body.region?.trim() || null, openDate: body.openDate!,
      mode: body.mode === "운영대행" ? "운영대행" : "가맹",
      storeType: body.storeType === "포장형" ? "포장형" : "테이블형",
      stage: body.stage === "진행" ? "진행" : "상담중",
      memo: body.memo ?? "",
    });
    reply.code(201);
    return opening;
  });

  app.get("/api/v2/openings/:id", async (request) => {
    assertPosRole(request.actor);
    const detail = await openingStore.get((request.params as { id: string }).id);
    if (!detail) throw new PosDomainError("OPENING_NOT_FOUND", "오픈 프로젝트를 찾을 수 없습니다.", 404);
    return detail;
  });

  app.patch("/api/v2/openings/:id", async (request) => {
    assertPosRole(request.actor);
    const id = (request.params as { id: string }).id;
    const body = request.body as { stage?: string; openDate?: string; storeId?: string };
    if (body.storeId) {
      const confirmed = await openingStore.confirmOpen(id, body.storeId);
      if (!confirmed) throw new PosDomainError("OPENING_NOT_FOUND", "오픈 프로젝트를 찾을 수 없습니다.", 404);
      return confirmed;
    }
    if (body.stage) {
      if (!STAGES.includes(body.stage as OpeningStage)) throw new PosDomainError("BAD_STAGE", "허용되지 않는 단계입니다.", 422);
      const moved = await openingStore.setStage(id, body.stage as OpeningStage);
      if (!moved) throw new PosDomainError("OPENING_NOT_FOUND", "오픈 프로젝트를 찾을 수 없습니다.", 404);
      return moved;
    }
    if (dateOnly.test(body.openDate ?? "")) {
      const moved = await openingStore.reschedule(id, body.openDate!);
      if (!moved) throw new PosDomainError("OPENING_NOT_FOUND", "오픈 프로젝트를 찾을 수 없습니다.", 404);
      return moved;
    }
    throw new PosDomainError("NOTHING_TO_UPDATE", "stage, openDate, storeId 중 하나가 필요합니다.", 422);
  });

  app.post("/api/v2/openings/:id/tasks", async (request, reply) => {
    assertPosRole(request.actor);
    const body = request.body as { phase?: string; group?: string; title?: string; detail?: string; owner?: string; dayOffset?: number };
    if (!body?.title?.trim()) throw new PosDomainError("TASK_TITLE_REQUIRED", "항목명이 필요합니다.", 422);
    const phase = OPENING_PHASES.includes(body.phase as OpeningPhase) ? (body.phase as OpeningPhase) : "D-1주차";
    const task = await openingStore.addTask((request.params as { id: string }).id, {
      phase, group: body.group?.trim() || "추가 항목", title: body.title.trim(),
      detail: body.detail ?? "", owner: body.owner === "hq" ? "hq" : body.owner === "both" ? "both" : "pt",
      dayOffset: typeof body.dayOffset === "number" ? body.dayOffset : -7,
    });
    if (!task) throw new PosDomainError("OPENING_NOT_FOUND", "오픈 프로젝트를 찾을 수 없습니다.", 404);
    reply.code(201);
    return task;
  });

  app.patch("/api/v2/openings/tasks/:taskId", async (request) => {
    assertPosRole(request.actor);
    const body = request.body as { done?: boolean; memo?: string };
    const actorId = (request.actor as { id?: string } | undefined)?.id ?? null;
    const updated = await openingStore.toggleTask(
      (request.params as { taskId: string }).taskId, body.done === true, actorId, body.memo);
    if (!updated) throw new PosDomainError("TASK_NOT_FOUND", "항목을 찾을 수 없습니다.", 404);
    return { ok: true };
  });

  app.post("/api/v2/webhooks/tossplace", async (request) => {
    const payload = request.body as { merchantId?: unknown } | null;
    await posStore.recordWebhookInbox("tossplace", payload);
    const merchantId = payload && typeof payload.merchantId !== "undefined" ? String(payload.merchantId) : null;
    const known = merchantId ? await posStore.findLinkByMerchant(merchantId) : null;
    return { ok: true, merchantId, known: Boolean(known) };
  });

  app.post("/api/v2/webhooks/popbill", async (request, reply) => {
    if (config.appMode === "production" && config.providerMode !== "production") {
      throw new DomainError("NOT_FOUND", "경로를 찾을 수 없습니다.", 404);
    }
    verifyWebhookApiKey(request, config.popbillWebhookApiKey, config.appMode === "production");
    const mid = String(request.headers["pb-webhook-mid"] ?? "");
    const corpNum = String(request.headers["pb-webhook-corpnum"] ?? "");
    if (!mid) throw new DomainError("WEBHOOK_MID_REQUIRED", "Pb-Webhook-MID 헤더가 필요합니다.", 400);
    if (!corpNum) throw new DomainError("WEBHOOK_CORP_REQUIRED", "Pb-Webhook-Corpnum 헤더가 필요합니다.", 400);
    const bodies = normalizePopbillWebhookBodies(request.body);
    const headquarters = (await repository.list<{ businessNumber: string; isHeadquarters: boolean }>("legal_entity"))
      .find((entity) => entity.isHeadquarters);
    invariantHeadquarters(headquarters);
    const headquartersNumber = headquarters.businessNumber.replaceAll("-", "");
    if (corpNum.replaceAll("-", "") !== headquartersNumber
      || bodies.some((payload) => typeof payload.corpNum === "string" && payload.corpNum.replaceAll("-", "") !== headquartersNumber)) {
      throw new DomainError("WEBHOOK_CORP_MISMATCH", "다른 사업자의 Webhook은 처리할 수 없습니다.", 403);
    }
    const result = await service.receivePopbillWebhook(mid, { headers: { mid, corpNum }, bodies });
    return reply.code(result.accepted ? 202 : 200).send(result);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({ error: { code: "VALIDATION_ERROR", message: "입력값을 확인해 주세요.", details: error.issues, requestId: request.id } });
    }
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details, requestId: request.id } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "처리 중 오류가 발생했습니다.", requestId: request.id } });
  });
  app.addHook("onClose", async () => repository.close());
  return app;
}

function verifyWebhookApiKey(request: FastifyRequest, apiKey: string | undefined, required: boolean): void {
  if (!apiKey) {
    if (required) throw new DomainError("WEBHOOK_API_KEY_MISSING", "POPBILL_WEBHOOK_API_KEY가 필요합니다.", 503);
    return;
  }
  const received = String(request.headers["x-api-key"] ?? "");
  const expected = createHmac("sha256", apiKey).update("ofd-popbill-webhook").digest();
  const actual = createHmac("sha256", received).update("ofd-popbill-webhook").digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new DomainError("INVALID_WEBHOOK_SIGNATURE", "Webhook 서명이 올바르지 않습니다.", 401);
}

function invariantHeadquarters(value: { businessNumber: string } | undefined): asserts value is { businessNumber: string } {
  if (!value) throw new DomainError("HQ_BUSINESS_MISSING", "본사 사업자 정보가 없습니다.", 503);
}

function setSessionCookie(reply: import("fastify").FastifyReply, token: string, appMode: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: appMode === "production", sameSite: "strict", path: "/", maxAge: 8 * 60 * 60 });
}

function normalizePopbillWebhookBodies(value: unknown): Array<Record<string, unknown>> {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length < 1 || entries.length > 500) {
    throw new DomainError("INVALID_WEBHOOK_BODY", "Webhook 본문은 1~500개의 이벤트여야 합니다.", 422);
  }
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError("INVALID_WEBHOOK_BODY", "Webhook 이벤트 본문이 올바르지 않습니다.", 422);
    }
    const outer = entry as Record<string, unknown>;
    const body = outer.body;
    if (body !== undefined) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new DomainError("INVALID_WEBHOOK_BODY", "Webhook body 객체가 올바르지 않습니다.", 422);
      }
      return body as Record<string, unknown>;
    }
    return outer;
  });
}
