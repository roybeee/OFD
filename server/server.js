/* =============================================================
 * OFD 프랜차이즈 워크스테이션 — 서버판 v2 (부서 계정)
 * 의존성 0개: node:http + node:sqlite + node:crypto (Node >= 22.5)
 * 본사 계정 분리: 마스터 / 관리 / 운영 / 영업 — 기능별 권한을 서버가 강제.
 * 기존 v1(단일 PIN) DB는 최초 기동 시 master 계정으로 자동 이관.
 * ============================================================= */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ofd.db');
const SECURE = process.env.SECURE_COOKIES === '1';
const SESSION_HOURS = +(process.env.SESSION_HOURS || 12);
const PUB = path.join(__dirname, 'public');

/* ---------------- DB ---------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT,
  dept TEXT, pw_hash TEXT, active INTEGER DEFAULT 1, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stores(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, region TEXT,
  addr TEXT, phone TEXT, open_date TEXT, code_hash TEXT, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, name TEXT, phone TEXT, area TEXT,
  store_name TEXT, stage INTEGER DEFAULT 0, doc_date TEXT, advisor INTEGER DEFAULT 0,
  open_target TEXT, memo TEXT, flag INTEGER DEFAULT 0, created TEXT, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS skus(id TEXT PRIMARY KEY, name TEXT, price INTEGER, supply INTEGER,
  mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, store_id TEXT, date TEXT, status TEXT,
  memo TEXT, items TEXT, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS closings(id TEXT PRIMARY KEY, store_id TEXT, date TEXT, items TEXT,
  mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, date TEXT, title TEXT, body TEXT,
  pinned INTEGER DEFAULT 0, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, role TEXT, store_id TEXT, user_id TEXT,
  created INTEGER, expires INTEGER);
CREATE INDEX IF NOT EXISTS idx_close ON closings(store_id, date);
CREATE INDEX IF NOT EXISTS idx_ord ON orders(store_id, date);
`);
try { db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT'); } catch (e) {}
db.exec(`
CREATE TABLE IF NOT EXISTS pos_links(store_id TEXT PRIMARY KEY, provider TEXT, merchant_id TEXT,
  access_key_enc TEXT, secret_key_enc TEXT, active INTEGER DEFAULT 1,
  last_sync INTEGER, last_result TEXT, mt INTEGER, del INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pos_sales(id TEXT PRIMARY KEY, store_id TEXT, date TEXT, hour INTEGER,
  sku_id TEXT, raw_name TEXT, qty INTEGER, amount INTEGER, mt INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pos ON pos_sales(store_id, date, hour, raw_name);
CREATE INDEX IF NOT EXISTS idx_pos_sd ON pos_sales(store_id, date);
CREATE TABLE IF NOT EXISTS sku_aliases(alias TEXT PRIMARY KEY, sku_id TEXT, mt INTEGER);
CREATE TABLE IF NOT EXISTS pos_events(id TEXT PRIMARY KEY, ts INTEGER, type TEXT, merchant_id TEXT, app TEXT, raw TEXT);
`);
try { db.exec('ALTER TABLE skus ADD COLUMN category TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE skus ADD COLUMN store_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE sku_aliases ADD COLUMN store_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN deliver_date TEXT'); db.exec('UPDATE orders SET deliver_date=date WHERE deliver_date IS NULL'); } catch (e) {}

/* ---------------- utils ---------------- */
const uid = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const now = () => Date.now();
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const kstDayStart = d => new Date(d + 'T00:00:00+09:00').getTime(); /* KST 자정 → epoch ms */
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function pwHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function pwVerify(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(test, 'hex')); }
  catch (e) { return false; }
}
const genCode = () => String(crypto.randomInt(100000, 1000000));

const cfgGet = k => { const r = db.prepare('SELECT v FROM config WHERE k=?').get(k); return r ? r.v : null; };
const cfgSet = (k, v) => db.prepare('INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
/* POS API 키 보관용 대칭키: 환경변수 OFD_SECRET 우선, 없으면 최초 1회 생성해 DB에 보관 */
function encKey() {
  if (process.env.OFD_SECRET) return crypto.createHash('sha256').update(process.env.OFD_SECRET).digest();
  let k = cfgGet('enc_key');
  if (!k) { k = crypto.randomBytes(32).toString('hex'); cfgSet('enc_key', k); }
  return Buffer.from(k, 'hex');
}
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decSecret(b64) {
  try {
    const b = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

const AUDIT_KEEP_DAYS = 30;
function purgeAudit() { /* 보존 기간 초과 감사 로그 정리 */
  try {
    const cut = now() - AUDIT_KEEP_DAYS * 864e5;
    const r = db.prepare('DELETE FROM audit WHERE ts < ?').run(cut);
    return r.changes | 0;
  } catch (e) { return 0; }
}
function audit(actor, action, detail) {
  db.prepare('INSERT INTO audit(id,ts,actor,action,detail) VALUES(?,?,?,?,?)')
    .run(uid('g'), now(), actor, action, detail || '');
}

function fmtPhone(v) { /* 한국 전화번호 자동 형식화 — 규칙 밖 입력은 원문 유지 */
  const t = String(v || '').trim();
  const d = t.replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('02')) {
    if (d.length === 9) return '02-' + d.slice(2, 5) + '-' + d.slice(5);
    if (d.length === 10) return '02-' + d.slice(2, 6) + '-' + d.slice(6);
  } else if (d.startsWith('0')) {
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    if (d.length === 11) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  } else if (d.length === 8 && /^1[0-9]{3}/.test(d)) {
    return d.slice(0, 4) + '-' + d.slice(4);
  }
  return t;
}
try { /* 기존 매장 전화번호 일괄 정규화 (멱등) */
  db.prepare('SELECT id, phone FROM stores').all().forEach(r => {
    const f = fmtPhone(r.phone);
    if (f !== (r.phone || '')) db.prepare('UPDATE stores SET phone=? WHERE id=?').run(f, r.id);
  });
} catch (e) {}

/* ---------------- 부서 권한 (서버 강제) ---------------- */
const DEPTS = { master: '마스터', admin: '관리', ops: '운영', sales: '영업' };
const CATS = ['도넛', '링도넛', '음료', '굿즈', '서비스', '세트', '기타'];
const CAP = {
  leads:   ['master', 'sales'],            // 가맹 영업 파이프라인
  orders:  ['master', 'ops'],              // 발주 상태 전이·반려·대리 발주
  closings:['master', 'ops'],              // 본사 측 마감 입력·CSV
  notices: ['master', 'ops'],              // 공지 게시·삭제
  stores:  ['master', 'ops'],              // 매장 등록·삭제
  codes:   ['master', 'ops'],              // 접속코드 재발급
  pos:     ['master', 'ops'],              // POS 연동 관리·수동 동기화
  skus:    ['master', 'admin'],            // 품목·가격
  settle:  ['master', 'admin'],            // 정산 조회
  auditv:  ['master', 'admin'],            // 감사 로그 열람
  users:   ['master'],                     // 계정 관리
  backup:  ['master']                      // 백업·이관
};
const hasCap = (user, cap) => !!(user && CAP[cap] && CAP[cap].includes(user.dept));

/* ---------------- v1(단일 PIN) → master 계정 자동 이관 ---------------- */
(function migrateLegacyPin() {
  const uc = db.prepare('SELECT COUNT(*) c FROM users WHERE del=0').get().c;
  const ph = cfgGet('pin_hash');
  if (uc === 0 && ph) {
    db.prepare('INSERT INTO users(id,username,name,dept,pw_hash,active,mt) VALUES(?,?,?,?,?,1,?)')
      .run(uid('u'), 'master', '관리자', 'master', ph, now());
    audit('시스템', '계정 이관', '기존 단일 PIN → master 계정 (아이디 master, 비밀번호 = 기존 PIN)');
  }
})();

/* ---------------- row <-> camelCase ---------------- */
const J = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
const mStore = r => r && ({ id: r.id, name: r.name, type: r.type, region: r.region, addr: r.addr, phone: r.phone, openDate: r.open_date, hasCode: !!r.code_hash, mt: r.mt });
const mLead = r => r && ({ id: r.id, name: r.name, phone: r.phone, area: r.area, storeName: r.store_name, stage: r.stage, docDate: r.doc_date || '', advisor: !!r.advisor, openTarget: r.open_target || '', memo: r.memo || '', flag: !!r.flag, created: r.created, mt: r.mt });
const mSku = r => r && ({ id: r.id, name: r.name, price: r.price, supply: r.supply, category: r.category || '기타', storeId: r.store_id || null, mt: r.mt });
const mOrder = r => r && ({ id: r.id, storeId: r.store_id, date: r.date, deliverDate: r.deliver_date || r.date, status: r.status, memo: r.memo || '', items: J(r.items), mt: r.mt });
const mClosing = r => r && ({ id: r.id, storeId: r.store_id, date: r.date, items: J(r.items), mt: r.mt });
const mNotice = r => r && ({ id: r.id, date: r.date, title: r.title, body: r.body || '', pinned: !!r.pinned, mt: r.mt });
const mUser = r => r && ({ id: r.id, username: r.username, name: r.name, dept: r.dept, active: !!r.active, mt: r.mt });

const allStores = () => db.prepare('SELECT * FROM stores WHERE del=0 ORDER BY name').all().map(mStore);
const allLeads = () => db.prepare('SELECT * FROM leads WHERE del=0').all().map(mLead);
const allSkus = () => db.prepare('SELECT * FROM skus WHERE del=0 ORDER BY rowid').all().map(mSku);
const allUsers = () => db.prepare('SELECT * FROM users WHERE del=0 ORDER BY rowid').all().map(mUser);
const ordersOf = sid => (sid
  ? db.prepare('SELECT * FROM orders WHERE del=0 AND store_id=? ORDER BY date DESC, mt DESC').all(sid)
  : db.prepare('SELECT * FROM orders WHERE del=0 ORDER BY date DESC, mt DESC').all()).map(mOrder);
const closingsOf = sid => (sid
  ? db.prepare('SELECT * FROM closings WHERE del=0 AND store_id=? ORDER BY date DESC').all(sid)
  : db.prepare('SELECT * FROM closings WHERE del=0 ORDER BY date DESC').all()).map(mClosing);
const allNotices = () => db.prepare('SELECT * FROM notices WHERE del=0 ORDER BY pinned DESC, date DESC').all().map(mNotice);

/* ---------------- 세션 ---------------- */
function makeSession(role, storeId, userId) {
  const tok = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(th,role,store_id,user_id,created,expires) VALUES(?,?,?,?,?,?)')
    .run(sha256(tok), role, storeId || null, userId || null, now(), now() + SESSION_HOURS * 3600e3);
  return tok;
}
function getSession(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)ofds=([a-f0-9]{48})/);
  if (!m) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE th=?').get(sha256(m[1]));
  if (!s) return null;
  if (s.expires < now()) { db.prepare('DELETE FROM sessions WHERE th=?').run(s.th); return null; }
  let user = null;
  if (s.role === 'hq') {
    const r = db.prepare('SELECT * FROM users WHERE id=? AND del=0 AND active=1').get(s.user_id);
    if (!r) { db.prepare('DELETE FROM sessions WHERE th=?').run(s.th); return null; } // 비활성 즉시 차단
    user = r;
  }
  return { role: s.role, storeId: s.store_id, userId: s.user_id, th: s.th, user };
}
function sessCookie(tok) {
  return `ofds=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}` + (SECURE ? '; Secure' : '');
}
const clearCookie = () => 'ofds=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (SECURE ? '; Secure' : '');
function actorOf(sess) {
  if (!sess) return '-';
  if (sess.role === 'hq') return sess.user.name + ' (' + (DEPTS[sess.user.dept] || sess.user.dept) + ')';
  const st = db.prepare('SELECT name FROM stores WHERE id=?').get(sess.storeId);
  return (st ? st.name : sess.storeId) + ' 점주';
}

/* ---------------- 레이트 리밋 ---------------- */
const rl = new Map();
function limited(key, max, winMs) {
  const t = now(); const e = rl.get(key);
  if (!e || e.reset < t) { rl.set(key, { n: 1, reset: t + winMs }); return false; }
  e.n++; return e.n > max;
}

