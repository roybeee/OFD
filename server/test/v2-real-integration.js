/* V2 실운영 계약 테스트 — 데모 데이터 없이 SQLite·세션·권한·발주 수명주기를 검증한다. */
'use strict';

delete process.env.ALLOW_DEMO_SEED;
delete process.env.ALLOW_MOCK_POS;
process.env.DB_PATH = '/tmp/ofd_v2_real_' + Date.now() + '_' + process.pid + '.db';
process.env.PORT = '0';
process.env.POS_AUTOSYNC = '0';
process.env.POS_BACKFILL_RUNNER = '0';

const { server, db } = require('../server.js');

let BASE = '';
const jars = Object.create(null);
const checks = [];

function log(name, ok, detail) {
  checks.push(Boolean(ok));
  console.log((ok ? '  OK  ' : 'FAIL  ') + name + (ok ? '' : '   << ' + (detail || '')));
}

function codeOf(result) {
  const error = result && result.data && result.data.error;
  return typeof error === 'string' ? error : error && error.code;
}

async function call(jar, method, path, body, headers) {
  const requestHeaders = Object.assign({ 'X-OFD': '1' }, headers || {});
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (jar && jars[jar]) requestHeaders.Cookie = jars[jar];
  const response = await fetch(BASE + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (jar && setCookie) jars[jar] = setCookie.split(';')[0];
  let data = null;
  try { data = await response.json(); } catch (error) {}
  return { status: response.status, data, headers: response.headers };
}

async function must(jar, method, path, body, headers, expectedStatus = 200) {
  const result = await call(jar, method, path, body, headers);
  if (result.status !== expectedStatus) {
    throw new Error(method + ' ' + path + ' expected ' + expectedStatus + ', got ' + result.status + ' ' + JSON.stringify(result.data));
  }
  return result;
}

function orderOf(result) { return result && result.data && result.data.order; }
function idem(key) { return { 'Idempotency-Key': key }; }

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  BASE = 'http://127.0.0.1:' + server.address().port;

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_DEMO_SEED = '1';
  const setup = await call('hq', 'POST', '/api/setup', {
    username: 'realmaster', name: '실운영 마스터', password: 'm2468', demo: true,
  });
  delete process.env.ALLOW_DEMO_SEED;
  delete process.env.NODE_ENV;
  const seedCounts = {
    stores: db.prepare('SELECT COUNT(*) n FROM stores WHERE del=0').get().n,
    products: db.prepare('SELECT COUNT(*) n FROM skus WHERE del=0').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders WHERE del=0').get().n,
  };
  log('V01 운영 초기 설정: production에서는 환경변수·demo 요청으로도 예시 원장을 만들지 않음',
    setup.status === 200 && Object.keys(setup.data.codes || {}).length === 0
    && Object.values(seedCounts).every(value => value === 0), JSON.stringify(seedCounts));

  let result = await call(null, 'GET', '/api/v2/bootstrap');
  log('V02 V2 인증: 세션 없는 bootstrap을 거부', result.status === 401 && codeOf(result) === 'AUTH_REQUIRED', JSON.stringify(result.data));
  result = await call(null, 'GET', '/api/v2/bootstrap?demo=1');
  log('V03 V2 인증: demo 쿼리로 실제 인증을 우회할 수 없음', result.status === 401 && codeOf(result) === 'AUTH_REQUIRED', JSON.stringify(result.data));

  const rootResponse = await fetch(BASE + '/');
  const rootText = await rootResponse.text();
  const workflowTag = (rootText.match(/<a class="workflow"[^>]*aria-label="통합 발주·정산 메뉴"[^>]*>/) || [])[0] || '';
  log('V04 정식 메뉴: 로그인 후 역할별 실서비스 경로만 동일 탭으로 연결',
    rootResponse.status === 200 && rootText.includes('통합 발주·정산') && rootText.includes('발주부터 정산까지')
    && rootText.includes("isHQ()?'/v2/hq/orders':'/v2/store/orders'")
    && workflowTag && !/\btarget\s*=/.test(workflowTag)
    && !rootText.includes('?demo=1') && !rootText.includes('V2 파일럿')
    && !rootText.includes('id="su_demo"') && rootText.includes('빈 운영 원장으로 시작합니다'));

  const shellResponse = await fetch(BASE + '/v2/store/orders');
  const shellText = await shellResponse.text();
  const assetPath = (shellText.match(/src="([^"]+\.js)"/) || [])[1];
  const assetResponse = assetPath ? await fetch(BASE + assetPath) : null;
  const assetText = assetResponse ? await assetResponse.text() : '';
  const runtimeDemoMarkers = ['PO-260802-014', '김운영', '박도현', 'store-doksan', 'OFD-demo-2026', 'x-demo-actor-id', '데모 데이터이므로', '?demo=1'];
  log('V05 V2 배포 번들: 고정 데모 인물·발주·인증 우회를 포함하지 않음',
    shellResponse.status === 200 && assetResponse && assetResponse.status === 200
    && !runtimeDemoMarkers.some(marker => assetText.includes(marker)));

  const emptyBootstrap = await must('hq', 'GET', '/api/v2/bootstrap');
  const emptyArrays = ['stores', 'products', 'orders', 'shipments', 'receipts', 'paymentRequests', 'bankTransactions', 'settlements', 'taxInvoices'];
  log('V06 실제 bootstrap: 빈 운영 원장을 가짜 데이터로 대체하지 않음',
    emptyBootstrap.data.meta && emptyBootstrap.data.meta.appMode === 'production'
    && emptyBootstrap.data.meta.providerMode === 'disabled'
    && emptyArrays.every(key => Array.isArray(emptyBootstrap.data[key]) && emptyBootstrap.data[key].length === 0));

  const storeAResult = await must('hq', 'POST', '/api/stores', {
    name: '실데이터 A점', type: '가맹', region: '서울', addr: '서울 금천구 실데이터로 1', phone: '02-111-1111', openDate: '2025-01-02',
  });
  const storeBResult = await must('hq', 'POST', '/api/stores', {
    name: '실데이터 B점', type: '가맹', region: '서울', addr: '서울 용산구 실데이터로 2', phone: '02-222-2222', openDate: '2025-02-03',
  });
  const storeA = storeAResult.data.id;
  const storeB = storeBResult.data.id;
  const globalSkuResult = await must('hq', 'POST', '/api/skus', { name: '실운영 공통상품', price: 52000, supply: 26000, category: '도넛' });
  const roundingSkuResult = await must('hq', 'POST', '/api/skus', { name: '원단위 검증상품', price: 4436, supply: 2016, category: '도넛' });
  const storeASkuResult = await must('hq', 'POST', '/api/skus', { name: 'A점 전용상품', price: 22000, supply: 11000, category: '음료', storeId: storeA });
  const storeBSkuResult = await must('hq', 'POST', '/api/skus', { name: 'B점 전용상품', price: 34000, supply: 17000, category: '굿즈', storeId: storeB });
  const globalSku = globalSkuResult.data.skuId;
  const roundingSku = roundingSkuResult.data.skuId;
  const storeASku = storeASkuResult.data.skuId;
  const storeBSku = storeBSkuResult.data.skuId;

  await must('storeA', 'POST', '/api/auth/store', { storeId: storeA, code: storeAResult.data.code });
  await must('storeB', 'POST', '/api/auth/store', { storeId: storeB, code: storeBResult.data.code });

  const storeBootstrap = await must('storeA', 'GET', '/api/v2/bootstrap');
  const productIds = new Set(storeBootstrap.data.products.map(product => product.id));
  const globalProjection = storeBootstrap.data.products.find(product => product.id === globalSku);
  const storeProjection = storeBootstrap.data.products.find(product => product.id === storeASku);
  const forbiddenCaps = ['store.documents.read', 'hq.shipments.manage', 'hq.shipments.dispatch', 'hq.payments.reconcile', 'hq.invoices.read', 'driver.deliveries.read'];
  log('V07 매장 격리: 자기 매장·허용 상품·실제 category와 구현된 capability만 투영',
    storeBootstrap.data.currentActor.storeIds.length === 1 && storeBootstrap.data.currentActor.storeIds[0] === storeA
    && storeBootstrap.data.stores.length === 1 && storeBootstrap.data.stores[0].id === storeA
    && productIds.has(globalSku) && productIds.has(storeASku) && !productIds.has(storeBSku)
    && globalProjection.category === '도넛' && storeProjection.category === '음료'
    && globalProjection.unitGross === 28600 && storeProjection.unitGross === 12100
    && storeBootstrap.data.stores[0].billingCycle === 'unconfigured'
    && storeBootstrap.data.stores[0].paymentMethod === 'unconfigured'
    && forbiddenCaps.every(capability => !storeBootstrap.data.capabilities.includes(capability)));

  const allowedDates = storeBootstrap.data.allowedDeliveryDates;
  log('V08 입고일: 서버가 제공한 날짜는 일요일을 제외',
    Array.isArray(allowedDates) && allowedDates.length > 0
    && allowedDates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date + 'T00:00:00Z').getUTCDay() !== 0));
  const deliveryDate = allowedDates[0];

  const submitBody = {
    storeId: storeA, requestedDeliveryDate: deliveryDate,
    items: [{ productId: globalSku, quantity: 2 }],
  };
  const submitted = await call('storeA', 'POST', '/api/v2/orders/submit-new', submitBody, idem('submit-approve-001'));
  const submittedOrder = orderOf(submitted);
  log('V09 신규 발주: 실제 상품 공급가 스냅샷으로 version 2 주문을 저장',
    submitted.status === 201 && submittedOrder && submittedOrder.version === 2
    && submittedOrder.status === 'submitted' && submittedOrder.source === 'native'
    && submittedOrder.gross === 57200 && submittedOrder.supply === 52000 && submittedOrder.vat === 5200
    && submittedOrder.lines[0].snapshot.unitGross === 28600
    && submittedOrder.lines[0].snapshot.category === undefined
    && db.prepare('SELECT COUNT(*) n FROM orders WHERE id=? AND store_id=? AND del=0').get(submittedOrder.id, storeA).n === 1);

  const replayed = await call('storeA', 'POST', '/api/v2/orders/submit-new', submitBody, idem('submit-approve-001'));
  log('V10 멱등 재시도: 같은 요청은 같은 201 응답을 재생하고 중복 저장하지 않음',
    replayed.status === 201 && replayed.headers.get('idempotency-replayed') === 'true'
    && orderOf(replayed).id === submittedOrder.id
    && db.prepare('SELECT COUNT(*) n FROM orders WHERE store_id=? AND del=0').get(storeA).n === 1);

  const reused = await call('storeA', 'POST', '/api/v2/orders/submit-new', {
    ...submitBody, items: [{ productId: globalSku, quantity: 3 }],
  }, idem('submit-approve-001'));
  log('V11 멱등 키: 다른 payload 재사용을 충돌로 거부', reused.status === 409 && codeOf(reused) === 'IDEMPOTENCY_KEY_REUSED', JSON.stringify(reused.data));

  const missingKey = await call('storeA', 'POST', '/api/v2/orders/submit-new', submitBody);
  log('V12 멱등 키: 쓰기 요청의 키 누락을 거부', missingKey.status === 400 && codeOf(missingKey) === 'IDEMPOTENCY_KEY_REQUIRED', JSON.stringify(missingKey.data));

  const crossStore = await call('storeA', 'POST', '/api/v2/orders/submit-new', {
    ...submitBody, storeId: storeB,
  }, idem('cross-store-001'));
  log('V13 매장 격리: 다른 매장 명의 발주를 거부', crossStore.status === 403, JSON.stringify(crossStore.data));

  const storeApproval = await call('storeA', 'POST', '/api/v2/orders/' + submittedOrder.id + '/approve', {
    expectedVersion: 2,
  }, idem('store-approve-001'));
  log('V14 역할 권한: 점주의 본사 승인 작업을 거부', storeApproval.status === 403, JSON.stringify(storeApproval.data));

  const staleApproval = await call('hq', 'POST', '/api/v2/orders/' + submittedOrder.id + '/approve', {
    expectedVersion: 1,
  }, idem('hq-approve-stale-001'));
  log('V15 낙관적 잠금: 오래된 버전 승인을 충돌로 거부', staleApproval.status === 409 && codeOf(staleApproval) === 'VERSION_CONFLICT', JSON.stringify(staleApproval.data));

  const approval = await call('hq', 'POST', '/api/v2/orders/' + submittedOrder.id + '/approve', {
    expectedVersion: 2,
  }, idem('hq-approve-live-001'));
  const hqAfterApproval = await must('hq', 'GET', '/api/v2/bootstrap');
  const persistedApproval = hqAfterApproval.data.orders.find(order => order.id === submittedOrder.id);
  log('V16 본사 승인: 상태·승인자·version 3을 SQLite와 다음 bootstrap에 보존',
    approval.status === 200 && orderOf(approval).status === 'approved' && orderOf(approval).version === 3
    && orderOf(approval).approvedBy && persistedApproval && persistedApproval.status === 'approved' && persistedApproval.version === 3);

  const lifecycleSubmit = await must('storeA', 'POST', '/api/v2/orders/submit-new', {
    storeId: storeA, requestedDeliveryDate: deliveryDate, items: [{ productId: globalSku, quantity: 1 }],
  }, idem('lifecycle-submit-001'), 201);
  const lifecycleId = orderOf(lifecycleSubmit).id;
  const changed = await call('hq', 'POST', '/api/v2/orders/' + lifecycleId + '/change-request', {
    expectedVersion: 2, reason: '발주 수량을 다시 확인해 주세요',
  }, idem('lifecycle-change-001'));
  const resubmitted = await call('storeA', 'POST', '/api/v2/orders/' + lifecycleId + '/resubmit', {
    expectedVersion: 3, requestedDeliveryDate: deliveryDate, items: [{ productId: globalSku, quantity: 3 }],
  }, idem('lifecycle-resubmit-001'));
  const cancelled = await call('storeA', 'POST', '/api/v2/orders/' + lifecycleId + '/cancel', {
    expectedVersion: 4, reason: '점주 직접 취소',
  }, idem('lifecycle-cancel-001'));
  const lifecycleDetails = db.prepare('SELECT * FROM v2_order_details WHERE order_id=?').get(lifecycleId);
  const lifecycleLegacy = db.prepare('SELECT status, items FROM orders WHERE id=?').get(lifecycleId);
  log('V17 변경 전체 흐름: 요청 v3 → 재제출 v4·85,800원 → 취소 v5를 보존하고 변경 사유를 정리',
    changed.status === 200 && orderOf(changed).version === 3 && orderOf(changed).status === 'change_requested'
    && resubmitted.status === 200 && orderOf(resubmitted).version === 4 && orderOf(resubmitted).gross === 85800
    && !orderOf(resubmitted).changeRequest
    && cancelled.status === 200 && orderOf(cancelled).version === 5 && orderOf(cancelled).status === 'cancelled'
    && !orderOf(cancelled).changeRequest && lifecycleDetails.change_reason === null
    && lifecycleDetails.version === 5 && lifecycleLegacy.status === '취소');

  const legacyId = 'legacy-real-order';
  db.prepare(`INSERT INTO orders(id,store_id,date,deliver_date,status,memo,items,mt,del)
    VALUES(?,?,?,?,?,?,?,?,0)`).run(legacyId, storeA, deliveryDate, deliveryDate, '대기', '기존 시스템 발주', JSON.stringify([{ skuId: globalSku, qty: 1 }]), Date.now());
  const legacyBootstrap = await must('storeA', 'GET', '/api/v2/bootstrap');
  const legacyProjection = legacyBootstrap.data.orders.find(order => order.id === legacyId);
  const legacyCancel = await call('storeA', 'POST', '/api/v2/orders/' + legacyId + '/cancel', { expectedVersion: 1, reason: '취소' }, idem('legacy-cancel-001'));
  const legacyResubmit = await call('storeA', 'POST', '/api/v2/orders/' + legacyId + '/resubmit', {
    expectedVersion: 1, requestedDeliveryDate: deliveryDate, items: [{ productId: globalSku, quantity: 1 }],
  }, idem('legacy-resubmit-001'));
  const legacyApprove = await call('hq', 'POST', '/api/v2/orders/' + legacyId + '/approve', { expectedVersion: 1 }, idem('legacy-approve-001'));
  const legacyChange = await call('hq', 'POST', '/api/v2/orders/' + legacyId + '/change-request', {
    expectedVersion: 1, reason: '변경 요청',
  }, idem('legacy-change-001'));
  log('V18 레거시 발주: legacy_unverified로 투영하고 모든 V2 대상 변경을 읽기 전용으로 거부',
    legacyProjection && legacyProjection.source === 'legacy_unverified'
    && legacyProjection.gross === null && legacyProjection.supply === null && legacyProjection.vat === null
    && legacyProjection.lines.length === 1 && legacyProjection.lines[0].gross === null
    && [legacyCancel, legacyResubmit, legacyApprove, legacyChange].every(item => item.status === 409 && codeOf(item) === 'LEGACY_READ_ONLY'));

  const bridgedLegacySubmit = await call('storeA', 'POST', '/api/orders', {
    deliverDate: deliveryDate, items: [{ skuId: globalSku, qty: 1 }], memo: '기존 화면에서 제출',
  });
  const bridgedDetails = bridgedLegacySubmit.data && db.prepare('SELECT * FROM v2_order_details WHERE order_id=?').get(bridgedLegacySubmit.data.id);
  const bridgedApproval = bridgedDetails ? await call('hq', 'POST', '/api/v2/orders/' + bridgedLegacySubmit.data.id + '/approve', {
    expectedVersion: bridgedDetails.version,
  }, idem('legacy-bridge-approve-001')) : { status: 0, data: null };
  log('V18b 기존 발주 화면의 신규 주문도 V2 가격 스냅샷·승인 흐름으로 통합',
    bridgedLegacySubmit.status === 200 && bridgedLegacySubmit.data.managedBy === 'v2'
    && bridgedDetails && bridgedDetails.source === 'native' && bridgedDetails.version === 2
    && bridgedApproval.status === 200 && orderOf(bridgedApproval).status === 'approved');

  const invoiceDisabled = await call('hq', 'POST', '/api/v2/invoices/issue', {}, idem('invoice-disabled-001'));
  log('V19 세금계산서: 실제 공급자 미설정 시 명시적으로 fail-closed',
    invoiceDisabled.status === 503 && codeOf(invoiceDisabled) === 'INVOICE_PROVIDER_DISABLED', JSON.stringify(invoiceDisabled.data));

  const bankDisabled = await call('hq', 'POST', '/api/v2/bank-sync', {}, idem('bank-disabled-001'));
  const deliveryDisabled = await call('hq', 'POST', '/api/v2/shipments/dispatch', {}, idem('delivery-disabled-001'));
  log('V20 은행·배송: 미구현 외부 워크플로를 성공처럼 노출하지 않고 503 처리',
    bankDisabled.status === 503 && codeOf(bankDisabled) === 'BANK_PROVIDER_DISABLED'
    && deliveryDisabled.status === 503 && codeOf(deliveryDisabled) === 'DELIVERY_WORKFLOW_DISABLED',
    JSON.stringify({ bank: bankDisabled.data, delivery: deliveryDisabled.data }));

  const logout = await call('storeB', 'POST', '/api/v2/auth/logout', {});
  const afterLogout = await call('storeB', 'GET', '/api/v2/bootstrap');
  log('V21 로그아웃 브리지: 기존 세션을 삭제하고 쿠키를 만료',
    logout.status === 200 && logout.data.ok === true && afterLogout.status === 401 && codeOf(afterLogout) === 'AUTH_REQUIRED');

  const roundingSubmit = await must('storeA', 'POST', '/api/v2/orders/submit-new', {
    storeId: storeA, requestedDeliveryDate: deliveryDate, items: [{ productId: roundingSku, quantity: 2 }],
  }, idem('rounding-submit-001'), 201);
  const roundingOrder = orderOf(roundingSubmit);
  log('V22 금액 불변식: VAT 포함 문서 총액을 100/110으로 계산하고 라인 합계와 일치',
    roundingOrder.gross === 4436 && roundingOrder.supply === 4033 && roundingOrder.vat === 403
    && roundingOrder.lines[0].gross === 4436 && roundingOrder.lines[0].supply === 4033 && roundingOrder.lines[0].vat === 403,
    JSON.stringify(roundingOrder));

  const legacyAdvancePending = await call('hq', 'POST', '/api/orders/' + roundingOrder.id + '/advance', {});
  const legacyAdvanceNative = await call('hq', 'POST', '/api/orders/' + submittedOrder.id + '/advance', {});
  const legacyDeleteNative = await call('hq', 'DELETE', '/api/orders/' + submittedOrder.id, {});
  const nativeAfterLegacyAttempts = db.prepare('SELECT status,del FROM orders WHERE id=?').get(submittedOrder.id);
  const detailsAfterLegacyAttempts = db.prepare('SELECT version FROM v2_order_details WHERE order_id=?').get(submittedOrder.id);
  log('V23 API 경계: 승인 전 우회·삭제를 막고 승인 후 기존 입금 흐름은 V2 버전과 동기화',
    legacyAdvancePending.status === 409 && codeOf(legacyAdvancePending) === 'V2_ORDER_MANAGED'
    && legacyAdvanceNative.status === 200 && legacyAdvanceNative.data.status === '입금확인'
    && legacyDeleteNative.status === 409 && codeOf(legacyDeleteNative) === 'V2_ORDER_MANAGED'
    && nativeAfterLegacyAttempts.status === '입금확인' && nativeAfterLegacyAttempts.del === 0
    && detailsAfterLegacyAttempts.version === 4,
    JSON.stringify({ pending: legacyAdvancePending.data, advance: legacyAdvanceNative.data, remove: legacyDeleteNative.data, order: nativeAfterLegacyAttempts }));

  const backup = await must('hq', 'GET', '/api/export');
  const backedUpDetails = Array.isArray(backup.data.v2OrderDetails)
    ? backup.data.v2OrderDetails.find(item => item.orderId === submittedOrder.id) : null;
  db.prepare('DELETE FROM v2_order_details WHERE order_id=?').run(submittedOrder.id);
  const restored = await must('hq', 'POST', '/api/import', backup.data);
  const restoredDetails = db.prepare('SELECT * FROM v2_order_details WHERE order_id=?').get(submittedOrder.id);
  const restoredLines = restoredDetails ? JSON.parse(restoredDetails.lines_snapshot) : [];
  log('V24 백업 복원: V2 가격 스냅샷·버전·승인 이력을 보존',
    backedUpDetails && backedUpDetails.version === 4 && backedUpDetails.approvedBy
    && restored.data.merged && restored.data.merged.v2OrderDetails.nIns === 1
    && restoredDetails && restoredDetails.version === 4 && restoredDetails.source === 'native'
    && restoredDetails.approved_by === backedUpDetails.approvedBy && restoredDetails.approved_at === backedUpDetails.approvedAt
    && restoredLines[0] && restoredLines[0].gross === 57200,
    JSON.stringify({ backedUpDetails, restoredDetails, restoredLines }));

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_MOCK_POS = '1';
  const productionMock = await call('hq', 'PUT', '/api/pos/links/' + storeA, {
    provider: 'mock', merchantId: '', accessKey: '', secretKey: '', active: true,
  });
  delete process.env.ALLOW_MOCK_POS;
  delete process.env.NODE_ENV;
  log('V25 운영 안전: production에서는 환경변수만으로 mock POS를 활성화할 수 없음',
    productionMock.status === 400 && codeOf(productionMock) === 'MOCK_POS_DISABLED', JSON.stringify(productionMock.data));

  const nativeBackupOrder = backup.data.orders.find(item => item.id === submittedOrder.id);
  const malformedImport = await must('hq', 'POST', '/api/import', {
    orders: [{ ...nativeBackupOrder, id: 'malformed-native-order', mt: Date.now() }],
    v2OrderDetails: [{ ...backedUpDetails, orderId: 'malformed-native-order', orderNumber: 'PO-MALFORMED', lines: [null] }],
  });
  const bootstrapAfterMalformed = await must('hq', 'GET', '/api/v2/bootstrap');
  log('V26 백업 검증: 잘못된 V2 라인 스냅샷을 건너뛰고 bootstrap 원장을 보호',
    malformedImport.data.merged.v2OrderDetails.nSkip === 1
    && !db.prepare('SELECT 1 FROM orders WHERE id=?').get('malformed-native-order')
    && !bootstrapAfterMalformed.data.orders.some(order => order.id === 'malformed-native-order'));

  const beforeRewrite = db.prepare('SELECT status,items,mt FROM orders WHERE id=?').get(submittedOrder.id);
  const beforeRewriteDetails = db.prepare('SELECT version FROM v2_order_details WHERE order_id=?').get(submittedOrder.id);
  const rewriteAttempt = await must('hq', 'POST', '/api/import', {
    orders: [{ ...nativeBackupOrder, status: '완료', items: [{ skuId: globalSku, qty: 999 }], mt: beforeRewrite.mt + 1000 }],
  });
  const afterRewrite = db.prepare('SELECT status,items,mt FROM orders WHERE id=?').get(submittedOrder.id);
  const afterRewriteDetails = db.prepare('SELECT version FROM v2_order_details WHERE order_id=?').get(submittedOrder.id);
  log('V27 백업 경계: 일반 주문 병합으로 native V2 상태·품목·버전을 우회 변경할 수 없음',
    rewriteAttempt.data.merged.orders.nUpd === 0
    && JSON.stringify(afterRewrite) === JSON.stringify(beforeRewrite)
    && afterRewriteDetails.version === beforeRewriteDetails.version,
    JSON.stringify({ beforeRewrite, afterRewrite, merged: rewriteAttempt.data.merged }));

  const productionQaGuard = await call(null, 'GET', '/api/e2e/qa-guard', undefined, { 'X-OFD-E2E-Token': 'not-configured-in-production' });
  log('V28 E2E 안전: 서버가 명시적으로 QA 모드에 동의하지 않으면 외부 쓰기 검증을 거부',
    productionQaGuard.status === 404 && codeOf(productionQaGuard) === 'NOT_FOUND', JSON.stringify(productionQaGuard.data));

  const passed = checks.filter(Boolean).length;
  console.log('\n' + passed + '/' + checks.length + ' V2 real-operation checks passed');
  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch (error) {}
  process.exit(passed === checks.length && checks.length === 29 ? 0 : 1);
}

main().catch(error => {
  console.error('V2 REAL HARNESS ERROR', error);
  try { server.close(); } catch (closeError) {}
  try { db.close(); } catch (closeError) {}
  process.exit(1);
});
