import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { createStepUpCoordinator } from './step-up-coordinator';

afterEach(() => vi.useRealTimers());

describe('step-up coordinator lifecycle', () => {
  it('shares one pending request and rejects it after the bounded timeout', async () => {
    vi.useFakeTimers();
    const opened = vi.fn();
    const closed = vi.fn();
    const coordinator = createStepUpCoordinator(opened, closed, 1_000);
    const first = coordinator.request();
    const second = coordinator.request();
    expect(first).toBe(second);
    expect(opened).toHaveBeenCalledTimes(1);

    const rejected = expect(first).rejects.toMatchObject({ code: 'STEP_UP_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(closed).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPending()).toBe(false);
  });

  it('rejects stale work on dispose and can recover with a fresh request', async () => {
    const coordinator = createStepUpCoordinator(vi.fn(), vi.fn(), 60_000);
    const stale = coordinator.request();
    coordinator.dispose();
    await expect(stale).rejects.toMatchObject({ code: 'STEP_UP_ABORTED' });

    const fresh = coordinator.request();
    coordinator.complete();
    await expect(fresh).resolves.toBeUndefined();
  });

  it('uses the caller error when cancelling', async () => {
    const coordinator = createStepUpCoordinator(vi.fn(), vi.fn(), 60_000);
    const pending = coordinator.request();
    coordinator.cancel(new ApiError(403, 'STEP_UP_CANCELLED', '취소'));
    await expect(pending).rejects.toMatchObject({ code: 'STEP_UP_CANCELLED' });
  });
});
