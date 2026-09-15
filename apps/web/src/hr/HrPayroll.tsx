import { useEffect, useState } from 'react';
import { calculateHrPayrollRow, calculateHrPayrollRun, exportHrPayrollCsv, getHrPayrollStateForContext, type HrPayrollRow, type HrPayrollRun } from '../../../../packages/domain/src/oda-hr-payroll';
import { Button } from '../components/ui';
import { applyOdaHrPayrollCost, getOdaHrPayrollCost, type HrPayrollCostPreview } from '../api/oda-hr-client';
import { HrDialog, HrEmpty, hrError, hrToday, type HrPanelProps } from './shared';

const krw = (value: number | null): string => value === null ? '검토 전' : `${value.toLocaleString('ko-KR')}원`;
const duration = (minutes: number): string => `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
const statusName = { draft: '작성 중', reviewed: '검토 완료', locked: '확정·잠금', published: '공개' } as const;
type ManualFields = { incomeTax: string; localTax: string; employeeInsurance: string; employerInsurance: string; note: string; manualConfirmed: boolean };
const manualLabels = { incomeTax: '소득세', localTax: '지방소득세', employeeInsurance: '근로자 부담 보험료', employerInsurance: '회사 부담 보험료' } as const;

export function HrPayroll(props: HrPanelProps) {
  const { workspace, permissions, busy: workspaceBusy, actorId, employeeId, mutate } = props;
  const [costBusy, setCostBusy] = useState(false);
  const busy = workspaceBusy || costBusy;
  const [costOpen, setCostOpen] = useState(false);
  const [costPreview, setCostPreview] = useState<HrPayrollCostPreview | null>(null);
  const [costError, setCostError] = useState('');
  const [costDone, setCostDone] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date().toISOString()), 30_000); return () => window.clearInterval(timer); }, []);
  const context = { actorId, ...(employeeId ? { employeeId } : {}), manager: permissions.manage, payroll: permissions.payroll, today: hrToday(), now, id: () => '' };
  const visible = getHrPayrollStateForContext(workspace.payroll, context);
  const runs = [...visible.runs].sort((a, b) => b.month.localeCompare(a.month));
  const [selectedId, setSelectedId] = useState('');
  const run = runs.find(item => item.id === selectedId) ?? runs[0];
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [month, setMonth] = useState(hrToday().slice(0, 7));
  const [payDate, setPayDate] = useState(hrToday());
  const [title, setTitle] = useState('');
  const [proration, setProration] = useState<'calendar' | 'full'>('calendar');
  const [editingEmployee, setEditingEmployee] = useState('');
  const editingRow = run?.rows.find(row => row.employeeId === editingEmployee);
  const [manual, setManual] = useState<ManualFields>({ incomeTax: '', localTax: '', employeeInsurance: '', employerInsurance: '', note: '', manualConfirmed: false });
  const [kind, setKind] = useState<'allowance' | 'deduction'>('allowance');
  const [category, setCategory] = useState<'manual' | 'unpaid_leave'>('manual');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [addEmployeeId, setAddEmployeeId] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishTime, setPublishTime] = useState('');

  async function send(type: string, input: Record<string, unknown>, success?: () => void) {
    setError('');
    try { await mutate(type, input); success?.(); } catch (cause) { setError(hrError(cause)); }
  }
  function command(type: string, input: Record<string, unknown> = {}, success?: () => void) {
    if (run) void send(type, { runId: run.id, revision: run.revision, ...input }, success);
  }
  function openRow(row: HrPayrollRow) {
    setManual({ incomeTax: row.incomeTax?.toString() ?? '', localTax: row.localTax?.toString() ?? '', employeeInsurance: row.employeeInsurance?.toString() ?? '', employerInsurance: row.employerInsurance?.toString() ?? '', note: row.note, manualConfirmed: row.manualConfirmed });
    setKind('allowance'); setCategory('manual'); setLabel(''); setAmount(''); setError(''); setEditingEmployee(row.employeeId);
  }
  function download(target: HrPayrollRun) {
    try {
      const blob = new Blob([exportHrPayrollCsv(target, context)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `ODA_급여_${target.month}.csv`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setError(hrError(cause)); }
  }
  async function loadCost() {
    if (!run || busy) return;
    setCostOpen(true); setCostPreview(null); setCostError(''); setCostDone(false); setCostBusy(true);
    try { setCostPreview(await getOdaHrPayrollCost(workspace.storeId, run.month)); }
    catch (cause) { setCostError(hrError(cause)); }
    finally { setCostBusy(false); }
  }
  async function applyCost() {
    if (!costPreview?.canApply || busy) return;
    setCostError(''); setCostBusy(true);
    try {
      const updated = await applyOdaHrPayrollCost(workspace.storeId, costPreview);
      setCostPreview(updated); setCostDone(true);
      await props.onReload?.();
    } catch (cause) {
      setCostError(hrError(cause));
      // A stale preview never silently retries a write; the user must review fresh values first.
      setCostPreview(null);
      try { await props.onReload?.(); } catch { /* Parent keeps its explicit recovery state. */ }
    } finally { setCostBusy(false); }
  }
  const totals = run ? calculateHrPayrollRun(run) : undefined;
  const editable = permissions.payroll && run?.status === 'draft';
  const candidates = workspace.employees.filter(employee => !run?.rows.some(row => row.employeeId === employee.id) && employee.hireDate <= `${run?.month ?? month}-31` && (!employee.endDate || employee.endDate >= `${run?.month ?? month}-01`));
  const scheduled = run?.status === 'published' && Boolean(run.publishedAt && run.publishedAt > now);

  return <div className="hr-grid">
    <section className="hr-card">
      <div className="hr-section-heading"><div><h2>{permissions.payroll ? '급여 정산' : '내 급여명세서'}</h2><p className="hr-muted">{permissions.payroll ? '인사·근태를 반영한 급여를 검토하고 구성원에게 공개합니다.' : '공개된 본인 급여를 확인하고 내려받을 수 있습니다.'}</p></div>
        {permissions.payroll && <Button type="button" disabled={busy} onClick={() => { setError(''); setCreateOpen(true); }}>급여 초안 만들기</Button>}
      </div>
      {error && <p className="hr-error" role="alert">{error}</p>}
      {runs.length > 0 && <div className="hr-toolbar"><label>귀속월<select aria-label="급여 귀속월" value={run?.id ?? ''} onChange={event => { setSelectedId(event.target.value); setEditingEmployee(''); }}>
        {runs.map(item => <option value={item.id} key={item.id}>{item.month} · {item.title} · {statusName[item.status]}</option>)}
      </select></label><Button type="button" variant="secondary" onClick={() => run && download(run)} disabled={busy}>급여 CSV 내려받기</Button></div>}
      {!run && <HrEmpty title={permissions.payroll ? '아직 급여 초안이 없습니다' : '공개된 급여명세서가 없습니다'}>{permissions.payroll ? '구성원의 급여 유형과 기본금액을 확인한 뒤 귀속월 급여를 만드세요.' : '급여 담당자가 공개하면 이곳에서 확인할 수 있습니다.'}</HrEmpty>}
      {run && totals && <>
        <div className="hr-section-heading"><div><h3>{run.title}</h3><p className="hr-muted">지급일 {run.payDate} · 대상 {run.rows.length}명 · <span className="hr-badge">{scheduled ? '공개 예약' : statusName[run.status]}</span></p></div></div>
        <div className="hr-metrics">
          <div className="hr-metric"><span>총 지급</span><strong>{krw(totals.gross)}</strong></div>
          <div className="hr-metric"><span>공제 합계{totals.net === null ? ' · 입력분' : ''}</span><strong>{krw(totals.deductions)}</strong></div>
          <div className="hr-metric"><span>실지급</span><strong>{krw(totals.net)}</strong></div>
          {permissions.payroll && <div className="hr-metric"><span>인건비 · {totals.net === null ? '입력분 기준' : '회사 보험 포함'}</span><strong>{krw(totals.laborCost)}</strong></div>}
        </div>
        {permissions.payroll && <p className="hr-muted">월급은 {run.proration === 'calendar' ? '월력일수에 따른 재직기간 비례' : '부분월도 월 전액'} 기준입니다. 시급은 승인된 근무와 유급휴가 시간을 합산합니다. 세액·보험은 직접 입력하며 0원도 확인해야 합니다.</p>}
        <div className="hr-table-wrap"><table className="hr-table"><thead><tr><th>구성원</th><th>기본급 계산</th><th>총 지급</th><th>공제</th><th>실지급</th>{permissions.payroll && <th>검토</th>}<th>명세</th></tr></thead><tbody>
          {run.rows.map(row => { const result = calculateHrPayrollRow(row); return <tr key={row.employeeId}>
            <td><strong>{row.name}</strong><div className="hr-muted">{row.employeeNumber}</div></td>
            <td>{row.segments.length > 1 ? `적용일별 ${row.segments.length}개 구간 합산` : row.payType === 'hourly' ? `시급 ${krw(row.basePay)} × ${duration(row.recognizedMinutes + row.paidLeaveMinutes)}` : `${krw(row.basePay)}${run.proration === 'calendar' ? ` × ${row.payableDays}/${row.calendarDays}일` : ' · 전액'}`}<div className="hr-muted">{row.periodStart} ~ {row.periodEnd}</div></td>
            <td>{krw(result.gross)}</td><td>{krw(result.deductions)}{result.net === null && <div className="hr-muted">입력된 공제만</div>}</td><td>{krw(result.net)}</td>
            {permissions.payroll && <td>{!row.attendanceLocked ? '근태 마감 필요' : row.pendingCount ? '미처리 근태 있음' : !row.manualConfirmed ? '세액·보험 확인 필요' : '확인 완료'}{row.employmentStatus === 'leave' && <div className="hr-muted">휴직 지급기준 확인</div>}</td>}
            <td><Button type="button" variant="secondary" disabled={busy} onClick={() => openRow(row)}>{editable ? '입력·검토' : '상세 보기'}</Button></td>
          </tr>; })}
        </tbody></table></div>
        {permissions.payroll && <>
          {editable && <form className="hr-toolbar" onSubmit={event => { event.preventDefault(); command('payroll.addEmployee', { employeeId: addEmployeeId }, () => setAddEmployeeId('')); }}><label>대상 추가<select value={addEmployeeId} onChange={event => setAddEmployeeId(event.target.value)}><option value="">구성원 선택</option>{candidates.map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.employeeNumber}</option>)}</select></label><Button type="submit" variant="secondary" disabled={busy || !addEmployeeId}>대상 추가</Button></form>}
          <div className="hr-actions">
            {editable && <><Button type="button" variant="secondary" disabled={busy} onClick={() => command('payroll.refresh')}>최신 인사·근태 반영</Button><Button type="button" disabled={busy || !run.rows.length} onClick={() => command('payroll.review')}>검토 완료</Button></>}
            {run.status === 'reviewed' && <Button type="button" disabled={busy} onClick={() => command('payroll.lock')}>확정·잠금</Button>}
            {run.status === 'locked' && <Button type="button" disabled={busy} onClick={() => { setPublishTime(''); setPublishOpen(true); }}>명세서 공개</Button>}
            {run.status !== 'draft' && <Button type="button" variant="secondary" disabled={busy} onClick={() => { setReason(''); setReopenOpen(true); }}>수정 재개</Button>}
            {(run.status === 'locked' || run.status === 'published') && <Button type="button" variant="secondary" disabled={busy} onClick={() => void loadCost()}>월 정산 인건비 미리보기</Button>}
          </div>
          {scheduled && <p className="hr-muted">공개 예정: {new Date(run.publishedAt!).toLocaleString('ko-KR')} · 예정 시각부터 본인에게 표시됩니다.</p>}
          {editable && <p className="hr-muted">인사·근태를 바꿨다면 최신정보를 반영하세요. 대상기간 근태 마감과 세액·보험 검토가 끝나야 확정할 수 있습니다.</p>}
          {run.history.length > 0 && <details><summary>확정·재개 이력 {run.history.length}건</summary><ul className="hr-list">{[...run.history].reverse().map((entry, index) => <li key={`${entry.revision}-${index}`}>{entry.at.slice(0, 10)} · v{entry.revision} · {entry.reason} · 총 지급 {krw(entry.totals.gross)}</li>)}</ul></details>}
        </>}
      </>}
    </section>

    {createOpen && <HrDialog title="급여 초안 만들기" busy={busy} onClose={() => setCreateOpen(false)}><form className="hr-form" onSubmit={event => { event.preventDefault(); void send('payroll.create', { month, payDate, title, proration }, () => { setCreateOpen(false); setSelectedId(''); }); }}>
      {error && <p className="hr-error" role="alert">{error}</p>}
      <div className="hr-form-grid"><label>귀속월<input type="month" required value={month} onChange={event => setMonth(event.target.value)} /></label><label>지급일<input type="date" required value={payDate} onChange={event => setPayDate(event.target.value)} /></label></div>
      <label>명세서 제목<input maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder={`${month} 급여명세서`} /></label>
      <label>월급제 부분월 계산<select value={proration} onChange={event => setProration(event.target.value as 'calendar' | 'full')}><option value="calendar">재직일수 ÷ 해당 월 일수</option><option value="full">재직기간과 관계없이 월 전액</option></select></label>
      <p className="hr-muted">귀속월의 입사일·퇴직일을 반영해 대상을 정합니다. 지급률·주휴수당·추가수당은 확인 후 직접 조정하세요.</p>
      <Button type="submit" disabled={busy}>초안 생성</Button>
    </form></HrDialog>}

    {editingRow && run && <HrDialog title={`${editingRow.name} · 급여명세`} busy={busy} onClose={() => setEditingEmployee('')}>
      {error && <p className="hr-error" role="alert">{error}</p>}
      <p>{editingRow.segments.length > 1 ? '마지막 구간 ' : ''}{editingRow.payType === 'hourly' ? '시급' : '월급'} {krw(editingRow.basePay)} · 기본급 합계 {krw(editingRow.baseAmount)}</p>
      {editingRow.segments.length > 1 && <ul className="hr-list">{editingRow.segments.map(segment => <li key={segment.startDate}>{segment.startDate} ~ {segment.endDate} · {segment.payType === 'hourly' ? '시급' : '월급'} {krw(segment.basePay)} · {segment.payType === 'hourly' ? duration(segment.recognizedMinutes + segment.paidLeaveMinutes) : `${segment.payableDays}일`} → {krw(segment.baseAmount)}</li>)}</ul>}
      <p className="hr-muted">인정근무 {duration(editingRow.recognizedMinutes)} · 유급휴가 {duration(editingRow.paidLeaveMinutes)} · 무급휴가 {duration(editingRow.unpaidLeaveMinutes)}{editingRow.payType === 'hourly' ? ' (별도 차감 없음)' : ''}</p>
      <h3>수당·공제 항목</h3>
      {!editingRow.adjustments.length && <p className="hr-muted">추가 항목 없음</p>}
      <ul className="hr-list">{editingRow.adjustments.map(item => <li key={item.id}><span>{item.kind === 'allowance' ? '지급' : '공제'} · {item.label} · {krw(item.amount)}</span>{editable && <Button type="button" variant="ghost" disabled={busy} onClick={() => command('payroll.removeAdjustment', { employeeId: editingRow.employeeId, adjustmentId: item.id }, () => setManual(previous => ({ ...previous, manualConfirmed: false })))}>삭제</Button>}</li>)}</ul>
      {editable && <form className="hr-form" onSubmit={event => { event.preventDefault(); command('payroll.addAdjustment', { employeeId: editingRow.employeeId, kind, category, label, amount: Number(amount) }, () => { setLabel(''); setAmount(''); setManual(previous => ({ ...previous, manualConfirmed: false })); }); }}>
        <div className="hr-form-grid"><label>항목 구분<select value={kind} onChange={event => { setKind(event.target.value as 'allowance' | 'deduction'); setCategory('manual'); }}><option value="allowance">수당 지급</option><option value="deduction">수동 공제</option></select></label><label>이름<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} /></label><label>금액<input type="number" min={1} max={1_000_000_000} step={1} required value={amount} onChange={event => setAmount(event.target.value)} /></label></div>
        {kind === 'deduction' && editingRow.segments.every(segment => segment.payType === 'monthly') && <label>공제 사유<select value={category} onChange={event => setCategory(event.target.value as 'manual' | 'unpaid_leave')}><option value="manual">기타 공제</option><option value="unpaid_leave">무급휴가</option></select></label>}
        <Button type="submit" variant="secondary" disabled={busy}>항목 추가</Button>
      </form>}
      <h3>세액·보험</h3>
      {editable ? <form className="hr-form" onSubmit={event => { event.preventDefault(); command('payroll.updateRow', { employeeId: editingRow.employeeId, ...manual, incomeTax: Number(manual.incomeTax), localTax: Number(manual.localTax), employeeInsurance: Number(manual.employeeInsurance), employerInsurance: Number(manual.employerInsurance) }, () => setEditingEmployee('')); }}>
        <p className="hr-muted">확인한 금액을 직접 입력하세요. 해당 금액이 없으면 0을 입력합니다.</p>
        <div className="hr-form-grid">{(Object.keys(manualLabels) as (keyof typeof manualLabels)[]).map(key => <label key={key}>{manualLabels[key]}<input required type="number" min={0} max={1_000_000_000} step={1} value={manual[key]} onChange={event => setManual(previous => ({ ...previous, [key]: event.target.value, manualConfirmed: false }))} /></label>)}</div>
        <label>검토 메모<textarea maxLength={1000} value={manual.note} onChange={event => setManual(previous => ({ ...previous, note: event.target.value }))} placeholder="휴직 지급기준, 세액·보험 확인 근거 등" /></label>
        <label><input type="checkbox" checked={manual.manualConfirmed} onChange={event => setManual(previous => ({ ...previous, manualConfirmed: event.target.checked }))} /> 수당·공제와 세액·보험 금액을 확인했습니다</label>
        <div className="hr-actions"><Button type="submit" disabled={busy}>입력 저장</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => command('payroll.removeEmployee', { employeeId: editingRow.employeeId }, () => setEditingEmployee(''))}>이 정산에서 제외</Button></div>
      </form> : <><dl>{(Object.keys(manualLabels) as (keyof typeof manualLabels)[]).map(key => <div key={key}><dt>{manualLabels[key]}</dt><dd>{krw(editingRow[key])}</dd></div>)}</dl><p><strong>실지급 {krw(calculateHrPayrollRow(editingRow).net)}</strong></p></>}
    </HrDialog>}

    {reopenOpen && run && <HrDialog title="급여 수정 재개" busy={busy} onClose={() => setReopenOpen(false)}><form className="hr-form" onSubmit={event => { event.preventDefault(); command('payroll.reopen', { reason }, () => setReopenOpen(false)); }}>{error && <p className="hr-error" role="alert">{error}</p>}<p>기존 확정본은 이력에 남습니다. 공개 명세서는 다시 확정·공개할 때까지 구성원에게 표시되지 않습니다.</p><label>변경 사유<textarea required minLength={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label><Button type="submit" disabled={busy || reason.trim().length < 3}>사유 기록 후 재개</Button></form></HrDialog>}
    {publishOpen && run && <HrDialog title="급여명세서 공개" busy={busy} onClose={() => setPublishOpen(false)}><form className="hr-form" onSubmit={event => { event.preventDefault(); command('payroll.publish', publishTime ? { publishAt: new Date(publishTime).toISOString() } : {}, () => setPublishOpen(false)); }}>{error && <p className="hr-error" role="alert">{error}</p>}<p>구성원에게 본인의 확정 명세서를 공개합니다.</p><label>공개 시각 · 비우면 즉시<input type="datetime-local" value={publishTime} onChange={event => setPublishTime(event.target.value)} /></label><Button type="submit" disabled={busy}>{publishTime ? '공개 예약' : '지금 공개'}</Button></form></HrDialog>}
    {costOpen && <HrDialog title="월 정산 인건비 반영" busy={busy} onClose={() => setCostOpen(false)}>
      {costBusy && <p role="status">인사·월 정산을 확인하고 있습니다.</p>}
      {costError && <p className="hr-error" role="alert">{costError}</p>}
      {costDone && <p role="status">월 정산 인건비 반영을 확인했습니다.</p>}
      {costPreview && <>
        <p><strong>{costPreview.month} 귀속 · {workspace.settings.companyName}</strong></p>
        <dl><div><dt>확정급여 총지급</dt><dd>{krw(costPreview.gross)}</dd></div><div><dt>회사 부담 보험료</dt><dd>{krw(costPreview.employerInsurance)}</dd></div><div><dt>반영할 인건비 합계</dt><dd><strong>{krw(costPreview.total)}</strong></dd></div><div><dt>현재 HR 인건비 반영액</dt><dd>{krw(costPreview.currentAmount)}</dd></div></dl>
        {costPreview.otherLaborCount > 0 && <p>다른 인건비 {costPreview.otherLaborCount}건 · {krw(costPreview.otherLaborAmount)}</p>}
        <p className="hr-muted">작성 중인 월 정산의 HR 인건비 한 줄에 반영합니다. 이전 합계 증빙은 보존하며 직원별 급여는 전달하지 않습니다.</p>
        {costPreview.blockers.length > 0 && <ul className="hr-list">{costPreview.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
        {costPreview.alreadyApplied && <p>현재 확정급여가 이미 반영되어 있습니다.</p>}
        <Button type="button" disabled={busy || !costPreview.canApply} onClick={() => void applyCost()}>월정산 인건비에 반영</Button>
      </>}
      {!costPreview && !costBusy && <Button type="button" variant="secondary" onClick={() => void loadCost()}>미리보기 다시 확인</Button>}
    </HrDialog>}
  </div>;
}
