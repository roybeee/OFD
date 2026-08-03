import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepUpDialog } from './AuthGate';

describe('step-up authentication dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
  });

  it('captures password and MFA code, reports server errors, and supports Escape cancellation', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('인증번호가 올바르지 않습니다.'));
    const onCancel = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(<StepUpDialog onSubmit={onSubmit} onCancel={onCancel} />);
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    async function enter(selector: string, value: string) {
      await act(async () => {
        const element = container.querySelector<HTMLInputElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await enter('input[type="password"]', 'CorrectHorseBatteryStaple!');
    await enter('input[inputmode="numeric"]', '000000');
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(onSubmit).toHaveBeenCalledWith('CorrectHorseBatteryStaple!', '000000');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('인증번호가 올바르지 않습니다.');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
