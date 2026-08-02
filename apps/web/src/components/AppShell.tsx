import type { ReactNode } from 'react';
import {
  Bike,
  Building2,
  ClipboardCheck,
  FileCheck2,
  Landmark,
  LayoutGrid,
  PackageCheck,
  ReceiptText,
  Route,
  Store,
} from './icons';
import type { DataSource, Role } from '../types';
import { pathCapability } from '../lib/access';

type NavItem = { path: string; label: string; icon: typeof LayoutGrid };

const navByRole: Record<Role, NavItem[]> = {
  store: [
    { path: '/store/orders', label: '발주·입고', icon: PackageCheck },
    { path: '/store/documents', label: '정산·증빙', icon: ReceiptText },
  ],
  hq: [
    { path: '/hq/orders', label: '주문 운영', icon: ClipboardCheck },
    { path: '/hq/delivery', label: '배송', icon: Route },
    { path: '/hq/reconciliation', label: '입금 대사', icon: Landmark },
    { path: '/hq/invoices', label: '정산·세금계산서', icon: FileCheck2 },
  ],
  driver: [{ path: '/driver/today', label: '오늘 배송', icon: Bike }],
};

const roleOptions: Array<{ role: Role; label: string; compact: string; icon: typeof Store; path: string }> = [
  { role: 'store', label: '매장 점주', compact: '점주', icon: Store, path: '/store/orders' },
  { role: 'hq', label: '본사 운영', compact: '본사', icon: Building2, path: '/hq/orders' },
  { role: 'driver', label: '배송 기사', compact: '기사', icon: Bike, path: '/driver/today' },
];

export function AppShell({ role, path, source, actorName, actorRole, storeName, deliveryCount, capabilities, explicitDemo, onNavigate, onLogout, children }: {
  role: Role;
  path: string;
  source: DataSource;
  actorName: string;
  actorRole: string;
  storeName: string;
  deliveryCount: number;
  capabilities: string[];
  explicitDemo: boolean;
  onNavigate: (path: string) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const nav = navByRole[role].filter((item) => explicitDemo || capabilities.includes(pathCapability[item.path]));
  const contextName = role === 'store' ? storeName : role === 'driver' ? `오늘 배송 ${deliveryCount}곳` : '본사 운영센터';
  const actorRoleLabel = role === 'hq' ? actorRole === 'auditor' ? '감사 · 읽기 전용' : actorRole === 'hq_master' || actorRole === 'master' ? '마스터' : actorRole === 'hq_finance' ? '재무' : '운영' : role === 'driver' ? '배송기사' : actorRole === 'store_staff' ? '매장 직원' : '점주';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      <header className="app-header">
        <div className="header-main">
          <button className="brand" type="button" onClick={() => onNavigate(nav[0]?.path ?? path)} aria-label="OFD 워크스테이션 홈">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>OFD 워크스테이션</strong><small>ORDER · DELIVERY · FINANCE</small></span>
          </button>

          <div className="header-actions">
            {explicitDemo && <div className="role-switcher" role="group" aria-label="화면 역할 전환">
              {roleOptions.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.role} type="button" className={role === item.role ? 'active' : ''} aria-pressed={role === item.role} aria-label={`${item.label} 화면`} onClick={() => onNavigate(item.path)}>
                    <Icon size={16} aria-hidden="true" />
                    <span className="role-full">{item.label}</span><span className="role-compact">{item.compact}</span>
                  </button>
                );
              })}
            </div>}
            <div className="profile-button" aria-label={`로그인 사용자 ${actorName}`}>
              <span>{actorName.slice(0, 1)}</span><span className="profile-copy"><strong>{actorName}</strong><small>{actorRoleLabel}</small></span>
            </div>
            {!explicitDemo && <button type="button" className="logout-button" onClick={onLogout}>로그아웃</button>}
          </div>
        </div>

        <div className="context-bar">
          <div className="context-title"><span className="online-dot" role="img" aria-label="정상 연결" /> <strong>{contextName}</strong></div>
          <nav className="primary-nav" aria-label="주요 메뉴">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = path === item.path;
              return (
                <button key={item.path} type="button" className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item.path)}>
                  <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className={`source-pill source-${source}`} title={source === 'demo' ? '실제 저장이나 외부 발행을 하지 않습니다.' : '실시간 운영 데이터에 연결됨'}>
            <span />{source === 'demo' ? '데모 데이터' : '실시간 연결'}
          </div>
        </div>
      </header>
      {children}
      <footer className="app-footer">
        <span>OFD Franchise Operations</span><span>업무 문의는 계정 관리자에게 요청해 주세요.</span>
      </footer>
    </div>
  );
}
