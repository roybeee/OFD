import { createHash, randomUUID } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import {
  assertRecentStepUp,
  assertRole,
  DomainError,
  hashPassword,
  invariant,
  verifyPassword,
  type ActorDirectoryEntry,
  type AdminInvariant,
  type AdminActorSummary,
  type Actor,
  type ProvisionableActorRole,
  type PublicActor,
  type Store,
  type UserCredential,
} from "@ofd/domain";
import { audit } from "./events.ts";
import { signSessionToken, type SessionPayload } from "./auth.ts";

const dummyPasswordHash = hashPassword("Dummy-login-2026!", Buffer.alloc(16, 3));

export interface ProvisionActorInput {
  name: string;
  role: ProvisionableActorRole;
  storeIds: string[];
  email: string;
  password: string;
}

type ProvisionableActor = Actor & { role: ProvisionableActorRole };

/** 기본 세션 수명 — 브라우저를 켜 둔 채 근무하는 하루 업무 시간 기준. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** 자동 로그인(rememberMe) 세션 수명 — 개인 기기에서 재로그인 없이 쓰는 기간. */
export const REMEMBER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export class AuthService {
  private readonly rate = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly repository: StateRepository,
    private readonly secret: string,
    private readonly appMode: "demo" | "test" | "production",
    private readonly encryptionKey?: string,
  ) {}

  async login(email: string, password: string, ip: string, rememberMe = false):
    Promise<{ token?: string; mfaRequired: boolean; mustChangePassword: boolean; actor: PublicActor }> {
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
    const token = await this.finishLogin(credential, actor, undefined, rememberMe);
    return { token, mfaRequired: false, mustChangePassword: Boolean(credential.mustChangePassword), actor: publicActor(actor) };
  }

  /** 중요 작업 본인 확인 — MFA 없이 비밀번호만 재확인해 최근 스텝업 세션을 발급한다. */
  async stepUp(actor: Actor, password: string, ip: string, remember = false): Promise<{ token: string; actor: PublicActor }> {
    this.checkRate(`step-up:${actor.id}:${ip}`);
    const credential = await this.credentialForActor(actor.id);
    this.assertCredentialAvailable(credential, actor);
    if (!verifyPassword(password, credential.passwordHash)) {
      await this.recordFailure(credential, actor, "auth.step_up_failed");
      throw new DomainError("INVALID_CREDENTIALS", "비밀번호가 올바르지 않습니다.", 401);
    }
    const stepUpAt = new Date().toISOString();
    const updated: UserCredential = { ...credential, failedAttempts: 0, version: credential.version + 1 };
    delete updated.lockedUntil;
    await this.repository.commit({
      changes: [{ type: "credential", id: credential.id, expectedVersion: credential.version, value: updated }],
      audits: [audit(actor, "credential", credential.id, "auth.step_up_succeeded", undefined, undefined, { actorId: actor.id })],
    });
    return { token: signSessionToken(this.payload(actor, "session", stepUpAt, remember), this.secret), actor: publicActor(actor) };
  }

  /** POST /api/v2/auth/change-password — 본인 비밀번호 변경. 현재 비밀번호 확인 후 전 세션 폐기. */
  async changeOwnPassword(actor: Actor, currentPassword: string, newPassword: string, ip: string,
    remember = false): Promise<{ token: string; actor: PublicActor }> {
    this.checkRate(`change-password:${actor.id}:${ip}`);
    const credential = await this.credentialForActor(actor.id);
    this.assertCredentialAvailable(credential, actor);
    if (!verifyPassword(currentPassword, credential.passwordHash)) {
      await this.recordFailure(credential, actor, "auth.password_change_failed");
      throw new DomainError("INVALID_CREDENTIALS", "현재 비밀번호가 올바르지 않습니다.", 401);
    }
    invariant(!verifyPassword(newPassword, credential.passwordHash), "PASSWORD_UNCHANGED", "새 비밀번호가 기존 비밀번호와 같습니다.", 422);
    const freshActor = await this.requiredActor(actor.id);
    const updatedActor: Actor = { ...freshActor, authVersion: freshActor.authVersion + 1 };
    const updatedCredential: UserCredential = {
      ...credential, passwordHash: hashPassword(newPassword), failedAttempts: 0, version: credential.version + 1,
    };
    delete updatedCredential.lockedUntil;
    delete updatedCredential.mustChangePassword;
    await this.repository.commit({
      changes: [
        { type: "actor", id: freshActor.id, expectedVersion: freshActor.authVersion, value: updatedActor },
        { type: "credential", id: credential.id, expectedVersion: credential.version, value: updatedCredential },
      ],
      audits: [audit(actor, "credential", credential.id, "auth.password_changed", undefined, undefined, { actorId: actor.id })],
    });
    // 새 authVersion으로 세션을 즉시 재발급해 현재 사용자는 로그인 상태를 유지한다(다른 기기 세션만 폐기).
    return { token: signSessionToken(this.payload(updatedActor, "session", undefined, remember), this.secret), actor: publicActor(updatedActor) };
  }

  /** GET /api/v2/admin/actors response. No credential secret or password material is returned. */
  async listActorAccounts(actor: Actor): Promise<{ actors: AdminActorSummary[] }> {
    this.assertMasterStepUp(actor);
    const [actors, credentials] = await Promise.all([
      this.repository.list<Actor>("actor"),
      this.repository.list<UserCredential>("credential"),
    ]);
    const credentialByActor = new Map(credentials.map((credential) => [credential.actorId, credential]));
    return {
      actors: actors
        .filter((candidate) => candidate.role !== "system")
        .flatMap((candidate) => {
          const credential = credentialByActor.get(candidate.id);
          return credential ? [adminActorSummary(candidate, credential)] : [];
        })
        .sort((left, right) => left.name.localeCompare(right.name, "ko")),
    };
  }

  /** GET /api/v2/directory/drivers response. Active delivery identities only. */
  async listActiveDrivers(actor: Actor): Promise<{ drivers: ActorDirectoryEntry[] }> {
    assertRole(actor, ["hq_ops", "hq_master"]);
    const drivers = (await this.repository.list<Actor>("actor"))
      .filter((candidate) => candidate.role === "driver" && candidate.active)
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
    return { drivers };
  }

  /** POST /api/v2/admin/actors. Caller supplies initial secrets over TLS; the response is sanitized. */
  async provisionActor(actor: Actor, input: ProvisionActorInput): Promise<{ actor: AdminActorSummary }> {
    this.assertMasterStepUp(actor);
    invariant(isProvisionableActorRole(input.role), "ACTOR_ROLE_NOT_PROVISIONABLE", "시스템 계정은 생성할 수 없습니다.");
    const name = input.name.trim();
    const email = normalizeEmail(input.email);
    invariant(name.length >= 2 && name.length <= 100, "INVALID_ACTOR_NAME", "계정 이름은 2~100자로 입력해 주세요.");
    await this.assertStoreAssignment(input.role, input.storeIds);
    const existingCredentials = await this.repository.list<UserCredential>("credential");
    invariant(!existingCredentials.some((credential) => credential.email.toLowerCase() === email),
      "EMAIL_ALREADY_REGISTERED", "이미 등록된 이메일입니다.", 409);
    const createdActor: Actor = {
      id: randomUUID(), name, role: input.role, storeIds: [...new Set(input.storeIds)], active: true, authVersion: 1,
    };
    const credential: UserCredential = {
      id: stableCredentialId(email), actorId: createdActor.id, email, passwordHash: hashPassword(input.password),
      failedAttempts: 0, mustChangePassword: true, version: 1,
    };
    await this.repository.commit({
      changes: [
        { type: "actor", id: createdActor.id, expectedVersion: null, value: createdActor },
        { type: "credential", id: credential.id, expectedVersion: null, value: credential },
      ],
      audits: [audit(actor, "actor", createdActor.id, "admin.actor_provisioned", undefined, undefined,
        publicActor(createdActor), { role: createdActor.role })],
    });
    return { actor: adminActorSummary(createdActor, credential) };
  }

  /** PATCH /api/v2/admin/actors action=deactivate. Increments authVersion to revoke all sessions. */
  async deactivateActor(actor: Actor, actorId: string, expectedVersion: number): Promise<{ actor: AdminActorSummary }> {
    this.assertMasterStepUp(actor);
    invariant(actor.id !== actorId, "SELF_DEACTIVATION_DENIED", "현재 사용 중인 관리자 계정은 비활성화할 수 없습니다.", 409);
    const target = await this.requiredActorForAdmin(actorId);
    invariant(target.active, "ACTOR_ALREADY_INACTIVE", "이미 비활성화된 계정입니다.", 409);
    invariant(target.authVersion === expectedVersion, "VERSION_CONFLICT", "계정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.", 409);
    if (target.role === "hq_master") {
      const activeMasters = (await this.repository.list<Actor>("actor"))
        .filter((candidate) => candidate.role === "hq_master" && candidate.active);
      invariant(activeMasters.length > 1, "LAST_MASTER_REQUIRED", "마지막 활성 최고관리자 계정은 비활성화할 수 없습니다.", 409);
    }
    if (target.role === "driver") {
      const activeShipments = (await this.repository.list<{ driverId?: string; status: string }>("shipment"))
        .filter((shipment) => shipment.driverId === target.id && (shipment.status === "preparing" || shipment.status === "out_for_delivery"));
      invariant(activeShipments.length === 0, "DRIVER_HAS_ACTIVE_SHIPMENTS",
        "준비 또는 배송 중인 배정이 있는 기사는 비활성화할 수 없습니다.", 409);
    }
    const credential = await this.credentialForActor(target.id);
    const updated: Actor = { ...target, active: false, authVersion: target.authVersion + 1 };
    const changes: Parameters<StateRepository["commit"]>[0]["changes"] = [
      { type: "actor", id: target.id, expectedVersion, value: updated },
    ];
    const audits = [audit(actor, "actor", target.id, "admin.actor_deactivated", undefined, publicActor(target), publicActor(updated))];
    if (target.role === "driver") {
      const invariantId: AdminInvariant["id"] = `driver-liveness:${target.id}`;
      const currentInvariant = await this.repository.get<AdminInvariant>("admin_invariant", invariantId);
      const nextInvariant: AdminInvariant = { id: invariantId, version: (currentInvariant?.version ?? 0) + 1 };
      changes.push({ type: "admin_invariant", id: invariantId, storeId: "__system__",
        expectedVersion: currentInvariant?.version ?? null, value: nextInvariant });
      audits.push(audit(actor, "admin_invariant", invariantId, "admin.driver_deactivation_serialized", undefined,
        currentInvariant, nextInvariant, { deactivatedDriverId: target.id }));
    }
    if (target.role === "hq_master") {
      const invariantId: AdminInvariant["id"] = "hq-master-liveness";
      const currentInvariant = await this.repository.get<AdminInvariant>("admin_invariant", invariantId);
      const nextInvariant: AdminInvariant = { id: invariantId, version: (currentInvariant?.version ?? 0) + 1 };
      changes.push({ type: "admin_invariant", id: invariantId, storeId: "__system__",
        expectedVersion: currentInvariant?.version ?? null, value: nextInvariant });
      audits.push(audit(actor, "admin_invariant", invariantId, "admin.master_deactivation_serialized", undefined,
        currentInvariant, nextInvariant, { deactivatedMasterId: target.id }));
    }
    changes.sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
    await this.repository.commit({
      changes,
      audits,
    });
    return { actor: adminActorSummary(updated, credential) };
  }

  /** PATCH /api/v2/admin/actors action=role. 계정 유형(역할)과 매장 배정을 바꾸고 전 세션을 폐기한다. */
  async changeActorRole(actor: Actor, actorId: string, expectedVersion: number, role: ProvisionableActorRole,
    storeIds: string[]): Promise<{ actor: AdminActorSummary }> {
    this.assertMasterStepUp(actor);
    invariant(isProvisionableActorRole(role), "ACTOR_ROLE_NOT_PROVISIONABLE", "시스템 계정 유형으로는 바꿀 수 없습니다.");
    invariant(actor.id !== actorId, "SELF_ROLE_CHANGE_DENIED", "현재 사용 중인 관리자 계정의 유형은 바꿀 수 없습니다.", 409);
    const target = await this.requiredActorForAdmin(actorId);
    invariant(target.authVersion === expectedVersion, "VERSION_CONFLICT", "계정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.", 409);
    invariant(target.role !== role || !sameStoreAssignment(target.storeIds, storeIds), "ROLE_UNCHANGED", "변경할 내용이 없습니다.", 409);
    await this.assertStoreAssignment(role, storeIds);

    /* 마지막 활성 최고관리자를 다른 유형으로 강등하면 관리 주체가 사라진다 */
    if (target.role === "hq_master" && role !== "hq_master") {
      const activeMasters = (await this.repository.list<Actor>("actor"))
        .filter((candidate) => candidate.role === "hq_master" && candidate.active);
      invariant(activeMasters.length > 1, "LAST_MASTER_REQUIRED", "마지막 활성 최고관리자의 계정 유형은 바꿀 수 없습니다.", 409);
    }
    /* 배송 중인 기사를 다른 유형으로 바꾸면 배정이 고아가 된다 */
    if (target.role === "driver" && role !== "driver") {
      const activeShipments = (await this.repository.list<{ driverId?: string; status: string }>("shipment"))
        .filter((shipment) => shipment.driverId === target.id && (shipment.status === "preparing" || shipment.status === "out_for_delivery"));
      invariant(activeShipments.length === 0, "DRIVER_HAS_ACTIVE_SHIPMENTS",
        "준비 또는 배송 중인 배정이 있는 기사는 계정 유형을 바꿀 수 없습니다.", 409);
    }

    const credential = await this.credentialForActor(target.id);
    const updated: Actor = { ...target, role, storeIds: [...new Set(storeIds)], authVersion: target.authVersion + 1 };
    await this.repository.commit({
      changes: [{ type: "actor", id: target.id, expectedVersion, value: updated }],
      audits: [audit(actor, "actor", target.id, "admin.actor_role_changed", undefined,
        publicActor(target), publicActor(updated), { from: target.role, to: role })],
    });
    return { actor: adminActorSummary(updated, credential) };
  }

  /** PATCH /api/v2/admin/actors action=reset. 비밀번호를 재설정하고 남은 MFA 흔적을 제거하며 전 세션을 폐기한다. */
  async resetActor(actor: Actor, actorId: string, expectedVersion: number, newPassword: string): Promise<{ actor: AdminActorSummary }> {
    this.assertMasterStepUp(actor);
    const target = await this.requiredActorForAdmin(actorId);
    invariant(target.authVersion === expectedVersion, "VERSION_CONFLICT", "계정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.", 409);
    const credential = await this.credentialForActor(target.id);
    const updatedActor: Actor = { ...target, authVersion: target.authVersion + 1 };
    const updatedCredential: UserCredential = {
      ...credential, passwordHash: hashPassword(newPassword), failedAttempts: 0,
      mustChangePassword: true, version: credential.version + 1,
    };
    delete updatedCredential.lockedUntil;
    delete updatedCredential.mfaSecretEncrypted;
    await this.repository.commit({
      changes: [
        { type: "actor", id: target.id, expectedVersion, value: updatedActor },
        { type: "credential", id: credential.id, expectedVersion: credential.version, value: updatedCredential },
      ],
      audits: [audit(actor, "actor", target.id, "admin.actor_credentials_reset", undefined,
        publicActor(target), publicActor(updatedActor), {})],
    });
    return { actor: adminActorSummary(updatedActor, updatedCredential) };
  }

  private async finishLogin(credential: UserCredential, actor: Actor, mfaAt?: string, remember = false): Promise<string> {
    const now = new Date().toISOString();
    const updated: UserCredential = { ...credential, failedAttempts: 0, lastLoginAt: now, version: credential.version + 1 };
    delete updated.lockedUntil;
    await this.repository.commit({
      changes: [{ type: "credential", id: credential.id, expectedVersion: credential.version, value: updated }],
      audits: [audit(actor, "credential", credential.id, "auth.login_succeeded", undefined, undefined, { actorId: actor.id })],
    });
    return signSessionToken(this.payload(actor, "session", mfaAt, remember), this.secret);
  }

  private async recordFailure(credential: UserCredential, actor: Actor, failureAction = "auth.login_failed"): Promise<void> {
    let current = credential;
    for (let conflictRetries = 0; conflictRetries < 128; conflictRetries += 1) {
      const failedAttempts = current.failedAttempts + 1;
      const updated: UserCredential = { ...current, failedAttempts, version: current.version + 1,
        ...(failedAttempts >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() } : {}) };
      try {
        await this.repository.commit({
          changes: [{ type: "credential", id: current.id, expectedVersion: current.version, value: updated }],
          audits: [audit(actor, "credential", current.id, failedAttempts >= 5 ? "auth.account_locked" : failureAction, undefined,
            undefined, { actorId: actor.id, failedAttempts })],
        });
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "VERSION_CONFLICT") throw error;
        // Another failure won the compare-and-swap. Reload its count and add this attempt instead of dropping it.
        current = await this.credentialForActor(actor.id);
      }
    }
    throw new DomainError("AUTH_FAILURE_COUNT_BUSY", "로그인 실패 기록이 혼잡합니다. 잠시 후 다시 시도해 주세요.", 503);
  }

  private payload(actor: Actor, purpose: SessionPayload["purpose"], mfaAt?: string, remember = false): SessionPayload {
    const expiresInSeconds = remember ? REMEMBER_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS;
    return { sub: actor.id, exp: Math.floor(Date.now() / 1_000) + expiresInSeconds, iss: "ofd-api", aud: "ofd-web",
      sid: randomUUID(), ver: actor.authVersion, purpose, ...(mfaAt ? { mfaAt } : {}), ...(remember ? { rem: true as const } : {}) };
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

  private assertCredentialAvailable(credential: UserCredential, actor: Actor): void {
    if (!actor.active) throw new DomainError("ACCOUNT_DISABLED", "비활성화된 계정입니다.", 403);
    if (credential.lockedUntil && new Date(credential.lockedUntil) > new Date()) {
      throw new DomainError("ACCOUNT_LOCKED", "로그인 실패가 반복되어 계정이 잠겼습니다. 잠시 후 다시 시도해 주세요.", 423);
    }
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

  private assertMasterStepUp(actor: Actor): void {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
  }

  private async requiredActorForAdmin(actorId: string): Promise<ProvisionableActor> {
    const target = await this.repository.get<Actor>("actor", actorId);
    if (!target || !isProvisionableActor(target)) throw new DomainError("ACTOR_NOT_FOUND", "계정을 찾을 수 없습니다.", 404);
    return target;
  }

  private async assertStoreAssignment(role: ProvisionableActorRole, rawStoreIds: string[]): Promise<void> {
    const storeIds = [...new Set(rawStoreIds)];
    if (role === "store_owner" || role === "store_staff") {
      invariant(storeIds.length > 0, "STORE_ASSIGNMENT_REQUIRED", "점주 및 매장 직원 계정에는 매장 배정이 필요합니다.");
      const stores = await Promise.all(storeIds.map((storeId) => this.repository.get<Store>("store", storeId)));
      invariant(stores.every((store) => store?.active), "INVALID_STORE_ASSIGNMENT", "운영 중인 매장만 배정할 수 있습니다.", 409);
      return;
    }
    invariant(storeIds.length === 0, "STORE_ASSIGNMENT_NOT_ALLOWED", "본사·감사·배송 계정에는 매장을 배정할 수 없습니다.");
  }
}

function publicActor(actor: Actor): PublicActor {
  return { id: actor.id, name: actor.name, role: actor.role, storeIds: actor.storeIds };
}

function isProvisionableActor(actor: Actor): actor is ProvisionableActor {
  return isProvisionableActorRole(actor.role);
}

function isProvisionableActorRole(role: Actor["role"]): role is ProvisionableActorRole {
  return role !== "system";
}

function adminActorSummary(actor: Actor, credential: UserCredential): AdminActorSummary {
  return {
    ...publicActor(actor), active: actor.active, version: actor.authVersion, email: credential.email,
    ...(credential.lastLoginAt ? { lastLoginAt: credential.lastLoginAt } : {}),
    ...(credential.lockedUntil ? { lockedUntil: credential.lockedUntil } : {}),
  };
}

function sameStoreAssignment(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stableCredentialId(email: string): string {
  const digest = createHash("sha256").update(`ofd-credential:${email}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
