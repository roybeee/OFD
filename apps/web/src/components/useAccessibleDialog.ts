import { useEffect, useRef } from 'react';

const focusable = 'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]';
const dialogs: HTMLElement[] = [];
const background = new Map<HTMLElement, string | null>();
let unlockScroll: (() => void) | undefined;
let observer: MutationObserver | undefined;
const topDialog = () => dialogs[dialogs.length - 1];

function available(element: HTMLElement, dialog: HTMLElement): boolean {
  if (element.matches(':disabled, input[type="hidden"]') || (element.tabIndex < 0 && (!element.matches('summary, [contenteditable="true"]') || element.hasAttribute('tabindex')))) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert')) return false;
    if (node instanceof HTMLDetailsElement && !node.open && !node.querySelector(':scope > summary')?.contains(element)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (node === dialog) break;
  }
  return true;
}

function focusableItems(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(item => available(item, dialog));
}

function focusDialog(dialog: HTMLElement) {
  const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial]');
  const target = preferred && available(preferred, dialog) ? preferred : focusableItems(dialog)[0] ?? dialog;
  target.focus({ preventScroll: true });
}

function restoreBackground() {
  for (const [element, original] of background) {
    if (original === null) element.removeAttribute('inert');
    else element.setAttribute('inert', original);
  }
  background.clear();
}

// Dialogs are rendered inline. Make siblings along the active dialog's ancestor
// path inert, rather than hiding a root that also contains the dialog itself.
function syncBackground() {
  restoreBackground();
  for (let node = topDialog(); node?.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.matches('script, style, link, meta')) continue;
      background.set(sibling, sibling.getAttribute('inert'));
      sibling.setAttribute('inert', '');
    }
    if (node.parentElement === document.body) break;
  }
}

function register(dialog: HTMLElement) {
  if (!dialogs.length) {
    const styles = [document.documentElement.style, document.body.style].map(style => ({ style, value: style.getPropertyValue('overflow'), priority: style.getPropertyPriority('overflow') }));
    for (const { style } of styles) style.setProperty('overflow', 'hidden');
    unlockScroll = () => { for (const { style, value, priority } of styles) { if (value) style.setProperty('overflow', value, priority); else style.removeProperty('overflow'); } };
    observer = new MutationObserver(syncBackground);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  // A nested child effect can run before its parent effect on the same render.
  const childIndex = dialogs.findIndex(existing => dialog.contains(existing));
  dialogs.splice(childIndex < 0 ? dialogs.length : childIndex, 0, dialog);
  syncBackground();
}

function unregister(dialog: HTMLElement) {
  const index = dialogs.indexOf(dialog);
  if (index >= 0) dialogs.splice(index, 1);
  syncBackground();
  if (!dialogs.length) {
    observer?.disconnect(); observer = undefined;
    unlockScroll?.(); unlockScroll = undefined;
  }
}

export function useAccessibleDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    register(dialog);
    let lastFocus: HTMLElement | null = null;
    const focusInitial = window.setTimeout(() => {
      if (topDialog() === dialog) focusDialog(dialog);
    }, 0);

    function onKeyDown(event: KeyboardEvent) {
      if (topDialog() !== dialog || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableItems(dialog!);
      if (items.length === 0) { event.preventDefault(); dialog!.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialog!.contains(document.activeElement) || document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    function onFocus(event: FocusEvent) {
      if (topDialog() !== dialog) return;
      if (event.target instanceof HTMLElement && dialog!.contains(event.target)) { lastFocus = event.target; return; }
      if (lastFocus?.isConnected && available(lastFocus, dialog!)) lastFocus.focus({ preventScroll: true });
      else focusDialog(dialog!);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      const wasTop = topDialog() === dialog;
      window.clearTimeout(focusInitial);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocus);
      unregister(dialog);
      const next = topDialog();
      if (wasTop) window.setTimeout(() => {
        if (topDialog() !== next) return;
        if (previousFocus?.isConnected && !previousFocus.closest('[inert]') && (!next || next.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
        else if (next) focusDialog(next);
      }, 0);
    };
  }, []);

  return dialogRef;
}
