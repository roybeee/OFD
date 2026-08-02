import assert from "node:assert/strict";
import test from "node:test";
import { assertInvoiceApprovalSegregation, assertInvoiceTransition, assertOrderTransition, assertShipmentTransition } from "./transitions.ts";
import { popbillManagementKey } from "./policies.ts";

test("주문은 점주 제출 후 본사 승인을 거친다", () => {
  assert.doesNotThrow(() => assertOrderTransition("draft", "submitted"));
  assert.doesNotThrow(() => assertOrderTransition("submitted", "approved"));
  assert.throws(() => assertOrderTransition("draft", "approved"), /변경할 수 없습니다/);
});

test("Popbill 관리키는 같은 invoice ID에 안정적이고 24자를 넘지 않는다", () => {
  const first = popbillManagementKey("00000000-0000-4000-8000-000000008001");
  assert.equal(first, popbillManagementKey("00000000-0000-4000-8000-000000008001"));
  assert.equal(first.length, 24);
  assert.notEqual(first, popbillManagementKey("00000000-0000-4000-8000-000000008002"));
});

test("배송 완료는 출발 상태를 건너뛸 수 없다", () => {
  assert.doesNotThrow(() => assertShipmentTransition("preparing", "out_for_delivery"));
  assert.throws(() => assertShipmentTransition("preparing", "delivered"), /변경할 수 없습니다/);
});

test("세금계산서는 검토와 승인 단계를 건너뛸 수 없다", () => {
  assert.doesNotThrow(() => assertInvoiceTransition("draft", "reviewed"));
  assert.throws(() => assertInvoiceTransition("draft", "approved"), /변경할 수 없습니다/);
});

test("검토자와 MFA 승인자는 서로 달라야 한다", () => {
  assert.doesNotThrow(() => assertInvoiceApprovalSegregation("finance-1", {
    id: "master-1", name: "마스터", role: "hq_master", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString(),
  }));
  assert.throws(() => assertInvoiceApprovalSegregation("master-1", {
    id: "master-1", name: "마스터", role: "hq_master", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString(),
  }), /서로 달라야/);
});
