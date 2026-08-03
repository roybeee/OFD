import { invariant } from "./errors.ts";
import { createHash } from "node:crypto";
import type { LegalEntitySnapshot, OrderSource, PaymentRequest, PaymentStatus, Store, TaxInvoice } from "./types.ts";

export function invoiceIssueType(supplier: LegalEntitySnapshot, store: Store): "normal" | "internal_statement" {
  return supplier.businessNumber.replaceAll("-", "") === store.business.businessNumber.replaceAll("-", "")
    ? "internal_statement"
    : "normal";
}

export function assertInvoiceEligible(source: OrderSource): void {
  invariant(source !== "legacy_unverified", "LEGACY_NOT_INVOICEABLE", "검증되지 않은 과거 주문은 자동 세금계산서 대상에서 제외됩니다.", 409);
}

export type HolidayCalendar = (isoDate: string) => boolean;

export function parseHolidayCalendar(value: string | undefined, required = false): HolidayCalendar {
  invariant(value !== undefined || !required, "HOLIDAY_CALENDAR_REQUIRED",
    "운영 환경에는 KOREA_HOLIDAYS 휴일 달력이 필요합니다.", 503);
  const holidays = new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  invariant(holidays.size > 0 || !required, "HOLIDAY_CALENDAR_REQUIRED",
    "운영 환경의 KOREA_HOLIDAYS는 하나 이상의 휴일을 포함해야 합니다.", 503);
  for (const holiday of holidays) {
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(holiday), "HOLIDAY_CALENDAR_INVALID",
      "KOREA_HOLIDAYS는 YYYY-MM-DD 형식의 쉼표 구분 목록이어야 합니다.", 503);
    const parsed = new Date(`${holiday}T00:00:00.000Z`);
    invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === holiday,
      "HOLIDAY_CALENDAR_INVALID", "KOREA_HOLIDAYS에 유효하지 않은 날짜가 있습니다.", 503);
  }
  return (isoDate: string) => holidays.has(isoDate);
}

export function nextInvoiceDeadline(periodEnd: string, isHoliday: HolidayCalendar = () => false): string {
  const end = new Date(`${periodEnd}T00:00:00.000Z`);
  invariant(!Number.isNaN(end.valueOf()), "INVALID_DATE", "정산 종료일이 올바르지 않습니다.");
  const deadline = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 10));
  while (deadline.getUTCDay() === 6 || deadline.getUTCDay() === 0 || isHoliday(deadline.toISOString().slice(0, 10))) {
    deadline.setUTCDate(deadline.getUTCDate() + 1);
  }
  return deadline.toISOString().slice(0, 10);
}

/** Monthly-credit collection and invoice issuance use the same next-month statutory business-day calendar. */
export const nextPaymentDeadline = nextInvoiceDeadline;

export function isPaymentMatchCandidate(status: PaymentStatus): boolean {
  return status === "pending" || status === "manual_review";
}

/** Prepaid stores are already gated before dispatch; monthly-credit stores must pay the settlement request before review/approval. */
export function assertSettlementPaymentSatisfied(store: Store, settlementId: string, request: PaymentRequest | undefined): void {
  if (store.paymentMethod !== "monthly_credit") return;
  invariant(request?.settlementId === settlementId, "SETTLEMENT_PAYMENT_REQUEST_REQUIRED", "정산에 연결된 월후불 결제요청이 필요합니다.", 409);
  invariant(request.status === "paid", "SETTLEMENT_PAYMENT_REQUIRED", "월후불 입금 완료 후 정산을 검토하거나 승인할 수 있습니다.", 409);
}

/**
 * The current API creates a full negative reversal. Korean modified-tax-invoice reasons 03, 04 and 06 support that shape.
 * Reasons 01, 02 and 05 require corrected dates/amounts or replacement lines and are rejected until supplied explicitly.
 */
export function assertLegalModifiedInvoice(original: TaxInvoice,
  reasonCode: NonNullable<TaxInvoice["modificationReasonCode"]>): void {
  invariant(original.issueType === "normal", "ORIGINAL_INVOICE_TYPE_INVALID", "정상 세금계산서만 수정할 수 있습니다.", 409);
  invariant(original.status === "nts_success", "ORIGINAL_NOT_NTS_SUCCESS", "국세청 전송 성공 세금계산서만 수정할 수 있습니다.", 409);
  invariant(Boolean(original.serialNumber && /^\d{24}$/.test(original.serialNumber)), "ORIGINAL_NTS_NUMBER_REQUIRED",
    "원본의 24자리 국세청 승인번호가 필요합니다.", 409);
  invariant(original.gross > 0 && original.supply >= 0 && original.vat >= 0 && original.gross === original.supply + original.vat,
    "ORIGINAL_INVOICE_AMOUNT_INVALID", "수정 대상 원본 금액은 합계가 일치하는 양수여야 합니다.", 409);
  invariant(new Set(["03", "04", "06"]).has(reasonCode), "MODIFICATION_DETAILS_REQUIRED",
    `수정 사유 ${reasonCode}에는 정정 공급일·금액·품목 정보가 필요합니다.`, 422);
}

export function popbillManagementKey(invoiceId: string, retryAttempt = 0): string {
  invariant(invoiceId.length > 0, "INVALID_INVOICE_ID", "세금계산서 ID가 필요합니다.");
  invariant(Number.isSafeInteger(retryAttempt) && retryAttempt >= 0, "INVALID_RETRY_ATTEMPT", "재시도 횟수가 올바르지 않습니다.");
  const seed = retryAttempt === 0 ? invoiceId : `${invoiceId}:retry:${retryAttempt}`;
  return `OFD${createHash("sha256").update(seed).digest("hex").slice(0, 21)}`;
}
