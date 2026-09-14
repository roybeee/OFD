import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOdaMonth, odaMutation, odaUrl, prepareOdaFile, previewOdaImport } from './oda-client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('ODA 원본 파일과 동시 수정 API 계약', () => {
  it('한글 UTF-8 CSV의 BOM·CRLF·원본 바이트를 변환 없이 base64로 보존한다', async () => {
    const original = new TextEncoder().encode('\uFEFF귀속일,내용,금액\r\n2026-09-01,"피자, 주문",11000\r\n');
    const file = new File([original], '매출 원본.csv', { type: 'text/csv' });
    // jsdom File에는 arrayBuffer가 없으므로 브라우저 File의 읽기 결과만 보충한다.
    Object.defineProperty(file, 'arrayBuffer', { value: async () => original.buffer.slice(0) });
    const result = await prepareOdaFile(file, 'pos', 'pos');
    expect(result).toMatchObject({ filename: '매출 원본.csv', kind: 'pos', channel: 'pos', mediaType: 'text/csv' });
    expect(result).not.toHaveProperty('content');
    const decoded = Uint8Array.from(atob(result.contentBase64!), (char) => char.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('크기·파일 형식을 업로드 전에 제한하고 PDF는 손익자동집계가 아닌 증빙으로 전달한다', async () => {
    const oversized = new File(['x'], '매출.csv'); Object.defineProperty(oversized, 'size', { value: 2 * 1024 * 1024 + 1 });
    await expect(prepareOdaFile(oversized, 'pos', 'pos')).rejects.toThrow('2MB');
    await expect(prepareOdaFile(new File(['x'], '실행.exe'), 'expense', 'manual')).rejects.toThrow('지원합니다');
    const pdf = new File(['%PDF'], '영수증.pdf'); Object.defineProperty(pdf, 'arrayBuffer', { value: async () => new TextEncoder().encode('%PDF').buffer });
    expect(await prepareOdaFile(pdf, 'pos', 'pos')).toMatchObject({ kind: 'evidence', mediaType: 'application/pdf' });
  });

  it('미리보기와 저장 경로를 분리하고 실제 최신 expectedVersion을 함께 전송한다', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true })); vi.stubGlobal('fetch', fetchMock);
    const input = { filename: '매출.csv', kind: 'pos' as const, contentBase64: 'YWJj', channel: 'pos' };
    await previewOdaImport('oda/1', '2026-09', input);
    await odaMutation('oda/1', '2026-09', '/import', 7, { ...input, expectedVersion: 999 });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v2/oda/oda%2F1/2026-09/import/preview', '/api/v2/oda/oda%2F1/2026-09/import']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual(input);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ ...input, expectedVersion: 7 });
    expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBeTruthy();
    expect(odaUrl('oda/1', '2026-09', '/export.csv')).toBe('/api/v2/oda/oda%2F1/2026-09/export.csv');
  });

  it('조회 오류의 서버 사유를 보존하고 요청 취소 신호를 전달한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'ODA_FORBIDDEN', message: '해당 매장의 정산을 열람할 수 없습니다.' } }, 403)); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(getOdaMonth('oda-1', '2026-09', controller.signal)).rejects.toMatchObject({ status: 403, code: 'ODA_FORBIDDEN', message: '해당 매장의 정산을 열람할 수 없습니다.' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/oda/oda-1/2026-09', expect.objectContaining({ credentials: 'same-origin', signal: controller.signal }));
  });
});
