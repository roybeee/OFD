import type { HrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { Button } from '../components/ui';
import type { HrTab } from '../pages/OdaHrPage';
import { hrToday } from './shared';

type Props = {
  workspace: HrWorkspace;
  accounts: ReadonlyArray<{ id: string }>;
  busy: boolean;
  onTabChange: (tab: HrTab) => void;
};

/** Readiness uses saved data only. Opening this card never changes HR records. */
export function HrStaffSetup({ workspace: w, accounts, busy, onTabChange }: Props) {
  const today = hrToday();
  const month = today.slice(0, 7);
  const employees = w.employees.filter(row => row.status === 'active' && row.hireDate <= today);
  const linked = employees.filter(row => accounts.some(account => account.id === row.actorId));
  const missing = employees.filter(row => !linked.includes(row));
  const published = w.attendance.shifts.filter(row => row.status === 'published' && row.date.startsWith(`${month}-`) && employees.some(employee => employee.id === row.employeeId));
  const scheduled = new Set(published.map(row => row.employeeId)).size;
  const notices = w.notices.filter(row => row.status === 'published');
  const location = w.settings.clockLocation;
  const rows: Array<{ title: string; state: string; detail: string; tab: HrTab; action: string; ready: boolean }> = [
    { title: '출퇴근 기준 위치', state: location ? '저장됨' : '설정 필요', detail: location ? `${location.address} · 반경 200m` : '매장 현장에서 위치를 확인하거나 검증한 좌표를 저장하세요.', tab: 'settings', action: '출퇴근 위치 설정', ready: Boolean(location) },
    { title: '직원 로그인 계정', state: `${linked.length}/${employees.length}명 연결`, detail: !employees.length ? '근무를 시작한 재직 직원을 등록하고 로그인 계정을 연결하세요.' : missing.length ? `연결 확인 필요: ${missing.slice(0, 3).map(row => row.name).join(', ')}${missing.length > 3 ? ` 외 ${missing.length - 3}명` : ''}. 해당 매장의 활성 계정인지 확인하세요.` : '재직 직원 모두 해당 매장의 활성 로그인 계정과 연결되어 있습니다.', tab: 'people', action: '직원 계정 연결 확인', ready: employees.length > 0 && missing.length === 0 },
    { title: `${Number(month.slice(5))}월 근무표`, state: `${scheduled}/${employees.length}명 게시`, detail: `게시된 근무·휴무 일정 ${published.length}건. 초안은 직원에게 보이지 않습니다.`, tab: 'shifts', action: '당월 근무표 관리', ready: employees.length > 0 && scheduled === employees.length },
    { title: '매장 공지', state: `${notices.length}건 게시`, detail: notices.length ? '게시된 공지를 직원 홈에서 확인할 수 있습니다.' : '공유할 소식이 있으면 공지를 작성하고 게시하세요.', tab: 'overview', action: '매장 공지 보기', ready: notices.length > 0 },
  ];
  function open(row: typeof rows[number]) {
    if (row.tab === 'overview') document.getElementById('hr-store-notices')?.scrollIntoView?.({ block: 'start' });
    else onTabChange(row.tab);
  }
  return <section className="hr-card hr-staff-setup" aria-label="직원 화면 준비 현황">
    <div className="hr-section-heading"><div><h2>직원 화면 준비 현황</h2><p>선택한 매장의 저장된 설정과 게시 상태입니다.</p></div></div>
    <ul>{rows.map(row => <li key={row.title}>
      <div><h3>{row.title}<span className={row.ready ? 'hr-setup-ready' : 'hr-setup-pending'}>{row.state}</span></h3><p>{row.detail}</p></div>
      <Button variant="secondary" disabled={busy} onClick={() => open(row)}>{row.action}</Button>
    </li>)}</ul>
    <p className="hr-note">직원 휴대폰의 위치 허용은 각 기기에서 설정합니다. 근무표와 공지는 매장 밖에서도 확인할 수 있습니다.</p>
  </section>;
}
