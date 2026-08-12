import type { Role } from '../types';

export const pathCapability: Record<string, string> = {
  // 점주 홈이 매장 계정의 첫 화면이다 — defaultPathFor가 삽입 순서를 따르므로 맨 앞에 둔다.
  '/store/home': 'store.orders.read',
  '/store/orders': 'store.orders.read',
  '/store/documents': 'store.documents.read',
  '/hq/orders': 'hq.orders.read',
  '/hq/delivery': 'hq.shipments.manage',
  '/hq/reconciliation': 'hq.payments.reconcile',
  '/hq/invoices': 'hq.invoices.read',
  '/hq/sales': 'hq.pos.read',
  '/hq/products': 'hq.pos.read',
  '/hq/openings': 'hq.pos.read',
  '/hq/stores': 'hq.stores.manage',
  '/hq/leads': 'hq.leads.manage',
  '/hq/audit': 'hq.audit.read',
  '/hq/accounts': 'hq.accounts.manage',
  '/hq/settings': 'hq.settings.manage',
  '/driver/today': 'driver.deliveries.read',
};

function normalizedBasePath(basePath: string) {
  const value = `/${basePath}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return value === '/' ? '' : value;
}

export function logicalPathFromLocation(pathname: string, basePath: string) {
  const base = normalizedBasePath(basePath);
  if (!base) return pathname || '/';
  if (pathname === base) return '/';
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

export function browserPathFor(logicalPath: string, basePath: string) {
  const base = normalizedBasePath(basePath);
  const path = logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
  if (!base || path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

export function canAccessPath(path: string, capabilities: string[]) {
  return capabilities.includes(pathCapability[path]);
}

export function defaultPathFor(capabilities: string[]) {
  return Object.keys(pathCapability).find((path) => capabilities.includes(pathCapability[path])) ?? '/unauthorized';
}

export function roleForActor(actorRole: string): Role {
  if (actorRole === 'driver') return 'driver';
  if (actorRole.startsWith('hq_') || actorRole === 'auditor') return 'hq';
  return 'store';
}

export function roleForPath(path: string): Role {
  if (path.startsWith('/hq/')) return 'hq';
  if (path.startsWith('/driver/')) return 'driver';
  return 'store';
}

/** 저장된 순서를 메뉴에 적용한다 — 목록에 없는 경로는 무시하고, 빠진 메뉴는 원래 순서로 뒤에 붙인다.
 *  (메뉴가 추가·삭제돼도 저장된 순서가 화면을 깨뜨리지 않게 한다) */
export function applyMenuOrder<T extends { path: string }>(items: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order?.length) return [...items];
  const rank = new Map(order.map((path, index) => [path, index]));
  return [...items].sort((left, right) => {
    const a = rank.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const b = rank.get(right.path) ?? Number.MAX_SAFE_INTEGER;
    return a === b ? items.indexOf(left) - items.indexOf(right) : a - b;
  });
}
