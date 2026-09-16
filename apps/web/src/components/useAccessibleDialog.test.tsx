import { act, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAccessibleDialog } from './useAccessibleDialog';

let root: Root;
let container: HTMLDivElement;
let outside: HTMLButtonElement;
function Dialog({ name, onClose, children }: { name: string; onClose: () => void; children?: ReactNode }) {
  const ref = useAccessibleDialog(onClose);
  return <section ref={ref} role="dialog" aria-label={name} tabIndex={-1}><button onClick={onClose}>{name} 닫기</button>{children}</section>;
}
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div'); outside = document.createElement('button');
  outside.textContent = 'outside'; document.body.append(outside, container);
  root = createRoot(container); outside.focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => vi.runOnlyPendingTimers());
  container.remove(); outside.remove();
  document.body.style.removeProperty('overflow'); document.documentElement.style.removeProperty('overflow');
  vi.useRealTimers();
});
async function render(node: ReactNode) { await act(async () => root.render(node)); await act(async () => vi.runOnlyPendingTimers()); }
async function press(key: string, shiftKey = false) { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))); }
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(row => row.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => { button.focus(); button.click(); });
  await act(async () => vi.runOnlyPendingTimers());
}

it('locks scrolling, leaves the active dialog usable, and restores pre-existing inert and scroll styles', async () => {
  outside.setAttribute('inert', 'original');
  document.body.style.setProperty('overflow', 'scroll', 'important');
  document.documentElement.style.setProperty('overflow', 'clip');
  await render(<main><p data-background>Content</p><Dialog name="Test" onClose={() => {}}><input aria-label="Field" /></Dialog></main>);
  expect(document.body.style.overflow).toBe('hidden');
  expect(document.documentElement.style.overflow).toBe('hidden');
  expect(container.querySelector('[data-background]')!.hasAttribute('inert')).toBe(true);
  expect(container.querySelector('[role=dialog]')!.closest('[inert]')).toBeNull();
  expect(outside.hasAttribute('inert')).toBe(true);
  await render(null);
  expect(outside.getAttribute('inert')).toBe('original');
  expect(document.body.style.overflow).toBe('scroll');
  expect(document.body.style.getPropertyPriority('overflow')).toBe('important');
  expect(document.documentElement.style.overflow).toBe('clip');
});

it('keeps keyboard and programmatic focus inside the visible, enabled controls', async () => {
  await render(<Dialog name="Test" onClose={() => {}}>
    <input hidden aria-label="Hidden" /><input type="hidden" /><button disabled>Disabled</button>
    <fieldset disabled><input aria-label="Disabled fieldset" /></fieldset>
    <div style={{ display: 'none' }}><button>Hidden parent</button></div>
    <input aria-label="Last" />
  </Dialog>);
  const first = container.querySelector('button')!;
  const last = container.querySelector<HTMLInputElement>('[aria-label=Last]')!;
  expect(document.activeElement).toBe(first);
  await press('Tab', true); expect(document.activeElement).toBe(last);
  await press('Tab'); expect(document.activeElement).toBe(first);
  outside.focus(); expect(document.activeElement).toBe(first);
  const dialog = container.querySelector<HTMLElement>('[role=dialog]')!;
  dialog.focus(); await press('Tab', true); expect(document.activeElement).toBe(last);
});

it('closes only the top modal on Escape and restores the parent trigger before the page trigger', async () => {
  const parentClose = vi.fn(); const childClose = vi.fn();
  function Harness() {
    const [parent, setParent] = useState(true); const [child, setChild] = useState(false);
    return parent && <Dialog name="Parent" onClose={() => { parentClose(); setParent(false); }}>
      <button onClick={() => setChild(true)}>Open child</button>
      {child && <Dialog name="Child" onClose={() => { childClose(); setChild(false); }}><input aria-label="Child field" /></Dialog>}
    </Dialog>;
  }
  await render(<Harness />); await click('Open child');
  expect(container.querySelector('[aria-label=Child]')!.closest('[inert]')).toBeNull();
  expect(container.querySelector('[aria-label=Parent]')!.querySelector('button')!.hasAttribute('inert')).toBe(true);
  await press('Escape'); await act(async () => vi.runOnlyPendingTimers());
  expect(childClose).toHaveBeenCalledOnce(); expect(parentClose).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toBe('Open child');
  expect(document.body.style.overflow).toBe('hidden');
  await press('Escape'); await act(async () => vi.runOnlyPendingTimers());
  expect(parentClose).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(outside);
  expect(outside.hasAttribute('inert')).toBe(false); expect(document.body.style.overflow).toBe('');
});

it('treats a child mounted with its parent as the top modal and cleans up after strict-mode unmount', async () => {
  const parentClose = vi.fn(); const childClose = vi.fn();
  await render(<StrictMode><Dialog name="Parent" onClose={parentClose}><Dialog name="Child" onClose={childClose} /></Dialog></StrictMode>);
  expect(document.activeElement?.textContent).toBe('Child 닫기');
  await press('Escape');
  expect(childClose).toHaveBeenCalledOnce(); expect(parentClose).not.toHaveBeenCalled();
  await render(null);
  expect(outside.hasAttribute('inert')).toBe(false); expect(document.body.style.overflow).toBe('');
  expect(document.activeElement).toBe(outside);
});

it('inerts background siblings added while open and restores them after abrupt unmount', async () => {
  await render(<Dialog name="Test" onClose={() => {}} />);
  const notification = document.createElement('button');
  try {
    await act(async () => document.body.append(notification));
    expect(notification.hasAttribute('inert')).toBe(true);
    await render(null);
    expect(notification.hasAttribute('inert')).toBe(false);
  } finally { notification.remove(); }
});

it('uses current close behavior after busy changes and ignores Escape during text composition', async () => {
  const close = vi.fn();
  await render(<Dialog name="Test" onClose={() => {}} />);
  await press('Escape'); expect(close).not.toHaveBeenCalled();
  await render(<Dialog name="Test" onClose={close} />);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(close).not.toHaveBeenCalled();
  await press('Escape'); expect(close).toHaveBeenCalledOnce();
});

it('includes disclosure summaries but excludes controls hidden in a closed disclosure', async () => {
  await render(<Dialog name="Test" onClose={() => {}}><details><summary>Details</summary><input aria-label="Closed field" /></details></Dialog>);
  await press('Tab', true);
  expect(document.activeElement?.tagName).toBe('SUMMARY');
  await press('Tab'); expect(document.activeElement?.textContent).toBe('Test 닫기');
});
