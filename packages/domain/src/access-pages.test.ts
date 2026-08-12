import assert from "node:assert/strict";
import test from "node:test";
import { accessDomainForRole, capabilitiesForPages, defaultPagesForRole, selectablePagesForRole } from "./access-pages.ts";

test("역할은 자기 영역의 페이지만 선택 후보로 갖는다", () => {
  assert.equal(accessDomainForRole("store_owner"), "store");
  assert.equal(accessDomainForRole("hq_finance"), "hq");
  assert.equal(accessDomainForRole("driver"), "driver");
  assert.equal(accessDomainForRole("system"), null);
  assert.ok(selectablePagesForRole("hq_ops").every((page) => page.domain === "hq"));
  assert.ok(selectablePagesForRole("store_owner").every((page) => page.domain === "store"));
});

test("선택된 페이지의 capability만 유효하며 영역 밖 경로는 무시된다", () => {
  const caps = capabilitiesForPages("hq_ops", ["/hq/orders", "/hq/sales", "/store/orders"]);
  assert.ok(caps.includes("hq.orders.read"));
  assert.ok(caps.includes("hq.orders.approve"));
  assert.ok(caps.includes("hq.pos.read"));
  assert.ok(!caps.includes("store.orders.read"), "영역(store) 밖 페이지는 hq_ops에 부여되지 않는다");
});

test("역할 기본 페이지는 기본 capability에 대표 권한이 포함된 페이지들", () => {
  const base = ["hq.orders.read", "hq.pos.read"];
  const pages = defaultPagesForRole("hq_ops", base);
  assert.ok(pages.includes("/hq/orders"));
  assert.ok(pages.includes("/hq/sales"));
  assert.ok(!pages.includes("/hq/reconciliation"), "reconcile 권한이 없으면 입금 대사 페이지는 기본 노출이 아니다");
});
