import { createHmac, timingSafeEqual } from "node:crypto";
import { DEMO_IDS, type StateRepository } from "@ofd/db";
import { DomainError, type Actor } from "@ofd/domain";
import type { FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
    /** 현재 요청의 세션이 자동 로그인(rememberMe)으로 발급됐는지 — 세션 갱신 시 유지 기간 승계에 쓴다. */
    sessionRemembered?: boolean;
  }
}

export interface SessionPayload {
  sub: string;
  exp: number;
  iss: "ofd-api";
  aud: "ofd-web";
  sid: string;
  ver: number;
  purpose: "session";
  mfaAt?: string;
  /** 자동 로그인으로 발급된 세션 표시. 스텝업 등 갱신 시 30일 유지를 승계한다. */
  rem?: true;
}

export const SESSION_COOKIE = "ofd_session";

export async function resolveActor(request: FastifyRequest, repository: StateRepository, appMode: string, secret?: string,
  requireTestAuth = false): Promise<Actor> {
  let actorId: string;
  let mfaAtFromSession: string | undefined;
  const sessionRequired = appMode === "production" || (appMode === "test" && requireTestAuth);
  if (!sessionRequired) {
    const requested = request.headers["x-demo-actor-id"];
    actorId = typeof requested === "string" && requested ? requested : DEMO_IDS.owner;
  } else {
    if (!secret || secret.length < 32) throw new DomainError("SESSION_CONFIG_ERROR", "SESSION_SECRET은 32자 이상이어야 합니다.", 503);
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.cookies?.[SESSION_COOKIE];
    if (!token) throw new DomainError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
    const payload = verifySessionToken(token, secret, "session");
    actorId = payload.sub;
    mfaAtFromSession = payload.mfaAt;
    request.sessionRemembered = payload.rem === true;
  }
  const actor = await repository.get<Actor>("actor", actorId);
  if (!actor) throw new DomainError("UNAUTHENTICATED", "사용자 계정을 찾을 수 없습니다.", 401);
  if (!actor.active) throw new DomainError("ACCOUNT_DISABLED", "비활성화된 계정입니다.", 403);
  if (sessionRequired) {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.cookies?.[SESSION_COOKIE];
    const payload = verifySessionToken(token!, secret!, "session");
    if (payload.ver !== actor.authVersion) throw new DomainError("SESSION_REVOKED", "폐기된 세션입니다. 다시 로그인해 주세요.", 401);
  }
  if (!sessionRequired) return actor;
  const sessionActor: Actor = { ...actor, mfaVerified: Boolean(mfaAtFromSession) };
  if (mfaAtFromSession) sessionActor.mfaVerifiedAt = mfaAtFromSession;
  else delete sessionActor.mfaVerifiedAt;
  return sessionActor;
}

export function signSessionToken(payload: SessionPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `v2.${encoded}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, purpose: SessionPayload["purpose"] = "session"): SessionPayload {
  const [version, encoded, signature] = token.split(".");
  if (version !== "v2" || !encoded || !signature) throw new DomainError("INVALID_SESSION", "세션이 올바르지 않습니다.", 401);
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new DomainError("INVALID_SESSION", "세션이 올바르지 않습니다.", 401);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  if (!payload.sub || payload.iss !== "ofd-api" || payload.aud !== "ofd-web" || !payload.sid || !Number.isInteger(payload.ver) || payload.purpose !== purpose) {
    throw new DomainError("INVALID_SESSION", "세션이 올바르지 않습니다.", 401);
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) throw new DomainError("SESSION_EXPIRED", "세션이 만료되었습니다.", 401);
  return payload;
}