/* ---------------- 도메인 규칙 ---------------- */
const OSTAT = ['대기', '승인', '입금확인', '출고', '완료'];
function coolingGate(lead) { // 가맹사업법 제7조③ — KST 기준 서버 강제
  if (!lead.docDate) return { has: false };
  const days = lead.advisor ? 7 : 14;
  const gate = addDays(lead.docDate, days);
  return { has: true, days, gate, ok: kstToday() >= gate };
}
function upsertClosing(storeId, date, items, mode) {
  const ex = db.prepare('SELECT * FROM closings WHERE del=0 AND store_id=? AND date=?').get(storeId, date);
  let finalItems = items;
  if (mode === 'import' && ex) { // CSV: 판매 대체, 기존 폐기 보존
    const prev = {}; J(ex.items).forEach(i => { prev[i.skuId] = i; });
    const merged = {};
    items.forEach(i => { merged[i.skuId] = { skuId: i.skuId, sold: i.sold | 0, waste: (prev[i.skuId] ? prev[i.skuId].waste | 0 : 0) }; });
    J(ex.items).forEach(i => { if (!merged[i.skuId] && (i.waste | 0) > 0) merged[i.skuId] = { skuId: i.skuId, sold: 0, waste: i.waste | 0 }; });
    finalItems = Object.values(merged);
  }
  if (ex) db.prepare('UPDATE closings SET items=?, mt=? WHERE id=?').run(JSON.stringify(finalItems), now(), ex.id);
  else db.prepare('INSERT INTO closings(id,store_id,date,items,mt) VALUES(?,?,?,?,?)')
    .run(uid('c'), storeId, date, JSON.stringify(finalItems), now());
}

/* ---------------- POS 연동 (토스플레이스) ---------------- */
const normName = s => String(s || '').replace(/\s+/g, '');
const isDate = v => { /* 형식 + 실재 여부 (2026-13-99 차단) */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const normKey = s => String(s || '').replace(/\([^)]*\)/g, '').replace(/[\s\u00b7.\-_/]/g, '').toLowerCase();
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function suggestSku(rawName) { // 표기 유사도 기반 SKU 제안 (60점 미만은 제안하지 않음)
  const n = normKey(rawName);
  if (!n) return null;
  let best = null;
  for (const k of allSkus()) {
    const kn = normKey(k.name);
    let score;
    if (n === kn) score = 100;
    else if (n.includes(kn) || kn.includes(n)) score = 85;
    else {
      const L = Math.max(n.length, kn.length);
      score = Math.round((1 - lev(n, kn) / L) * 100);
    }
    if (!best || score > best.score) best = { skuId: k.id, name: k.name, score };
  }
  return best && best.score >= 60 ? best : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kstParts(ts) { // ISO 시각 → KST {date, hour}. 오프셋 없으면 KST로 간주
  if (!ts) return null;
  const str = String(ts);
  if (/(?:Z|[+\-]\d{2}:?\d{2})$/.test(str)) {
    const d = new Date(str);
    if (isNaN(d)) return null;
    const parts = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
      .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
    return { date: parts.year + '-' + parts.month + '-' + parts.day, hour: (+parts.hour) % 24 };
  }
  return { date: str.slice(0, 10), hour: +str.slice(11, 13) || 0 };
}
const TP_BASE = 'https://open-api.tossplace.com/api-public/openapi/v1/merchants/';
async function tpGet(url, ak, sk) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'x-access-key': ak, 'x-secret-key': sk, 'Content-Type': 'application/json' }, signal: ac.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error('HTTP ' + r.status + (j && j.error ? ' ' + j.error.reason : ''));
    if (!j || j.resultType !== 'SUCCESS') throw new Error(j && j.error ? j.error.errorCode + ' ' + j.error.reason : 'BAD_ENVELOPE');
    return j.success;
  } finally { clearTimeout(to); }
}
const providers = {
  /* 토스플레이스 Open API — 주문 목록(COMPLETED)을 KST 하루 범위로 페이지 순회 */
  tossplace: {
    async fetchDay(link, date) {
      const from = encodeURIComponent(date + 'T00:00:00+09:00');
      const to = encodeURIComponent(addDays(date, 1) + 'T00:00:00+09:00');
      const ak = decSecret(link.access_key_enc), sk = decSecret(link.secret_key_enc);
      if (!ak || !sk) throw new Error('KEY_DECRYPT_FAIL');
      const agg = new Map();
      for (let page = 1; page <= 40; page++) {
        const url = TP_BASE + encodeURIComponent(link.merchant_id) +
          '/order/orders?from=' + from + '&to=' + to + '&orderStates=COMPLETED&page=' + page + '&size=500&sortOrder=ASC';
        const arr = (await tpGet(url, ak, sk)) || [];
        for (const o of arr) {
          if (o.orderState && o.orderState !== 'COMPLETED') continue;
          const kp = kstParts(o.completedAt || o.createdAt);
          if (!kp || kp.date !== date) continue;
          for (const li of (o.lineItems || [])) {
            const name = (li.item && li.item.title) || '';
            const qty = Number(li.quantity) || 0;
            if (!name || qty <= 0) continue;
            let amt = (li.itemPrice ? Number(li.itemPrice.priceValue) || 0 : 0) * qty;
            (li.optionChoices || []).forEach(c => { amt += (Number(c.priceValue) || 0) * (Number(c.quantity) || 0); });
            (li.appliedDiscounts || []).forEach(d => { amt -= Number(d.amount) || 0; });
            const key = kp.hour + '|' + name;
            const cur = agg.get(key) || { hour: kp.hour, name, qty: 0, amount: 0 };
            cur.qty += qty; cur.amount += Math.max(0, amt);
            agg.set(key, cur);
          }
        }
        if (arr.length < 500) break;
        await sleep(150); /* 매장별 호출량 제한(초당 10) 준수 */
      }
      return [...agg.values()];
    }
  },
  /* 결정적 목 드라이버 — 키 발급 전 전체 파이프라인 검증·시연용 */
  mock: {
    async fetchDay(link, date) {
      const wknd = (d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; })(date);
      const P = { '우유크림도넛': 4200, '버터피스타치오': 5800, '신메뉴딸기': 4500 };
      const plan = wknd
        ? [['우유크림도넛', [[12, 30], [15, 20], [18, 10]]], ['버터피스타치오', [[12, 15], [15, 10], [18, 5]]], ['신메뉴딸기', [[15, 10]]]]
        : [['우유크림도넛', [[12, 15], [15, 10], [18, 5]]], ['버터피스타치오', [[12, 8], [15, 5], [18, 2]]], ['신메뉴딸기', [[15, 5]]]];
      const out = [];
      plan.forEach(([name, slots]) => slots.forEach(([hour, qty]) =>
        out.push({ hour, name, qty, amount: qty * P[name] })));
      return out;
    }
  }
};
function resolveSku(rawName, storeId) {
  const n = normName(rawName);
  const pool = allSkus();
  if (storeId) {
    const own = pool.find(k => k.storeId === storeId && normName(k.name) === n);
    if (own) return own.id;
  }
  const glob = pool.find(k => !k.storeId && normName(k.name) === n);
  if (glob) return glob.id;
  if (storeId) {
    const alS = db.prepare('SELECT sku_id FROM sku_aliases WHERE alias=?').get(aliasKey(n, storeId));
    if (alS) return alS.sku_id;
  }
  const al = db.prepare('SELECT sku_id FROM sku_aliases WHERE alias=? AND (store_id IS NULL OR store_id=\'\')').get(n);
  return al ? al.sku_id : null;
}
function receivedQty(storeId, date) { /* 입고 = 해당 입고일의 출고·완료 발주 수량 (당일생산-당일배송) */
  const map = {};
  db.prepare("SELECT items FROM orders WHERE store_id=? AND COALESCE(deliver_date,date)=? AND del=0 AND status IN ('출고','완료')")
    .all(storeId, date).forEach(o => {
      J(o.items).forEach(i => { map[i.skuId] = (map[i.skuId] || 0) + (i.qty | 0); });
    });
  return map;
}
function rebuildClosingFromPos(storeId, date) {
  const sold = {};
  db.prepare('SELECT sku_id, SUM(qty) q FROM pos_sales WHERE store_id=? AND date=? AND sku_id IS NOT NULL GROUP BY sku_id')
    .all(storeId, date).forEach(r => { sold[r.sku_id] = r.q | 0; });
  const recv = receivedQty(storeId, date);
  const ids = [...new Set([...Object.keys(sold), ...Object.keys(recv)])];
  /* 폐기 = 입고 − 판매 (당일생산-당일판매 기준). 입고 기록이 없으면 0으로 두고 수기 폐기값을 보존한다. */
  const items = ids.map(k => ({ skuId: k, sold: sold[k] || 0, waste: recv[k] !== undefined ? Math.max(0, recv[k] - (sold[k] || 0)) : 0 }))
    .filter(i => i.sold > 0 || i.waste > 0);
  if (items.length) upsertClosing(storeId, date, items, Object.keys(recv).length ? 'auto' : 'import');
}
async function syncStoreDay(storeId, date, actorName, quiet) {
  const link = db.prepare('SELECT * FROM pos_links WHERE store_id=? AND del=0 AND active=1').get(storeId);
  if (!link) throw new Error('NO_LINK');
  const drv = providers[link.provider];
  if (!drv) throw new Error('BAD_PROVIDER');
  const lines = await drv.fetchDay(link, date);
  const M = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM pos_sales WHERE store_id=? AND date=?').run(storeId, date); /* 일 단위 전량 재계산 → 멱등 */
    const ins = db.prepare('INSERT INTO pos_sales(id,store_id,date,hour,sku_id,raw_name,qty,amount,mt) VALUES(?,?,?,?,?,?,?,?,?)');
    let matched = 0; const missSet = new Set();
    for (const L of lines) {
      const kid = resolveSku(L.name, storeId);
      if (kid) matched += L.qty; else missSet.add(L.name);
      ins.run(uid('x'), storeId, date, L.hour | 0, kid, L.name, L.qty | 0, L.amount | 0, M);
    }
    db.exec('COMMIT');
    rebuildClosingFromPos(storeId, date);
    const revenue = lines.reduce((a, L) => a + (L.amount | 0), 0);
    const res = { date, lines: lines.length, matchedQty: matched, unmatched: [...missSet], revenue };
    db.prepare('UPDATE pos_links SET last_sync=?, last_result=?, mt=? WHERE store_id=?')
      .run(now(), 'OK ' + date + ' 매출 ' + revenue.toLocaleString('ko-KR') + '원' + (missSet.size ? ' · 미매칭 ' + missSet.size + '종' : ''), now(), storeId);
    if (!quiet) audit(actorName || '스케줄러', 'POS 동기화', ((db.prepare('SELECT name FROM stores WHERE id=?').get(storeId) || {}).name || storeId) + ' ' + date + ' (' + lines.length + '행)');
    return res;
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}
const aliasKey = (n, storeId) => storeId ? n + '@@' + storeId : n; /* 매장 전용 SKU 매핑은 그 매장에만 적용 */
function reapplyAlias(aliasNorm, skuId, storeId) {
  const names = db.prepare('SELECT DISTINCT raw_name FROM pos_sales').all()
    .map(r => r.raw_name).filter(n => normName(n) === aliasNorm);
  const upd = storeId
    ? db.prepare('UPDATE pos_sales SET sku_id=? WHERE raw_name=? AND store_id=?')
    : db.prepare('UPDATE pos_sales SET sku_id=? WHERE raw_name=?');
  const sel = storeId
    ? db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=? AND store_id=?')
    : db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=?');
  const affected = new Set();
  names.forEach(n => {
    if (storeId) { upd.run(skuId, n, storeId); sel.all(n, storeId).forEach(a => affected.add(a.store_id + '|' + a.date)); }
    else { upd.run(skuId, n); sel.all(n).forEach(a => affected.add(a.store_id + '|' + a.date)); }
  });
  [...affected].forEach(k => { const [s2, d] = k.split('|'); rebuildClosingFromPos(s2, d); });
  return affected.size;
}
function computeAnalytics(storeId, from, to) {
  const days = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5) + 1;
  const skuMap = {}; allSkus().forEach(k => { skuMap[k.id] = k; });
  const pos = db.prepare('SELECT * FROM pos_sales WHERE store_id=? AND date>=? AND date<=?').all(storeId, from, to);
  const daily = {}; const mix = {}; let hourly = null; let source;
  if (pos.length) {
    source = 'pos';
    hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, qty: 0, amount: 0 }));
    pos.forEach(r => {
      daily[r.date] = daily[r.date] || { qty: 0, amount: 0 };
      daily[r.date].qty += r.qty; daily[r.date].amount += r.amount;
      hourly[r.hour].qty += r.qty; hourly[r.hour].amount += r.amount;
      const key = r.sku_id || ('?' + normName(r.raw_name));
      if (!mix[key]) mix[key] = { skuId: r.sku_id, name: r.sku_id ? ((skuMap[r.sku_id] || {}).name || r.raw_name) : r.raw_name, matched: !!r.sku_id, qty: 0, amount: 0, _nm: {} };
      mix[key].qty += r.qty; mix[key].amount += r.amount;
      if (!mix[key]._nm[r.raw_name]) mix[key]._nm[r.raw_name] = { name: r.raw_name, qty: 0, amount: 0 };
      mix[key]._nm[r.raw_name].qty += r.qty; mix[key]._nm[r.raw_name].amount += r.amount;
    });
  } else {
    source = 'closings'; /* POS 미연동 매장 폴백: 마감 × 정가 */
    closingsOf(storeId).forEach(c => {
      if (c.date < from || c.date > to) return;
      c.items.forEach(i => {
        const k = skuMap[i.skuId]; if (!k) return;
        daily[c.date] = daily[c.date] || { qty: 0, amount: 0 };
        daily[c.date].qty += i.sold; daily[c.date].amount += k.price * i.sold;
        if (!mix[i.skuId]) mix[i.skuId] = { skuId: i.skuId, name: k.name, matched: true, qty: 0, amount: 0, _nm: {} };
        mix[i.skuId].qty += i.sold; mix[i.skuId].amount += k.price * i.sold;
      });
    });
  }
  const dailyArr = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i); const v = daily[d] || { qty: 0, amount: 0 };
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    dailyArr.push({ date: d, qty: v.qty, amount: v.amount, wknd: (w === 0 || w === 6) });
  }
  const totalAmount = dailyArr.reduce((a, x) => a + x.amount, 0);
  const totalQty = dailyArr.reduce((a, x) => a + x.qty, 0);
  const wk = dailyArr.filter(x => x.wknd), wd = dailyArr.filter(x => !x.wknd);
  const avg = arr => arr.length ? Math.round(arr.reduce((a, x) => a + x.amount, 0) / arr.length) : 0;
  const pf = addDays(from, -days), pt = addDays(from, -1);
  let prevAmount;
  if (source === 'pos') prevAmount = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM pos_sales WHERE store_id=? AND date>=? AND date<=?').get(storeId, pf, pt).a;
  else {
    prevAmount = 0;
    closingsOf(storeId).forEach(c => { if (c.date < pf || c.date > pt) return;
      c.items.forEach(i => { const k = skuMap[i.skuId]; if (k) prevAmount += k.price * i.sold; }); });
  }
  const mixArr = Object.values(mix).sort((a, b) => b.amount - a.amount)
    .map(x => {
      const names = Object.values(x._nm || {}).sort((a, b) => b.amount - a.amount);
      const o = Object.assign({}, x, { share: totalAmount > 0 ? x.amount / totalAmount * 100 : 0, names });
      delete o._nm; return o;
    });
  return { storeId, from, to, days, source, totalAmount, totalQty,
    daily: dailyArr, hourly, weekendAvg: avg(wk), weekdayAvg: avg(wd),
    prevAmount, growthPct: prevAmount > 0 ? (totalAmount - prevAmount) / prevAmount * 100 : null,
    mix: mixArr, unmatchedAmount: mixArr.filter(x => !x.matched).reduce((a, x) => a + x.amount, 0) };
}

