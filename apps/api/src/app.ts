import { createHmac, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { createRepository, type StateRepository } from "@ofd/db";
import { assertEncryptionKey, DomainError } from "@ofd/domain";
import {
  createObjectStorage,
  readProviderConfig,
  type ObjectStorage,
} from "@ofd/integrations";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { resolveActor } from "./auth.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { AuthService } from "./auth-service.ts";
import { idempotentMutation } from "./idempotency.ts";
import { ProcurementService } from "./service.ts";

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  repository?: StateRepository;
  storage?: ObjectStorage;
  logger?: boolean;
}

const idParams = z.object({ id: z.string().min(1) });
const expectedVersion = z.object({ expectedVersion: z.number().int().positive() });

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config = readProviderConfig(env);
  const repository = options.repository ?? createRepository(env);
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
    config.providerMode, config.providerMode === "production" && config.taxInvoiceEnabled);
  const sessionSecret = env.SESSION_SECRET ?? "ofd-demo-session-secret-32-characters-minimum";
  const authService = new AuthService(repository, sessionSecret, config.appMode, env.ENCRYPTION_KEY);
  const app = Fastify({ logger: options.logger ?? env.LOG_LEVEL !== "silent", bodyLimit: config.uploadMaxBytes, trustProxy: true });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.appMode === "production" ? (env.WEB_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean) : true,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-demo-actor-id", "x-api-key", "pb-webhook-mid", "pb-webhook-corpnum"],
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
    if (path === "/api/v2/health" || path === "/api/v2/auth/login" || path === "/api/v2/auth/mfa"
      || path === "/api/v2/webhooks/popbill" || path === "/api/v2/mock-uploads" || path === "/api/v2/mock-files") return;
    request.actor = await resolveActor(request, repository, config.appMode, sessionSecret);
  });

  app.get("/api/v2/health", async () => ({ ok: true, mode: config.appMode, providerMode: config.providerMode, now: new Date().toISOString() }));
  app.post("/api/v2/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).parse(request.body);
    const result = await authService.login(body.email, body.password, request.ip);
    if (result.token) setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: Boolean(result.token), mfaRequired: result.mfaRequired, challengeToken: result.challengeToken, actor: result.actor };
  });
  app.post("/api/v2/auth/mfa", async (request, reply) => {
    const body = z.object({ challengeToken: z.string().min(20), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const result = await authService.completeMfa(body.challengeToken, body.code);
    setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: true, actor: result.actor };
  });
  app.post("/api/v2/auth/step-up", async (request, reply) => {
    const body = z.object({ password: z.string().min(1).max(200), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const result = await authService.stepUp(request.actor, body.password, body.code);
    setSessionCookie(reply, result.token, config.appMode);
    return { authenticated: true, mfaVerifiedAt: new Date().toISOString(), actor: result.actor };
  });
  app.post("/api/v2/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
  app.get("/api/v2/bootstrap", async (request) => service.bootstrap(request.actor));

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
    const body = z.object({ orderId: z.string().min(1), driverId: z.string().min(1), plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.body);
    return idempotentMutation(request, reply, repository, request.actor, 201,
      (scoped) => service.withRepository(scoped).createShipment(request.actor, body.orderId, body.driverId, body.plannedDate));
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
      capturedAt: z.string().datetime(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
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
  app.post("/api/v2/admin/outbox/:id/requeue", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return idempotentMutation(request, reply, repository, request.actor, 200,
      (scoped) => service.withRepository(scoped).requeueDeadLetter(request.actor, id));
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
