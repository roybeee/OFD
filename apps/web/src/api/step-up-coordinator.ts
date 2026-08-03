import { ApiError } from './client';

export const STEP_UP_TIMEOUT_MS = 120_000;

type PendingStepUp = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createStepUpCoordinator(open: () => void, close: () => void, timeoutMs = STEP_UP_TIMEOUT_MS) {
  let pending: PendingStepUp | null = null;

  function settle(kind: 'resolve' | 'reject', reason?: unknown) {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimeout(current.timer);
    close();
    if (kind === 'resolve') current.resolve();
    else current.reject(reason);
  }

  return {
    request(): Promise<void> {
      if (pending) return pending.promise;
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const timer = setTimeout(() => settle('reject', new ApiError(408, 'STEP_UP_TIMEOUT', '본인 확인 시간이 만료되었습니다. 작업을 다시 시도해 주세요.')), timeoutMs);
      pending = { promise, resolve, reject, timer };
      open();
      return promise;
    },
    complete() { settle('resolve'); },
    cancel(reason = new ApiError(403, 'STEP_UP_CANCELLED', '중요 작업 본인 확인이 취소되었습니다.')) { settle('reject', reason); },
    dispose() { settle('reject', new ApiError(499, 'STEP_UP_ABORTED', '화면 전환으로 본인 확인이 중단되었습니다. 작업을 다시 시도해 주세요.')); },
    hasPending() { return pending !== null; },
  };
}
