import { describe, expect, it } from 'vitest';
import { seoulDateTime, seoulDayLabel, seoulDayOf, seoulShortDateTime, seoulToday } from './datetime';

/* 이 테스트는 UTC 러너에서 돈다. 서울 고정이 풀리면 9시간 어긋난 값이 나오므로 즉시 걸린다. */
describe('서울 시각 표기', () => {
  it('시점을 UTC가 아니라 서울 벽시계로 보여준다', () => {
    /* 실제로 있었던 사고: 오후 5시 32분에 수신한 웹훅이 화면에 08:32로 찍혔다 */
    expect(seoulDateTime('2026-09-03T08:32:00.000Z')).toBe('2026-09-03 17:32');
    expect(seoulShortDateTime('2026-09-03T08:32:00.000Z')).toBe('09. 03. 17:32');
  });

  it('날짜 경계를 넘는 시점도 서울 기준 날짜로 넘긴다', () => {
    /* UTC 9/3 20:00 = 서울 9/4 05:00 — 하루가 밀리면 정산 귀속이 틀어진다 */
    expect(seoulDateTime('2026-09-03T20:00:00.000Z')).toBe('2026-09-04 05:00');
    /* 서울 자정은 24:00이 아니라 00:00으로 적는다 */
    expect(seoulDateTime('2026-09-03T15:00:00.000Z')).toBe('2026-09-04 00:00');
  });

  it('값이 없거나 깨졌으면 화면을 망가뜨리지 않는다', () => {
    expect(seoulDateTime(null)).toBe('아직 없음');
    expect(seoulDateTime('')).toBe('아직 없음');
    expect(seoulDateTime(undefined, '미수집')).toBe('미수집');
    expect(seoulDateTime('나중에')).toBe('나중에');
  });

  it('날짜만 있는 값은 시간대에 흔들리지 않는다', () => {
    /* new Date('2026-09-05')는 UTC 자정이라 UTC 서쪽에서 열면 9/4로 밀린다 — 정오 고정으로 막는다 */
    expect(seoulDayOf('2026-09-05').toISOString()).toBe('2026-09-05T03:00:00.000Z');
    expect(seoulDayLabel('2026-09-05', { month: 'numeric', day: 'numeric' })).toBe('9. 5.');
  });

  it('오늘 날짜는 서울 기준이다', () => {
    expect(seoulToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seoulToday()).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()));
  });
});
