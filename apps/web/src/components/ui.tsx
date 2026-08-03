import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, Check, Clock3, Info, RefreshCcw, ServerOff, X } from './icons';
import { getStatusLabel } from '../lib/workflows';
import type { Toast } from '../types';

export function StatusBadge({ status }: { status: string }) {
  const positive = ['approved', 'delivered', 'auto_matched', 'nts_success', 'issued', 'paid', 'internal_statement'].includes(status);
  const warning = ['submitted', 'manual_review', 'reviewed', 'scheduled', 'pending', 'queued', 'ready', 'nts_pending'].includes(status);
  const danger = ['change_requested', 'overdue', 'failed', 'cancelled'].includes(status);
  const Icon = positive ? Check : danger ? AlertTriangle : warning ? Clock3 : Info;
  return (
    <span className={`status-badge ${positive ? 'positive' : danger ? 'danger' : warning ? 'warning' : 'neutral'}`}>
      <Icon size={13} aria-hidden="true" />
      {getStatusLabel(status)}
    </span>
  );
}

export function MetricCard({ label, value, detail, icon, tone = 'default' }: { label: string; value: string; detail: string; icon: ReactNode; tone?: 'default' | 'orange' | 'green' | 'red' }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-icon" aria-hidden="true">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-region" role="status" aria-live="polite" aria-label="알림">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          {toast.tone === 'success' ? <Check size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />}
          <span>{toast.message}</span>
          <button type="button" aria-label="알림 닫기" onClick={() => onDismiss(toast.id)}><X size={18} /></button>
        </div>
      ))}
    </div>
  );
}

export function SkeletonScreen() {
  return (
    <div className="skeleton-screen" role="status" aria-label="화면을 불러오는 중">
      <div className="skeleton title" />
      <div className="skeleton wide" />
      <div className="skeleton-grid">
        <div className="skeleton card" /><div className="skeleton card" /><div className="skeleton card" />
      </div>
      <span className="sr-only">운영 정보를 불러오고 있습니다.</span>
    </div>
  );
}

export function ApiConnectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="connection-error" id="main-content">
      <div className="error-symbol"><ServerOff size={31} aria-hidden="true" /></div>
      <p className="eyebrow"><span /> SAFE MODE</p>
      <h1>운영 서버에 연결할 수 없습니다</h1>
      <p>운영 데이터 연결이 복구될 때까지 조회와 업무 처리를 차단했습니다. 네트워크와 API 상태를 확인한 뒤 다시 연결해 주세요.</p>
      <button className="button button-primary" type="button" onClick={onRetry}><RefreshCcw size={18} aria-hidden="true" /> 다시 연결</button>
      <small>연결 문제가 계속되면 계정 관리자에게 문의해 주세요.</small>
    </main>
  );
}
