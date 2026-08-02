import { DomainError, invariant } from "./errors.ts";
import type { Actor, InvoiceStatus, OrderStatus, PaymentStatus, SettlementStatus, ShipmentStatus } from "./types.ts";

const orderTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["change_requested", "approved", "rejected", "cancelled"],
  change_requested: ["submitted", "cancelled"],
  approved: ["cancelled"],
  rejected: [],
  cancelled: [],
};

const shipmentTransitions: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  preparing: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
  delivered: [],
};

const paymentTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["matching", "manual_review", "paid", "cancelled"],
  matching: ["manual_review", "paid", "pending", "cancelled"],
  manual_review: ["paid", "pending", "cancelled"],
  paid: ["reversed"],
  reversed: ["pending", "cancelled"],
  cancelled: [],
};

const settlementTransitions: Record<SettlementStatus, readonly SettlementStatus[]> = {
  open: ["draft"],
  draft: ["reviewed", "open"],
  reviewed: ["approved", "draft"],
  approved: ["locked"],
  locked: [],
};

const invoiceTransitions: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["reviewed", "cancelled"],
  reviewed: ["approved", "draft", "cancelled"],
  approved: ["queued", "cancelled"],
  queued: ["issued", "failed"],
  issued: ["nts_pending", "failed"],
  nts_pending: ["nts_success", "failed", "cancelled"],
  nts_success: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

function assertTransition<T extends string>(machine: string, map: Record<T, readonly T[]>, from: T, to: T): void {
  if (!map[from]?.includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `${machine} 상태를 ${from}에서 ${to}(으)로 변경할 수 없습니다.`, 409, { machine, from, to });
  }
}

export const assertOrderTransition = (from: OrderStatus, to: OrderStatus): void => assertTransition("order", orderTransitions, from, to);
export const assertShipmentTransition = (from: ShipmentStatus, to: ShipmentStatus): void => assertTransition("shipment", shipmentTransitions, from, to);
export const assertPaymentTransition = (from: PaymentStatus, to: PaymentStatus): void => assertTransition("payment", paymentTransitions, from, to);
export const assertSettlementTransition = (from: SettlementStatus, to: SettlementStatus): void => assertTransition("settlement", settlementTransitions, from, to);
export const assertInvoiceTransition = (from: InvoiceStatus, to: InvoiceStatus): void => assertTransition("invoice", invoiceTransitions, from, to);

export function assertRole(actor: Actor, allowed: Actor["role"][]): void {
  invariant(allowed.includes(actor.role), "FORBIDDEN", "이 작업을 수행할 권한이 없습니다.", 403);
}

export function assertStoreScope(actor: Actor, storeId: string): void {
  if (actor.role.startsWith("store_")) {
    invariant(actor.storeIds.includes(storeId), "STORE_SCOPE_DENIED", "다른 매장의 정보에는 접근할 수 없습니다.", 403);
  }
}

export function assertVersion(actual: number, expected: number): void {
  invariant(Number.isInteger(expected), "EXPECTED_VERSION_REQUIRED", "expectedVersion이 필요합니다.", 428);
  invariant(actual === expected, "VERSION_CONFLICT", "다른 사용자가 먼저 변경했습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.", 409);
}

export function assertInvoiceApprovalSegregation(reviewedBy: string | undefined, actor: Actor): void {
  assertRole(actor, ["hq_master"]);
  assertRecentStepUp(actor);
  invariant(Boolean(reviewedBy), "REVIEW_REQUIRED", "재무 검토가 먼저 필요합니다.", 409);
  invariant(reviewedBy !== actor.id, "SEGREGATION_OF_DUTIES", "검토자와 최종 승인자는 서로 달라야 합니다.", 409);
}

export function assertRecentStepUp(actor: Actor, maxAgeMs = 5 * 60_000, now = Date.now()): void {
  const verifiedAt = actor.mfaVerifiedAt ? new Date(actor.mfaVerifiedAt).valueOf() : Number.NaN;
  invariant(actor.mfaVerified && Number.isFinite(verifiedAt) && now - verifiedAt >= 0 && now - verifiedAt <= maxAgeMs,
    "STEP_UP_REQUIRED", "이 작업을 위해 5분 이내 MFA 재인증이 필요합니다.", 403);
}
