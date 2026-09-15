import { createContext, useContext, type ReactNode } from 'react';
import type { HrPermissions, HrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { Button } from '../components/ui';
import { useAccessibleDialog } from '../components/useAccessibleDialog';

export type HrPanelProps = {
  workspace: HrWorkspace;
  permissions: HrPermissions;
  mutate: (type: string, input: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  actorId: string;
  employeeId?: string;
  onReload?: () => Promise<void>;
};

export const HrRecoveryContext = createContext<{ error: string; pending: boolean; retry: () => void } | null>(null);

export function HrEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="hr-empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function HrDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const recovery = useContext(HrRecoveryContext);
  const closeDisabled = busy && !recovery?.error;
  const ref = useAccessibleDialog(() => { if (!closeDisabled) onClose(); });
  return <div className="hr-dialog-backdrop"><section ref={ref} className="hr-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <header className="hr-section-heading"><h2>{title}</h2><Button type="button" variant="ghost" onClick={onClose} disabled={closeDisabled} aria-label={`${title} 닫기`}>닫기</Button></header>
    {recovery?.error && <div className="hr-error" role="alert"><p>{recovery.error}</p><Button type="button" variant="secondary" disabled={recovery.pending} onClick={recovery.retry}>입력 유지하고 다시 불러오기</Button></div>}
    {children}
  </section></div>;
}

export function hrDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function hrToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function hrError(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
}
