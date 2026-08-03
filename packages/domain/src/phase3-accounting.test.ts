import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLegalModifiedInvoice,
  assertSettlementPaymentSatisfied,
  isPaymentMatchCandidate,
  nextPaymentDeadline,
  parseHolidayCalendar,
  popbillManagementKey,
  type Store,
  type TaxInvoice,
} from "./index.ts";

const monthlyStore: Store = {
  id: "store-1", code: "STORE-1", name: "월후불점",
  business: { businessNumber: "1111111111", legalName: "월후불점", representativeName: "대표", address: "서울",
    businessType: "음식", businessCategory: "카페", email: "store@example.com" },
  billingCycle: "monthly", paymentMethod: "monthly_credit", notificationPhone: "01000000000", active: true, version: 1,
};

const originalInvoice: TaxInvoice = {
  id: "invoice-1", storeId: monthlyStore.id, settlementId: "settlement-1", invoiceGroupId: "group-1",
  partNumber: 1, partCount: 1, providerManagementKey: "OFD000000000000000000001", issueType: "normal",
  status: "nts_success", serialNumber: "123456789012345678901234", issueDate: "2026-07-31", dueDate: "2026-08-10",
  supplier: monthlyStore.business, recipient: monthlyStore.business, gross: 11_000, supply: 10_000, vat: 1_000,
  preparedBy: "finance-1", lines: [{ id: "line-1", description: "공급", quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000 }], version: 1,
};

test("월후불 정산은 연결된 결제요청이 입금완료여야 검토할 수 있다", () => {
  assert.throws(() => assertSettlementPaymentSatisfied(monthlyStore, "settlement-1", undefined), /PAYMENT_REQUEST_REQUIRED|결제/);
  assert.throws(() => assertSettlementPaymentSatisfied(monthlyStore, "settlement-1", {
    id: "payment-1", storeId: monthlyStore.id, settlementId: "settlement-1", amount: 11_000, dueDate: "2026-08-10",
    status: "pending", depositorHint: "대표", createdAt: "2026-08-01T00:00:00.000Z", version: 1,
  }), /PAYMENT_REQUIRED|입금/);
  assert.doesNotThrow(() => assertSettlementPaymentSatisfied(monthlyStore, "settlement-1", {
    id: "payment-1", storeId: monthlyStore.id, settlementId: "settlement-1", amount: 11_000, dueDate: "2026-08-10",
    status: "paid", depositorHint: "대표", createdAt: "2026-08-01T00:00:00.000Z", version: 2,
  }));
  assert.doesNotThrow(() => assertSettlementPaymentSatisfied({ ...monthlyStore, paymentMethod: "prepaid" }, "settlement-1", undefined));
});

test("자동·수동 매칭 대상은 pending/manual_review만 허용한다", () => {
  assert.equal(isPaymentMatchCandidate("pending"), true);
  assert.equal(isPaymentMatchCandidate("manual_review"), true);
  for (const status of ["matching", "paid", "reversed", "cancelled"] as const) assert.equal(isPaymentMatchCandidate(status), false);
});

test("월후불 납부기한은 다음 달 10일의 휴일·주말을 넘긴 영업일이다", () => {
  assert.equal(nextPaymentDeadline("2026-09-30", (date) => date === "2026-10-12"), "2026-10-13");
});

test("운영 휴일 달력은 명시적인 ISO 날짜 목록만 허용한다", () => {
  const calendar = parseHolidayCalendar("2026-10-09, 2026-10-12", true);
  assert.equal(calendar("2026-10-09"), true);
  assert.equal(calendar("2026-10-10"), false);
  assert.throws(() => parseHolidayCalendar(undefined, true), /HOLIDAY_CALENDAR_REQUIRED|휴일 달력/);
  assert.throws(() => parseHolidayCalendar("", true), /HOLIDAY_CALENDAR_REQUIRED|휴일/);
  assert.throws(() => parseHolidayCalendar("2026-02-30"), /HOLIDAY_CALENDAR_INVALID|유효하지 않은/);
});

test("Popbill 관리키는 최초 발행과 재시도별로 결정적이며 서로 다르다", () => {
  const initial = popbillManagementKey("invoice-1");
  const retry1 = popbillManagementKey("invoice-1", 1);
  assert.equal(popbillManagementKey("invoice-1", 1), retry1);
  assert.notEqual(initial, retry1);
  assert.notEqual(retry1, popbillManagementKey("invoice-1", 2));
  assert.throws(() => popbillManagementKey("invoice-1", -1), /INVALID_RETRY_ATTEMPT|재시도/);
});

test("현재 지원하는 수정세금계산서는 적법한 전액 음수 수정 사유만 허용한다", () => {
  for (const reason of ["03", "04", "06"] as const) assert.doesNotThrow(() => assertLegalModifiedInvoice(originalInvoice, reason));
  for (const reason of ["01", "02", "05"] as const) {
    assert.throws(() => assertLegalModifiedInvoice(originalInvoice, reason), /MODIFICATION_DETAILS_REQUIRED|정정/);
  }
  assert.throws(() => assertLegalModifiedInvoice({ ...originalInvoice, gross: -11_000 }, "03"), /ORIGINAL_INVOICE_AMOUNT_INVALID|양수/);
});