function weekStartMon(d) { // 월요일 시작 주
  const dt = new Date(d + 'T00:00:00Z'); const w = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - (w === 0 ? 6 : w - 1));
  return dt.toISOString().slice(0, 10);
}
function computeSalesReport(from, to, unit, storeIds, skuSel) {
  const skuMap = {}; allSkus().forEach(k => { skuMap[k.id] = k; });
  const stores = allStores().filter(st => !storeIds || storeIds.includes(st.id));
  const bucketOf = d => unit === 'month' ? d.slice(0, 7) : unit === 'week' ? weekStartMon(d) : d;
  const buckets = {}; const srcMap = {};
  const ensure = (bk, sid) => {
    if (!buckets[bk]) buckets[bk] = { perStore: {}, total: { amount: 0, qty: 0 } };
    if (!buckets[bk].perStore[sid]) buckets[bk].perStore[sid] = { amount: 0, qty: 0 };
    return buckets[bk];
  };
  for (const st of stores) {
    const pos = db.prepare('SELECT date, sku_id, qty, amount FROM pos_sales WHERE store_id=? AND date>=? AND date<=?').all(st.id, from, to);
    if (pos.length) {
      srcMap[st.id] = 'pos';
      for (const r of pos) {
        if (skuSel && !skuSel.has(r.sku_id || '__unmatched')) continue;
        const b = ensure(bucketOf(r.date), st.id);
        b.perStore[st.id].amount += r.amount; b.perStore[st.id].qty += r.qty;
        b.total.amount += r.amount; b.total.qty += r.qty;
      }
    } else {
      srcMap[st.id] = 'closings'; /* POS 미연동 매장 폴백: 마감 × 정가 */
      closingsOf(st.id).forEach(c => {
        if (c.date < from || c.date > to) return;
        c.items.forEach(i => {
          const k = skuMap[i.skuId]; if (!k) return;
          if (skuSel && !skuSel.has(i.skuId)) return;
          const b = ensure(bucketOf(c.date), st.id);
          const amt = k.price * i.sold;
          b.perStore[st.id].amount += amt; b.perStore[st.id].qty += i.sold;
          b.total.amount += amt; b.total.qty += i.sold;
        });
      });
    }
  }
  const rows = Object.keys(buckets).sort().reverse().map(bk => ({
    bucket: bk,
    label: unit === 'week' ? bk.slice(5).replace('-', '/') + '~' + addDays(bk, 6).slice(5).replace('-', '/')
      : unit === 'month' ? bk : bk,
    perStore: buckets[bk].perStore, total: buckets[bk].total
  }));
  const grand = { amount: 0, qty: 0 }; const perStoreTotal = {};
  rows.forEach(r => {
    grand.amount += r.total.amount; grand.qty += r.total.qty;
    Object.keys(r.perStore).forEach(sid => {
      if (!perStoreTotal[sid]) perStoreTotal[sid] = { amount: 0, qty: 0 };
      perStoreTotal[sid].amount += r.perStore[sid].amount;
      perStoreTotal[sid].qty += r.perStore[sid].qty;
    });
  });
  return { from, to, unit,
    stores: stores.map(st => ({ storeId: st.id, name: st.name, type: st.type, source: srcMap[st.id] || '-' })),
    rows, perStoreTotal, grand };
}

