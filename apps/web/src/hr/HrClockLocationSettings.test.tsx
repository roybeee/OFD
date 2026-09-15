import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHrWorkspace } from '../../../../packages/domain/src/oda-hr';
import { HrClockLocationSettings } from './HrClockLocationSettings';
import { HrPersonnel } from './HrPersonnel';
import type { HrPanelProps } from './shared';

const location = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/hr-location', () => ({ getCurrentHrPosition: location.get }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function fixture(): HrPanelProps {
  return { workspace: createHrWorkspace('store-1', '매장', '2026-09-15T00:00:00Z'), actorId: 'manager', permissions: { manage: true, payroll: true, self: false },
    storeAddress: '서울특별시 중구 매장로 10', busy: false, mutate: vi.fn(async () => {}) };
}
function field(name: string): HTMLInputElement { return container.querySelector<HTMLInputElement>(`[name="${name}"]`)!; }
function form(): HTMLFormElement { return container.querySelector<HTMLFormElement>('form[aria-label="매장 출퇴근 위치 설정"]')!; }
async function fill(name: string, value: string): Promise<void> {
  const input = field(name); expect(input).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(row => row.textContent?.trim() === label); expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function submit(): Promise<void> {
  await act(async () => { form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('store clock location settings', () => {
  it('uses a precise current position as a preview and saves only after the explicit button', async () => {
    const props = fixture(); location.get.mockResolvedValue({ latitude: 37.5665, longitude: 126.978, accuracy: 50, timestamp: Date.now() });
    await act(async () => root.render(<HrClockLocationSettings {...props} />));
    expect(field('clockLocationAddress').value).toBe(props.storeAddress); expect(location.get).not.toHaveBeenCalled();
    await click('매장 현장의 현재 위치 사용');
    expect(field('clockLocationLatitude').value).toBe('37.5665'); expect(field('clockLocationLongitude').value).toBe('126.978');
    const link = container.querySelector<HTMLAnchorElement>('a')!;
    expect(new URL(link.href).searchParams.get('query')).toBe('37.5665,126.978'); expect(link.rel).toContain('noopener');
    expect(container.textContent).toContain('오차: 약 50m'); expect(props.mutate).not.toHaveBeenCalled();
    await click('이 위치를 매장 출퇴근 기준으로 저장');
    expect(props.mutate).toHaveBeenCalledExactlyOnceWith('attendance.location.set', { address: props.storeAddress, latitude: 37.5665, longitude: 126.978 });
    expect(container.textContent).toContain('허용 반경은 200m');
  });

  it('keeps manual location separate from the personnel form and prevents duplicate saves while pending', async () => {
    const props = fixture(); let finish!: () => void;
    props.mutate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => root.render(<HrPersonnel {...props} tab="settings" onTabChange={vi.fn()} />));
    expect(container.querySelectorAll('form')).toHaveLength(2); expect(container.querySelector('form form')).toBeNull();
    await fill('clockLocationAddress', '  직접 확인한 매장 주소  '); await fill('clockLocationLatitude', '-33.865'); await fill('clockLocationLongitude', '151.209');
    expect(location.get).not.toHaveBeenCalled(); expect(props.mutate).not.toHaveBeenCalled();
    await act(async () => { form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(props.mutate).toHaveBeenCalledExactlyOnceWith('attendance.location.set', { address: '직접 확인한 매장 주소', latitude: -33.865, longitude: 151.209 });
    expect(form().querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => finish()); expect(form().querySelector('fieldset')?.disabled).toBe(false);
  });

  it('rejects invalid coordinates and inaccurate or denied GPS without overwriting the entered point', async () => {
    const props = fixture(); await act(async () => root.render(<HrClockLocationSettings {...props} />));
    await fill('clockLocationLatitude', '91'); await fill('clockLocationLongitude', '127'); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('위도는 -90~90'); expect(props.mutate).not.toHaveBeenCalled();
    await fill('clockLocationLatitude', '37.5');
    location.get.mockResolvedValueOnce({ latitude: 38, longitude: 128, accuracy: 51, timestamp: Date.now() });
    await click('매장 현장의 현재 위치 사용');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('오차가 약 51m'); expect(field('clockLocationLatitude').value).toBe('37.5');
    location.get.mockRejectedValueOnce(new Error('위치 사용이 허용되지 않았습니다. 설정에서 위치 권한을 허용해 주세요.'));
    await click('매장 현장의 현재 위치 사용'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('위치 사용이 허용되지 않았습니다');
    expect(field('clockLocationLongitude').value).toBe('127'); expect(props.mutate).not.toHaveBeenCalled();
  });

  it('shows saved coordinates read-only without a location request or edit controls for staff', async () => {
    const props = fixture(); props.permissions = { manage: false, payroll: false, self: true };
    props.workspace.settings.clockLocation = { address: '저장된 매장 주소', latitude: 37.5, longitude: 127, radiusMeters: 200, updatedAt: '2026-09-15T00:00:00Z', updatedBy: 'manager' };
    await act(async () => root.render(<HrClockLocationSettings {...props} />));
    expect(container.textContent).toContain('저장된 매장 주소'); expect(container.textContent).toContain('200m · 고정');
    expect(container.querySelector('form')).toBeNull(); expect(container.querySelector('input')).toBeNull(); expect(container.querySelector('button')).toBeNull();
    expect(new URL(container.querySelector<HTMLAnchorElement>('a')!.href).searchParams.get('query')).toBe('37.5,127');
    expect(location.get).not.toHaveBeenCalled(); expect(props.mutate).not.toHaveBeenCalled();
  });
});
