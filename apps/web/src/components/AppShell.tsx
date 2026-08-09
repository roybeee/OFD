import type { ReactNode } from 'react';
import {
  Bike,
  ClipboardCheck,
  FileCheck2,
  Handshake,
  Landmark,
  LayoutGrid,
  PackageCheck,
  ReceiptText,
  Route,
  ScrollText,
  Store,
  UserRound,
} from './icons';
import type { Role } from '../types';
import { pathCapability } from '../lib/access';

type NavItem = { path: string; label: string; icon: typeof LayoutGrid };

const navByRole: Record<Role, NavItem[]> = {
  store: [
    { path: '/store/home', label: '홈', icon: LayoutGrid },
    { path: '/store/orders', label: '발주·입고', icon: PackageCheck },
    { path: '/store/documents', label: '정산·증빙', icon: ReceiptText },
  ],
  hq: [
    { path: '/hq/orders', label: '주문 운영', icon: ClipboardCheck },
    { path: '/hq/delivery', label: '배송', icon: Route },
    { path: '/hq/reconciliation', label: '입금 대사', icon: Landmark },
    { path: '/hq/invoices', label: '정산·세금계산서', icon: FileCheck2 },
    { path: '/hq/sales', label: '매출현황', icon: LayoutGrid },
    { path: '/hq/products', label: '상품 관리', icon: PackageCheck },
    { path: '/hq/openings', label: '오픈', icon: ClipboardCheck },
    { path: '/hq/stores', label: '매장 대장', icon: Store },
    { path: '/hq/leads', label: '가맹 영업', icon: Handshake },
    { path: '/hq/audit', label: '감사 로그', icon: ScrollText },
    { path: '/hq/accounts', label: '계정 관리', icon: UserRound },
  ],
  driver: [{ path: '/driver/today', label: '오늘 배송', icon: Bike }],
};

export function AppShell({ role, path, actorName, actorRole, storeName, deliveryCount, capabilities, onNavigate, onLogout, logoutPending = false, children }: {
  role: Role;
  path: string;
  actorName: string;
  actorRole: string;
  storeName: string;
  deliveryCount: number;
  capabilities: string[];
  onNavigate: (path: string) => void;
  onLogout: () => void;
  logoutPending?: boolean;
  children: ReactNode;
}) {
  const nav = navByRole[role].filter((item) => capabilities.includes(pathCapability[item.path]));
  const contextName = role === 'store' ? storeName : role === 'driver' ? `오늘 배송 ${deliveryCount}곳` : '본사 운영센터';
  const actorRoleLabel = role === 'hq' ? actorRole === 'auditor' ? '감사 · 읽기 전용' : actorRole === 'hq_master' || actorRole === 'master' ? '마스터' : actorRole === 'hq_finance' ? '재무' : '운영' : role === 'driver' ? '배송기사' : actorRole === 'store_staff' ? '매장 직원' : '점주';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      <header className="app-header">
        <div className="header-main">
          <button className="brand" type="button" onClick={() => onNavigate(nav[0]?.path ?? path)} aria-label="통합 발주·정산 첫 화면">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>OFD 워크스테이션 · 통합 발주·정산</strong><small>ORDER · DELIVERY · FINANCE</small></span>
          </button>

          <div className="header-actions">
            <a className="legacy-home-link" href="/" aria-label="기존 OFD 워크스테이션 홈으로 이동"><LayoutGrid size={17} aria-hidden="true" /><span>워크스테이션 홈</span></a>
            <div className="profile-button" aria-label={`로그인 사용자 ${actorName}`}>
              <span>{actorName.slice(0, 1)}</span><span className="profile-copy"><strong>{actorName}</strong><small>{actorRoleLabel}</small></span>
            </div>
            <button type="button" className="logout-button" onClick={onLogout} disabled={logoutPending}>{logoutPending ? '로그아웃 중…' : '로그아웃'}</button>
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
          <div className="source-pill source-live" title="운영 API에 연결됨">
            <span />운영 API 연결
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
