import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeMfaV2,
  listActorAccountsV2,
  loginV2,
  mutateV2,
  provisionActorV2,
  registerStepUpRequester,
  resetActorV2,
} from './client';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  registerStepUpRequester(null);
  vi.unstubAllGlobals();
});

describe('production authentication client', () => {
  it('copies the Fastify login and MFA challenge contracts exactly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ authenticated: false, mfaRequired: true, challengeToken: 'challenge-token-1234567890', actor: { id: 'hq-1', name: 'HQ', role: 'hq_master', storeIds: [] } }))
      .mockResolvedValueOnce(json({ authenticated: true, actor: { id: 'hq-1', name: 'HQ', role: 'hq_master', storeIds: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const login = await loginV2('master@example.com', 'correct-password');
    expect(login).toMatchObject({ authenticated: false, mfaRequired: true, challengeToken: 'challenge-token-1234567890' });
    await completeMfaV2(login.challengeToken!, '123456');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v2/auth/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: 'master@example.com', password: 'correct-password' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v2/auth/mfa');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ challengeToken: 'challenge-token-1234567890', code: '123456' });
  });

  it('opens one step-up request and retries the original mutation once with the same idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'STEP_UP_REQUIRED', message: '재인증 필요' } }, 403))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const stepUp = vi.fn().mockResolvedValue(undefined);
    registerStepUpRequester(stepUp);

    await expect(mutateV2('/payments/auto-match', {}, { idempotencyKey: 'same-idempotency-key' })).resolves.toEqual({ ok: true });

    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['same-idempotency-key', 'same-idempotency-key']);
  });

  it('retries a late concurrent STEP_UP_REQUIRED response against the completed generation without a second dialog', async () => {
    let releaseStepUp!: () => void;
    let releaseLateResponse!: () => void;
    const stepUpGate = new Promise<void>((resolve) => { releaseStepUp = resolve; });
    const lateGate = new Promise<void>((resolve) => { releaseLateResponse = resolve; });
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      if (path.endsWith('/late') && attempt === 1) {
        await lateGate;
        return json({ error: { code: 'STEP_UP_REQUIRED', message: '늦은 재인증 응답' } }, 403);
      }
      if (attempt === 1) return json({ error: { code: 'STEP_UP_REQUIRED', message: '재인증 필요' } }, 403);
      return json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const stepUp = vi.fn(() => stepUpGate);
    registerStepUpRequester(stepUp);

    const first = mutateV2('/payments/first', {}, { idempotencyKey: 'first-key' });
    await vi.waitFor(() => expect(stepUp).toHaveBeenCalledTimes(1));
    const late = mutateV2('/payments/late', {}, { idempotencyKey: 'late-key' });
    await Promise.resolve();
    releaseStepUp();
    await first;
    releaseLateResponse();
    await expect(late).resolves.toEqual({ ok: true });

    expect(stepUp).toHaveBeenCalledTimes(1);
    const lateCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/payments/late'));
    expect(lateCalls).toHaveLength(2);
    expect(lateCalls.map((call) => (call[1]?.headers as Record<string, string>)['Idempotency-Key'])).toEqual(['late-key', 'late-key']);
  });

  it('uses GET/POST/PATCH actor administration contracts without serializing secrets into list responses', async () => {
    const actor = { id: 'actor-1', name: '기사', role: 'driver', storeIds: [], active: true, version: 1, email: 'driver@example.com', mfaEnabled: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ actors: [actor] }))
      .mockResolvedValueOnce(json({ actor }, 201))
      .mockResolvedValueOnce(json({ actor: { ...actor, version: 2 } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await listActorAccountsV2()).toEqual({ actors: [actor] });
    await provisionActorV2({ name: '기사', role: 'driver', storeIds: [], email: 'driver@example.com', password: 'strong-password' }, 'create-actor-key');
    await resetActorV2('actor-1', 1, 'new-strong-password', undefined, 'reset-actor-key');

    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? 'GET')).toEqual(['GET', 'POST', 'PATCH']);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body ?? '')).not.toContain('password');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ action: 'reset', actorId: 'actor-1', expectedVersion: 1, newPassword: 'new-strong-password' });
  });
});
