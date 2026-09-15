import { CalendarDays, CheckCircle2, FileCheck2, LayoutGrid } from '../components/icons';

export const staffHomeTabs = ['today', 'schedule', 'tasks', 'more'] as const;
export type StaffHomeTab = typeof staffHomeTabs[number];
export function StaffBottomNav({ active, onSelect, disabled = false }: { active: StaffHomeTab; onSelect: (tab: StaffHomeTab) => void; disabled?: boolean }) {
  const tabs = [ ['today', '오늘', FileCheck2], ['schedule', '일정', CalendarDays], ['tasks', '할 일', CheckCircle2], ['more', '더 보기', LayoutGrid] ] as const;
  return <nav className="staff-bottom-nav" aria-label="직원 앱 메뉴">{tabs.map(([id, label, Icon]) => <button type="button" key={id} aria-current={active === id ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(id)}><Icon size={23} aria-hidden="true" /><span>{label}</span></button>)}</nav>;
}
