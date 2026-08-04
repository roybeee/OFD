import { useCallback, useEffect, useState } from 'react';
import {
  createOpeningV2, loadOpeningV2, loadOpeningsV2, newIdempotencyKey, patchOpeningV2, toggleOpeningTaskV2,
  type OpeningBoard, type OpeningDetail, type OpeningSummary,
} from '../api/client';
import { Button, EmptyState, MetricCard } from '../components/ui';
import { ClipboardCheck } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

const STAGES = ['상담중', '진행', '보류', '완료'] as const;
const PHASES = ['D-4주차', 'D-3주차', 'D-2주차', 'D-1주차', 'D-DAY'] as const;
const OWNER_LABEL: Record<string, string> = { hq: '본사', pt: '가맹점', both: '협의' };
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

/** V1 오픈 탭 이식: 칸반 보드 + 단계별 체크리스트 */
export function HqOpeningsPage({ notify }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [board, setBoard] = useState<OpeningBoard | null>(null);
  const [detail, setDetail] = useState<OpeningDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', region: '', openDate: '', mode: '가맹', storeType: '테이블형' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      setBoard(await loadOpeningsV2());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '오픈 프로젝트를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function openDetail(id: string) {
    try {
      setDetail(await loadOpeningV2(id));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '상세를 불러오지 못했습니다.', 'warning');
    }
  }

  async function submitNew() {
    if (!form.name.trim() || !form.openDate) {
      notify('매장명과 오픈일을 입력해 주세요.', 'warning');
      return;
    }
    setBusy(true);
    try {
      const created = await createOpeningV2({
        name: form.name.trim(), region: form.region.trim() || null, openDate: form.openDate,
        mode: form.mode, storeType: form.storeType, stage: '상담중',
      }, newIdempotencyKey());
      notify(`${created.name} 오픈 프로젝트 생성 — 체크리스트 ${created.total}항목`, 'success');
      setCreating(false);
      setForm({ name: '', region: '', openDate: '', mode: '가맹', storeType: '테이블형' });
      await refresh();
      await openDetail(created.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '생성에 실패했습니다.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  async function moveStage(opening: OpeningSummary, stage: string) {
    try {
      await patchOpeningV2(opening.id, { stage });
      notify(`${opening.name} → ${stage}`, 'success');
      await refresh();
      if (detail?.id === opening.id) await openDetail(opening.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '단계 이동에 실패했습니다.', 'warning');
    }
  }

  async function reschedule(openDate: string) {
    if (!detail) return;
    try {
      await patchOpeningV2(detail.id, { openDate });
      notify('오픈일 변경 — 모든 데드라인을 재계산했습니다.', 'success');
      await refresh();
      await openDetail(detail.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '오픈일 변경에 실패했습니다.', 'warning');
    }
  }

  async function toggle(taskId: string, done: boolean) {
    if (!detail) return;
    try {
      await toggleOpeningTaskV2(taskId, done);
      await openDetail(detail.id);
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '항목을 변경하지 못했습니다.', 'warning');
    }
  }

  return (
    <section className="page" aria-labelledby="openings-heading">
      <header className="page-head">
        <div>
          <h1 id="openings-heading">오픈 프로세스</h1>
          <p>신규매장 오픈 매뉴얼 기반 체크리스트 · 지연은 진행 단계에서만 집계합니다</p>
        </div>
        <div className="page-actions">
          <Button type="button" onClick={() => setCreating((value) => !value)}>{creating ? '취소' : '오픈 프로젝트 추가'}</Button>
        </div>
      </header>

      {board && (
        <div className="metric-grid">
          <MetricCard label="진행 중" value={`${board.kpi.active}곳`} detail="상담중·보류 제외" icon={<ClipboardCheck size={18} aria-hidden="true" />} />
          <MetricCard label="지연 항목" value={`${board.kpi.overdue}건`} detail="데드라인 초과 · 진행 건만" icon={<ClipboardCheck size={18} aria-hidden="true" />} tone={board.kpi.overdue ? 'red' : 'green'} />
          <MetricCard label="30일 내 오픈" value={`${board.kpi.within30Days}곳`} detail="집중 관리 대상" icon={<ClipboardCheck size={18} aria-hidden="true" />} tone="orange" />
        </div>
      )}

      {error && <div className="inline-error" role="alert">{error}</div>}

      {creating && (
        <section className="panel" aria-labelledby="new-opening-heading">
          <h2 id="new-opening-heading">새 오픈 프로젝트</h2>
          <div className="form-grid">
            <label>매장명<input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="예: 판교점" /></label>
            <label>지역<input type="text" value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="예: 경기 성남" /></label>
            <label>오픈일<input type="date" value={form.openDate} min={seoulToday()} onChange={(event) => setForm({ ...form, openDate: event.target.value })} /></label>
            <label>운영 형태
              <select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
                <option value="가맹">가맹</option><option value="운영대행">운영대행</option>
              </select>
            </label>
            <label>매장 유형
              <select value={form.storeType} onChange={(event) => setForm({ ...form, storeType: event.target.value })}>
                <option value="테이블형">테이블형</option><option value="포장형">포장형</option>
              </select>
            </label>
          </div>
          <Button type="button" onClick={submitNew} disabled={busy}>{busy ? '생성 중…' : '생성'}</Button>
        </section>
      )}

      {!board ? <p className="muted">불러오는 중…</p> : board.openings.length === 0 ? (
        <EmptyState icon={<ClipboardCheck size={20} aria-hidden="true" />} title="등록된 오픈 프로젝트가 없습니다">
          오픈 프로젝트를 추가하면 매장 유형에 맞는 체크리스트가 자동 생성됩니다.
        </EmptyState>
      ) : (
        <div className="kanban">
          {STAGES.map((stage) => (
            <div key={stage} className="kanban-column">
              <h2 className="kanban-head">{stage} <span className="muted">{board.board[stage]?.length ?? 0}</span></h2>
              {(board.board[stage] ?? []).map((opening) => (
                <article key={opening.id} className={opening.overdue ? 'kanban-card card-alert' : 'kanban-card'}>
                  <button type="button" className="kanban-title" onClick={() => void openDetail(opening.id)}>
                    <strong>{opening.name}</strong>
                    <small>{opening.region ?? '지역 미정'} · {opening.mode} · {opening.storeType}</small>
                  </button>
                  <p className="kanban-meta">
                    {opening.openDate} · {opening.dDay > 0 ? `D-${opening.dDay}` : opening.dDay === 0 ? 'D-DAY' : `D+${-opening.dDay}`}
                  </p>
                  <div className="progress" role="img" aria-label={`진행률 ${opening.progressPct}%`}>
                    <span style={{ width: `${opening.progressPct}%` }} />
                  </div>
                  <p className="kanban-meta">{opening.done}/{opening.total} 완료 · {opening.progressPct}%
                    {opening.overdue > 0 && <span className="tag tag-warn"> 지연 {opening.overdue}</span>}</p>
                  <div className="inline-actions">
                    {STAGES.filter((item) => item !== stage).map((item) => (
                      <Button key={item} type="button" variant="ghost" onClick={() => void moveStage(opening, item)}>{item}</Button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      )}

      {detail && (
        <section className="panel" aria-labelledby="detail-heading">
          <div className="page-head">
            <div>
              <h2 id="detail-heading">{detail.name} 체크리스트</h2>
              <p>{detail.stage} · {detail.done}/{detail.total} 완료 ({detail.progressPct}%) · 지연 {detail.overdue}건</p>
            </div>
            <div className="page-actions">
              <label className="filter-date">오픈일<input type="date" value={detail.openDate} onChange={(event) => void reschedule(event.target.value)} /></label>
              <Button type="button" variant="ghost" onClick={() => setDetail(null)}>닫기</Button>
            </div>
          </div>
          {PHASES.map((phase) => {
            const tasks = detail.tasks.filter((task) => task.phase === phase);
            if (tasks.length === 0) return null;
            const phaseStat = detail.phases[phase];
            return (
              <div key={phase} className="phase-block">
                <h3>{phase} <span className="muted">{phaseStat?.done ?? 0}/{phaseStat?.total ?? 0}</span></h3>
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id} className={task.overdue ? 'task task-overdue' : task.done ? 'task task-done' : 'task'}>
                      <label>
                        <input type="checkbox" checked={task.done} onChange={(event) => void toggle(task.id, event.target.checked)} />
                        <span className="task-copy">
                          <strong>{task.title}</strong>
                          {task.detail && <small>{task.detail}</small>}
                          <small className="task-meta">
                            {OWNER_LABEL[task.owner] ?? task.owner} · 마감 {task.deadline}
                            {task.overdue && <span className="tag tag-warn"> 지연</span>}
                            {task.custom && <span className="tag"> 추가</span>}
                          </small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </section>
  );
}
