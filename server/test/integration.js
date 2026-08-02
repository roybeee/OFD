/* 통합 테스트 v2 — 부서 계정 RBAC 포함. 실행: node --no-warnings test/integration.js */
'use strict';
process.env.DB_PATH = '/tmp/ofd_t2_' + Date.now() + '.db';
process.env.PORT = '8899';
process.env.POS_BACKFILL_RUNNER = '0';
const { server, db, _test } = require('../server.js');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://127.0.0.1:8899';
const jars = {};
async function call(jar, method, path, body, hdr) {
  const h = Object.assign({ 'X-OFD': '1' }, hdr || {});
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (jars[jar]) h['Cookie'] = jars[jar];
  const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) jars[jar] = sc.split(';')[0];
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const R = [];
const log = (n, ok, x) => { R.push(ok); console.log((ok ? '  OK  ' : 'FAIL  ') + n + (ok ? '' : '   << ' + (x || ''))); };
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addD = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function main() {
  await new Promise(r => server.listen(8899, r));
  const t = kstToday();
  let r, chk;

  /* ===== A. 초기 설정 (마스터 계정) ===== */
  r = await call('m', 'GET', '/api/state');
  log('A1 미설정 감지', r.data.setup === true);
  r = await call('x', 'POST', '/api/setup', { username: 'AB', name: 'x', password: '1234' });
  log('A2 아이디 형식 400', r.status === 400);
  r = await call('x', 'POST', '/api/setup', { username: 'boss', name: 'x', password: '12' });
  log('A3 비밀번호 형식 400', r.status === 400);
  r = await call('m', 'POST', '/api/setup', { username: 'boss', name: '황대표', password: 'm2468', demo: true });
  log('A4 마스터 생성 → 세션+코드 1회', r.status === 200 && /^\d{6}$/.test((r.data.codes || {}).s2 || ''));
  const s2code = r.data.codes.s2;
  r = await call('y', 'POST', '/api/setup', { username: 'evil', name: 'x', password: '9999' });
  log('A5 재설정 차단 409', r.status === 409);

  /* ===== B. CSRF·인증 ===== */
  r = await fetch(BASE + '/api/notices', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jars.m || '' }, body: '{}' });
  log('B1 X-OFD 없는 변이 403', r.status === 403);
  r = await call('anon', 'GET', '/api/bootstrap');
  log('B2 비인증 401', r.status === 401);
  r = await call('bad', 'POST', '/api/auth/hq', { username: 'boss', password: 'wrong' });
  log('B3 오답 로그인 401', r.status === 401);

  /* ===== C. 부서 계정 생성 (마스터) ===== */
  for (const [un, nm, dp] of [['sales1', '김영업', 'sales'], ['ops1', '박운영', 'ops'], ['adm1', '최관리', 'admin']]) {
    r = await call('m', 'POST', '/api/users', { username: un, name: nm, dept: dp, password: 'pw' + un });
    if (r.status !== 200) { log('C1 부서 계정 생성 (' + un + ')', false, JSON.stringify(r.data)); break; }
  }
  log('C1 부서 계정 3개 생성', r.status === 200);
  r = await call('m', 'POST', '/api/users', { username: 'sales1', name: 'dup', dept: 'sales', password: '1234' });
  log('C2 아이디 중복 409', r.status === 409);
  chk = await call('m', 'GET', '/api/bootstrap');
  log('C3 마스터 부트스트랩: users·audit·leads·orders 포함', !!chk.data.users && !!chk.data.audit && !!chk.data.leads && !!chk.data.orders);
  const uids = {}; chk.data.users.forEach(u => { uids[u.username] = u.id; });
  const uid = un => uids[un];

  /* ===== D. 영업 계정 스코프 ===== */
  await call('sa', 'POST', '/api/auth/hq', { username: 'sales1', password: 'pwsales1' });
  r = await call('sa', 'GET', '/api/bootstrap');
  log('D1 영업 스코프: leads O / orders·sales·audit·users X',
    !!r.data.leads && !r.data.orders && !r.data.sales && !r.data.audit && !r.data.users);
  log('D2 영업 세션 신원', r.data.me.dept === 'sales' && r.data.me.name === '김영업');
  r = await call('sa', 'POST', '/api/leads', { name: '영업생성리드', area: '테스트' });
  log('D3 영업: 리드 생성 가능', r.status === 200);
  r = await call('sa', 'POST', '/api/orders/o1/advance', {});
  log('D4 영업: 발주 전이 403(need orders)', r.status === 403 && r.data.need === 'orders');
  r = await call('sa', 'GET', '/api/settle?month=' + t.slice(0, 7));
  log('D5 영업: 정산 403', r.status === 403);
  r = await call('sa', 'POST', '/api/notices', { title: 'x' });
  log('D6 영업: 공지 403', r.status === 403);
  r = await call('sa', 'POST', '/api/users', { username: 'zz11', name: 'z', dept: 'sales', password: '1234' });
  log('D7 영업: 계정 생성 403', r.status === 403);

  /* 숙려 게이트 — 영업 행위자로 강제·기록 */
  r = await call('sa', 'POST', '/api/leads/p1/stage', { dir: 1 });
  log('D8 숙려 미경과 409 COOLING(게이트일)', r.status === 409 && r.data.gate === addD(addD(t, -6), 14));
  r = await call('sa', 'POST', '/api/leads/p1/stage', { dir: 1, override: true });
  log('D9 override 사후기록 + 플래그', r.status === 200 && r.data.flag === true);

  /* ===== E. 운영 계정 스코프 ===== */
  await call('op', 'POST', '/api/auth/hq', { username: 'ops1', password: 'pwops1' });
  r = await call('op', 'GET', '/api/bootstrap');
  log('E1 운영 스코프: orders·sales O / leads·audit X', !!r.data.orders && !!r.data.sales && !r.data.leads && !r.data.audit);
  r = await call('op', 'POST', '/api/leads', { name: 'x' });
  log('E2 운영: 리드 403(need leads)', r.status === 403 && r.data.need === 'leads');
  r = await call('op', 'GET', '/api/settle?month=' + t.slice(0, 7));
  log('E3 운영: 정산 403', r.status === 403);
  r = await call('op', 'POST', '/api/skus', { name: 'x', price: 1000 });
  log('E4 운영: SKU 403', r.status === 403);
  r = await call('op', 'POST', '/api/notices', { title: '운영 공지', body: 'ok' });
  log('E5 운영: 공지 게시 가능', r.status === 200);

  /* ===== F. 점주 로그인·격리 (유지) ===== */
  r = await call('owner', 'POST', '/api/auth/store', { storeId: 's2', code: '000000' });
  log('F1 오답 접속코드 401', r.status === 401);
  r = await call('owner', 'POST', '/api/auth/store', { storeId: 's2', code: s2code });
  log('F2 점주 로그인', r.status === 200);
  r = await call('owner', 'GET', '/api/bootstrap');
  log('F3 점주: 자기 매장만·leads 없음', r.data.me.storeId === 's2' && r.data.stores.length === 1 && !r.data.leads);
  r = await call('owner', 'PUT', '/api/closings', { storeId: 's1', date: t, items: [{ skuId: 'k1', sold: 1, waste: 0 }] });
  chk = await call('op', 'GET', '/api/bootstrap');
  log('F4 점주 타 매장 시도 → 자기 매장 강제', r.status === 200 && !chk.data.sales.some(c => c.storeId === 's1'));
  r = await call('owner', 'POST', '/api/orders/o1/advance', {});
  log('F5 점주: 상태 전이 403', r.status === 403);

  /* ===== G. 발주 수명주기 (점주 생성 → 운영 전이) ===== */
  r = await call('owner', 'POST', '/api/orders', { items: [{ skuId: 'k4', qty: 100 }] });
  const oid = r.data.id;
  log('G1 점주 발주 생성', r.status === 200 && !!oid);
  for (const want of ['승인', '입금확인', '출고']) {
    r = await call('op', 'POST', '/api/orders/' + oid + '/advance', {});
    if (r.data.status !== want) break;
  }
  log('G2 운영: 대기→출고 전이', r.data.status === '출고');

  /* ===== H. 관리 계정 — 정산·SKU·감사 ===== */
  await call('ad', 'POST', '/api/auth/hq', { username: 'adm1', password: 'pwadm1' });
  r = await call('ad', 'GET', '/api/bootstrap');
  log('H1 관리 스코프: audit·orders(read) O / leads·users X', !!r.data.audit && !!r.data.orders && !r.data.leads && !r.data.users);
  r = await call('ad', 'GET', '/api/settle?month=' + t.slice(0, 7));
  const rowS2 = r.data.rows.find(x => x.storeId === 's2');
  log('H2 관리: 정산 조회 — 출고 144,000', r.status === 200 && rowS2.supply === 144000);
  log('H3 정산: 대기 발주(o1) 제외', r.data.rows.every(x => x.supply === (x.storeId === 's2' ? 144000 : 0)));
  r = await call('ad', 'POST', '/api/orders/' + oid + '/advance', {});
  log('H4 관리: 발주 전이 403(읽기만)', r.status === 403);
  r = await call('ad', 'POST', '/api/skus', { name: '두바이초코', price: 6500 });
  log('H5 관리: SKU 추가 가능(48% 자동)', r.status === 200);
  chk = await call('ad', 'GET', '/api/bootstrap');
  log('H6 SKU 공급가 자동 3,120', chk.data.skus.find(k => k.name === '두바이초코').supply === 3120);
  r = await call('ad', 'POST', '/api/stores/s2/code', {});
  log('H7 관리: 코드 재발급 403(운영 권한)', r.status === 403 && r.data.need === 'codes');

  /* ===== H8. 매장 운영 가이드 — 권한·정본 안전성 ===== */
  r = await call('anon-guide', 'GET', '/api/store-guide');
  log('H8 가이드: 비인증 401', r.status === 401);
  r = await call('owner', 'GET', '/api/store-guide');
  const guideData = r.data;
  const guideText = JSON.stringify(guideData || {});
  log('H9 가이드: 점주 열람·버전 메타', r.status === 200
    && guideData.meta && guideData.meta.version === '1.0'
    && ['today', 'help', 'learn', 'standards', 'maintenance'].every(id => guideData.sections.some(s => s.id === id)));
  const guideIds = [...guideData.sections, ...guideData.articles, ...guideData.products].map(x => x.id);
  log('H10 가이드: ID 고유·필수 배열 구조', new Set(guideIds).size === guideIds.length
    && guideData.articles.every(a => a.id && a.section && a.title && Array.isArray(a.steps) && Array.isArray(a.keywords))
    && guideData.products.every(p => p.id && p.nameKo && Array.isArray(p.allergens) && Array.isArray(p.hiddenFields)));
  const guideChapters = ['브랜드소개', '소통·보고체계', '구비서류 및 게시물 체크리스트', '도넛메뉴', '메뉴별 중량열량',
    '음료메뉴', '고객응대매뉴얼', '직급별 업무 R&R', '주간월간계절업무', '위생품질상황별 매뉴얼',
    '솔드아웃 타임', '오픈마감업무', '설비관리', '주간월간 청소관리', '개정이력'];
  log('H11 가이드: 원본 15개 장 출처 매핑', guideChapters.every(x => guideText.includes(x)));
  log('H12 가이드: 안전 정본 — 전일 잔여·정적 가격 차단', !guideText.includes('전일 잔여')
    && guideData.products.every(p => !Object.prototype.hasOwnProperty.call(p, 'price')));
  log('H13 가이드: 충돌 제품 값 숨김·검수 상태', guideData.products.filter(p => p.reviewStatus === 'needs-review').length >= 4
    && guideData.products.filter(p => p.reviewStatus === 'needs-review').every(p => p.hiddenFields.length > 0));
  r = await call('op', 'GET', '/api/store-guide');
  log('H14 가이드: 운영 열람', r.status === 200);
  r = await call('m', 'GET', '/api/store-guide');
  log('H15 가이드: 마스터 열람', r.status === 200);
  r = await call('ad', 'GET', '/api/store-guide');
  log('H16 가이드: 관리 차단', r.status === 403);
  r = await call('sa', 'GET', '/api/store-guide');
  log('H17 가이드: 영업 차단', r.status === 403);

  /* ===== I. 감사 로그 — 개인·부서 단위 행위자 ===== */
  const au = chk.data.audit;
  log('I1 감사: 영업 개인 식별(숙려 미준수)', au.some(a => a.who === '김영업 (영업)' && a.act.includes('숙려기간 미준수')));
  log('I2 감사: 운영 개인 식별(발주 상태)', au.some(a => a.who === '박운영 (운영)' && a.act.includes('발주 상태')));
  log('I3 감사: 관리 개인 식별(SKU)', au.some(a => a.who === '최관리 (관리)' && a.act.includes('SKU 추가')));

  /* ===== J. 계정 수명주기 ===== */
  r = await call('m', 'PATCH', '/api/users/' + uid('ops1'), { active: false });
  log('J1 운영 계정 비활성', r.status === 200);
  r = await call('op', 'GET', '/api/bootstrap');
  log('J2 비활성 즉시 세션 무효(401)', r.status === 401);
  r = await call('m', 'PATCH', '/api/users/' + uid('ops1'), { active: true, password: 'newpw99' });
  log('J3 재활성+비번 재설정', r.status === 200);
  r = await call('op2', 'POST', '/api/auth/hq', { username: 'ops1', password: 'pwops1' });
  log('J4 구 비번 로그인 불가', r.status === 401);
  r = await call('op2', 'POST', '/api/auth/hq', { username: 'ops1', password: 'newpw99' });
  log('J5 새 비번 로그인', r.status === 200);

  /* ===== K. 마지막 마스터 보호 ===== */
  r = await call('m', 'PATCH', '/api/users/' + uid('boss'), { dept: 'sales' });
  log('K1 마지막 마스터 강등 409', r.status === 409 && r.data.error === 'LAST_MASTER');
  r = await call('m', 'DELETE', '/api/users/' + uid('boss'));
  log('K2 마지막 마스터 삭제 409', r.status === 409);
  await call('m', 'POST', '/api/users', { username: 'boss2', name: '부마스터', dept: 'master', password: 'm22222' });
  r = await call('m', 'PATCH', '/api/users/' + (await call('m', 'GET', '/api/bootstrap')).data.users.find(u => u.username === 'boss2').id, { active: false });
  log('K3 다른 마스터 존재 시 비활성 가능', r.status === 200);

  /* ===== L. 본인 비밀번호 변경 → 타 기기 세션 종료 ===== */
  await call('m2', 'POST', '/api/auth/hq', { username: 'boss', password: 'm2468' });
  r = await call('m', 'POST', '/api/password', { old: 'm2468', new: 'm1357' });
  log('L1 본인 비번 변경', r.status === 200);
  r = await call('m2', 'GET', '/api/bootstrap');
  log('L2 타 기기 세션 종료(401)', r.status === 401);
  r = await call('m', 'GET', '/api/bootstrap');
  log('L3 현재 세션은 유지', r.status === 200);

  /* ===== M. 마감·CSV(폐기 보존) ===== */
  await call('owner', 'PUT', '/api/closings', { date: t, items: [{ skuId: 'k1', sold: 99, waste: 7 }], mode: 'replace' });
  await call('owner', 'PUT', '/api/closings', { date: t, mode: 'import', items: [{ skuId: 'k1', sold: 40, waste: 0 }, { skuId: 'k2', sold: 20, waste: 0 }] });
  chk = await call('owner', 'GET', '/api/bootstrap');
  const cT = chk.data.sales.find(c => c.date === t);
  const k1 = cT.items.find(i => i.skuId === 'k1'), k2i = cT.items.find(i => i.skuId === 'k2');
  log('M1 CSV: 판매 대체(99→40)·폐기 유지(7)', k1.sold === 40 && k1.waste === 7 && k2i.sold === 20);

  /* ===== N. 오픈완료 → 매장+코드 / 코드 재발급 세션 무효 ===== */
  r = await call('sa', 'POST', '/api/leads/p3/stage', { dir: 1 });
  log('N1 영업 오픈완료 → 매장+코드 1회', r.status === 200 && r.data.newStore && /^\d{6}$/.test(r.data.code));
  r = await call('nt', 'POST', '/api/auth/store', { storeId: r.data.newStore.id, code: r.data.code });
  log('N2 신규 매장 점주 로그인', r.status === 200);
  r = await call('op2', 'POST', '/api/stores/s2/code', {});
  const newCode = r.data.code;
  log('N3 운영: 코드 재발급', r.status === 200 && /^\d{6}$/.test(newCode));
  r = await call('owner', 'GET', '/api/bootstrap');
  log('N4 재발급 → 기존 점주 세션 401', r.status === 401);
  r = await call('own2', 'POST', '/api/auth/store', { storeId: 's2', code: newCode });
  log('N5 신 코드 로그인', r.status === 200);

  /* ===== O. 백업 — 마스터 전용 / 해시 미포함 / 이관 ===== */
  r = await call('ad', 'GET', '/api/export');
  log('O1 관리: 내보내기 403(마스터 전용)', r.status === 403);
  r = await call('m', 'GET', '/api/export');
  const expStr = JSON.stringify(r.data);
  log('O2 내보내기: users 포함·해시 전무', Array.isArray(r.data.users) && !expStr.includes('code_hash') && !expStr.includes('pw_hash') && !/[0-9a-f]{32}:[0-9a-f]{64}/.test(expStr));
  const artifact = {
    skus: [{ id: 'k99', mt: Date.now(), name: '흑임자라떼도넛', price: 5200, supply: 2496 }],
    stores: [{ id: 's77', mt: Date.now(), name: '광교점', type: '가맹', region: '경기', addr: '수원', phone: '', openDate: t }],
    sales: [{ id: 'c77', mt: Date.now(), storeId: 's77', date: t, items: [{ skuId: 'k99', sold: 10, waste: 1 }] }],
    users: [{ id: 'u99', username: 'legacy1', name: '이관자', dept: 'sales', active: true, mt: Date.now() }],
    logs: [{ mt: Date.now(), who: '본사 관리자', act: '아티팩트 시절 기록' }],
    sec: { pinH: 'ignored', codes: { s77: '123456' } }
  };
  r = await call('m', 'POST', '/api/import', artifact);
  log('O3 병합: 매장·SKU·계정 편입', r.status === 200 && r.data.merged.stores.nIns === 1 && r.data.merged.users.nIns === 1);
  chk = await call('m', 'GET', '/api/bootstrap');
  log('O4 이관 매장 코드 미발급', chk.data.stores.find(s => s.id === 's77').hasCode === false);
  r = await call('z1', 'POST', '/api/auth/store', { storeId: 's77', code: '123456' });
  log('O5 아티팩트 구 코드 로그인 불가', r.status === 401);
  r = await call('z2', 'POST', '/api/auth/hq', { username: 'legacy1', password: 'anything' });
  log('O6 이관 계정: 비번 미설정 → 로그인 불가', r.status === 401);
  r = await call('m', 'PATCH', '/api/users/u99', { password: 'fresh123' });
  r = await call('z2', 'POST', '/api/auth/hq', { username: 'legacy1', password: 'fresh123' });
  log('O7 마스터 재설정 후 이관 계정 로그인', r.status === 200);

  /* ===== P. 레이트 리밋 (계정 단위) ===== */
  let hit429 = false;
  for (let i = 0; i < 12; i++) {
    const rr = await call('brute', 'POST', '/api/auth/hq', { username: 'boss', password: 'x' + i });
    if (rr.status === 429) { hit429 = true; break; }
  }
  log('P1 동일 계정 무차별 시도 → 429', hit429);

  /* ===== Q. 레거시 v1(단일 PIN) DB 자동 이관 — 별도 프로세스 ===== */
  const legacyDb = '/tmp/ofd_legacy_' + Date.now() + '.db';
  {
    const d2 = new DatabaseSync(legacyDb);
    d2.exec('CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT)');
    const salt = crypto.randomBytes(16).toString('hex');
    const ph = salt + ':' + crypto.scryptSync('1357', salt, 64).toString('hex');
    d2.prepare('INSERT INTO config(k,v) VALUES(?,?)').run('pin_hash', ph);
    d2.close();
  }
  const child = spawn(process.execPath, ['--no-warnings', require('node:path').join(__dirname, '..', 'server.js')],
    { env: Object.assign({}, process.env, { PORT: '8898', DB_PATH: legacyDb }), stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const h = await fetch('http://127.0.0.1:8898/health'); if (h.ok) { up = true; break; } } catch (e) {}
    await new Promise(r2 => setTimeout(r2, 100));
  }
  log('Q1 레거시 DB 서버 기동', up);
  let q2 = { status: 0 };
  if (up) {
    q2 = await fetch('http://127.0.0.1:8898/api/auth/hq', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OFD': '1' },
      body: JSON.stringify({ username: 'master', password: '1357' }) });
  }
  log('Q2 기존 PIN → master 계정 자동 이관 로그인', q2.status === 200);
  child.kill();

  /* ===== S. POS 연동 (토스플레이스 어댑터 + mock 파이프라인) ===== */
  const day = d => new Date(d + 'T00:00:00Z').getUTCDay();
  let satD = t, monD = t;
  for (let i = 0; i < 14; i++) { const d = addD(t, -i); if (day(d) === 6) { satD = d; break; } }
  for (let i = 0; i < 14; i++) { const d = addD(t, -i); if (day(d) === 1) { monD = d; break; } }

  r = await call('sa', 'PUT', '/api/pos/links/s2', { provider: 'mock' });
  log('S1 영업: POS 연동 설정 403(need pos)', r.status === 403 && r.data.need === 'pos');
  r = await call('op2', 'PUT', '/api/pos/links/s2', { provider: 'mock' });
  log('S2 운영: mock 연동 등록', r.status === 200);
  r = await call('op2', 'PUT', '/api/pos/links/s3', { provider: 'tossplace', merchantId: '42' });
  log('S3 tossplace 키 누락 400(LINK_INCOMPLETE)', r.status === 400 && r.data.error === 'LINK_INCOMPLETE');

  await call('own2', 'PUT', '/api/closings', { date: satD, items: [{ skuId: 'k1', sold: 999, waste: 4 }], mode: 'replace' });
  r = await call('op2', 'POST', '/api/pos/sync/s2', { date: satD });
  log('S4 주말 동기화: 7행·매출 471,000·미매칭 1종', r.status === 200 && r.data.lines === 7 && r.data.revenue === 471000 && r.data.unmatched.length === 1 && r.data.unmatched[0] === '신메뉴딸기');
  chk = await call('own2', 'GET', '/api/bootstrap');
  let cSat = chk.data.sales.find(c => c.date === satD);
  const sk1 = cSat.items.find(i => i.skuId === 'k1'), sk2 = cSat.items.find(i => i.skuId === 'k2');
  log('S5 마감 자동 반영: k1 60(폐기 4 보존)·k2 30', sk1.sold === 60 && sk1.waste === 4 && sk2.sold === 30);
  r = await call('op2', 'POST', '/api/pos/sync/s2', { date: satD });
  log('S6 재동기화 멱등: 동일 결과(전량 재계산)', r.status === 200 && r.data.revenue === 471000);
  r = await call('op2', 'POST', '/api/pos/sync/s2', { date: monD });
  log('S7 평일 동기화: 매출 235,500', r.status === 200 && r.data.revenue === 235500);
  r = await call('op2', 'GET', '/api/pos/unmatched');
  const um = r.data.items.find(x => x.name === '신메뉴딸기');
  log('S8 미매칭 집계: 15개(중복 없음)', !!um && um.qty === 15 && r.data.items.length === 1);
  r = await call('op2', 'GET', '/api/pos/links');
  const lk = JSON.stringify(r.data);
  log('S9 링크 조회: 키 재료 미노출', r.status === 200 && !lk.includes('Enc') && !lk.includes('access_key') && r.data.links.some(L => L.storeId === 's2' && L.provider === 'mock'));

  /* ===== T. 매출 분석 ===== */
  const aFrom = satD < monD ? satD : monD, aTo = satD < monD ? monD : satD;
  r = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + aFrom + '&to=' + aTo);
  const A = r.data;
  log('T1 분석: POS 소스·총매출 706,500', r.status === 200 && A.source === 'pos' && A.totalAmount === 706500);
  let wkC = 0, wdC = 0;
  for (let d2 = aFrom; d2 <= aTo; d2 = addD(d2, 1)) { (day(d2) === 0 || day(d2) === 6) ? wkC++ : wdC++; }
  log('T2 주중/주말 일평균(달력일 기준)', A.weekendAvg === Math.round(471000 / wkC) && A.weekdayAvg === Math.round(235500 / wdC));
  const hSum = A.hourly.reduce((a2, h) => a2 + h.amount, 0);
  log('T3 시간대: 12시 322,400 · Σ=총매출', A.hourly[12].amount === 322400 && hSum === A.totalAmount);
  const mixK1 = A.mix.find(x => x.skuId === 'k1');
  log('T4 믹스: 우유크림 378,000 · 미매칭 67,500', mixK1.amount === 378000 && A.unmatchedAmount === 67500 && A.mix[0].skuId === 'k1');
  log('T5 성장률: 직전 기간 0 → null', A.growthPct === null && A.prevAmount === 0);
  r = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + satD + '&to=' + satD);
  log('T5b 당일 분석: 하루 범위·POS 매출·일별 1건', r.status === 200 && r.data.days === 1
    && r.data.from === satD && r.data.to === satD && r.data.totalAmount === 471000
    && r.data.daily.length === 1 && r.data.daily[0].date === satD);
  r = await call('sa', 'GET', '/api/analytics?storeId=s2');
  log('T6 영업: 분석 403(need settle)', r.status === 403);
  r = await call('own2', 'GET', '/api/analytics?from=' + aFrom + '&to=' + aTo);
  log('T7 점주: 자기 매장 분석 200(POS)', r.status === 200 && r.data.storeId === 's2' && r.data.totalAmount === 706500);
  r = await call('own2', 'GET', '/api/analytics?storeId=s1');
  log('T8 점주: 타 매장 분석 403', r.status === 403);
  r = await call('op2', 'POST', '/api/pos/alias', { alias: '신메뉴딸기', skuId: 'k3' });
  log('T9 별칭 매핑: 2개 매장일 소급 재계산', r.status === 200 && r.data.rebuilt === 2);
  r = await call('op2', 'GET', '/api/pos/unmatched');
  log('T10 매핑 후 미매칭 0', r.data.items.length === 0);
  chk = await call('own2', 'GET', '/api/bootstrap');
  cSat = chk.data.sales.find(c => c.date === satD);
  const sk3 = cSat.items.find(i => i.skuId === 'k3');
  log('T11 마감 소급 반영: k3 10 추가·폐기 4 유지', !!sk3 && sk3.sold === 10 && cSat.items.find(i => i.skuId === 'k1').waste === 4);
  r = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + aFrom + '&to=' + aTo);
  log('T12 분석 소급: 미매칭 0·k3 67,500', r.data.unmatchedAmount === 0 && r.data.mix.find(x => x.skuId === 'k3').amount === 67500);
  r = await call('op2', 'PUT', '/api/pos/links/s3', { provider: 'tossplace', merchantId: '42', accessKey: 'AKKEY123', secretKey: 'SKKEY456' });
  log('T13 tossplace 키 등록', r.status === 200);
  r = await call('op2', 'GET', '/api/pos/links');
  log('T14 키 평문 미노출(hasKeys만)', !JSON.stringify(r.data).includes('AKKEY123') && r.data.links.find(L => L.storeId === 's3').hasKeys === true);
  r = await call('m', 'GET', '/api/export');
  log('T15 백업에 POS 키 부재·별칭 포함', !JSON.stringify(r.data).includes('AKKEY123') && Array.isArray(r.data.aliases) && r.data.aliases.some(a2 => a2.skuId === 'k3'));
  const kp1 = _test.kstParts('2026-08-01T15:00:00Z'), kp2 = _test.kstParts('2026-08-01T15:00:00');
  log('T16 KST 변환: 15:00Z→익일 00시 / 무오프셋→그대로', kp1.date === '2026-08-02' && kp1.hour === 0 && kp2.date === '2026-08-01' && kp2.hour === 15);

  /* ===== U. POS 기간 백필 ===== */
  r = await call('sa', 'POST', '/api/pos/backfill/s2', { days: 3 });
  log('U1 영업: 백필 403', r.status === 403);
  r = await call('op2', 'POST', '/api/pos/backfill/s2', { days: 3 });
  let expBf = 0;
  for (let i = 2; i >= 0; i--) { const d = addD(t, -i); expBf += (day(d) === 0 || day(d) === 6) ? 471000 : 235500; }
  log('U2 백필 3일: 일자·매출 합계 정확', r.status === 200 && r.data.results.length === 3 && r.data.revenue === expBf && r.data.errors === 0);
  chk = await call('m', 'GET', '/api/bootstrap');
  log('U3 백필 감사 요약 1건 기록', chk.data.audit.some(a2 => a2.act.includes('POS 백필')));
  r = await call('op2', 'GET', '/api/pos/backfills');
  log('U4 수동 백필 전 작업 없음', r.status === 200 && Array.isArray(r.data.jobs) && r.data.jobs.length === 0);
  r = await call('op2', 'POST', '/api/pos/backfill/s2', { years: 2, days: 1 });
  log('U5 백필은 1·3·5년만 허용', r.status === 400 && r.data.error === 'BACKFILL_YEARS');
  const bf5 = typeof _test.backfillBounds === 'function' ? _test.backfillBounds(t, 5, '2020-01-01') : null;
  log('U6 5개년 경계·월 단위 분할', !!bf5 && bf5.years === 5 && bf5.from <= addD(t, -(365 * 5 - 2))
    && bf5.to === t && bf5.totalDays >= 1825 && bf5.totalDays <= 1827 && bf5.chunks.length >= 60 && bf5.chunks.length <= 61);
  r = await call('op2', 'POST', '/api/pos/backfill/s2', { years: 1, days: 1 });
  const manualJob = r.data && r.data.job;
  log('U7 1년 수동 백필 작업 생성(즉시 응답)', r.status === 202 && manualJob && manualJob.storeId === 's2'
    && manualJob.years === 1 && manualJob.status === 'queued' && manualJob.manual === true);
  r = await call('op2', 'POST', '/api/pos/backfill/s2', { years: 3, days: 1 });
  log('U8 같은 매장 중복 백필 차단', r.status === 409 && r.data.error === 'BACKFILL_ACTIVE');
  r = await call('sa', 'GET', '/api/pos/backfills');
  log('U9 영업 계정 작업 상태 조회 403', r.status === 403);
  r = await call('op2', 'GET', '/api/pos/backfills');
  const savedJob = r.data && r.data.jobs && r.data.jobs.find(j => manualJob && j.id === manualJob.id);
  log('U10 수동 작업 상태 저장·자동 반복 없음', r.status === 200 && r.data.jobs.length === 1 && savedJob
    && savedJob.status === 'queued' && savedJob.completedDays === 0 && savedJob.totalDays >= 365);
  db.prepare("UPDATE pos_backfills SET status='interrupted',from_date=?,to_date=?,next_date=? WHERE id=?")
    .run(addD(t, -400), addD(t, -35), addD(t, -300), manualJob.id);
  r = await call('op2', 'POST', '/api/pos/backfill/s2', { years: 1 });
  log('U11 날짜가 바뀐 뒤에도 같은 기간 버튼으로 중단 작업 재개', r.status === 202 && r.data.resumed === true
    && r.data.job.id === manualJob.id && r.data.job.from === addD(t, -400) && r.data.job.status === 'queued');

  /* ===== V. POS 연결 진단 ===== */
  r = await call('sa', 'POST', '/api/pos/test/s2', {});
  log('V1 영업: 진단 403', r.status === 403);
  r = await call('op2', 'POST', '/api/pos/test/s2', {});
  log('V2 mock 진단 통과', r.status === 200 && r.data.ok === true);
  r = await call('op2', 'POST', '/api/pos/test/s1', {});
  log('V3 미연동 매장 진단 404(NO_LINK)', r.status === 404);
  r = await call('op2', 'PUT', '/api/pos/links/s3', { provider: 'tossplace', merchantId: '  9942  ', accessKey: ' AK ', secretKey: ' SK ' });
  chk = await call('op2', 'GET', '/api/pos/links');
  log('V4 저장 시 공백 제거(merchantId)', chk.data.links.find(L => L.storeId === 's3').merchantId === '9942');

  /* ===== W. 토스플레이스 웹훅 수신 (매장 ID 자동 감지) ===== */
  {
    const wr = await fetch(BASE + '/api/webhooks/tossplace', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt-1', type: 'app.installation.created.v1', merchantId: 7777001, app: 'ofd-workstation' }) });
    log('W1 웹훅: X-OFD 없이 수신 200', wr.status === 200);
  }
  {
    const wr2 = await fetch(BASE + '/api/webhooks/tossplace', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt-2', type: 'order.order.completed.v1', merchantId: 7777002, app: 'ofd-workstation' }) });
    log('W1b 주문 이벤트 수신 200', wr2.status === 200);
  }
  r = await call('op2', 'GET', '/api/pos/links');
  log('W2 이벤트 merchantId 노출(설치+주문)', Array.isArray(r.data.events) && r.data.events.some(e => e.merchantId === '7777001') && r.data.events.some(e => e.merchantId === '7777002'));
  chk = await call('m', 'GET', '/api/bootstrap');
  log('W3 설치 이벤트 감사 기록', chk.data.audit.some(a2 => a2.who === '토스플레이스 웹훅' && a2.act.includes('7777001')));

  /* ===== X. 매출현황 리포트 ===== */
  r = await call('sa', 'GET', '/api/salesreport');
  log('X1 영업: 리포트 403', r.status === 403);
  r = await call('op2', 'GET', '/api/salesreport');
  log('X2 운영: 리포트 403(need settle)', r.status === 403 && r.data.need === 'settle');
  r = await call('ad', 'GET', '/api/salesreport?from=' + satD + '&to=' + satD + '&unit=day&stores=s2');
  log('X3 일별·단일매장: 471,000 / 100개 / POS', r.status === 200 && r.data.rows.length === 1
    && r.data.rows[0].total.amount === 471000 && r.data.rows[0].total.qty === 100
    && r.data.stores[0].source === 'pos');
  const syncedAmt = {}; [satD, monD, addD(t, -2), addD(t, -1), t].forEach(d => {
    syncedAmt[d] = (day(d) === 0 || day(d) === 6) ? 471000 : 235500; });
  const wFrom = addD(satD, -6);
  let expWeek = 0;
  Object.keys(syncedAmt).forEach(d => { if (d >= wFrom && d <= satD) expWeek += syncedAmt[d]; });
  r = await call('ad', 'GET', '/api/salesreport?from=' + wFrom + '&to=' + satD + '&unit=week&stores=s2');
  log('X4 주별 합계 = 일별 합산과 일치', r.status === 200 && r.data.grand.amount === expWeek);
  r = await call('ad', 'GET', '/api/salesreport?from=' + satD + '&to=' + satD + '&unit=day&stores=s2&skus=k2');
  log('X5 품목 필터(k2): 174,000 / 30개', r.data.grand.amount === 174000 && r.data.grand.qty === 30);
  r = await call('ad', 'GET', '/api/salesreport?from=' + satD + '&to=' + satD + '&unit=day&stores=s2&skus=k3');
  chk = await call('ad', 'GET', '/api/salesreport?from=' + satD + '&to=' + satD + '&unit=day&stores=s2&skus=__unmatched');
  log('X6 별칭 소급 반영: k3 45,000 · 미매칭 0', r.data.grand.amount === 45000 && chk.data.grand.amount === 0);
  r = await call('ad', 'GET', '/api/salesreport?from=' + t + '&to=' + t + '&unit=day&stores=s77');
  log('X7 마감 폴백 매장: 52,000 / closings', r.data.grand.amount === 52000 && r.data.stores[0].source === 'closings');
  {
    const dRange = 'from=' + monD + '&to=' + satD + '&stores=s2';
    const rd = await call('ad', 'GET', '/api/salesreport?' + dRange + '&unit=day');
    const rm = await call('ad', 'GET', '/api/salesreport?' + dRange + '&unit=month');
    log('X8 월별 합계 = 일별 합계', rd.data.grand.amount === rm.data.grand.amount && rd.data.grand.qty === rm.data.grand.qty);
  }

  /* ===== Y. 미매칭 지능화 — 제안·통합 내역·해제 ===== */
  {
    const s1 = _test.suggestSku('보스톤크림 (BO)');
    const s2b = _test.suggestSku('버터피스타치오 (B)');
    const s3 = _test.suggestSku('레몬에이드');
    log('Y1 유사도 제안: 보스톤→보스턴·괄호 무시·음료는 제안 없음',
      !!s1 && s1.name === '보스턴크림' && !!s2b && s2b.name === '버터피스타치오' && s2b.score >= 85 && s3 === null);
  }
  r = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + satD + '&to=' + satD);
  {
    const mk3 = r.data.mix.find(x => x.skuId === 'k3');
    const mk1 = r.data.mix.find(x => x.skuId === 'k1');
    log('Y2 믹스 드릴다운: 통합 원본 메뉴명 노출', !!mk3 && mk3.names.some(n => n.name === '신메뉴딸기') && mk3.names[0].amount === 45000
      && !!mk1 && mk1.names.some(n => n.name === '우유크림도넛'));
  }
  const berryDates = [...new Set([satD, monD, addD(t, -2), addD(t, -1), t])];
  const berryQty = berryDates.reduce((a2, d) => a2 + ((day(d) === 0 || day(d) === 6) ? 10 : 5), 0);
  r = await call('op2', 'GET', '/api/pos/aliases');
  {
    const al = r.data.aliases.find(a2 => a2.skuId === 'k3');
    log('Y3 별칭 목록: 통합 원본·누적 수량 정확', !!al && al.names.includes('신메뉴딸기') && al.qty === berryQty);
  }
  r = await call('op2', 'DELETE', '/api/pos/alias/' + encodeURIComponent('신메뉴딸기'));
  log('Y4 별칭 해제: 전체 매장일 소급 원복', r.status === 200 && r.data.rebuilt === berryDates.length);
  r = await call('op2', 'GET', '/api/pos/unmatched');
  {
    const um2 = r.data.items.find(x => x.name === '신메뉴딸기');
    log('Y5 해제 후 미매칭 복귀(제안 없음)', !!um2 && um2.qty === berryQty && um2.suggest === null);
  }
  chk = await call('own2', 'GET', '/api/bootstrap');
  {
    const cS = chk.data.sales.find(c => c.date === satD);
    log('Y6 마감 원복: k3 제거·폐기 4 유지', !cS.items.find(i => i.skuId === 'k3') && cS.items.find(i => i.skuId === 'k1').waste === 4);
  }
  r = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + satD + '&to=' + satD);
  log('Y7 분석 원복: 미매칭 45,000 재표시', r.data.unmatchedAmount === 45000);

  /* ===== AA. SKU 승격·연쇄 삭제 ===== */
  r = await call('op2', 'POST', '/api/skus/promote', { rawName: '신메뉴딸기', price: 4500 });
  log('AA1 운영: 승격 403(need skus)', r.status === 403 && r.data.need === 'skus');
  r = await call('ad', 'POST', '/api/skus/promote', { rawName: '신메뉴딸기', price: 4500 });
  const proId = r.data.skuId;
  log('AA2 승격: SKU 생성+매핑+소급', r.status === 200 && r.data.name === '신메뉴딸기'
    && r.data.supply === 2160 && r.data.rebuilt === berryDates.length);
  chk = await call('op2', 'GET', '/api/pos/unmatched');
  log('AA3 승격 후 미매칭 소거', !chk.data.items.some(x => x.name === '신메뉴딸기'));
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AA4 마감 소급: 신 SKU sold 10', chk.data.sales.find(c => c.date === satD).items.find(i => i.skuId === proId).sold === 10);
  r = await call('ad', 'POST', '/api/skus/promote', { rawName: '신메뉴딸기 (S)', price: 4500 });
  log('AA5 동일 이름 재승격 409', r.status === 409 && r.data.error === 'SKU_EXISTS');
  r = await call('ad', 'DELETE', '/api/skus/' + proId);
  log('AA6 연쇄 삭제: 별칭 1건 해제·소급 원복', r.status === 200 && r.data.unmapped === 1 && r.data.rebuilt === berryDates.length);
  chk = await call('op2', 'GET', '/api/pos/unmatched');
  const um3 = chk.data.items.find(x => x.name === '신메뉴딸기');
  log('AA7 삭제 후 미매칭 복귀·수량 보존', !!um3 && um3.qty === berryQty);
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AA8 마감 원복·폐기 유지', !chk.data.sales.find(c => c.date === satD).items.find(i => i.skuId === proId)
    && chk.data.sales.find(c => c.date === satD).items.find(i => i.skuId === 'k1').waste === 4);

  /* ===== AB. 상품 관리 — 카테고리·매장 전용·가격 편차 ===== */
  r = await call('op2', 'PATCH', '/api/skus/k1', { category: '도넛' });
  log('AB1 운영: SKU 수정 403(need skus)', r.status === 403);
  r = await call('ad', 'PATCH', '/api/skus/k1', { category: '도넛' });
  chk = await call('ad', 'GET', '/api/bootstrap');
  log('AB2 카테고리 지정 저장', r.status === 200 && chk.data.skus.find(k => k.id === 'k1').category === '도넛');
  r = await call('ad', 'PATCH', '/api/skus/k2', { category: '링도넛' });
  chk = await call('ad', 'GET', '/api/bootstrap');
  log('AB2b 링도넛 카테고리 허용', r.status === 200 && chk.data.skus.find(k => k.id === 'k2').category === '링도넛');
  r = await call('ad', 'PATCH', '/api/skus/k2', { category: '없는분류' });
  log('AB2c 미정의 카테고리 거부 400', r.status === 400 && r.data.error === 'BAD_CATEGORY');
  r = await call('ad', 'POST', '/api/skus', { name: '수제쿠키', price: 3000, category: '기타', storeId: 's77' });
  log('AB3 매장 전용 SKU 생성', r.status === 200);
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AB4 타 매장에 전용 SKU 미노출', !chk.data.skus.some(k => k.name === '수제쿠키') && chk.data.skus.some(k => k.id === 'k1'));
  r = await call('ad', 'POST', '/api/skus/promote', { rawName: '신메뉴딸기', price: 4500, category: '도넛', storeId: 's2' });
  const proId2 = r.data.skuId;
  log('AB5 매장 전용 승격+소급', r.status === 200 && r.data.rebuilt === berryDates.length);
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AB6 전용 SKU: 자기 매장 노출·마감 반영', chk.data.skus.some(k => k.id === proId2 && k.storeId === 's2')
    && chk.data.sales.find(c => c.date === satD).items.find(i => i.skuId === proId2).sold === 10);
  r = await call('ad', 'GET', '/api/pos/unmatched');
  log('AB7 관리 권한 미매칭 접근(pos|skus)·소거 확인', r.status === 200 && !r.data.items.some(x => x.name === '신메뉴딸기'));
  await call('ad', 'PATCH', '/api/skus/' + proId2, { price: 5000 });
  r = await call('ad', 'GET', '/api/products/prices?days=400');
  {
    const it = r.data.items.find(x => x.skuId === proId2);
    const st2 = it && it.stores.find(s3 => s3.storeId === 's2');
    log('AB8 가격 편차: 실측 4,500 vs 기준 5,000 = -10% low',
      !!st2 && st2.avg === 4500 && Math.round(st2.diffPct) === -10 && it.flag === 'low');
  }
  r = await call('sa', 'GET', '/api/products/prices');
  log('AB9 영업: 가격 편차 403', r.status === 403);
  await call('ad', 'DELETE', '/api/skus/' + proId2);
  r = await call('ad', 'GET', '/api/pos/unmatched');
  {
    const um4 = r.data.items.find(x => x.name === '신메뉴딸기');
    log('AB10 전용 SKU 연쇄 삭제: 원복+매장 내역', !!um4 && um4.qty === berryQty
      && um4.stores.some(st3 => st3.storeId === 's2' && st3.qty === berryQty));
  }

  /* ===== AC. 범위 인라인 수정·단가 구성 ===== */
  r = await call('ad', 'PATCH', '/api/skus/k4', { storeId: 's77' });
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AC1 전용 전환: 타 매장에서 사라짐', r.status === 200 && !chk.data.skus.some(k => k.id === 'k4'));
  r = await call('ad', 'PATCH', '/api/skus/k4', { storeId: '' });
  chk = await call('own2', 'GET', '/api/bootstrap');
  log('AC2 공통 복귀: 다시 노출', r.status === 200 && chk.data.skus.some(k => k.id === 'k4'));
  r = await call('ad', 'POST', '/api/skus', { name: '오리지널', price: 3000, storeId: 's77' });
  const dupSid = r.data.skuId;
  r = await call('ad', 'PATCH', '/api/skus/' + dupSid, { storeId: '' });
  log('AC3 범위 충돌 가드 409', r.status === 409 && r.data.error === 'SKU_EXISTS');
  await call('ad', 'DELETE', '/api/skus/' + dupSid);
  r = await call('ad', 'GET', '/api/products/prices?days=400');
  {
    const it = r.data.items.find(x => x.skuId === 'k1');
    const st3 = it && it.stores.find(x => x.storeId === 's2');
    log('AC4 단가 구성: 단일가 4,200원 분포 정확', !!st3 && st3.unitBreakdown.length === 1
      && st3.unitBreakdown[0].unit === 4200 && st3.unitBreakdown[0].qty === st3.qty);
  }

  /* ===== AD. 전용 SKU 매핑 스코프 ===== */
  r = await call('ad', 'POST', '/api/skus', { name: '독산한정쿠키', price: 3000, category: '기타', storeId: 's2' });
  const exSku = r.data.skuId;
  r = await call('ad', 'POST', '/api/pos/alias', { alias: '신메뉴딸기', skuId: exSku });
  log('AD1 전용 SKU 매핑: scoped 적용', r.status === 200 && r.data.scoped === true && r.data.rebuilt === berryDates.length);
  chk = await call('ad', 'GET', '/api/pos/aliases');
  {
    const al2 = chk.data.aliases.find(a2 => a2.skuId === exSku);
    log('AD2 별칭 목록: 매장 스코프 표기·수량 매장분만', !!al2 && al2.storeId === 's2' && al2.qty === berryQty);
  }
  r = await call('ad', 'POST', '/api/pos/alias', { alias: '없는품목xyz', skuId: exSku });
  log('AD3 미판매 품목의 전용 매핑 차단 400', r.status === 400 && r.data.error === 'NOT_SOLD_AT_STORE');
  r = await call('ad', 'DELETE', '/api/pos/alias/' + encodeURIComponent('신메뉴딸기@@s2'));
  log('AD4 스코프 별칭 해제', r.status === 200 && r.data.rebuilt === berryDates.length);
  chk = await call('ad', 'GET', '/api/pos/unmatched');
  log('AD5 해제 후 미매칭 복귀', chk.data.items.some(x => x.name === '신메뉴딸기' && x.qty === berryQty));
  await call('ad', 'DELETE', '/api/skus/' + exSku);

  /* ===== AE. SKU 삭제 → 미매칭 원복 (이름 직결분 포함) ===== */
  {
    const before = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + satD + '&to=' + satD);
    const k1qty = before.data.mix.find(x => x.skuId === 'k1').qty;
    r = await call('ad', 'DELETE', '/api/skus/k1');
    log('AE1 이름 직결 매출도 원복 대상', r.status === 200 && r.data.restoredQty > 0 && r.data.rebuilt > 0);
    chk = await call('ad', 'GET', '/api/pos/unmatched');
    const um5 = chk.data.items.find(x => x.name === '우유크림도넛');
    log('AE2 삭제 SKU가 미매칭 목록으로 복귀', !!um5 && um5.qty >= k1qty);
    chk = await call('own2', 'GET', '/api/bootstrap');
    {
      const cs = chk.data.sales.find(c => c.date === satD);
      const k1row = cs.items.find(i => i.skuId === 'k1');
      log('AE3 마감 판매수량 0으로 원복·폐기 보존·타 품목 유지',
        (!k1row || (k1row.sold === 0 && k1row.waste === 4)) && cs.items.some(i => i.skuId === 'k2' && i.sold > 0));
    }
    r = await call('ad', 'POST', '/api/skus/promote', { rawName: '우유크림도넛', price: 4200, category: '도넛' });
    log('AE4 재등록 시 원상 복구', r.status === 200 && r.data.rebuilt > 0);
    chk = await call('ad', 'GET', '/api/analytics?storeId=s2&from=' + satD + '&to=' + satD);
    log('AE5 분석 수량 복원', chk.data.mix.find(x => x.name === '우유크림도넛').qty === k1qty);
  }

  /* ===== AF. 매장 정보 수정 ===== */
  r = await call('sa', 'PATCH', '/api/stores/s77', { region: '서울' });
  log('AF1 영업: 매장 수정 403', r.status === 403);
  r = await call('op2', 'PATCH', '/api/stores/s77', { type: '직영', region: '서울', addr: '금천구 독산동 302-9', phone: '010-2193-5280', openDate: '2026-05-10' });
  log('AF2 운영: 전 항목 수정 200', r.status === 200 && r.data.store.type === '직영'
    && r.data.store.openDate === '2026-05-10' && r.data.store.phone === '010-2193-5280');
  r = await call('op2', 'PATCH', '/api/stores/s77', { openDate: '20260-05-10' });
  log('AF3 잘못된 날짜 400', r.status === 400 && r.data.error === 'BAD_DATE');
  r = await call('op2', 'PATCH', '/api/stores/s77', { openDate: '2026-02-31' });
  log('AF3b 실재하지 않는 날짜 400', r.status === 400 && r.data.error === 'BAD_DATE');
  r = await call('op2', 'PATCH', '/api/stores/s77', { type: '위탁' });
  log('AF4 잘못된 구분 400', r.status === 400 && r.data.error === 'BAD_TYPE');
  r = await call('op2', 'PATCH', '/api/stores/s77', { name: '  ' });
  log('AF5 빈 매장명 400', r.status === 400);
  chk = await call('m', 'GET', '/api/bootstrap');
  log('AF6 수정 감사 기록', chk.data.audit.some(a2 => a2.act.startsWith('매장 정보 수정') && a2.act.includes('오픈일')));
  r = await call('op2', 'PATCH', '/api/stores/nope', { region: 'x' });
  log('AF7 없는 매장 404', r.status === 404);

  /* ===== AG. 전화 형식화·지도 키 ===== */
  r = await call('op2', 'PATCH', '/api/stores/s77', { phone: '01085558525' });
  log('AG1 휴대폰 11자리 자동 형식', r.status === 200 && r.data.store.phone === '010-8555-8525');
  r = await call('op2', 'PATCH', '/api/stores/s77', { phone: '0221234567' });
  log('AG2 서울 02 10자리', r.data.store.phone === '02-2123-4567');
  r = await call('op2', 'PATCH', '/api/stores/s77', { phone: '15885535' });
  log('AG3 대표번호 8자리', r.data.store.phone === '1588-5535');
  r = await call('op2', 'PATCH', '/api/stores/s77', { phone: '031-8071-7363' });
  log('AG4 이미 형식화된 값 유지', r.data.store.phone === '031-8071-7363');
  r = await call('sa', 'POST', '/api/config/navermap', { key: 'x' });
  log('AG5 영업: 지도 키 403', r.status === 403);
  r = await call('op2', 'POST', '/api/config/navermap', { key: 'testNcpKey123' });
  chk = await call('m', 'GET', '/api/bootstrap');
  log('AG6 지도 키 저장·부트스트랩 노출', r.status === 200 && chk.data.mapKey === 'testNcpKey123');
  r = await call('op2', 'POST', '/api/config/navermap', { key: '' });
  chk = await call('m', 'GET', '/api/bootstrap');
  log('AG7 키 해제', chk.data.mapKey === '');

  /* ===== AH. 폐기 자동 산출 (입고 − 판매) ===== */
  {
    /* s2 satD: mock 판매 버터피스타치오(k2) 30개. k1은 AE에서 삭제되었으므로 k2·k4로 검증 */
    let o = await call('op2', 'POST', '/api/orders', { storeId: 's2', deliverDate: satD,
      items: [{ skuId: 'k2', qty: 40 }, { skuId: 'k4', qty: 5 }] });
    const oid = o.data.id;
    log('AH1 발주 입고일 지정', o.status === 200);
    chk = await call('ad', 'GET', '/api/waste?storeId=s2&date=' + satD);
    log('AH2 출고 전 입고 없음 → 폐기·로스율 null(N/A)', chk.data.hasOrder === false
      && chk.data.totals.wasteRate === null
      && chk.data.items.every(x => x.received === null && x.waste === null && x.wasteRate === null && x.lossAmount === null));
    for (const st of ['승인', '입금확인', '출고']) await call('op2', 'POST', '/api/orders/' + oid + '/advance', {});
    chk = await call('ad', 'GET', '/api/waste?storeId=s2&date=' + satD);
    const w1 = chk.data.items.find(x => x.skuId === 'k2');
    const w2 = chk.data.items.find(x => x.skuId === 'k4');
    log('AH3 폐기 = 입고 − 판매 (40−30=10 / 5−0=5)', chk.data.hasOrder === true
      && w1.received === 40 && w1.sold === 30 && w1.waste === 10
      && w2.received === 5 && w2.sold === 0 && w2.waste === 5);
    log('AH4 폐기율·로스금액·합계', Math.round(w1.wasteRate) === 25
      && w1.lossAmount === 10 * 2784
      && chk.data.totals.received === 45 && chk.data.totals.waste === 15
      && Math.round(chk.data.totals.wasteRate) === 33);
    chk = await call('own2', 'GET', '/api/bootstrap');
    const cAuto = chk.data.sales.find(c => c.date === satD);
    log('AH5 마감에 폐기 자동 반영', cAuto.items.find(i => i.skuId === 'k2').waste === 10
      && cAuto.items.find(i => i.skuId === 'k2').sold === 30
      && cAuto.items.find(i => i.skuId === 'k4').waste === 5);
    o = await call('op2', 'POST', '/api/orders', { storeId: 's2', deliverDate: monD, items: [{ skuId: 'k2', qty: 5 }] });
    for (const st of ['승인', '입금확인', '출고']) await call('op2', 'POST', '/api/orders/' + o.data.id + '/advance', {});
    chk = await call('ad', 'GET', '/api/waste?storeId=s2&date=' + monD);
    const w3 = chk.data.items.find(x => x.skuId === 'k2');
    log('AH6 판매>입고: 폐기 0·초과분 표기', w3.waste === 0 && w3.over === w3.sold - 5 && w3.over > 0);
    r = await call('sa', 'GET', '/api/waste?storeId=s2&date=' + satD);
    log('AH7 영업: 폐기 조회 403', r.status === 403);
    r = await call('op2', 'POST', '/api/orders', { storeId: 's2', deliverDate: '2026-13-99', items: [{ skuId: 'k2', qty: 1 }] });
    log('AH8 잘못된 입고일 400', r.status === 400);
  }

  /* ===== AI. 감사 로그 검색·보존 ===== */
  r = await call('sa', 'GET', '/api/audit');
  log('AI1 영업: 감사 검색 403', r.status === 403);
  r = await call('op2', 'GET', '/api/audit');
  log('AI2 운영: 감사 검색 403(auditv)', r.status === 403);
  r = await call('ad', 'GET', '/api/audit?limit=10');
  log('AI3 관리: 페이지네이션·보존기간 노출', r.status === 200 && r.data.rows.length <= 10
    && r.data.total >= r.data.rows.length && r.data.keepDays === 30);
  {
    const p1 = await call('ad', 'GET', '/api/audit?limit=10&page=1');
    const p2 = await call('ad', 'GET', '/api/audit?limit=10&page=2');
    const ids1 = new Set(p1.data.rows.map(x => x.id));
    log('AI4 페이지 이동 시 중복 없음(최소 limit 10 적용)', p1.data.rows.length === 10 && p2.data.rows.length > 0
      && p2.data.rows.every(x => !ids1.has(x.id)) && p1.data.limit === 10);
  }
  r = await call('ad', 'GET', '/api/audit?q=' + encodeURIComponent('매장 정보 수정'));
  log('AI5 키워드 검색', r.data.total > 0 && r.data.rows.every(x => x.act.includes('매장 정보 수정')));
  r = await call('ad', 'GET', '/api/audit?from=' + t + '&to=' + t);
  {
    const all = await call('ad', 'GET', '/api/audit?limit=300');
    log('AI6 오늘 일자 필터', r.data.total > 0 && r.data.total <= all.data.total);
  }
  r = await call('ad', 'GET', '/api/audit?from=2020-01-01&to=2020-01-02');
  log('AI7 과거 구간 0건', r.data.total === 0 && r.data.rows.length === 0);
  r = await call('ad', 'GET', '/api/audit?from=2026-13-01');
  log('AI8 잘못된 날짜는 무시(전체 조회)', r.status === 200 && r.data.total > 0);

  /* ===== AJ. 오픈 프로세스 ===== */
  r = await call('sa', 'POST', '/api/open', { name: 'X점', openDate: addD(t, 30) });
  log('AJ1 영업: 오픈 403', r.status === 403);
  r = await call('op2', 'POST', '/api/open', { name: '판교점', region: '경기 판교', openDate: addD(t, 28), mode: '가맹', stype: '테이블형', status: '진행' });
  const opId = r.data.id;
  log('AJ2 프로젝트 생성: 템플릿 자동 생성(테이블형 전용 포함·포장형 제외)', r.status === 200 && r.data.tasks >= 45);
  r = await call('op2', 'GET', '/api/open/' + opId);
  {
    const T3 = r.data.tasks;
    const biz = T3.find(x => x.title === '영업신고증 발급');
    const portal = T3.find(x => x.title.startsWith('포털 위치 등록'));
    const tbl = T3.some(x => x.title.includes('[테이블형]'));
    const pkg = T3.some(x => x.title.includes('[포장형]'));
    log('AJ3 데드라인 반영: 영업신고 D-10·포털 D-10·유형 필터', biz.off === -10 && biz.due === addD(addD(t, 28), -10)
      && portal.off === -10 && tbl && !pkg);
    log('AJ3a 프로젝트 지역 저장·상세 응답', r.data.project.region === '경기 판교');
    log('AJ4 담당 표기: 가맹 모드 → 가맹점', T3.find(x => x.owner === 'pt').ownerLabel === '가맹점');
    const tk1 = T3.find(x => x.title === '위생교육 수료');
    r = await call('op2', 'PATCH', '/api/open/task/' + tk1.id, { done: true, memo: '수료증 수령' });
    log('AJ5 체크 처리', r.status === 200);
  }
  r = await call('op2', 'GET', '/api/open/' + opId);
  {
    const tk = r.data.tasks.find(x => x.title === '위생교육 수료');
    log('AJ6 완료자·시각 기록', tk.done === true && tk.doneBy.length > 0 && tk.doneAt > 0 && tk.memo === '수료증 수령');
  }
  r = await call('op2', 'POST', '/api/open/' + opId + '/task', { title: '몰 셔터 점검', phase: 'D-1주차', owner: 'both' });
  log('AJ7 커스텀 항목 추가', r.status === 200);
  r = await call('op2', 'PATCH', '/api/open/' + opId, { openDate: addD(t, -20) });
  chk = await call('op2', 'GET', '/api/open/' + opId);
  log('AJ8 오픈일 변경 → 마감 재계산·지연 산출', chk.data.tasks.find(x => x.title === '영업신고증 발급').due === addD(addD(t, -20), -10)
    && chk.data.tasks.filter(x => x.overdue).length > 30);
  r = await call('op2', 'POST', '/api/open/' + opId + '/confirm', {});
  log('AJ9 미완료 잔존 시 확정 거부 409', r.status === 409 && r.data.error === 'TASKS_LEFT');
  r = await call('op2', 'POST', '/api/open/' + opId + '/confirm', { force: true, region: '경기', addr: '판교로 1', phone: '01011112222', type: '가맹' });
  log('AJ10 강행 확정 → 매장 생성·전화 형식화', r.status === 200 && !!r.data.code);
  chk = await call('m', 'GET', '/api/bootstrap');
  {
    const ns = chk.data.stores.find(s2 => s2.name === '판교점');
    log('AJ11 매장 대장 자동 등록', !!ns && ns.type === '가맹' && ns.phone === '010-1111-2222' && ns.openDate === addD(t, -20));
  }
  chk = await call('op2', 'GET', '/api/open');
  log('AJ12 프로젝트 완료 상태·확정 지역 반영', chk.data.projects.find(x => x.id === opId).status === '완료'
    && chk.data.projects.find(x => x.id === opId).region === '경기');

  /* ===== AK. 칸반 단계 ===== */
  r = await call('op2', 'POST', '/api/open', { name: '상담테스트점', openDate: addD(t, -5), mode: '가맹', stype: '포장형' });
  const okId = r.data.id;
  chk = await call('op2', 'GET', '/api/open');
  {
    const pj = chk.data.projects.find(x => x.id === okId);
    log('AK1 기본 단계 상담중·지연 미집계', pj.status === '상담중' && pj.overdue === 0);
  }
  r = await call('op2', 'PATCH', '/api/open/' + okId, { status: '진행' });
  chk = await call('op2', 'GET', '/api/open');
  log('AK2 진행 전환 시 지연 집계 시작', r.status === 200
    && chk.data.projects.find(x => x.id === okId).overdue > 0);
  r = await call('op2', 'PATCH', '/api/open/' + okId, { status: '없는단계' });
  chk = await call('op2', 'GET', '/api/open');
  log('AK3 미정의 단계 무시', chk.data.projects.find(x => x.id === okId).status === '진행');
  r = await call('op2', 'PATCH', '/api/open/' + okId, { status: '보류' });
  chk = await call('op2', 'GET', '/api/open');
  log('AK4 보류 전환·지연 정지', chk.data.projects.find(x => x.id === okId).status === '보류'
    && chk.data.projects.find(x => x.id === okId).overdue === 0);
  await call('op2', 'DELETE', '/api/open/' + okId);

  /* ===== AL. 매출현황 품목 드릴다운 ===== */
  r = await call('ad', 'GET', '/api/salesreport?from=' + satD + '&to=' + satD + '&unit=day&stores=s2');
  {
    const row = r.data.rows[0];
    const sum = row.mix.reduce((a2, x) => a2 + x.amount, 0);
    const qs = row.mix.reduce((a2, x) => a2 + x.qty, 0);
    log('AL1 행별 품목 내역 합 = 행 합계', Array.isArray(row.mix) && row.mix.length > 0
      && sum === row.total.amount && qs === row.total.qty);
    log('AL2 금액 내림차순 정렬', row.mix.every((x, i2) => i2 === 0 || row.mix[i2 - 1].amount >= x.amount));
    log('AL3 품목별 매장 내역 포함', row.mix[0].stores.length === 1 && row.mix[0].stores[0].storeId === 's2'
      && row.mix[0].stores[0].amount === row.mix[0].amount);
  }
  r = await call('ad', 'GET', '/api/salesreport?from=' + addD(satD, -6) + '&to=' + satD + '&unit=week&stores=s2');
  {
    const row = r.data.rows[0];
    log('AL4 주별 버킷에도 품목 집계', row.mix.length > 0
      && row.mix.reduce((a2, x) => a2 + x.amount, 0) === row.total.amount);
  }
  r = await call('ad', 'GET', '/api/salesreport?from=' + t + '&to=' + t + '&unit=day&stores=s77');
  log('AL5 마감 폴백 매장도 품목 내역 제공', r.data.rows.length > 0 && r.data.rows[0].mix.length > 0);

  /* ===== Z. 예시 데이터 삭제 ===== */
  r = await call('ad', 'POST', '/api/admin/purge-demo', {});
  log('Z1 관리: 삭제 403(마스터 전용)', r.status === 403);
  r = await call('m', 'POST', '/api/admin/purge-demo', {});
  log('Z2 삭제 실행: 매장3·마감3·리드2·발주1·공지1',
    r.status === 200 && r.data.counts.stores === 3 && r.data.counts.closings === 3
    && r.data.counts.leads === 2 && r.data.counts.orders === 1 && r.data.counts.notices === 1);
  chk = await call('m', 'GET', '/api/bootstrap');
  log('Z3 시드 매장 제거·실매장 유지', !chk.data.stores.some(s => ['s1', 's2', 's3'].includes(s.id))
    && chk.data.stores.some(s => s.id === 's77') && !chk.data.sales.some(c => c.storeId === 's2' && ['c1','c2','c3'].includes(c.id)));
  r = await call('own2', 'GET', '/api/bootstrap');
  log('Z4 삭제 매장 점주 세션 즉시 무효', r.status === 401);
  r = await call('m', 'POST', '/api/admin/purge-demo', {});
  log('Z5 재실행 멱등(0건)', r.status === 200 && r.data.counts.stores === 0 && r.data.counts.closings === 0);

  /* ===== R. UI ===== */
  const ui = await fetch(BASE + '/');
  const uiText = await ui.text();
  log('R1 UI: UTF-8 + 계정 게이트', (ui.headers.get('content-type') || '').includes('utf-8') && uiText.includes('부서 계정'));
  log('R2 오픈 보드 UI: KPI·검색·지연 필터·4열 고정·카드 상태 select 제거',
    uiText.includes('class="kpis open-kpis"') && uiText.includes('id="op_q"') && uiText.includes('id="op_delay"')
    && ['전체 프로젝트', '30일 내 오픈', '지연 프로젝트', '미완료 체크리스트'].every(x => uiText.includes(x))
    && ['open-card-name', 'open-card-region', '운영 방식 ·', '매장 유형 ·', '오픈 예정일', '진행률'].every(x => uiText.includes(x))
    && uiText.includes("const COLS=['상담중','진행','보류','완료']") && uiText.includes('max-width:1680px')
    && !uiText.includes('data-opst='));
  log('R3 오픈 상세 헤더·전체 진행사항 XLSX 내보내기',
    ['open-detail-header', 'open-detail-title', 'open-detail-schedule', '전체 진행사항 Excel'].every(x => uiText.includes(x))
    && ['프로젝트 현황', '전체 체크리스트', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'].every(x => uiText.includes(x))
    && uiText.includes("projects.map(p=>api('GET','/api/open/'+p.id))"));
  log('R4 매출 분석: 당일 기간 선택 제공', uiText.includes('[1,7,30,90]')
    && uiText.includes("d===1?'당일':d+'일'"));
  log('R5 일별 매출: 평균선·최고/선택 요약·날짜별 접근 가능한 막대',
    ['daily-chart-scroll', 'daily-average-line', 'daily-bar-value', '최고 매출', '선택일'].every(x => uiText.includes(x))
    && uiText.includes('data-anday="${d.date}"') && uiText.includes('aria-label="${d.date}'));
  log('R6 분석 탭명·매장별 수동 1·3·5년 백필 UI',
    !uiText.includes("['an','분석']") && uiText.includes("['an','매출 분석']")
    && ['1년 백필', '3년 백필', '5년 백필', '백필 상태 새로고침', '수동 실행'].every(x => uiText.includes(x)));
  log('R7 매장 운영 가이드: 메뉴·검색·상황/역할 필터·읽기 전용 안전표시',
    uiText.includes("['guide','매장 운영 가이드']") && uiText.includes("guide:['master','ops']")
    && ['id="guide_search"', 'data-guide-section=', 'data-guide-role=', '가격 확인 필요', '본사 확인 중', '읽기 전용'].every(x => uiText.includes(x))
    && uiText.includes('체크 결과나 진행률을 저장하지 않습니다')
    && !uiText.includes('올드페리도넛_매장운영매뉴얼_2026.ver.xlsx'));
  log('R8 매장 운영 가이드: 미검수 알레르기 정보를 공란으로 오인하지 않게 표시',
    uiText.includes("const allergensHidden=hidden.includes('allergens')")
    && uiText.includes('알레르기 · 본사 확인 중'));

  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' integration checks passed');
  server.close();
  process.exit(pass === R.length ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
