import { randomUUID } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import {
  decryptMfaSecret,
  DomainError,
  hashPassword,
  invariant,
  verifyPassword,
  verifyTotp,
  type Actor,
  type UserCredential,
} from "@ofd/domain";
import { audit } from "./events.ts";
import { signSessionToken, verifySessionToken, type SessionPayload } from "./auth.ts";

const dummyPasswordHash = hashPassword("Dummy-login-2026!", Buffer.alloc(16, 3));

export class AuthService {
  private readonly rate = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly repository: StateRepository,
    private readonly secret: string,
    private readonly appMode: "demo" | "test" | "production",
    private readonly encryptionKey?: string,
  ) {}

  async login(email: string, password: string, ip: string): Promise<{ token?: string; mfaRequired: boolean; challengeToken?: string; actor: PublicActor }> {
    this.checkRate(`${ip}:${email.toLowerCase()}`);
    const credential = (await this.repository.list<UserCredential>("credential"))
      .find((item) => item.email.toLowerCase() === email.trim().toLowerCase());
    const passwordOk = verifyPassword(password, credential?.passwordHash ?? dummyPasswordHash);
    if (!credential) throw new DomainError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", 401);
    const actor = await this.requiredActor(credential.actorId);
    if (credential.lockedUntil && new Date(credential.lockedUntil) > new Date()) {
      throw new DomainError("ACCOUNT_LOCKED", "로그인 실패가 반복되어 계정이 잠겼습니다. 잠시 후 다시 시도해 주세요.", 423);
    }
    if (!passwordOk) {
      await this.recordFailure(credential, actor);
      throw new DomainError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", 401);
    }
    if (!actor.active) throw new DomainError("ACCOUNT_DISABLED", "비활성화된 계정입니다.", 403);
    const needsMfa = actor.role.startsWith("hq_") || actor.role === "auditor";
    if (needsMfa) {
      invariant(Boolean(credential.mfaSecretEncrypted), "MFA_NOT_ENROLLED", "본사 계정에 MFA가 등록되지 않았습니다.", 403);
      const challengeToken = signSessionToken(this.payload(actor, "mfa_challenge", undefined, 5 * 60), this.secret);
      return { mfaRequired: true, challengeToken, actor: publicActor(actor) };
    }
    const token = await this.finishLogin(credential, actor);
    return { token, mfaRequired: false, actor: publicActor(actor) };
  }

  async completeMfa(challengeToken: string, code: string): Promise<{ token: string; actor: PublicActor }> {
    const payload = verifySessionToken(challengeToken, this.secret, "mfa_challenge");
    const actor = await this.requiredActor(payload.sub);
    invariant(payload.ver === actor.authVersion, "SESSION_REVOKED", "폐기된 로그인 요청입니다.", 401);
    const credential = await this.credentialForActor(actor.id);
    const secret = decryptMfaSecret(credential.mfaSecretEncrypted ?? "", this.encryptionKey, this.appMode !== "production");
    if (!verifyTotp(code, secret)) {
      await this.recordFailure(credential, actor);
      throw new DomainError("INVALID_MFA_CODE", "인증 코드가 올바르지 않습니다.", 401);
    }
    return { token: await this.finishLogin(credential, actor, new Date().toISOString()), actor: publicActor(actor) };
  }

  async stepUp(actor: Actor, password: string, code: string): Promise<{ token: string; actor: PublicActor }> {
    const credential = await this.credentialForActor(actor.id);
    invariant(verifyPassword(password, credential.passwordHash), "INVALID_CREDENTIALS", "비밀번호가 올바르지 않습니다.", 401);
    const secret = decryptMfaSecret(credential.mfaSecretEncrypted ?? "", this.encryptionKey, this.appMode !== "production");
    invariant(verifyTotp(code, secret), "INVALID_MFA_CODE", "인증 코드가 올바르지 않습니다.", 401);
    const mfaAt = new Date().toISOString();
    return { token: signSessionToken(this.payload(actor, "session", mfaAt), this.secret), actor: publicActor(actor) };
  }

  private async finishLogin(credential: UserCredential, actor: Actor, mfaAt?: string): Promise<string> {
    const now = new Date().toISOString();
    const updated: UserCredential = { ...credential, failedAttempts: 0, lastLoginAt: now, version: credential.version + 1 };
    delete updated.lockedUntil;
    await this.repository.commit({
      changes: [{ type: "credential", id: credential.id, expectedVersion: credential.version, value: updated }],
      audits: [audit(actor, "credential", credential.id, "auth.login_succeeded", undefined, undefined, { actorId: actor.id })],
    });
    return signSessionToken(this.payload(actor, "session", mfaAt), this.secret);
  }

  private async recordFailure(credential: UserCredential, actor: Actor): Promise<void> {
    const failedAttempts = credential.failedAttempts + 1;
    const updated: UserCredential = { ...credential, failedAttempts, version: credential.version + 1,
      ...(failedAttempts >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() } : {}) };
    await this.repository.commit({
      changes: [{ type: "credential", id: credential.id, expectedVersion: credential.version, value: updated }],
      audits: [audit(actor, "credential", credential.id, failedAttempts >= 5 ? "auth.account_locked" : "auth.login_failed", undefined,
        undefined, { actorId: actor.id, failedAttempts })],
    });
  }

  private payload(actor: Actor, purpose: SessionPayload["purpose"], mfaAt?: string, expiresInSeconds = 8 * 60 * 60): SessionPayload {
    return { sub: actor.id, exp: Math.floor(Date.now() / 1_000) + expiresInSeconds, iss: "ofd-api", aud: "ofd-web",
      sid: randomUUID(), ver: actor.authVersion, purpose, ...(mfaAt ? { mfaAt } : {}) };
  }

  private checkRate(key: string): void {
    const now = Date.now();
    const current = this.rate.get(key);
    if (!current || current.resetAt <= now) {
      this.rate.set(key, { count: 1, resetAt: now + 10 * 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > 20) throw new DomainError("RATE_LIMITED", "로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", 429);
  }

  private async credentialForActor(actorId: string): Promise<UserCredential> {
    const credential = (await this.repository.list<UserCredential>("credential")).find((item) => item.actorId === actorId);
    if (!credential) throw new DomainError("CREDENTIAL_NOT_FOUND", "로그인 자격정보를 찾을 수 없습니다.", 401);
    return credential;
  }

  private async requiredActor(actorId: string): Promise<Actor> {
    const actor = await this.repository.get<Actor>("actor", actorId);
    if (!actor) throw new DomainError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", 401);
    return actor;
  }
}

export type PublicActor = Pick<Actor, "id" | "name" | "role" | "storeIds">;
function publicActor(actor: Actor): PublicActor {
  return { id: actor.id, name: actor.name, role: actor.role, storeIds: actor.storeIds };
}
