import type { HrCommand, HrContext, HrWorkspace } from './oda-hr.ts';
import { hrDate, hrEnum, hrFail, hrText } from './oda-hr-utils.ts';
export interface HrStoreCheck { id: string; date: string; phase: 'open' | 'close'; taskKey: string; label: string; done: boolean; completedBy?: string; completedAt?: string }
export interface HrStoreHandover { id: string; date: string; body: string; category: 'general' | 'stock' | 'facility' | 'cash'; authorId: string; authorName: string; createdAt: string; resolved: boolean; resolvedBy?: string; resolvedAt?: string; hasPhoto: boolean }
export interface HrStoreOperations { checks: HrStoreCheck[]; handovers: HrStoreHandover[] }
export const HR_STORE_CHECKLIST: ReadonlyArray<{ taskKey: string; label: string; phase: 'open' | 'close' }> = [
  { taskKey: 'open_clean', label: '매장 청결·위생 점검', phase: 'open' },
  { taskKey: 'open_stock', label: '원재료·상품 재고 확인', phase: 'open' },
  { taskKey: 'open_equipment', label: '설비·POS 작동 확인', phase: 'open' },
  { taskKey: 'close_cash', label: '매출·현금 마감 확인', phase: 'close' },
  { taskKey: 'close_stock', label: '폐기·잔여 재고 기록', phase: 'close' },
  { taskKey: 'close_safety', label: '청소·전원·잠금 확인', phase: 'close' },
];
export function createHrStoreOperations(): HrStoreOperations { return { checks: [], handovers: [] }; }
function keys(input: Record<string, unknown>, allowed: string[]) { if (Object.keys(input).some(k => !allowed.includes(k))) hrFail('지원하지 않는 매장 업무 입력 항목입니다.'); }
function bool(input: Record<string, unknown>, key: string): boolean { if (typeof input[key] !== 'boolean') hrFail('참/거짓 값을 입력해 주세요.'); return input[key] as boolean; }
export function canUseHrOperations(workspace: HrWorkspace, ctx: HrContext): boolean {
  return ctx.operationsAllowed !== false && (ctx.manager || Boolean(ctx.employeeId && workspace.employees.some(e => e.id === ctx.employeeId && e.status === 'active')));
}
export function applyHrOperationsCommand(workspace: HrWorkspace, command: HrCommand, ctx: HrContext): boolean {
  if (!command.type.startsWith('operations.')) return false;
  if (!canUseHrOperations(workspace, ctx)) hrFail('재직 구성원과 매장 관리자만 매장 업무를 사용할 수 있습니다.', 'HR_FORBIDDEN', 403);
  const state = workspace.operations ??= createHrStoreOperations(); const input = command.input;
  switch (command.type) {
    case 'operations.check': {
      keys(input, ['date', 'phase', 'taskKey', 'done']);
      const date = hrDate(input, 'date'), phase = hrEnum(input, 'phase', ['open', 'close']), taskKey = hrText(input, 'taskKey', 80), done = bool(input, 'done');
      if (date > ctx.today) hrFail('미래 날짜의 점검을 완료할 수 없습니다.');
      const task = HR_STORE_CHECKLIST.find(t => t.taskKey === taskKey && t.phase === phase); if (!task) hrFail('점검 항목이 올바르지 않습니다.');
      const id = `${date}:${phase}:${taskKey}`, existing = state.checks.find(c => c.id === id);
      const row: HrStoreCheck = { id, date, phase, taskKey, label: task.label, done, ...(done ? { completedBy: ctx.actorId, completedAt: ctx.now } : {}) };
      if (existing) state.checks[state.checks.indexOf(existing)] = row;
      else { if (state.checks.length >= 30000) hrFail('점검 기록 보관 한도에 도달했습니다.'); state.checks.push(row); }
      return true;
    }
    case 'operations.handover.create': {
      keys(input, ['date', 'body', 'category']); const date = hrDate(input, 'date');
      if (date > ctx.today) hrFail('미래 날짜의 인수인계를 등록할 수 없습니다.');
      if (state.handovers.length >= 10000) hrFail('인수인계 보관 한도에 도달했습니다.');
      state.handovers.push({ id: ctx.id(), date, body: hrText(input, 'body', 3000), category: hrEnum(input, 'category', ['general', 'stock', 'facility', 'cash']),
        authorId: ctx.actorId, authorName: workspace.employees.find(e => e.id === ctx.employeeId)?.name ?? '매장 관리자', createdAt: ctx.now, resolved: false, hasPhoto: false }); return true;
    }
    case 'operations.handover.resolve': {
      keys(input, ['id', 'resolved']); if (!ctx.manager) hrFail('관리자만 해결 상태를 변경할 수 있습니다.', 'HR_FORBIDDEN', 403);
      const row = state.handovers.find(h => h.id === hrText(input, 'id', 120)); if (!row) hrFail('인수인계를 찾을 수 없습니다.', 'HR_HANDOVER_NOT_FOUND', 404);
      row.resolved = bool(input, 'resolved'); if (row.resolved) { row.resolvedBy = ctx.actorId; row.resolvedAt = ctx.now; } else { delete row.resolvedBy; delete row.resolvedAt; } return true;
    }
    default: return false;
  }
}
