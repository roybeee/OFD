import { Button } from '../components/ui';
import type { HrTab } from '../pages/OdaHrPage';

export function HrStaffHelp({ onTabChange, onHome, busy }: { onTabChange: (tab: HrTab) => void; onHome?: () => void; busy: boolean }) {
  const steps: Array<{ title: string; text: string; tab?: HrTab; action?: string }> = [
    { title: '매장과 내 계정 확인', text: '직원 홈에서 근무할 매장을 선택하세요. 계정 연결 안내가 나오면 관리자에게 매장 배정과 직원 정보의 로그인 계정 연결을 요청하세요.' },
    { title: '매장에 도착해 출근 등록', text: '직원 홈에서 출근하기를 누르고 위치 접근을 허용하세요. 저장된 매장 기준점에서 위치 오차까지 포함해 200m 이내일 때 등록됩니다. 앱을 열기만 하면 출근이 기록되지는 않습니다.', action: '직원 홈에서 출퇴근' },
    { title: '당월 근무표와 매장 공지 확인', text: '직원 홈의 근무 일정에서 나 또는 매장을 선택하고 날짜를 누르면 게시된 근무·휴무 일정을 확인할 수 있습니다. 공지 제목을 누르면 본문이 펼쳐집니다. 매장 밖에서도 확인할 수 있습니다.', action: '직원 홈에서 일정·공지 확인' },
    { title: '근무를 마치고 퇴근 등록', text: '매장을 떠나기 전에 퇴근하기를 누르세요. 퇴근도 새 위치를 확인합니다. 기록에 문제가 있으면 근무 기록에서 수동 정정을 요청하고 관리자 승인을 받으세요.', tab: 'attendance', action: '내 근무 기록 열기' },
    { title: '휴가 신청과 결과 확인', text: '휴가에서 사용할 날짜와 시간을 신청하고 승인 상태를 확인하세요. 신청만으로 승인이 완료되지는 않습니다.', tab: 'leave', action: '내 휴가 열기' },
    { title: '급여 명세와 개인 문서 확인', text: '담당자가 확정하고 공개한 급여 명세를 확인할 수 있습니다. 개인 문서와 전체 공개 규정은 문서함에서 확인하세요.', tab: 'payroll', action: '내 급여 열기' },
  ];
  const questions = [
    ['위치를 허용하지 않았거나 위치를 찾지 못해요.', '휴대폰의 위치 서비스를 켜고, 앱을 연 브라우저의 사이트 설정에서 위치 접근을 허용해 주세요. 앱으로 돌아와 위치 다시 확인을 누르세요. 실내에서 계속 실패하면 매장 가까운 창가나 출입구에서 다시 확인하세요.'],
    ['매장 안인데 반경 밖이거나 위치 오차가 크다고 나와요.', '위치 오차가 50m 이하이고, 매장까지의 거리와 오차를 합쳐 200m 이내여야 합니다. 위치 다시 확인을 눌러 재측정하세요. 계속 반경 밖으로 표시되면 관리자에게 저장된 매장 기준 위치 확인을 요청하세요.'],
    ['출근하기 버튼이 비활성화되어 있어요.', '직원 정보와 로그인 계정이 연결되어 있고 매장 기준 위치가 저장되어야 합니다. 화면에 표시된 연결 또는 위치 설정 안내를 관리자에게 전달하세요. 정보를 불러오는 중이거나 오류가 있으면 새로고침 후 확인하세요.'],
    ['출퇴근을 눌렀는데 응답이 없거나 오류가 났어요.', '새로고침 후 현재 출퇴근 상태와 근무 기록을 먼저 확인하세요. 통신 오류가 나도 서버에 기록되었을 수 있습니다. 확인 없이 다시 누르면 다음 출퇴근 동작이 기록될 수 있습니다.'],
    ['퇴근을 잊었거나 기록을 수정해야 해요.', '내 근무 기록에서 날짜와 시간을 확인하고 정정 사유를 적어 요청하세요. 직원이 수동으로 입력하거나 수정한 근무는 관리자 승인 후 반영됩니다.'],
    ['근무표나 급여가 보이지 않아요.', '선택한 매장과 월을 확인하세요. 직원에게는 게시된 근무표와 확정·공개된 본인 급여만 보입니다. 관리자에게 게시 상태와 계정 연결을 확인해 달라고 요청하세요.'],
  ];
  return <>
    <section className="hr-card hr-staff-help" aria-label="직원 이용 안내"><div className="hr-section-heading"><div><h2>직원 이용 안내</h2><p>출퇴근 등록부터 근무표와 내 인사 정보 확인까지</p></div></div>
      {steps.map((step, index) => <article className="hr-help-step" key={step.title}><span className="hr-help-number">{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p>
        {step.action && (step.tab || onHome) && <Button disabled={busy} variant="secondary" onClick={() => step.tab ? onTabChange(step.tab) : onHome?.()}>{step.action}</Button>}
      </div></article>)}
      <Button disabled={busy} variant="secondary" onClick={() => onTabChange('documents')}>내 문서함 열기</Button>
    </section>
    <section className="hr-card hr-staff-help" aria-label="출퇴근 자주 묻는 질문"><h2>출퇴근 자주 묻는 질문</h2><div className="hr-staff-faq">{questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
  </>;
}
