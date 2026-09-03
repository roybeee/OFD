/* 이 시스템의 모든 업무 시각은 Asia/Seoul 기준이다 — 정산 귀속월, POS 일자 집계, 감사로그 조회가
 * 전부 서버에서 Asia/Seoul로 계산된다. 화면도 같은 기준으로 보여야 두 값이 어긋나지 않는다.
 *
 * 두 가지 실수를 여기서 한 번에 막는다.
 *  1) ISO 문자열을 그대로 잘라 쓰기 — `'2026-09-03T08:32:00Z'.slice(0,16)` 은 누가 보든 UTC다.
 *     서울에서는 실제 17:32인데 08:32로 보인다.
 *  2) timeZone 없이 Intl에 넘기기 — 브라우저 로컬 시간대를 따라가서, 해외에서 열면 값이 달라진다.
 *     날짜만 있는 값(`'2026-09-05'`)은 UTC 자정으로 파싱되므로 UTC 서쪽에서는 하루 앞당겨진다.
 */
const SEOUL = 'Asia/Seoul';

/** 오늘 날짜(서울). `2026-09-03` */
export const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: SEOUL }).format(new Date());

/** 시점(instant)을 서울 벽시계로. `2026-09-03 17:32` */
export function seoulDateTime(value: string | null | undefined, fallback = '아직 없음') {
  if (!value) return fallback;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  /* hour12:false는 자정을 '24'로 내는 환경이 있어 보정한다 */
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

/** 시점을 짧게. `09-03 17:32` — 표에서 폭을 아껴야 할 때 */
export const seoulShortDateTime = (value: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: SEOUL, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

/** `2026-09-05` 같은 날짜만 있는 값을 시간대에 흔들리지 않게 파싱한다(정오 고정). */
export function seoulDayOf(value: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(dateOnly ? `${value}T12:00:00+09:00` : value);
}

/** 날짜만 있는 값을 사람이 읽는 형태로. `9월 5일 (금)` */
export function seoulDayLabel(value: string, options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', weekday: 'short' }) {
  const at = seoulDayOf(value);
  if (Number.isNaN(at.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL, ...options }).format(at);
}