/* ---------------- 시드 ---------------- */
function seed(demo) {
  const M = now();
  [['우유크림도넛', 4200, 2016], ['버터피스타치오', 5800, 2784], ['크림브륄레', 4700, 2256],
   ['오리지널', 3000, 1440], ['시나몬슈가', 3400, 1632], ['보스턴크림', 4900, 2352],
   ['티라미수', 5800, 2784], ['피넛버터', 5800, 2784], ['초코크런치', 3800, 1824],
   ['메이플피칸', 5000, 2400]].forEach((x, i) =>
    db.prepare("INSERT INTO skus(id,name,price,supply,category,mt) VALUES(?,?,?,?,'도넛',?)").run('k' + (i + 1), x[0], x[1], x[2], M));
  const st = [['s1', '가로수길점', '직영', '서울', '강남구 강남대로160길 35-5', '0507-1339-2589', '2018-05-01'],
    ['s2', '정자점', '가맹', '경기', '성남시 분당구 정자일로 135', '031-607-4137', '2021-03-01'],
    ['s3', '사당점', '가맹', '서울', '서초구 동작대로 36', '0507-1406-5061', '2022-06-01']];
  const codes = {};
  st.forEach(s => { const code = genCode(); codes[s[0]] = code;
    db.prepare('INSERT INTO stores(id,name,type,region,addr,phone,open_date,code_hash,mt) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], pwHash(code), M); });
  if (demo) {
    const t = kstToday();
    db.prepare('INSERT INTO leads(id,name,phone,area,store_name,stage,doc_date,advisor,open_target,memo,flag,created,mt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('p1', '김OO', '010-1234-0001', '수원 광교', '광교점(예정)', 2, addDays(t, -6), 0, addDays(t, 45), '(예시) 갤러리아 광교 인근 희망', 0, addDays(t, -9), M);
    db.prepare('INSERT INTO leads(id,name,phone,area,store_name,stage,doc_date,advisor,open_target,memo,flag,created,mt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('p3', '이OO', '010-1234-0003', '동탄 신도시', '동탄점(예정)', 4, addDays(t, -40), 1, addDays(t, 20), '(예시) 인테리어 착공', 0, addDays(t, -55), M);
    db.prepare('INSERT INTO orders(id,store_id,date,status,memo,items,mt) VALUES(?,?,?,?,?,?,?)')
      .run('o1', 's2', addDays(t, -1), '대기', '(예시)', JSON.stringify([{ skuId: 'k1', qty: 60 }, { skuId: 'k2', qty: 30 }]), M);
    [[addDays(t, -3), [{ skuId: 'k1', sold: 42, waste: 1 }, { skuId: 'k2', sold: 22, waste: 0 }]],
     [addDays(t, -2), [{ skuId: 'k1', sold: 35, waste: 3 }, { skuId: 'k2', sold: 18, waste: 1 }]],
     [addDays(t, -1), [{ skuId: 'k1', sold: 40, waste: 2 }, { skuId: 'k2', sold: 20, waste: 0 }]]]
      .forEach((c, i) => db.prepare('INSERT INTO closings(id,store_id,date,items,mt) VALUES(?,?,?,?,?)')
        .run('c' + (i + 1), 's2', c[0], JSON.stringify(c[1]), M));
    db.prepare('INSERT INTO notices(id,date,title,body,pinned,mt) VALUES(?,?,?,?,?,?)')
      .run('n1', t, '워크스테이션 서버판 오픈', '부서별 계정으로 접속하십시오. 점주 접속코드는 운영/마스터 권한으로 발급합니다.', 1, M);
  }
  return codes;
}

/* ---------------- HTTP ---------------- */
function send(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}
const err = (res, code, error, extraObj) => send(res, code, Object.assign({ error }, extraObj || {}));
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 2e6) { reject(new Error('TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('BAD_JSON')); } });
    req.on('error', reject);
  });
}
const setupNeeded = () => db.prepare('SELECT COUNT(*) c FROM users WHERE del=0').get().c === 0;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const f = path.join(PUB, 'index.html');
      if (!fs.existsSync(f)) return err(res, 404, 'NO_UI');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, ts: now() });
    if (!p.startsWith('/api/')) return err(res, 404, 'NOT_FOUND');

    const sess = getSession(req);
    const mut = req.method !== 'GET';
    if (mut && req.headers['x-ofd'] !== '1' && p !== '/api/webhooks/tossplace') return err(res, 403, 'CSRF');
    const body = mut ? await readBody(req) : {};
    const ip = req.socket.remoteAddress || '?';

    /* ---- 공개 ---- */
    if (p === '/api/state' && req.method === 'GET') {
      const setup = setupNeeded();
      const stores = setup ? [] : allStores().map(s => ({ id: s.id, name: s.name }));
      return send(res, 200, { setup, authed: !!sess, role: sess ? sess.role : null,
        dept: sess && sess.user ? sess.user.dept : null, storeId: sess ? sess.storeId : null, stores });
    }
    if (p === '/api/setup' && req.method === 'POST') {
      if (!setupNeeded()) return err(res, 409, 'ALREADY_SETUP');
      const un = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,20}$/.test(un)) return err(res, 400, 'USERNAME_FORMAT');
      if (String(body.password || '').length < 4) return err(res, 400, 'PW_FORMAT');
      const uidM = uid('u');
      db.prepare('INSERT INTO users(id,username,name,dept,pw_hash,active,mt) VALUES(?,?,?,?,?,1,?)')
        .run(uidM, un, String(body.name || '마스터').trim() || '마스터', 'master', pwHash(body.password), now());
      const codes = seed(body.demo !== false);
      audit('시스템', '초기 설정', '마스터 계정 ' + un + ' 생성' + (body.demo !== false ? ' (예시 데이터 포함)' : ''));
      const tok = makeSession('hq', null, uidM);
      return send(res, 200, { ok: true, codes }, { 'Set-Cookie': sessCookie(tok) });
    }
    if (p === '/api/auth/hq' && req.method === 'POST') {
      const un = String(body.username || '').trim().toLowerCase();
      if (limited('hq|' + ip, 30, 60e3) || limited('hqu|' + un, 10, 60e3)) return err(res, 429, 'RATE_LIMIT');
      const r = db.prepare('SELECT * FROM users WHERE username=? AND del=0 AND active=1').get(un);
      if (!r || !pwVerify(body.password || '', r.pw_hash)) {
        audit('-', '본사 로그인 실패', un + ' / IP ' + ip); return err(res, 401, 'BAD_LOGIN');
      }
      const tok = makeSession('hq', null, r.id);
      audit(r.name + ' (' + (DEPTS[r.dept] || r.dept) + ')', '본사 세션 시작', 'IP ' + ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessCookie(tok) });
    }
    if (p === '/api/auth/store' && req.method === 'POST') {
      if (limited('st|' + ip, 30, 60e3) || limited('stid|' + body.storeId, 10, 60e3)) return err(res, 429, 'RATE_LIMIT');
      const r = db.prepare('SELECT * FROM stores WHERE id=? AND del=0').get(String(body.storeId || ''));
      if (!r || !r.code_hash || !pwVerify(String(body.code || ''), r.code_hash)) {
        audit('-', '점주 로그인 실패', (r ? r.name : body.storeId) + ' / IP ' + ip);
        return err(res, 401, 'BAD_CODE');
      }
      const tok = makeSession('store', r.id, null);
      audit(r.name + ' 점주', '점주 세션 시작', 'IP ' + ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessCookie(tok) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      if (sess) { db.prepare('DELETE FROM sessions WHERE th=?').run(sess.th); audit(actorOf(sess), '세션 종료', ''); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }

    /* ---- 토스플레이스 웹훅 수신 (공개 — 토스 서버가 호출) ---- */
    if (p === '/api/webhooks/tossplace' && req.method === 'POST') {
      const ev = body || {};
      const mid = ev.merchantId !== undefined && ev.merchantId !== null ? String(ev.merchantId) : '';
      db.prepare('INSERT OR REPLACE INTO pos_events(id,ts,type,merchant_id,app,raw) VALUES(?,?,?,?,?,?)')
        .run(String(ev.id || uid('w')), now(), String(ev.type || ''), mid, String(ev.app || ''),
          JSON.stringify(ev).slice(0, 2000));
      db.exec("DELETE FROM pos_events WHERE id NOT IN (SELECT id FROM pos_events ORDER BY ts DESC LIMIT 200)");
      if (String(ev.type || '').startsWith('app.installation'))
        audit('토스플레이스 웹훅', '앱 설치 이벤트', 'merchantId ' + mid + ' (' + String(ev.type) + ')');
      return send(res, 200, { ok: true });
    }

    /* ---- 인증 필수 ---- */
    if (!sess) return err(res, 401, 'AUTH_REQUIRED');
    const HU = sess.user; // HQ user row or null(점주)
    const actor = actorOf(sess);
    const deny = cap => { if (sess.role !== 'hq' || !hasCap(HU, cap)) { err(res, 403, 'FORBIDDEN', { need: cap }); return true; } return false; };
    const denyAny = caps => { if (sess.role !== 'hq' || !caps.some(c => hasCap(HU, c))) { err(res, 403, 'FORBIDDEN', { need: caps.join('|') }); return true; } return false; };

    if (p === '/api/bootstrap' && req.method === 'GET') {
      const base = { skus: allSkus(), notices: allNotices(), today: kstToday() };
      if (sess.role === 'hq') {
        base.me = { role: 'hq', dept: HU.dept, deptLabel: DEPTS[HU.dept] || HU.dept, name: HU.name, username: HU.username, userId: HU.id };
        base.stores = allStores(); // 매장 대장은 전 부서 열람 (인근가맹점 현황 원천)
        if (hasCap(HU, 'leads')) base.leads = allLeads();
        if (hasCap(HU, 'orders') || hasCap(HU, 'settle')) base.orders = ordersOf(null);
        if (hasCap(HU, 'closings') || hasCap(HU, 'settle')) base.sales = closingsOf(null);
        { const mk = db.prepare("SELECT v FROM config WHERE k='naver_map_key'").get(); base.mapKey = mk ? mk.v : ''; }
        if (hasCap(HU, 'auditv')) base.audit = db.prepare('SELECT * FROM audit ORDER BY ts DESC LIMIT 200').all()
          .map(a => ({ ts: a.ts, who: a.actor, act: a.action + (a.detail ? ' — ' + a.detail : '') }));
        if (hasCap(HU, 'users')) base.users = allUsers();
        return send(res, 200, base);
      }
      const me = db.prepare('SELECT * FROM stores WHERE id=? AND del=0').get(sess.storeId);
      if (!me) return err(res, 403, 'STORE_GONE');
      base.me = { role: 'store', storeId: me.id, storeName: me.name };
      base.skus = allSkus().filter(k => !k.storeId || k.storeId === sess.storeId); /* 매장 전용 SKU 격리 */
      base.stores = [mStore(me)];
      base.orders = ordersOf(sess.storeId);
      base.sales = closingsOf(sess.storeId);
      return send(res, 200, base);
    }

    /* ---- 계정 관리 (마스터) ---- */
    let m;
    if (p === '/api/users' && req.method === 'POST') {
      if (deny('users')) return;
      const un = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,20}$/.test(un)) return err(res, 400, 'USERNAME_FORMAT');
      if (!DEPTS[body.dept]) return err(res, 400, 'DEPT_FORMAT');
      if (String(body.password || '').length < 4) return err(res, 400, 'PW_FORMAT');
      if (db.prepare('SELECT 1 FROM users WHERE username=? AND del=0').get(un)) return err(res, 409, 'USERNAME_TAKEN');
      db.prepare('INSERT INTO users(id,username,name,dept,pw_hash,active,mt) VALUES(?,?,?,?,?,1,?)')
        .run(uid('u'), un, String(body.name || un).trim(), body.dept, pwHash(body.password), now());
      audit(actor, '계정 생성', un + ' (' + DEPTS[body.dept] + ')');
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/users\/([\w-]+)$/)) && req.method === 'PATCH') {
      if (deny('users')) return;
      const r = db.prepare('SELECT * FROM users WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      const nextDept = body.dept !== undefined ? body.dept : r.dept;
      const nextActive = body.active !== undefined ? (body.active ? 1 : 0) : r.active;
      if (body.dept !== undefined && !DEPTS[body.dept]) return err(res, 400, 'DEPT_FORMAT');
      if (r.dept === 'master' && (nextDept !== 'master' || !nextActive)) { // 마지막 마스터 보호
        const others = db.prepare("SELECT COUNT(*) c FROM users WHERE del=0 AND active=1 AND dept='master' AND id!=?").get(r.id).c;
        if (others === 0) return err(res, 409, 'LAST_MASTER');
      }
      let pwPart = '';
      const args = [String(body.name !== undefined ? body.name : r.name).trim(), nextDept, nextActive];
      if (body.password !== undefined) {
        if (String(body.password).length < 4) return err(res, 400, 'PW_FORMAT');
        pwPart = ', pw_hash=?'; args.push(pwHash(body.password));
      }
      args.push(now(), m[1]);
      db.prepare('UPDATE users SET name=?, dept=?, active=?' + pwPart + ', mt=? WHERE id=?').run(...args);
      if (!nextActive || body.password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id=?').run(m[1]); // 즉시 무효화
      audit(actor, '계정 수정', r.username + (body.password !== undefined ? ' (비밀번호 재설정)' : '') + (body.active === false ? ' (비활성)' : ''));
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/users\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('users')) return;
      const r = db.prepare('SELECT * FROM users WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      if (r.dept === 'master') {
        const others = db.prepare("SELECT COUNT(*) c FROM users WHERE del=0 AND active=1 AND dept='master' AND id!=?").get(r.id).c;
        if (others === 0) return err(res, 409, 'LAST_MASTER');
      }
      db.prepare('UPDATE users SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(m[1]);
      audit(actor, '계정 삭제', r.username);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/password' && req.method === 'POST') { // 본인 비밀번호 (전 부서)
      if (sess.role !== 'hq') return err(res, 403, 'FORBIDDEN');
      if (!pwVerify(body.old || '', HU.pw_hash)) return err(res, 401, 'BAD_LOGIN');
      if (String(body.new || '').length < 4) return err(res, 400, 'PW_FORMAT');
      db.prepare('UPDATE users SET pw_hash=?, mt=? WHERE id=?').run(pwHash(body.new), now(), HU.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND th!=?').run(HU.id, sess.th);
      audit(actor, '비밀번호 변경', '');
      return send(res, 200, { ok: true });
    }

    /* ---- 리드 (영업) ---- */
    if (p === '/api/leads' && req.method === 'POST') {
      if (deny('leads')) return;
      const id = uid('p');
      db.prepare('INSERT INTO leads(id,name,phone,area,store_name,stage,doc_date,advisor,open_target,memo,flag,created,mt) VALUES(?,?,?,?,?,0,?,?,?,?,0,?,?)')
        .run(id, body.name || '신규 리드', body.phone || '', body.area || '', body.storeName || '',
          body.docDate || '', body.advisor ? 1 : 0, body.openTarget || '', body.memo || '', kstToday(), now());
      audit(actor, '리드 생성', body.name || id);
      return send(res, 200, { id });
    }
    if ((m = p.match(/^\/api\/leads\/([\w-]+)$/)) && req.method === 'PATCH') {
      if (deny('leads')) return;
      const r = db.prepare('SELECT * FROM leads WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      db.prepare('UPDATE leads SET name=?,phone=?,area=?,store_name=?,doc_date=?,advisor=?,open_target=?,memo=?,mt=? WHERE id=?')
        .run(body.name ?? r.name, body.phone ?? r.phone, body.area ?? r.area, body.storeName ?? r.store_name,
          body.docDate ?? r.doc_date, (body.advisor ?? !!r.advisor) ? 1 : 0, body.openTarget ?? r.open_target,
          body.memo ?? r.memo, now(), m[1]);
      audit(actor, '리드 수정', body.name ?? r.name);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/leads\/([\w-]+)\/stage$/)) && req.method === 'POST') {
      if (deny('leads')) return;
      const r = db.prepare('SELECT * FROM leads WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      const L = mLead(r);
      const dir = body.dir === -1 ? -1 : 1;
      const ns = Math.max(0, Math.min(5, L.stage + dir));
      if (ns === L.stage) return send(res, 200, { stage: ns });
      let flag = L.flag;
      if (dir > 0 && L.stage === 2 && ns === 3) {
        if (!L.docDate) return err(res, 409, 'DOC_REQUIRED');
        const g = coolingGate(L);
        if (!g.ok && !body.override) return err(res, 409, 'COOLING', { gate: g.gate, days: g.days });
        if (!g.ok && body.override) { flag = true; audit(actor, '숙려기간 미준수 사후기록', L.name + ' (계약가능일 ' + g.gate + ')'); }
      }
      let newStore = null, code = null;
      if (dir > 0 && L.stage === 4 && ns === 5) {
        const sid = uid('s'); code = genCode();
        db.prepare('INSERT INTO stores(id,name,type,region,addr,phone,open_date,code_hash,mt) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(sid, L.storeName || ((L.area || L.name) + ' 신규점'), '가맹', (L.area || '').split(' ')[0] || '',
            L.area || '', L.phone || '', kstToday(), pwHash(code), now());
        newStore = mStore(db.prepare('SELECT * FROM stores WHERE id=?').get(sid));
        audit(actor, '가맹점 오픈 등록', newStore.name);
      }
      db.prepare('UPDATE leads SET stage=?, flag=?, mt=? WHERE id=?').run(ns, flag ? 1 : 0, now(), m[1]);
      audit(actor, '리드 단계이동', L.name + ' → ' + ['리드', '상담', '정보공개서 제공', '가맹계약', '실사·공사', '오픈완료'][ns]);
      return send(res, 200, { stage: ns, flag, newStore, code });
    }
    if ((m = p.match(/^\/api\/leads\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('leads')) return;
      db.prepare('UPDATE leads SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      audit(actor, '리드 삭제', m[1]);
      return send(res, 200, { ok: true });
    }

    /* ---- 발주 ---- */
    if (p === '/api/orders' && req.method === 'POST') {
      let sid;
      if (sess.role === 'store') sid = sess.storeId;               // 점주: 자기 매장 강제
      else { if (deny('orders')) return; sid = String(body.storeId || ''); } // 본사: 운영/마스터
      if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(sid)) return err(res, 404, 'STORE_NOT_FOUND');
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(i => ({ skuId: String(i.skuId), qty: Math.max(0, i.qty | 0) })).filter(i => i.qty > 0);
      if (!items.length) return err(res, 400, 'EMPTY_ITEMS');
      const id = uid('o');
      let dd = String(body.deliverDate || '').trim();
      if (dd && !isDate(dd)) return err(res, 400, 'BAD_DATE');
      if (!dd) dd = addDays(kstToday(), 1); /* 기본: 익일 배송 */
      db.prepare('INSERT INTO orders(id,store_id,date,deliver_date,status,memo,items,mt) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, sid, kstToday(), dd, '대기', String(body.memo || ''), JSON.stringify(items), now());
      audit(actor, '발주 제출', (db.prepare('SELECT name FROM stores WHERE id=?').get(sid) || {}).name);
      return send(res, 200, { id });
    }
    if ((m = p.match(/^\/api\/orders\/([\w-]+)\/advance$/)) && req.method === 'POST') {
      if (deny('orders')) return;
      const r = db.prepare('SELECT * FROM orders WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      const i = OSTAT.indexOf(r.status);
      if (i < 0 || i >= OSTAT.length - 1) return err(res, 409, 'FINAL_STATE');
      db.prepare('UPDATE orders SET status=?, mt=? WHERE id=?').run(OSTAT[i + 1], now(), m[1]);
      if (OSTAT[i + 1] === '출고') rebuildClosingFromPos(r.store_id, r.deliver_date || r.date); /* 입고 확정 → 폐기 자동 재계산 */
      audit(actor, '발주 상태', (db.prepare('SELECT name FROM stores WHERE id=?').get(r.store_id) || {}).name + ' → ' + OSTAT[i + 1]);
      return send(res, 200, { status: OSTAT[i + 1] });
    }
    if ((m = p.match(/^\/api\/orders\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('orders')) return;
      db.prepare('UPDATE orders SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      audit(actor, '발주 반려', m[1]);
      return send(res, 200, { ok: true });
    }

    /* ---- 매출 마감 ---- */
    if (p === '/api/closings' && req.method === 'PUT') {
      let sid;
      if (sess.role === 'store') sid = sess.storeId;                 // 점주 타 매장 불가 — 서버 강제
      else { if (deny('closings')) return; sid = String(body.storeId || ''); }
      if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(sid)) return err(res, 404, 'STORE_NOT_FOUND');
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(res, 400, 'BAD_DATE');
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(i => ({ skuId: String(i.skuId), sold: Math.max(0, i.sold | 0), waste: Math.max(0, i.waste | 0) }))
        .filter(i => i.sold > 0 || i.waste > 0);
      if (!items.length) return err(res, 400, 'EMPTY_ITEMS');
      upsertClosing(sid, date, items, body.mode === 'import' ? 'import' : 'replace');
      audit(actor, body.mode === 'import' ? 'POS CSV 반영' : '매출 마감 저장',
        (db.prepare('SELECT name FROM stores WHERE id=?').get(sid) || {}).name + ' ' + date);
      return send(res, 200, { ok: true });
    }

    /* ---- 공지 ---- */
    if (p === '/api/notices' && req.method === 'POST') {
      if (deny('notices')) return;
      if (!String(body.title || '').trim()) return err(res, 400, 'TITLE_REQUIRED');
      db.prepare('INSERT INTO notices(id,date,title,body,pinned,mt) VALUES(?,?,?,?,?,?)')
        .run(uid('n'), kstToday(), String(body.title).trim(), String(body.body || ''), body.pinned ? 1 : 0, now());
      audit(actor, '공지 게시', String(body.title).trim());
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/notices\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('notices')) return;
      db.prepare('UPDATE notices SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      audit(actor, '공지 삭제', m[1]);
      return send(res, 200, { ok: true });
    }

    /* ---- 매장 ---- */
    if (p === '/api/stores' && req.method === 'POST') {
      if (deny('stores')) return;
      if (!String(body.name || '').trim()) return err(res, 400, 'NAME_REQUIRED');
      const od0 = String(body.openDate || '').trim();
      if (od0 && !isDate(od0)) return err(res, 400, 'BAD_DATE');
      const id = uid('s'); const code = genCode();
      db.prepare('INSERT INTO stores(id,name,type,region,addr,phone,open_date,code_hash,mt) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, String(body.name).trim(), body.type === '직영' ? '직영' : '가맹', String(body.region || ''),
          String(body.addr || ''), fmtPhone(body.phone), od0, pwHash(code), now());
      audit(actor, '매장 등록', String(body.name).trim());
      return send(res, 200, { id, code });
    }
    if (p === '/api/config/navermap' && req.method === 'POST') {
      if (deny('stores')) return;
      const key = String(body.key || '').trim();
      if (key) db.prepare("INSERT INTO config(k,v) VALUES('naver_map_key',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key);
      else db.prepare("DELETE FROM config WHERE k='naver_map_key'").run();
      audit(actor, '네이버 지도 키 ' + (key ? '설정' : '해제'), key ? key.slice(0, 6) + '…' : '');
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/stores\/([\w-]+)$/)) && req.method === 'PATCH') {
      if (deny('stores')) return;
      const r0 = db.prepare('SELECT * FROM stores WHERE id=? AND del=0').get(m[1]);
      if (!r0) return err(res, 404, 'NOT_FOUND');
      const chg = [];
      const nm2 = body.name !== undefined ? String(body.name).trim() : r0.name;
      if (!nm2) return err(res, 400, 'NAME_REQUIRED');
      if (nm2 !== r0.name) chg.push('상호 ' + r0.name + '→' + nm2);
      let type2 = r0.type;
      if (body.type !== undefined) {
        if (body.type !== '직영' && body.type !== '가맹') return err(res, 400, 'BAD_TYPE');
        type2 = body.type; if (type2 !== r0.type) chg.push('구분 ' + r0.type + '→' + type2);
      }
      let od2 = r0.open_date || '';
      if (body.openDate !== undefined) {
        od2 = String(body.openDate).trim();
        if (od2 && !isDate(od2)) return err(res, 400, 'BAD_DATE');
        if (od2 && (od2 < '2000-01-01' || od2 > '2100-12-31')) return err(res, 400, 'BAD_DATE');
        if (od2 !== (r0.open_date || '')) chg.push('오픈일 ' + (r0.open_date || '-') + '→' + (od2 || '-'));
      }
      const rg2 = body.region !== undefined ? String(body.region).trim() : (r0.region || '');
      const ad2 = body.addr !== undefined ? String(body.addr).trim() : (r0.addr || '');
      const ph2 = body.phone !== undefined ? fmtPhone(body.phone) : (r0.phone || '');
      if (rg2 !== (r0.region || '')) chg.push('지역');
      if (ad2 !== (r0.addr || '')) chg.push('소재지');
      if (ph2 !== (r0.phone || '')) chg.push('전화');
      db.prepare('UPDATE stores SET name=?, type=?, region=?, addr=?, phone=?, open_date=?, mt=? WHERE id=?')
        .run(nm2, type2, rg2, ad2, ph2, od2, now(), m[1]);
      audit(actor, '매장 정보 수정', nm2 + (chg.length ? ' — ' + chg.join(' · ') : ''));
      return send(res, 200, { ok: true, store: mStore(db.prepare('SELECT * FROM stores WHERE id=?').get(m[1])) });
    }
    if ((m = p.match(/^\/api\/stores\/([\w-]+)\/code$/)) && req.method === 'POST') {
      if (deny('codes')) return;
      const r = db.prepare('SELECT * FROM stores WHERE id=? AND del=0').get(m[1]);
      if (!r) return err(res, 404, 'NOT_FOUND');
      const code = genCode();
      db.prepare('UPDATE stores SET code_hash=?, mt=? WHERE id=?').run(pwHash(code), now(), m[1]);
      db.prepare("DELETE FROM sessions WHERE role='store' AND store_id=?").run(m[1]);
      audit(actor, '접속코드 재발급', r.name);
      return send(res, 200, { code });
    }
    if ((m = p.match(/^\/api\/stores\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('stores')) return;
      db.prepare('UPDATE stores SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      db.prepare("DELETE FROM sessions WHERE role='store' AND store_id=?").run(m[1]);
      audit(actor, '매장 삭제', m[1]);
      return send(res, 200, { ok: true });
    }

    /* ---- SKU (관리) ---- */
    if (p === '/api/skus' && req.method === 'POST') {
      if (deny('skus')) return;
      const name = String(body.name || '').trim(); const price = Math.max(0, body.price | 0);
      if (!name || !price) return err(res, 400, 'NAME_PRICE_REQUIRED');
      const category = CATS.includes(body.category) ? body.category : '기타';
      let storeId = null;
      if (body.storeId) {
        const stR = db.prepare('SELECT name FROM stores WHERE id=? AND del=0').get(String(body.storeId));
        if (!stR) return err(res, 404, 'STORE_NOT_FOUND');
        storeId = String(body.storeId);
      }
      const supply = body.supply ? Math.max(0, body.supply | 0) : Math.round(price * 0.48);
      const kid = uid('k');
      db.prepare('INSERT INTO skus(id,name,price,supply,category,store_id,mt) VALUES(?,?,?,?,?,?,?)')
        .run(kid, name, price, supply, category, storeId, now());
      audit(actor, 'SKU 추가', name + ' [' + category + ']' + (storeId ? ' · ' + ((db.prepare('SELECT name FROM stores WHERE id=?').get(storeId) || {}).name || storeId) + ' 전용' : ''));
      return send(res, 200, { ok: true, skuId: kid });
    }
    if ((m = p.match(/^\/api\/skus\/([\w-]+)$/)) && req.method === 'PATCH') {
      if (deny('skus')) return;
      const r0 = db.prepare('SELECT * FROM skus WHERE id=? AND del=0').get(m[1]);
      if (!r0) return err(res, 404, 'NOT_FOUND');
      if (body.category !== undefined && !CATS.includes(body.category)) return err(res, 400, 'BAD_CATEGORY');
      const nm2 = body.name !== undefined ? String(body.name).trim() : r0.name;
      const pr2 = body.price !== undefined ? Math.max(1, body.price | 0) : r0.price;
      const sp2 = body.supply !== undefined ? Math.max(0, body.supply | 0) : r0.supply;
      if (!nm2) return err(res, 400, 'NAME_PRICE_REQUIRED');
      let st2 = r0.store_id || null;
      if (body.storeId !== undefined) {
        if (body.storeId === null || body.storeId === '') st2 = null;
        else {
          if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(String(body.storeId))) return err(res, 404, 'STORE_NOT_FOUND');
          st2 = String(body.storeId);
        }
      }
      const clash = allSkus().find(k => k.id !== m[1] && normKey(k.name) === normKey(nm2) && (k.storeId || null) === st2);
      if (clash) return err(res, 409, 'SKU_EXISTS', { skuId: clash.id, name: clash.name });
      db.prepare('UPDATE skus SET name=?, price=?, supply=?, category=?, store_id=?, mt=? WHERE id=?')
        .run(nm2, pr2, sp2, body.category !== undefined ? body.category : (r0.category || '기타'), st2, now(), m[1]);
      const scopeTxt = body.storeId !== undefined ? (st2 ? ' → ' + ((db.prepare('SELECT name FROM stores WHERE id=?').get(st2) || {}).name || st2) + ' 전용' : ' → 본사 공통') : '';
      audit(actor, 'SKU 수정', nm2 + (body.category !== undefined ? ' [' + body.category + ']' : '') + scopeTxt);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/skus/promote' && req.method === 'POST') { /* 미매칭 → SKU 원클릭 승격+매핑 */
      if (deny('skus')) return;
      const rawName = String(body.rawName || '').trim();
      const name = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const price = Math.max(0, body.price | 0);
      if (!name || !price) return err(res, 400, 'NAME_PRICE_REQUIRED');
      const category = CATS.includes(body.category) ? body.category : '기타';
      let storeId = null;
      if (body.storeId) {
        if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(String(body.storeId))) return err(res, 404, 'STORE_NOT_FOUND');
        storeId = String(body.storeId);
      }
      const dup = allSkus().find(k => normKey(k.name) === normKey(name) && (k.storeId || null) === storeId);
      if (dup) return err(res, 409, 'SKU_EXISTS', { skuId: dup.id, name: dup.name });
      const supply = body.supply ? Math.max(0, body.supply | 0) : Math.round(price * 0.48);
      const kid = uid('k');
      db.prepare('INSERT INTO skus(id,name,price,supply,category,store_id,mt) VALUES(?,?,?,?,?,?,?)')
        .run(kid, name, price, supply, category, storeId, now());
      db.prepare('INSERT INTO sku_aliases(alias,sku_id,store_id,mt) VALUES(?,?,?,?) ON CONFLICT(alias) DO UPDATE SET sku_id=excluded.sku_id, store_id=excluded.store_id, mt=excluded.mt')
        .run(aliasKey(normName(rawName), storeId), kid, storeId, now());
      const n = reapplyAlias(normName(rawName), kid, storeId);
      audit(actor, 'SKU 승격', rawName + ' → ' + name + ' ' + price.toLocaleString('ko-KR') + '원 (' + n + '개 매장일 소급)');
      return send(res, 200, { ok: true, skuId: kid, name, price, supply, rebuilt: n });
    }
    if (p === '/api/products/prices' && req.method === 'GET') { /* 매장별 실판매가 vs 기준가 편차 */
      if (denyAny(['skus', 'settle'])) return;
      const days = Math.min(366, Math.max(1, parseInt(u.searchParams.get('days') || '30', 10) || 30));
      const to = kstToday(), from = addDays(to, -(days - 1));
      const agg = db.prepare('SELECT sku_id, store_id, SUM(qty) q, SUM(amount) a FROM pos_sales WHERE sku_id IS NOT NULL AND date>=? AND date<=? GROUP BY sku_id, store_id').all(from, to);
      const daily = db.prepare('SELECT sku_id, store_id, qty, amount FROM pos_sales WHERE sku_id IS NOT NULL AND qty>0 AND date>=? AND date<=?').all(from, to);
      const ub = {}; /* sku|store -> Map(단가 -> 수량): 일별 평균단가 분포로 혼합가·할인 유무 판별 */
      daily.forEach(r2 => {
        const key = r2.sku_id + '|' + r2.store_id, unit = Math.round(r2.amount / r2.qty);
        if (!ub[key]) ub[key] = {};
        ub[key][unit] = (ub[key][unit] || 0) + r2.qty;
      });
      const stMap = {}; allStores().forEach(s2 => { stMap[s2.id] = s2.name; });
      const items = allSkus().map(k => {
        const rows = agg.filter(x => x.sku_id === k.id && x.q > 0).map(x => {
          const avg = Math.round(x.a / x.q);
          const bd = Object.entries(ub[k.id + '|' + x.store_id] || {})
            .map(([unit2, q2]) => ({ unit: +unit2, qty: q2 }))
            .sort((a2, b2) => b2.qty - a2.qty).slice(0, 6);
          return { storeId: x.store_id, name: stMap[x.store_id] || x.store_id, qty: x.q, amount: x.a, avg,
            diffPct: k.price > 0 ? (avg - k.price) / k.price * 100 : 0, unitBreakdown: bd };
        });
        const up = rows.some(r2 => r2.diffPct >= 2), dn = rows.some(r2 => r2.diffPct <= -2);
        return { skuId: k.id, name: k.name, category: k.category, storeId: k.storeId, base: k.price,
          stores: rows, maxAbs: rows.reduce((a2, r2) => Math.max(a2, Math.abs(r2.diffPct)), 0),
          flag: up && dn ? 'mixed' : up ? 'high' : dn ? 'low' : null };
      });
      return send(res, 200, { days, from, to, items });
    }
    if ((m = p.match(/^\/api\/skus\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('skus')) return;
      const kRow = db.prepare('SELECT name FROM skus WHERE id=? AND del=0').get(m[1]);
      if (!kRow) return err(res, 404, 'NOT_FOUND');
      db.prepare('UPDATE skus SET del=1, mt=? WHERE id=?').run(now(), m[1]);
      /* 연쇄 정리: 이 SKU로 통합된 별칭 해제 → 해당 POS 매출 미매칭 원복 → 마감 소급 재계산 */
      const als = db.prepare('SELECT alias, store_id FROM sku_aliases WHERE sku_id=?').all(m[1]);
      const affected = new Set();
      als.forEach(al => {
        db.prepare('DELETE FROM sku_aliases WHERE alias=?').run(al.alias);
        const base2 = al.store_id ? al.alias.slice(0, al.alias.lastIndexOf('@@')) : al.alias;
        const names = db.prepare('SELECT DISTINCT raw_name FROM pos_sales').all()
          .map(r2 => r2.raw_name).filter(nm => normName(nm) === base2);
        names.forEach(nm => {
          if (al.store_id) {
            db.prepare('UPDATE pos_sales SET sku_id=NULL WHERE raw_name=? AND store_id=?').run(nm, al.store_id);
            db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=? AND store_id=?').all(nm, al.store_id)
              .forEach(a3 => affected.add(a3.store_id + '|' + a3.date));
          } else {
            db.prepare('UPDATE pos_sales SET sku_id=NULL WHERE raw_name=?').run(nm);
            db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=?').all(nm)
              .forEach(a3 => affected.add(a3.store_id + '|' + a3.date));
          }
        });
      });
      /* 이름 직결 매칭분(별칭 없이 SKU명이 POS 품목명과 일치해 잡힌 매출)도 미매칭으로 원복 */
      const direct = db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE sku_id=?').all(m[1]);
      const restoredQty = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM pos_sales WHERE sku_id=?').get(m[1]).q;
      db.prepare('UPDATE pos_sales SET sku_id=NULL WHERE sku_id=?').run(m[1]);
      direct.forEach(a3 => affected.add(a3.store_id + '|' + a3.date));
      [...affected].forEach(k2 => { const [sid, d] = k2.split('|'); rebuildClosingFromPos(sid, d); });
      audit(actor, 'SKU 삭제', kRow.name + ' (별칭 ' + als.length + '건 해제 · 미매칭 원복 ' + restoredQty + '개 · ' + affected.size + '개 매장일 소급)');
      return send(res, 200, { ok: true, unmapped: als.length, rebuilt: affected.size, restoredQty });
    }

    /* ---- 정산 (관리) ---- */
    if (p === '/api/settle' && req.method === 'GET') {
      if (deny('settle')) return;
      const month = /^\d{4}-\d{2}$/.test(u.searchParams.get('month') || '') ? u.searchParams.get('month') : kstToday().slice(0, 7);
      const skuMap = {}; allSkus().forEach(k => { skuMap[k.id] = k; });
      const rows = allStores().map(s => {
        let sup = 0;
        ordersOf(s.id).forEach(o => {
          if (o.date.slice(0, 7) === month && (o.status === '출고' || o.status === '완료'))
            o.items.forEach(i => { const k = skuMap[i.skuId]; if (k) sup += k.supply * i.qty; });
        });
        let rev = 0, sold = 0, waste = 0;
        closingsOf(s.id).forEach(c => {
          if (c.date.slice(0, 7) !== month) return;
          c.items.forEach(i => { const k = skuMap[i.skuId]; if (k) rev += k.price * i.sold; sold += i.sold; waste += i.waste; });
        });
        return { storeId: s.id, name: s.name, type: s.type, supply: sup, revenue: rev,
          lossRate: sold + waste > 0 ? waste / (sold + waste) * 100 : 0 };
      });
      return send(res, 200, { month, rows });
    }

    /* ---- POS 연동 (운영/마스터) ---- */
    if (p === '/api/pos/links' && req.method === 'GET') {
      if (deny('pos')) return;
      const rows = db.prepare('SELECT * FROM pos_links WHERE del=0').all().map(L => ({
        storeId: L.store_id, provider: L.provider, merchantId: L.merchant_id || '',
        active: !!L.active, hasKeys: !!(L.access_key_enc && L.secret_key_enc),
        lastSync: L.last_sync || null, lastResult: L.last_result || '' }));
      const events = db.prepare("SELECT merchant_id, MAX(ts) ts, MAX(type) type FROM pos_events WHERE merchant_id != '' GROUP BY merchant_id ORDER BY ts DESC LIMIT 5").all()
        .map(e => ({ ts: e.ts, type: e.type, merchantId: e.merchant_id }));
      return send(res, 200, { links: rows, events });
    }
    if ((m = p.match(/^\/api\/pos\/links\/([\w-]+)$/)) && req.method === 'PUT') {
      if (deny('pos')) return;
      const sid = m[1];
      const stRow = db.prepare('SELECT name FROM stores WHERE id=? AND del=0').get(sid);
      if (!stRow) return err(res, 404, 'STORE_NOT_FOUND');
      const ex = db.prepare('SELECT * FROM pos_links WHERE store_id=?').get(sid);
      const provider = body.provider === 'mock' ? 'mock' : 'tossplace';
      const akEnc = String(body.accessKey || '').trim() ? encSecret(String(body.accessKey).trim()) : (ex ? ex.access_key_enc : null);
      const skEnc = String(body.secretKey || '').trim() ? encSecret(String(body.secretKey).trim()) : (ex ? ex.secret_key_enc : null);
      const mid = body.merchantId !== undefined ? String(body.merchantId).trim() : (ex ? ex.merchant_id : '');
      if (provider === 'tossplace' && (!mid || !akEnc || !skEnc)) return err(res, 400, 'LINK_INCOMPLETE');
      const act = body.active === undefined ? (ex ? ex.active : 1) : (body.active ? 1 : 0);
      if (ex) db.prepare('UPDATE pos_links SET provider=?, merchant_id=?, access_key_enc=?, secret_key_enc=?, active=?, del=0, mt=? WHERE store_id=?')
        .run(provider, mid, akEnc, skEnc, act, now(), sid);
      else db.prepare('INSERT INTO pos_links(store_id,provider,merchant_id,access_key_enc,secret_key_enc,active,mt) VALUES(?,?,?,?,?,?,?)')
        .run(sid, provider, mid, akEnc, skEnc, act, now());
      audit(actor, 'POS 연동 설정', stRow.name + ' (' + provider + (act ? '' : ' · 비활성') + ')');
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/pos\/links\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (deny('pos')) return;
      db.prepare('UPDATE pos_links SET del=1, active=0, mt=? WHERE store_id=?').run(now(), m[1]);
      audit(actor, 'POS 연동 해제', m[1]);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/pos\/sync\/([\w-]+)$/)) && req.method === 'POST') {
      if (deny('pos')) return;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : kstToday();
      try { const r2 = await syncStoreDay(m[1], date, actor); return send(res, 200, r2); }
      catch (e) { return err(res, 502, 'SYNC_FAIL', { reason: e.message || String(e) }); }
    }
    if ((m = p.match(/^\/api\/pos\/test\/([\w-]+)$/)) && req.method === 'POST') {
      if (deny('pos')) return;
      const link = db.prepare('SELECT * FROM pos_links WHERE store_id=? AND del=0').get(m[1]);
      if (!link) return err(res, 404, 'NO_LINK');
      if (link.provider === 'mock') return send(res, 200, { ok: true, provider: 'mock', detail: 'mock 제공자는 항상 통과합니다' });
      const ak = decSecret(link.access_key_enc), sk = decSecret(link.secret_key_enc);
      if (!ak || !sk) return send(res, 200, { ok: false, step: 'KEY', detail: '키 복호화 실패 — Access/Secret Key를 다시 입력·저장하십시오' });
      try {
        const info = await tpGet(TP_BASE + encodeURIComponent(link.merchant_id), ak, sk);
        const nm = info && (info.name || info.merchantName || info.title) ? String(info.name || info.merchantName || info.title) : '';
        audit(actor, 'POS 연결 진단 성공', (nm || link.merchant_id));
        return send(res, 200, { ok: true, merchantId: link.merchant_id, name: nm, raw: info ? JSON.stringify(info).slice(0, 300) : '' });
      } catch (e) {
        const msg = e.message || String(e);
        audit(actor, 'POS 연결 진단 실패', link.merchant_id + ' — ' + msg);
        return send(res, 200, { ok: false, step: 'API', detail: msg,
          hint: /401|403/.test(msg)
            ? '키 인증 거부 — ① 현장 POS에서 [연결하기]까지 완료됐는지(코드 입력만으로는 미설치) ② 개발자센터 앱 상세의 연결 매장 목록에 이 매장이 보이는지 ③ Access/Secret Key를 뒤바꿔 넣지 않았는지 확인하십시오.'
            : /404/.test(msg)
            ? 'merchantId(' + link.merchant_id + ')를 찾을 수 없습니다 — 매장고유번호를 현장과 다시 대조하십시오.'
            : '네트워크 또는 토스플레이스 서버 응답 문제입니다. 잠시 후 재시도하십시오.' });
      }
    }
    if ((m = p.match(/^\/api\/pos\/backfill\/([\w-]+)$/)) && req.method === 'POST') {
      if (deny('pos')) return;
      const days = Math.min(60, Math.max(1, (body.days | 0) || 30));
      const t0 = kstToday();
      const results = []; let revenue = 0, errors = 0;
      for (let i = days - 1; i >= 0; i--) {
        const d = addDays(t0, -i);
        try { const r2 = await syncStoreDay(m[1], d, actor, true); results.push({ date: d, revenue: r2.revenue, lines: r2.lines }); revenue += r2.revenue; }
        catch (e) { errors++; results.push({ date: d, error: e.message || String(e) });
          if (e.message === 'NO_LINK' || e.message === 'BAD_PROVIDER' || e.message === 'KEY_DECRYPT_FAIL') break; }
        await sleep(120); /* 매장별 호출량 제한 준수 */
      }
      audit(actor, 'POS 백필', ((db.prepare('SELECT name FROM stores WHERE id=?').get(m[1]) || {}).name || m[1]) + ' ' + days + '일 — 매출 ' + revenue.toLocaleString('ko-KR') + '원, 오류 ' + errors + '건');
      return send(res, 200, { days, revenue, errors, results });
    }
    if (p === '/api/pos/unmatched' && req.method === 'GET') {
      if (denyAny(['pos', 'skus'])) return;
      const rows = db.prepare('SELECT raw_name, SUM(qty) q, SUM(amount) amt FROM pos_sales WHERE sku_id IS NULL GROUP BY raw_name ORDER BY amt DESC').all();
      const per = db.prepare('SELECT raw_name, store_id, SUM(qty) q, SUM(amount) a FROM pos_sales WHERE sku_id IS NULL GROUP BY raw_name, store_id').all();
      const stMap = {}; allStores().forEach(s2 => { stMap[s2.id] = s2.name; });
      return send(res, 200, { items: rows.map(r => ({ name: r.raw_name, qty: r.q, amount: r.amt, suggest: suggestSku(r.raw_name),
        stores: per.filter(x => x.raw_name === r.raw_name).map(x => ({ storeId: x.store_id, name: stMap[x.store_id] || x.store_id, qty: x.q, amount: x.a })) })) });
    }
    if (p === '/api/pos/alias' && req.method === 'POST') {
      if (denyAny(['pos', 'skus'])) return;
      const alias = normName(body.alias || '');
      const skuId = String(body.skuId || '');
      const kRow = db.prepare('SELECT name, store_id FROM skus WHERE id=? AND del=0').get(skuId);
      if (!alias || !kRow) return err(res, 400, 'ALIAS_INVALID');
      const scope = kRow.store_id || null;
      if (scope) { /* 전용 SKU: 해당 매장에서 실제 팔린 품목만 매핑 허용 */
        const soldHere = db.prepare('SELECT DISTINCT raw_name FROM pos_sales WHERE store_id=?').all(scope)
          .some(r2 => normName(r2.raw_name) === alias);
        if (!soldHere) return err(res, 400, 'NOT_SOLD_AT_STORE',
          { store: (db.prepare('SELECT name FROM stores WHERE id=?').get(scope) || {}).name || scope });
      }
      db.prepare('INSERT INTO sku_aliases(alias,sku_id,store_id,mt) VALUES(?,?,?,?) ON CONFLICT(alias) DO UPDATE SET sku_id=excluded.sku_id, store_id=excluded.store_id, mt=excluded.mt')
        .run(aliasKey(alias, scope), skuId, scope, now());
      const n = reapplyAlias(alias, skuId, scope);
      audit(actor, 'POS 품목 매핑', String(body.alias) + ' → ' + kRow.name + (scope ? ' [매장 전용]' : '') + ' (' + n + '개 매장일 재계산)');
      return send(res, 200, { ok: true, rebuilt: n, scoped: !!scope });
    }
    if (p === '/api/pos/aliases' && req.method === 'GET') {
      if (denyAny(['pos', 'skus'])) return;
      const skuMap = {}; allSkus().forEach(k => { skuMap[k.id] = k.name; });
      const stMap2 = {}; allStores().forEach(s2 => { stMap2[s2.id] = s2.name; });
      const list = db.prepare('SELECT alias, sku_id, store_id FROM sku_aliases ORDER BY rowid DESC').all().map(a => {
        const base = a.store_id ? a.alias.slice(0, a.alias.lastIndexOf('@@')) : a.alias;
        const names = db.prepare('SELECT DISTINCT raw_name FROM pos_sales').all()
          .map(r => r.raw_name).filter(nm => normName(nm) === base);
        let qty = 0, amount = 0;
        names.forEach(nm => {
          const st2 = a.store_id
            ? db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(amount),0) a FROM pos_sales WHERE raw_name=? AND store_id=?').get(nm, a.store_id)
            : db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(amount),0) a FROM pos_sales WHERE raw_name=?').get(nm);
          qty += st2.q; amount += st2.a;
        });
        return { alias: a.alias, base, storeId: a.store_id || null, storeName: a.store_id ? (stMap2[a.store_id] || a.store_id) : null,
          skuId: a.sku_id, skuName: skuMap[a.sku_id] || '(삭제된 SKU)', names, qty, amount };
      });
      return send(res, 200, { aliases: list });
    }
    if ((m = p.match(/^\/api\/pos\/alias\/(.+)$/)) && req.method === 'DELETE') {
      if (denyAny(['pos', 'skus'])) return;
      const rawKey = decodeURIComponent(m[1]);
      const at = rawKey.lastIndexOf('@@');
      const scope2 = at >= 0 ? rawKey.slice(at + 2) : null;
      const alias = at >= 0 ? normName(rawKey.slice(0, at)) : normName(rawKey);
      const key2 = aliasKey(alias, scope2);
      const ex = db.prepare('SELECT sku_id FROM sku_aliases WHERE alias=?').get(key2);
      if (!ex) return err(res, 404, 'NOT_FOUND');
      db.prepare('DELETE FROM sku_aliases WHERE alias=?').run(key2);
      const names = db.prepare('SELECT DISTINCT raw_name FROM pos_sales').all()
        .map(r => r.raw_name).filter(nm => normName(nm) === alias);
      const affected = new Set();
      const upd = scope2
        ? db.prepare('UPDATE pos_sales SET sku_id=NULL WHERE raw_name=? AND store_id=?')
        : db.prepare('UPDATE pos_sales SET sku_id=NULL WHERE raw_name=?');
      names.forEach(nm => {
        if (scope2) {
          upd.run(nm, scope2);
          db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=? AND store_id=?').all(nm, scope2)
            .forEach(a2 => affected.add(a2.store_id + '|' + a2.date));
        } else {
          upd.run(nm);
          db.prepare('SELECT DISTINCT store_id, date FROM pos_sales WHERE raw_name=?').all(nm)
            .forEach(a2 => affected.add(a2.store_id + '|' + a2.date));
        }
      });
      [...affected].forEach(k2 => { const [sid, d] = k2.split('|'); rebuildClosingFromPos(sid, d); });
      audit(actor, 'POS 품목 매핑 해제', alias + ' (' + affected.size + '개 매장일 재계산)');
      return send(res, 200, { ok: true, rebuilt: affected.size });
    }

    /* ---- 매출 분석 (관리/마스터 + 점주 자기 매장) ---- */
    if (p === '/api/analytics' && req.method === 'GET') {
      let sid = String(u.searchParams.get('storeId') || '');
      if (sess.role === 'store') {
        if (sid && sid !== sess.storeId) return err(res, 403, 'FORBIDDEN');
        sid = sess.storeId;
      } else if (!hasCap(HU, 'settle')) return err(res, 403, 'FORBIDDEN', { need: 'settle' });
      if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(sid)) return err(res, 404, 'STORE_NOT_FOUND');
      const to = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('to') || '') ? u.searchParams.get('to') : kstToday();
      let from = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('from') || '') ? u.searchParams.get('from') : addDays(to, -29);
      if (Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5) > 92) from = addDays(to, -91);
      return send(res, 200, computeAnalytics(sid, from, to));
    }

    /* ---- 매출현황 리포트 (관리/마스터) ---- */
    if (p === '/api/salesreport' && req.method === 'GET') {
      if (deny('settle')) return;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('to') || '') ? u.searchParams.get('to') : kstToday();
      let from = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('from') || '') ? u.searchParams.get('from') : addDays(to, -29);
      if (Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5) > 366) from = addDays(to, -365);
      const unitQ = u.searchParams.get('unit');
      const unit = unitQ === 'week' || unitQ === 'month' ? unitQ : 'day';
      const storesQ = (u.searchParams.get('stores') || '').split(',').map(x => x.trim()).filter(Boolean);
      const skusQ = (u.searchParams.get('skus') || '').split(',').map(x => x.trim()).filter(Boolean);
      return send(res, 200, computeSalesReport(from, to, unit,
        storesQ.length ? storesQ : null, skusQ.length ? new Set(skusQ) : null));
    }
    if (p === '/api/waste' && req.method === 'GET') { /* 입고 − 판매 = 폐기 (당일생산-당일판매) */
      if (denyAny(['settle', 'orders'])) return;
      const sid = String(u.searchParams.get('storeId') || '');
      if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND del=0').get(sid)) return err(res, 404, 'STORE_NOT_FOUND');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : kstToday();
      const skuMap = {}; allSkus().forEach(k => { skuMap[k.id] = k; });
      const sold = {};
      db.prepare('SELECT sku_id, SUM(qty) q FROM pos_sales WHERE store_id=? AND date=? AND sku_id IS NOT NULL GROUP BY sku_id')
        .all(sid, date).forEach(r => { sold[r.sku_id] = r.q | 0; });
      const recv = receivedQty(sid, date);
      const hasPos = db.prepare('SELECT COUNT(*) c FROM pos_sales WHERE store_id=? AND date=?').get(sid, date).c > 0;
      const ids = [...new Set([...Object.keys(recv), ...Object.keys(sold)])].filter(k => skuMap[k]);
      const items = ids.map(k => {
        const rq = recv[k], sq = sold[k] || 0;
        const w = rq === undefined ? null : Math.max(0, rq - sq);
        return { skuId: k, name: skuMap[k].name, category: skuMap[k].category,
          received: rq === undefined ? null : rq, sold: sq, waste: w,
          over: rq !== undefined && sq > rq ? sq - rq : 0,
          wasteRate: rq ? (Math.max(0, rq - sq) / rq * 100) : null,
          lossAmount: w === null ? null : w * skuMap[k].supply };
      }).sort((a, b) => (b.lossAmount || 0) - (a.lossAmount || 0));
      const tr = items.reduce((a, x) => a + (x.received || 0), 0);
      const ts = items.reduce((a, x) => a + x.sold, 0);
      const tw = items.reduce((a, x) => a + (x.waste || 0), 0);
      return send(res, 200, { storeId: sid, date, hasPos, hasOrder: Object.keys(recv).length > 0,
        items, totals: { received: tr, sold: ts, waste: tw,
          wasteRate: tr ? tw / tr * 100 : null,
          lossAmount: items.reduce((a, x) => a + (x.lossAmount || 0), 0) } });
    }

    /* ---- 예시 데이터 삭제 (마스터) ---- */
    if (p === '/api/admin/purge-demo' && req.method === 'POST') {
      if (deny('backup')) return;
      const M = now(); const counts = {};
      const mark = (table, ids) => {
        let n2 = 0;
        ids.forEach(id => { const r2 = db.prepare('UPDATE ' + table + ' SET del=1, mt=? WHERE id=? AND del=0').run(M, id); n2 += r2.changes; });
        return n2;
      };
      counts.leads = mark('leads', ['p1', 'p3']);
      counts.orders = mark('orders', ['o1']);
      counts.closings = mark('closings', ['c1', 'c2', 'c3']);
      counts.notices = mark('notices', ['n1']);
      counts.stores = mark('stores', ['s1', 's2', 's3']);
      ['s1', 's2', 's3'].forEach(sid => {
        db.prepare("DELETE FROM sessions WHERE role='store' AND store_id=?").run(sid);
        db.prepare('UPDATE pos_links SET del=1, active=0, mt=? WHERE store_id=?').run(M, sid);
      });
      audit(actor, '예시 데이터 삭제', JSON.stringify(counts));
      return send(res, 200, { ok: true, counts });
    }

    /* ---- 감사 로그 검색 (관리/마스터) ---- */
    if (p === '/api/audit' && req.method === 'GET') {
      if (deny('auditv')) return;
      const q = String(u.searchParams.get('q') || '').trim();
      const from = isDate(u.searchParams.get('from') || '') ? u.searchParams.get('from') : '';
      const to = isDate(u.searchParams.get('to') || '') ? u.searchParams.get('to') : '';
      const noSched = u.searchParams.get('noSched') === '1';
      const limit = Math.min(300, Math.max(10, parseInt(u.searchParams.get('limit') || '100', 10) || 100));
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1);
      const cond = [], args = [];
      if (from) { cond.push('ts >= ?'); args.push(kstDayStart(from)); }
      if (to) { cond.push('ts < ?'); args.push(kstDayStart(addDays(to, 1))); }
      if (noSched) cond.push("actor != '스케줄러'");
      if (q) { cond.push('(actor LIKE ? OR action LIKE ? OR detail LIKE ?)'); args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
      const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
      const total = db.prepare('SELECT COUNT(*) c FROM audit' + where).get(...args).c;
      const rows = db.prepare('SELECT * FROM audit' + where + ' ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?')
        .all(...args, limit, (page - 1) * limit)
        .map(a => ({ id: a.id, ts: a.ts, who: a.actor, act: a.action + (a.detail ? ' — ' + a.detail : '') }));
      const oldest = db.prepare('SELECT MIN(ts) m FROM audit').get().m;
      return send(res, 200, { rows, total, page, limit, keepDays: AUDIT_KEEP_DAYS, oldest: oldest || null });
    }

    /* ---- 백업 (마스터) ---- */
    if (p === '/api/export' && req.method === 'GET') {
      if (deny('backup')) return;
      audit(actor, '백업 내보내기', '');
      return send(res, 200, {
        kind: 'ofd-server', exportedAt: now(),
        skus: allSkus(), stores: allStores(), leads: allLeads(),
        orders: ordersOf(null), sales: closingsOf(null), notices: allNotices(),
        users: allUsers(),
        aliases: db.prepare('SELECT * FROM sku_aliases').all().map(a => ({ alias: a.alias, skuId: a.sku_id, mt: a.mt })),
        logs: db.prepare('SELECT * FROM audit ORDER BY ts').all().map(a => ({ mt: a.ts, who: a.actor, act: a.action + (a.detail ? ' — ' + a.detail : '') }))
      });
    }
    if (p === '/api/import' && req.method === 'POST') {
      if (deny('backup')) return;
      const d = body || {};
      const mergeTable = (list, table, cols, toRow) => {
        let nIns = 0, nUpd = 0;
        (Array.isArray(list) ? list : []).forEach(x => {
          if (!x || !x.id) return;
          const ex = db.prepare('SELECT id, mt FROM ' + table + ' WHERE id=?').get(x.id);
          const row = toRow(x);
          if (!ex) { db.prepare('INSERT INTO ' + table + '(' + cols.join(',') + ') VALUES(' + cols.map(() => '?').join(',') + ')').run(...row); nIns++; }
          else if ((x.mt || 0) > (ex.mt || 0)) {
            db.prepare('UPDATE ' + table + ' SET ' + cols.slice(1).map(c => c + '=?').join(',') + ' WHERE id=?').run(...row.slice(1), x.id); nUpd++;
          }
        });
        return { nIns, nUpd };
      };
      const g = (x, a, b) => x[a] !== undefined ? x[a] : x[b];
      const r1 = mergeTable(d.skus, 'skus', ['id', 'name', 'price', 'supply', 'category', 'store_id', 'mt', 'del'],
        x => [x.id, x.name, x.price | 0, x.supply | 0, CATS.includes(x.category) ? x.category : '기타', g(x, 'storeId', 'store_id') || null, x.mt || now(), x.del ? 1 : 0]);
      const r2 = mergeTable(d.stores, 'stores', ['id', 'name', 'type', 'region', 'addr', 'phone', 'open_date', 'mt', 'del'],
        x => [x.id, x.name, x.type || '가맹', x.region || '', x.addr || '', x.phone || '', g(x, 'openDate', 'open_date') || '', x.mt || now(), x.del ? 1 : 0]);
      const r3 = mergeTable(d.leads, 'leads', ['id', 'name', 'phone', 'area', 'store_name', 'stage', 'doc_date', 'advisor', 'open_target', 'memo', 'flag', 'created', 'mt', 'del'],
        x => [x.id, x.name, x.phone || '', x.area || '', g(x, 'storeName', 'store_name') || '', x.stage | 0, g(x, 'docDate', 'doc_date') || '', x.advisor ? 1 : 0, g(x, 'openTarget', 'open_target') || '', x.memo || '', x.flag ? 1 : 0, x.created || '', x.mt || now(), x.del ? 1 : 0]);
      const r4 = mergeTable(d.orders, 'orders', ['id', 'store_id', 'date', 'deliver_date', 'status', 'memo', 'items', 'mt', 'del'],
        x => [x.id, g(x, 'storeId', 'store_id'), x.date, g(x, 'deliverDate', 'deliver_date') || x.date, x.status || '대기', x.memo || '', JSON.stringify(x.items || []), x.mt || now(), x.del ? 1 : 0]);
      const r5 = mergeTable(d.sales, 'closings', ['id', 'store_id', 'date', 'items', 'mt', 'del'],
        x => [x.id, g(x, 'storeId', 'store_id'), x.date, JSON.stringify(x.items || []), x.mt || now(), x.del ? 1 : 0]);
      const r6 = mergeTable(d.notices, 'notices', ['id', 'date', 'title', 'body', 'pinned', 'mt', 'del'],
        x => [x.id, x.date, x.title, x.body || '', x.pinned ? 1 : 0, x.mt || now(), x.del ? 1 : 0]);
      /* 계정: 조직 구조만 이관 — 비밀번호 해시는 절대 이관하지 않음(신규 계정은 마스터가 재설정 필요) */
      let r7 = { nIns: 0, nUpd: 0 };
      (Array.isArray(d.users) ? d.users : []).forEach(x => {
        if (!x || !x.id || !x.username || !DEPTS[x.dept]) return;
        const ex = db.prepare('SELECT id, mt FROM users WHERE id=?').get(x.id);
        if (!ex) {
          if (db.prepare('SELECT 1 FROM users WHERE username=? AND del=0').get(String(x.username).toLowerCase())) return;
          db.prepare('INSERT INTO users(id,username,name,dept,pw_hash,active,mt,del) VALUES(?,?,?,?,NULL,?,?,?)')
            .run(x.id, String(x.username).toLowerCase(), x.name || x.username, x.dept, x.active === false ? 0 : 1, x.mt || now(), x.del ? 1 : 0);
          r7.nIns++;
        } else if ((x.mt || 0) > (ex.mt || 0)) {
          db.prepare('UPDATE users SET name=?, dept=?, active=?, del=?, mt=? WHERE id=?')
            .run(x.name || x.username, x.dept, x.active === false ? 0 : 1, x.del ? 1 : 0, x.mt || now(), x.id);
          r7.nUpd++;
        }
      });
      let r8 = { nIns: 0, nUpd: 0 };
      (Array.isArray(d.aliases) ? d.aliases : []).forEach(a => {
        if (!a || !a.alias || !a.skuId) return;
        const ex = db.prepare('SELECT mt FROM sku_aliases WHERE alias=?').get(normName(a.alias));
        if (!ex) { db.prepare('INSERT INTO sku_aliases(alias,sku_id,mt) VALUES(?,?,?)').run(normName(a.alias), a.skuId, a.mt || now()); r8.nIns++; }
        else if ((a.mt || 0) > (ex.mt || 0)) { db.prepare('UPDATE sku_aliases SET sku_id=?, mt=? WHERE alias=?').run(a.skuId, a.mt || now(), normName(a.alias)); r8.nUpd++; }
      });
      (Array.isArray(d.logs) ? d.logs : []).forEach(gl => {
        if (gl && gl.act) db.prepare('INSERT INTO audit(id,ts,actor,action,detail) VALUES(?,?,?,?,?)')
          .run(uid('g'), gl.mt || now(), (gl.who || '-') + ' (이관)', gl.act, '');
      });
      audit(actor, '백업 가져오기(병합)', JSON.stringify({ skus: r1, stores: r2, leads: r3, orders: r4, closings: r5, notices: r6, users: r7 }));
      return send(res, 200, { ok: true, merged: { skus: r1, stores: r2, leads: r3, orders: r4, closings: r5, notices: r6, users: r7 } });
    }

    return err(res, 404, 'NOT_FOUND');
  } catch (e) {
    if (e && (e.message === 'BAD_JSON' || e.message === 'TOO_LARGE')) return err(res, 400, e.message);
    console.error(e);
    return err(res, 500, 'SERVER_ERROR');
  }
});

setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(now()); } catch (e) {} }, 600e3).unref();
purgeAudit();
setInterval(purgeAudit, 6 * 3600e3).unref();
/* POS 자동 동기화 — 30분마다 활성 연동 매장의 오늘·어제를 재수집(멱등) */
async function posAutoSync() {
  const links = db.prepare('SELECT store_id FROM pos_links WHERE del=0 AND active=1').all();
  const t = kstToday();
  for (const L of links) {
    for (const d of [t, addDays(t, -1)]) {
      try { await syncStoreDay(L.store_id, d, '스케줄러'); }
      catch (e) { db.prepare('UPDATE pos_links SET last_result=?, mt=? WHERE store_id=?').run('ERR ' + (e.message || e), now(), L.store_id); }
    }
  }
}
if (process.env.POS_AUTOSYNC !== '0') setInterval(() => { posAutoSync().catch(() => {}); }, 1800e3).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('[OFD] 워크스테이션 서버 v2 가동 — http://localhost:' + PORT + ' (DB: ' + DB_PATH + ')'));
}
module.exports = { server, db, _test: { kstParts, computeAnalytics, suggestSku } };
