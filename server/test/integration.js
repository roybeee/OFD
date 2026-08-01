/* 통합 테스트 v2 — 부서 계정 RBAC 포함. 실행: node --no-warnings test/integration.js */
'use strict';
process.env.DB_PATH = '/tmp/ofd_t2_' + Date.now() + '.db';
process.env.PORT = '8899';
const { server, _test } = require('../server.js');
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

  /* ===== R. UI ===== */
  const ui = await fetch(BASE + '/');
  const uiText = await ui.text();
  log('R1 UI: UTF-8 + 계정 게이트', (ui.headers.get('content-type') || '').includes('utf-8') && uiText.includes('부서 계정'));

  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' integration checks passed');
  server.close();
  process.exit(pass === R.length ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
