import type { ActorRole } from "./types.ts";

/** 화면(메뉴) 노출 권한 제어의 기준 단위 = 페이지. 각 페이지는 사용에 필요한 capability 묶음을 가진다. */
export type AccessDomain = "store" | "hq" | "driver";

export interface AccessPage {
  path: string;
  label: string;
  domain: AccessDomain;
  /** 이 페이지가 켜질 때 부여되는 capability 묶음(메뉴 노출용 read + 화면 내 액션). */
  capabilities: string[];
}

/** 앱의 전체 페이지 카탈로그. 화면·라우팅·권한의 단일 출처. */
export const ACCESS_PAGES: readonly AccessPage[] = [
  { path: "/store/home", label: "홈", domain: "store", capabilities: ["store.orders.read"] },
  { path: "/store/orders", label: "발주·입고", domain: "store", capabilities: ["store.orders.read", "store.orders.create", "store.orders.submit", "store.orders.cancel"] },
  { path: "/store/documents", label: "정산·증빙", domain: "store", capabilities: ["store.documents.read"] },
  { path: "/hq/orders", label: "주문 운영", domain: "hq", capabilities: ["hq.orders.read", "hq.orders.approve", "hq.orders.change_request"] },
  { path: "/hq/delivery", label: "배송", domain: "hq", capabilities: ["hq.shipments.manage", "hq.shipments.dispatch", "hq.drivers.read"] },
  { path: "/hq/reconciliation", label: "입금 대사", domain: "hq", capabilities: ["hq.payments.reconcile"] },
  { path: "/hq/invoices", label: "정산·세금계산서", domain: "hq", capabilities: ["hq.settlements.manage", "hq.settlements.draft", "hq.settlements.approve", "hq.invoices.read", "hq.invoices.prepare", "hq.invoices.approve", "hq.invoices.retry", "hq.documents.read", "hq.outbox.requeue"] },
  { path: "/hq/sales", label: "매출현황", domain: "hq", capabilities: ["hq.pos.read"] },
  { path: "/hq/products", label: "상품 관리", domain: "hq", capabilities: ["hq.pos.read"] },
  { path: "/hq/openings", label: "오픈", domain: "hq", capabilities: ["hq.pos.read"] },
  { path: "/hq/stores", label: "매장 대장", domain: "hq", capabilities: ["hq.stores.manage", "hq.notices.manage"] },
  { path: "/hq/leads", label: "가맹 영업", domain: "hq", capabilities: ["hq.leads.manage"] },
  { path: "/hq/audit", label: "감사 로그", domain: "hq", capabilities: ["hq.audit.read", "hq.finance.read"] },
  { path: "/hq/accounts", label: "계정 관리", domain: "hq", capabilities: ["hq.accounts.manage", "hq.actors.manage"] },
  { path: "/driver/today", label: "오늘 배송", domain: "driver", capabilities: ["driver.deliveries.read", "driver.deliveries.complete"] },
];

/** 각 페이지의 대표(메뉴 노출) capability — pathCapability와 일치. */
export const pagePrimaryCapability = (page: AccessPage): string => page.capabilities[0]!;

export function accessDomainForRole(role: ActorRole): AccessDomain | null {
  if (role === "driver") return "driver";
  if (role === "store_owner" || role === "store_staff") return "store";
  if (role.startsWith("hq_") || role === "auditor") return "hq";
  return null; // system
}

/** 역할이 자유롭게 켜고 끌 수 있는 페이지 후보 = 같은 영역의 모든 페이지. */
export function selectablePagesForRole(role: ActorRole): AccessPage[] {
  const domain = accessDomainForRole(role);
  return domain ? ACCESS_PAGES.filter((page) => page.domain === domain) : [];
}

/** 역할의 기본 노출 페이지 = 대표 capability가 역할 기본 권한에 포함된 페이지. */
export function defaultPagesForRole(role: ActorRole, roleBaseCapabilities: readonly string[]): string[] {
  const base = new Set(roleBaseCapabilities);
  return selectablePagesForRole(role)
    .filter((page) => base.has(pagePrimaryCapability(page)))
    .map((page) => page.path);
}

/** 선택된 페이지 경로 목록으로부터 유효 capability를 계산한다(같은 영역 안에서만 유효). */
export function capabilitiesForPages(role: ActorRole, selectedPaths: readonly string[]): string[] {
  const selectable = new Map(selectablePagesForRole(role).map((page) => [page.path, page]));
  const caps = new Set<string>();
  for (const path of selectedPaths) {
    const page = selectable.get(path);
    if (page) for (const cap of page.capabilities) caps.add(cap);
  }
  return [...caps];
}
