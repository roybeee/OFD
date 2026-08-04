import type { Role } from '../types';

export const pathCapability: Record<string, string> = {
  '/store/orders': 'store.orders.read',
  '/store/documents': 'store.documents.read',
  '/hq/orders': 'hq.orders.read',
  '/hq/delivery': 'hq.shipments.manage',
  '/hq/reconciliation': 'hq.payments.reconcile',
  '/hq/invoices': 'hq.invoices.read',
  '/hq/sales': 'hq.orders.read',
  '/hq/products': 'hq.orders.read',
  '/hq/openings': 'hq.orders.read',
  '/hq/accounts': 'hq.accounts.manage',
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
