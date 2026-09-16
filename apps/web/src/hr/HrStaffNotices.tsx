import { useEffect, useId, useRef, useState } from 'react';
import type { HrNotice } from '../../../../packages/domain/src/oda-hr';
import type { HrResponse } from '../api/oda-hr-client';
import { Check, ChevronRight, Search } from '../components/icons';

export function isStaffNoticeAcknowledged(notice: HrNotice, actorId: string): boolean {
  return notice.receipts?.some(receipt => receipt.actorId === actorId && receipt.noticeUpdatedAt === notice.updatedAt) ?? false;
}

export function countStaffUnreadNotices(response: HrResponse | null, actorId: string): number {
  return response?.workspace.notices.filter(notice => notice.status === 'published' && !isStaffNoticeAcknowledged(notice, actorId)).length ?? 0;
}

interface Props {
  response: HrResponse | null;
  actorId: string;
  busy: boolean;
  onAcknowledge: (id: string, updatedAt: string) => void | Promise<void>;
  initialNoticeId?: string;
}

const displayDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value));

/** Reading never writes. Only the explicit confirmation action creates a server receipt. */
export function HrStaffNotices({ response, actorId, busy, onAcknowledge, initialNoticeId = '' }: Props) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(initialNoticeId);
  const [pendingId, setPendingId] = useState('');
  const [error, setError] = useState('');
  const operation = useRef(0);
  const working = useRef(false);
  const scope = `${actorId}:${response?.workspace.storeId ?? ''}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const panelId = useId();
  useEffect(() => {
    operation.current += 1; working.current = false;
    setPendingId(''); setError(''); setSearch(''); setFilter('all'); setOpenId(initialNoticeId);
    return () => { operation.current += 1; working.current = false; };
  }, [scope]);
  useEffect(() => { if (initialNoticeId) { setOpenId(initialNoticeId); setFilter('all'); setSearch(''); } }, [initialNoticeId]);

  const notices = response?.workspace.notices.filter(notice => notice.status === 'published').slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)) ?? [];
  const unreadCount = countStaffUnreadNotices(response, actorId);
  const needle = search.trim().toLocaleLowerCase('ko-KR');
  const visible = notices.filter(notice => (filter === 'all' || !isStaffNoticeAcknowledged(notice, actorId))
    && (!needle || `${notice.title} ${notice.body}`.toLocaleLowerCase('ko-KR').includes(needle)));
  const disabled = busy || Boolean(pendingId);

  async function acknowledge(notice: HrNotice) {
    if (busy || working.current || isStaffNoticeAcknowledged(notice, actorId)) return;
    working.current = true;
    const revision = ++operation.current; const startedScope = scope;
    setPendingId(notice.id); setError('');
    try { await onAcknowledge(notice.id, notice.updatedAt); }
    catch (reason) {
      if (operation.current === revision && currentScope.current === startedScope) {
        setError(reason instanceof Error ? reason.message : '공지 확인을 저장하지 못했습니다. 다시 시도해 주세요.');
      }
    } finally {
      if (operation.current === revision && currentScope.current === startedScope) { working.current = false; setPendingId(''); }
    }
  }

  return <section className="staff-notices" aria-label="매장 공지">
    <div className="staff-section-heading"><h2>매장 공지</h2><span className="staff-notice-count" aria-live="polite">미확인 {unreadCount}개</span></div>
    <div className="staff-notice-toolbar">
      <div className="staff-notice-filter" role="group" aria-label="공지 확인 상태">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체 {notices.length}</button>
        <button type="button" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>미확인 {unreadCount}</button>
      </div>
      <label className="staff-notice-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label="공지 검색" placeholder="공지 검색" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    {error && <p className="staff-notice-error" role="alert">{error}</p>}
    {!response ? <p className="staff-empty" role="status">{busy ? '공지를 불러오고 있어요.' : '공지 정보를 불러오지 못했습니다. 새로고침해 주세요.'}</p>
      : !visible.length ? <p className="staff-empty">{needle ? '검색 결과가 없습니다.' : filter === 'unread' && notices.length ? '모든 공지를 확인했어요.' : '게시된 매장 공지가 없습니다.'}</p>
        : <ul>{visible.map((notice, index) => {
          const acknowledged = isStaffNoticeAcknowledged(notice, actorId);
          const expanded = openId === notice.id;
          const receipt = notice.receipts?.find(row => row.actorId === actorId && row.noticeUpdatedAt === notice.updatedAt);
          const contentId = `${panelId}-notice-${index}`;
          return <li key={notice.id}>
            <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setOpenId(expanded ? '' : notice.id)}>
              <span>{notice.pinned && <small className="staff-pinned">중요</small>}<strong>{notice.title}</strong><small className={`staff-notice-state${acknowledged ? ' acknowledged' : ''}`}>{acknowledged ? '확인 완료' : '미확인'}</small><time dateTime={notice.updatedAt}>{displayDate(notice.updatedAt)}</time></span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            {expanded && <div id={contentId} className="staff-notice-detail">
              <p className="staff-notice-body">{notice.body}</p>
              <div className="staff-notice-actions">{acknowledged ? <p className="staff-notice-confirmed" role="status"><Check size={16} aria-hidden="true" /> 확인했어요{receipt ? ` · ${displayDate(receipt.acknowledgedAt)}` : ''}</p>
                : <button className="btn-primary" type="button" disabled={disabled || !(response.permissions.self || response.permissions.manage)} onClick={() => { void acknowledge(notice); }}>{pendingId === notice.id ? '확인 저장 중…' : '확인했어요'}</button>}</div>
            </div>}
          </li>;
        })}</ul>}
  </section>;
}
