import { useCallback, useEffect, useState } from 'react';
import {
  ApiError, createLeadV2, deleteLeadV2, loadLeadsV2, moveLeadStageV2, newIdempotencyKey, updateLeadV2,
  type FranchiseLead,
} from '../api/client';
import { Button, EmptyState } from '../components/ui';
import { Handshake } from '../components/icons';
import type { BootstrapData, Toast } from '../types';

/** V1 가맹 영업 파이프라인 이식 — 숙려기간(가맹사업법 제7조③)은 서버가 강제하고, 화면은 그 결정을 보여준다 */
export function HqLeadsPage({ notify }: { data: BootstrapData; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [stages, setStages] = useState<string[]>([]);
  const [leads, setLeads] = useState<FranchiseLead[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', area: '', storeName: '', openTarget: '' });
  const [busyId, setBusyId] = useState('');
  const [memoDraft, setMemoDraft] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setError('');
    try {
      const result = await loadLeadsV2();
      setStages(result.stages);
      setLeads(result.leads);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가맹 영업 현황을 불러오지 못했습니다.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function submitNew() {
    if (form.name.trim().length < 2) { notify('이름(2자 이상)을 입력해 주세요.', 'warning'); return; }
    try {
      await createLeadV2({ ...form, name: form.name.trim() }, newIdempotencyKey());
      setForm({ name: '', phone: '', area: '', storeName: '', openTarget: '' });
      setCreating(false);
      notify('리드를 추가했습니다.', 'success');
      await refresh();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '리드 추가에 실패했습니다.', 'warning'); }
  }

  async function patchLead(lead: FranchiseLead, patch: Record<string, unknown>, done?: string) {
    setBusyId(lead.id);
    try {
      await updateLeadV2(lead.id, patch);
      if (done) notify(done, 'success');
      await refresh();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '저장에 실패했습니다.', 'warning'); }
    finally { setBusyId(''); }
  }

  async function move(lead: FranchiseLead, dir: 'next' | 'back') {
    setBusyId(lead.id);
    try {
      const moved = await moveLeadStageV2(lead.id, dir, false, newIdempotencyKey());
      if (moved.createdStoreId) notify(`${moved.lead.storeName || moved.lead.name} 오픈완료 — 가맹 매장을 대장에 등록했습니다.`, 'success');
      else notify(`${lead.name} → ${stages[moved.lead.stage] ?? ''}`, 'success');
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'COOLING') {
        const gate = (cause.details as { gate?: string } | undefined)?.gate;
        const confirmed = window.confirm(
          `${cause.message}\n\n숙려기간(정보공개서 제공 후 ${lead.cooling.days ?? 14}일)이 지나지 않았습니다.` +
          `\n강행하면 가맹사업법 위반 소지가 있으며, 이 리드에 플래그가 남고 감사 원장에 "숙려기간 미준수 사후기록"이 기록됩니다.` +
          `\n${gate ? `권장: ${gate} 이후 진행` : ''}\n\n그래도 진행할까요?`);
        if (confirmed) {
          try {
            await moveLeadStageV2(lead.id, dir, true, newIdempotencyKey());
            notify('숙려기간 미경과 상태로 진행 — 감사 기록에 남았습니다.', 'warning');
            await refresh();
          } catch (inner) { notify(inner instanceof Error ? inner.message : '이동에 실패했습니다.', 'warning'); }
        }
      } else {
        notify(cause instanceof Error ? cause.message : '이동에 실패했습니다.', 'warning');
      }
    } finally { setBusyId(''); }
  }

  async function remove(lead: FranchiseLead) {
    if (!window.confirm(`${lead.name} 리드를 삭제할까요?`)) return;
    try { await deleteLeadV2(lead.id); notify('리드를 삭제했습니다.', 'info'); await refresh(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : '삭제에 실패했습니다.', 'warning'); }
  }

  function coolingBadge(lead: FranchiseLead) {
    if (lead.stage !== 2) return null;
    if (!lead.cooling.has) return <span className="lead-badge tone-red">정보공개서 제공일 입력 필요</span>;
    return lead.cooling.ok
      ? <span className="lead-badge tone-green">숙려기간 경과 — 계약 진행 가능</span>
      : <span className="lead-badge tone-red">숙려기간 중 · {lead.cooling.gate} 이후 계약 가능</span>;
  }

  return (
    <section className="page" aria-labelledby="leads-heading">
      <header className="page-head">
        <div>
          <h1 id="leads-heading">가맹 영업</h1>
          <p>리드부터 오픈완료까지 6단계 · 정보공개서 숙려기간(14일, 가맹거래사 자문 시 7일)은 시스템이 강제합니다</p>
        </div>
        <div className="page-actions">
          <Button type="button" onClick={() => setCreating((value) => !value)}>{creating ? '취소' : '리드 추가'}</Button>
        </div>
      </header>

      {error && <div className="inline-error" role="alert">{error}</div>}

      {creating && (
        <section className="panel" aria-labelledby="new-lead-heading">
          <h2 id="new-lead-heading">새 리드</h2>
          <div className="form-grid">
            <label>이름<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="예: 김가맹" /></label>
            <label>연락처<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="010-0000-0000" /></label>
            <label>희망 지역<input value={form.area} onChange={(event) => setForm({ ...form, area: event.target.value })} placeholder="예: 수원 영통" /></label>
            <label>가맹점명(가칭)<input value={form.storeName} onChange={(event) => setForm({ ...form, storeName: event.target.value })} placeholder="예: 영통점" /></label>
            <label>오픈 목표<input value={form.openTarget} onChange={(event) => setForm({ ...form, openTarget: event.target.value })} placeholder="예: 2026-11" /></label>
          </div>
          <Button type="button" onClick={() => void submitNew()}>등록</Button>
        </section>
      )}

      {stages.length > 0 && (
        <div className="kanban cols-6" role="list" aria-label="가맹 영업 단계 보드">
          {stages.map((stage, index) => {
            const column = leads.filter((lead) => lead.stage === index);
            return (
              <div key={stage} className="kanban-column" role="listitem">
                <div className="kanban-head">{stage} · {column.length}</div>
                {column.map((lead) => (
                  <article key={lead.id} className={`kanban-card${lead.flag ? ' card-alert' : ''}`} aria-label={`${lead.name} 리드`}>
                    <div className="kanban-title">
                      <strong>{lead.name}</strong>
                      <small>{[lead.storeName, lead.area].filter(Boolean).join(' · ') || '상세 미입력'}{lead.phone ? ` · ${lead.phone}` : ''}</small>
                    </div>
                    {lead.flag && <span className="lead-badge tone-red">숙려기간 미준수 기록</span>}
                    {coolingBadge(lead)}
                    {lead.stage === 2 && (
                      <div className="lead-fields">
                        <label>정보공개서 제공일
                          <input type="date" value={lead.docDate ?? ''} disabled={busyId === lead.id}
                            onChange={(event) => void patchLead(lead, { docDate: event.target.value || null }, '제공일을 저장했습니다 — 숙려기간을 다시 계산합니다.')} />
                        </label>
                        <label className="inline-check">
                          <input type="checkbox" checked={lead.advisor} disabled={busyId === lead.id}
                            onChange={(event) => void patchLead(lead, { advisor: event.target.checked }, event.target.checked ? '가맹거래사 자문 — 숙려 7일 적용' : '자문 해제 — 숙려 14일 적용')} />
                          가맹거래사 자문(7일)
                        </label>
                      </div>
                    )}
                    {lead.stage === 5 && lead.storeId && <span className="lead-badge tone-green">매장 대장 등록 완료</span>}
                    <textarea aria-label={`${lead.name} 메모`} rows={2} placeholder="메모"
                      value={memoDraft[lead.id] ?? lead.memo}
                      onChange={(event) => setMemoDraft((current) => ({ ...current, [lead.id]: event.target.value }))}
                      onBlur={() => {
                        const value = memoDraft[lead.id];
                        if (value !== undefined && value !== lead.memo) void patchLead(lead, { memo: value });
                      }} />
                    <div className="kanban-meta row-actions">
                      <Button type="button" variant="ghost" onClick={() => void move(lead, 'back')} disabled={busyId === lead.id || lead.stage === 0} aria-label={`${lead.name} 이전 단계`}>◀</Button>
                      <Button type="button" variant="secondary" onClick={() => void move(lead, 'next')} disabled={busyId === lead.id || lead.stage === stages.length - 1} aria-label={`${lead.name} 다음 단계`}>다음 ▶</Button>
                      <Button type="button" variant="ghost" onClick={() => void remove(lead)} disabled={busyId === lead.id} aria-label={`${lead.name} 삭제`}>삭제</Button>
                    </div>
                  </article>
                ))}
                {column.length === 0 && <p className="kanban-meta">비어 있음</p>}
              </div>
            );
          })}
        </div>
      )}

      {stages.length > 0 && leads.length === 0 && !creating && (
        <EmptyState icon={<Handshake size={22} aria-hidden="true" />} title="진행 중인 리드가 없습니다">상단의 리드 추가로 가맹 상담을 시작하세요.</EmptyState>
      )}
    </section>
  );
}
