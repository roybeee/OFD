import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { ApiError } from '../api/client';

type Connection = { id: string; name: string; storeIds: string[]; kinds: string[]; routines: boolean; expiresAt: string; revokedAt?: string };
type Row = { externalRef: string; date: string; kind: string; channel: string; category: string; description: string; amountKrw: number; vatKrw: number | null; status?: string };
type Batch = { id: string; digest: string; status: string; createdAt: string; expiresAt: string;
  input: { source: { system: string; accountRef: string; url: string; capturedAt: string }; lines: Row[] };
  preview?: { added: number; duplicates: number; conflicts: string[]; revenueKrw: number; expenseKrw: number; rows: Row[] } | null;
  result?: { added: number; duplicates: number; committedAt: string } };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}/oda/automation${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.error?.code ?? 'ODA_AUTOMATION_FAILED', result.error?.message ?? '자동화 정보를 불러오지 못했습니다.');
  return result as T;
}
const labels: Record<string, string> = { awaiting_approval: '검토 대기', approved: '승인 완료 · 반영 대기', committed: '반영 완료', rejected: '반려', new: '신규', duplicate: '기존과 동일 · 제외', conflict: '기존 자료와 다름', revenue: '매출', expense: '비용', pos: '매장 POS', baemin: '배달의민족', coupang: '쿠팡이츠', yogiyo: '요기요', ddangyo: '땡겨요', manual: '직접 수집' };
const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const dateTime = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
export function OdaAutomation({ storeId, month, canManage, onApplied }: { storeId: string; month: string; canManage: boolean; onApplied: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]); const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<Batch | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [name, setName] = useState('ORBIT · ASIDE'); const [revenue, setRevenue] = useState(true); const [expense, setExpense] = useState(true);
  const [routines, setRoutines] = useState(true); const [secret, setSecret] = useState('');
  const load = useCallback(async () => {
    const query = new URLSearchParams({ storeId, month });
    const [batchList, tokens] = await Promise.all([request<{ batches: Batch[] }>(`/batches?${query}`),
      canManage ? request<{ tokens: Connection[] }>(`/tokens?${new URLSearchParams({ storeId })}`) : Promise.resolve({ tokens: [] })]);
    setBatches(batchList.batches); setConnections(tokens.tokens);
  }, [storeId, month, canManage]);
  useEffect(() => { setSecret(''); setSelected(null); setError(''); let active = true;
    void load().catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [load]);
  async function perform(id: string, fn: () => Promise<void>) {
    if (busy) return; setBusy(id); setError('');
    try { await fn(); } catch (error) { setError(error instanceof Error ? error.message : '처리하지 못했습니다.'); } finally { setBusy(''); }
  }
  return <div className="oda-stack">
    <section className="oda-card"><div className="oda-card-head"><div><h2>자동 수집 → 확인 → 매출·비용 반영</h2><p>ORBIT·ASIDE가 수집한 거래를 원본 주소와 함께 확인합니다. 승인한 결과는 이 매장의 실제 월 정산에 반영됩니다.</p></div><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void perform('reload', load)}>새로고침</Button></div>
      <p className="oda-notice">같은 거래번호는 한 번만 반영합니다. 기존 금액과 다르거나 정산이 확정된 달이면 반영을 멈춥니다. 수집 기록은 원본 영수증을 대신하지 않으므로 비용 증빙은 별도로 확인해 주세요.</p>
      {error && <p className="oda-notice" role="alert">{error}</p>}
      {!batches.length ? <div className="oda-empty"><strong>수집 결과가 아직 없습니다</strong><p>연결 암호를 ORBIT에 등록하고 매출·비용 자료를 수집하면 이곳에서 검토할 수 있습니다.</p></div> : <div className="oda-evidence-list">{batches.map(batch => <div className="oda-evidence" key={batch.id}><div><strong>{batch.input.source.system} · {batch.input.lines.length}건</strong><small>{labels[batch.status]} · {dateTime(batch.createdAt)}<br />{batch.input.source.accountRef}{batch.result && ` · 신규 ${batch.result.added}건 / 중복 ${batch.result.duplicates}건`}</small></div><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void perform(batch.id, async () => { setSelected(await request<Batch>(`/batches/${batch.id}`)); })}>내역 확인</Button></div>)}</div>}
    </section>
    {selected && <section className="oda-card"><div className="oda-card-head"><div><h2>반영할 거래 확인</h2><p>{selected.input.source.system} · {labels[selected.status]} · 수집 {dateTime(selected.input.source.capturedAt)}</p></div><Button variant="secondary" onClick={() => setSelected(null)}>닫기</Button></div>
      <a href={selected.input.source.url} target="_blank" rel="noreferrer">원본 페이지 열기</a>
      {selected.preview && <p>신규 {selected.preview.added}건 · 중복 제외 {selected.preview.duplicates}건 · 매출 {won(selected.preview.revenueKrw)} · 비용 {won(selected.preview.expenseKrw)}</p>}
      {!!selected.preview?.conflicts.length && <p role="alert" className="oda-notice">기존 자료와 다른 거래가 있어 반영할 수 없습니다: {selected.preview.conflicts.join(', ')}</p>}
      <div style={{ overflowX: 'auto' }}><table className="oda-automation-table"><thead><tr><th>날짜·거래번호</th><th>유형·채널</th><th>내용</th><th>금액</th><th>부가세</th><th>확인</th></tr></thead><tbody>{(selected.preview?.rows ?? selected.input.lines).map(row => <tr key={`${row.kind}:${row.channel}:${row.externalRef}`}><td>{row.date}<small>{row.externalRef}</small></td><td>{labels[row.kind]}<small>{labels[row.channel]}</small></td><td>{row.description}<small>{row.category}</small></td><td>{won(row.amountKrw)}</td><td>{row.vatKrw === null ? '미확인' : won(row.vatKrw)}</td><td>{row.status ? labels[row.status] : '저장됨'}</td></tr>)}</tbody></table></div>
      {['awaiting_approval', 'approved'].includes(selected.status) && <div className="oda-policy-footer"><p>승인 시 표시된 신규 거래가 월 정산에 추가됩니다. 부가세·증빙 확인과 정산 확정은 별도입니다.</p><div className="oda-inline-tools"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void perform('reject', async () => { await request(`/batches/${selected.id}/reject`, {}); setSelected(null); await load(); })}>반려</Button><Button disabled={Boolean(busy) || !!selected.preview?.conflicts.length || !selected.preview || selected.expiresAt < new Date().toISOString()} onClick={() => void perform('approve', async () => {
        const saved = await request<Batch>(`/batches/${selected.id}/approve`, { digest: selected.digest, commit: true }); setSelected(saved); await load(); onApplied();
      })}>{busy === 'approve' ? '반영 중…' : '승인 후 반영'}</Button></div></div>}
    </section>}
    {canManage && <section className="oda-card"><div className="oda-card-head"><div><h2>ORBIT 연결 관리</h2><p>선택한 매장에만 유효한 연결 암호입니다. 30일 후 만료되며 언제든 폐기할 수 있습니다.</p></div></div>
      <div className="oda-automation-form"><label>연결 이름<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><div className="oda-inline-tools"><label><input type="checkbox" checked={revenue} onChange={event => setRevenue(event.target.checked)} /> 매출 수집</label><label><input type="checkbox" checked={expense} onChange={event => setExpense(event.target.checked)} /> 비용 수집</label><label><input type="checkbox" checked={routines} onChange={event => setRoutines(event.target.checked)} /> 서버 예약 실행</label></div>
        <Button disabled={Boolean(busy) || !name.trim() || !(revenue || expense || routines)} onClick={() => void perform('mint', async () => {
          const result = await request<{ token: string }>('/tokens', { name, storeIds: [storeId], kinds: [...(revenue ? ['revenue'] : []), ...(expense ? ['expense'] : [])], routines, expiresInDays: 30 }); setSecret(result.token); await load();
        })}>연결 암호 발급</Button>
      </div>
      {secret && <div className="oda-notice"><strong>지금 한 번만 표시됩니다</strong><p>ORBIT → ASIDE 실행 → ODA 연결에 붙여 넣으세요. 대화창이나 다른 사람에게 보내지 마세요.</p><input aria-label="새 ODA 연결 암호" readOnly type="password" value={secret} style={{ width: '100%' }} /><div className="oda-inline-tools"><Button variant="secondary" onClick={() => void perform('copy', async () => { await navigator.clipboard.writeText(secret); })}>암호 복사</Button><Button variant="secondary" onClick={() => setSecret('')}>표시 닫기</Button></div></div>}
      <div className="oda-evidence-list">{connections.map(connection => <div key={connection.id} className="oda-evidence"><div><strong>{connection.name}</strong><small>{connection.revokedAt ? '폐기됨' : connection.expiresAt < new Date().toISOString() ? '만료됨' : '사용 가능'} · {connection.kinds.map(kind => labels[kind]).join('·')}{connection.routines ? ' · 서버 예약' : ''}<br />만료 {dateTime(connection.expiresAt)}</small></div>{!connection.revokedAt && <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void perform(connection.id, async () => { await request(`/tokens/${connection.id}/revoke`, {}); setSecret(''); await load(); })}>연결 폐기</Button>}</div>)}</div>
    </section>}
  </div>;
}
