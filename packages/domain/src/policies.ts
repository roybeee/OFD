import { invariant } from "./errors.ts";
import { createHash } from "node:crypto";
import type { LegalEntitySnapshot, OrderSource, Store } from "./types.ts";

export function invoiceIssueType(supplier: LegalEntitySnapshot, store: Store): "normal" | "internal_statement" {
  return supplier.businessNumber.replaceAll("-", "") === store.business.businessNumber.replaceAll("-", "")
    ? "internal_statement"
    : "normal";
}

export function assertInvoiceEligible(source: OrderSource): void {
  invariant(source !== "legacy_unverified", "LEGACY_NOT_INVOICEABLE", "검증되지 않은 과거 주문은 자동 세금계산서 대상에서 제외됩니다.", 409);
}

export type HolidayCalendar = (isoDate: string) => boolean;

export function nextInvoiceDeadline(periodEnd: string, isHoliday: HolidayCalendar = () => false): string {
  const end = new Date(`${periodEnd}T00:00:00.000Z`);
  invariant(!Number.isNaN(end.valueOf()), "INVALID_DATE", "정산 종료일이 올바르지 않습니다.");
  const deadline = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 10));
  while (deadline.getUTCDay() === 6 || deadline.getUTCDay() === 0 || isHoliday(deadline.toISOString().slice(0, 10))) {
    deadline.setUTCDate(deadline.getUTCDate() + 1);
  }
  return deadline.toISOString().slice(0, 10);
}

export function popbillManagementKey(invoiceId: string): string {
  invariant(invoiceId.length > 0, "INVALID_INVOICE_ID", "세금계산서 ID가 필요합니다.");
  return `OFD${createHash("sha256").update(invoiceId).digest("hex").slice(0, 21)}`;
}
