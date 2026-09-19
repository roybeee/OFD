import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandOdaHr, getOdaHr } from './oda-hr-client';
import { ApiError } from './client';

afterEach(() => vi.unstubAllGlobals());
describe('ODA HR API client', () => {
  it('uses scoped URLs, session credentials and cancellation for reads', async () => {
    const payload = { workspace: { version: 3 }, permissions: { manage: true, payroll: true, self: false } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    expect(await getOdaHr('store/one', controller.signal)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/oda/store%2Fone/hr', expect.objectContaining({ credentials: 'same-origin', signal: controller.signal }));
  });

  it('reuses a supplied idempotency key for an operations retry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workspace: { version: 5 } }), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    await commandOdaHr('s1', 4, 'operations.check', { done: true }, 'retry-key');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('retry-key');
  });

  it('preserves the server status and error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'HR_ACCESS_DENIED', message: '배정된 매장이 아닙니다.' } }), { status: 403 })));
    await expect(getOdaHr('outside')).rejects.toMatchObject({ status: 403, code: 'HR_ACCESS_DENIED', message: '배정된 매장이 아닙니다.' } satisfies Partial<ApiError>);
  });

  it('submits the explicit command and CAS version with an idempotency key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workspace: { version: 5 } }), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    await commandOdaHr('s1', 4, 'notice.create', { title: '공지', body: '안내' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v2/oda/s1/hr/commands'); expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 4, type: 'notice.create', input: { title: '공지', body: '안내' } });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(init.credentials).toBe('same-origin');
  });
});
