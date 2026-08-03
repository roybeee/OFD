import type { BankMatch, BootstrapData, Delivery, DocumentItem, Invoice, Order, Product } from '../types';

export type BootstrapResult = { data: BootstrapData; source: 'live' };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export type MutationOptions = { idempotencyKey: string };

export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) throw new Error('Web Crypto is required to create an idempotency key');
  if (typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  return `ofd-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

type Dict = Record<string, unknown>;

function record(value: unknown): Dict { return value && typeof value === 'object' ? value as Dict : {}; }
function array(value: unknown): Dict[] { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function number(value: unknown, fallback = 0) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function money(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function positiveMoney(value: unknown) { const amount = money(value); return amount !== undefined && amount > 0 ? amount : undefined; }
function requiredMoney(value: unknown, label: string) {
  const amount = money(value);
  if (amount === undefined) throw new Error(`bootstrap ${label} money mismatch`);
  return amount;
}

const invoiceStatuses: Invoice['status'][] = ['draft', 'reviewed', 'approved', 'queued', 'issued', 'nts_pending', 'nts_success', 'failed', 'cancelled'];
function invoiceStatus(value: unknown, internalStatement: boolean): Invoice['status'] {
  if (internalStatement) return 'internal_statement';
  const status = text(value);
  if (!invoiceStatuses.includes(status as Invoice['status'])) throw new Error('bootstrap invoice status mismatch');
  return status as Invoice['status'];
}

export function normalizeBootstrap(input: unknown): BootstrapData {
  const raw = record(input);
  const actor = record(raw.currentActor);
  const rawStores = array(raw.stores);
  if (!text(actor.id)) throw new Error('bootstrap shape mismatch');
  const stores = new Map(rawStores.map((store) => [text(store.id), store]));
  const currentStore: Dict = rawStores[0] ?? { id: '', name: '배정 매장 없음', business: {} };
  const business = record(currentStore.business);
  const rawProducts = array(raw.products).filter((product) => product.active !== false
    && Boolean(text(product.id)) && positiveMoney(product.unitGross) !== undefined);
  const products: Product[] = rawProducts.map((product) => ({
    id: text(product.id), name: text(product.name, '이름 없는 상품'), unit: `1${text(product.unit, '개')}`,
    grossPrice: number(product.unitGross), category: text(product.category, '기타'),
    ...(product.recommended === true ? { recommended: true } : {}),
    ...(text(product.note) ? { note: text(product.note) } : {}),
  }));
  const rawShipments = array(raw.shipments);
  const shipmentByOrder = new Map(rawShipments.map((shipment) => [text(shipment.orderId), shipment]));
  const orders: Order[] = array(raw.orders).map((order) => {
    const store = stores.get(text(order.storeId)) ?? currentStore;
    const shipment = shipmentByOrder.get(text(order.id));
    const baseStatus = text(order.status, 'submitted');
    const source = text(order.source, 'native') as Order['source'];
    const legacyUnverified = source === 'legacy_unverified';
    const shipmentStatus = text(shipment?.status);
    const rawLines = array(order.lines);
    const lines: NonNullable<Order['lines']> = rawLines.map((line) => {
      const snapshot = record(line.snapshot);
      return {
        id: text(line.id), productId: text(snapshot.productId), name: text(snapshot.name, '품목'), unit: text(snapshot.unit, '개'),
        quantity: number(line.quantity),
        unitGross: legacyUnverified ? null : requiredMoney(snapshot.unitGross, 'order line unit gross'),
        gross: legacyUnverified ? null : requiredMoney(line.gross, 'order line gross'),
        supply: legacyUnverified ? null : requiredMoney(line.supply, 'order line supply'),
        vat: legacyUnverified ? null : requiredMoney(line.vat, 'order line vat'),
      };
    });
    const lineTotals = lines.reduce((sum, line) => ({ gross: sum.gross + (line.gross ?? 0), supply: sum.supply + (line.supply ?? 0), vat: sum.vat + (line.vat ?? 0) }), { gross: 0, supply: 0, vat: 0 });
    const paymentMethod = text(store.paymentMethod);
    const status = (shipmentStatus === 'out_for_delivery' || shipmentStatus === 'delivered' ? shipmentStatus : baseStatus === 'draft' ? 'change_requested' : baseStatus) as Order['status'];
    const shipmentRegistered = Boolean(shipment);
    const timeline = [
      { label: '발주 제출', at: text(order.submittedAt) ? '제출 완료' : undefined, done: baseStatus !== 'draft' },
      { label: '본사 승인', at: text(order.approvedAt) ? '승인 완료' : undefined, done: ['approved'].includes(baseStatus), active: baseStatus === 'submitted' },
      {
        label: shipmentStatus === 'out_for_delivery' ? '배송 시작' : !shipmentRegistered && baseStatus === 'approved' ? '배송 연동 미설정' : '배송 일정',
        at: !shipmentRegistered && baseStatus === 'approved' ? '배송 일정 미등록' : undefined,
        done: ['out_for_delivery', 'delivered'].includes(shipmentStatus),
        active: shipmentRegistered && baseStatus === 'approved' && !['out_for_delivery', 'delivered'].includes(shipmentStatus),
      },
      { label: '입고 완료', done: shipmentStatus === 'delivered', active: shipmentStatus === 'out_for_delivery' },
    ];
    return {
      id: text(order.id), storeId: text(order.storeId), storeAddress: text(record(store.business).address), code: text(order.number), storeName: text(store.name, '매장'),
      ownerName: text(record(store.business).representativeName), createdAt: text(order.createdAt),
      deliveryDate: `${text(order.requestedDeliveryDate)}T12:00:00`,
      itemCount: rawLines.reduce((sum, line) => sum + number(line.quantity), 0),
      grossAmount: legacyUnverified ? null : money(order.gross) ?? lineTotals.gross,
      supplyAmount: legacyUnverified ? null : money(order.supply) ?? lineTotals.supply,
      vatAmount: legacyUnverified ? null : money(order.vat) ?? lineTotals.vat,
      status, paymentTerm: paymentMethod === 'prepaid' ? 'prepaid' : paymentMethod === 'monthly_credit' ? 'monthly_credit' : 'unconfigured',
      risk: null, version: number(order.version, 1), source, timeline,
      changeRequest: text(record(order.changeRequest).reason) ? {
        reason: text(record(order.changeRequest).reason), requestedBy: text(record(order.changeRequest).requestedBy),
        requestedAt: text(record(order.changeRequest).requestedAt),
      } : undefined,
      lines,
    };
  });
  const deliveries: Delivery[] = rawShipments.map((shipment) => {
    const store = stores.get(text(shipment.storeId)) ?? currentStore;
    const storeBusiness = record(store.business);
    const proof = record(shipment.proof);
    const rawSequence = money(shipment.sequence);
    const explicitSequence = rawSequence !== undefined && rawSequence > 0 ? rawSequence : undefined;
    const recipientName = text(proof.recipientName).trim() || undefined;
    return {
      id: text(shipment.id), orderId: text(shipment.orderId), driverId: text(shipment.driverId), plannedDate: text(shipment.plannedDate), version: number(shipment.version, 1), sequence: explicitSequence,
      storeName: text(store.name, '매장'), address: text(storeBusiness.address, '등록된 주소 없음'), phone: text(storeBusiness.phone),
      window: text(shipment.deliveryWindow).trim() || '시간 미정', itemCount: array(shipment.lines).reduce((sum, line) => sum + number(line.quantity), 0),
      status: text(shipment.status) === 'delivered' ? 'delivered' : text(shipment.status) === 'out_for_delivery' ? 'driving' : 'ready',
      notes: text(array(raw.orders).find((item) => text(item.id) === text(shipment.orderId))?.note), recipientName,
      lines: orderFor(orders, text(shipment.orderId))?.lines?.map((line) => ({ name: line.name, unit: line.unit, quantity: line.quantity })) ?? [],
    };
  });
  const paymentRequests = array(raw.paymentRequests);
  const manualCandidates = array(raw.manualMatchCandidates);
  const bankMatches: BankMatch[] = array(raw.bankTransactions).map((transaction) => {
    const request = paymentRequests.find((item) => text(item.matchedBankTransactionId) === text(transaction.id));
    const store = request ? stores.get(text(request.storeId)) : undefined;
    const matched = Boolean(transaction.matched) || Boolean(request && text(request.status) === 'paid');
    const candidateOptions = manualCandidates.filter((candidate) => text(candidate.bankTransactionId) === text(transaction.id)).map((candidate) => {
      const candidateRequest = paymentRequests.find((item) => text(item.id) === text(candidate.paymentRequestId));
      const candidateStore = stores.get(text(candidate.storeId, text(candidateRequest?.storeId)));
      const candidateAmount = requiredMoney(candidate.amount ?? candidateRequest?.amount, 'payment candidate amount');
      return {
        paymentRequestId: text(candidate.paymentRequestId), bankTransactionId: text(candidate.bankTransactionId),
        storeName: text(candidateStore?.name, '매장 미상'), version: number(candidate.requestVersion, number(candidateRequest?.version, 1)),
        label: text(candidate.label).trim() || `${text(candidateStore?.name, '매장 미상')} · ${candidateAmount.toLocaleString('ko-KR')}원`,
      };
    }).filter((candidate) => candidate.paymentRequestId && candidate.bankTransactionId);
    return {
      id: text(transaction.id), bankTransactionId: text(transaction.id), paymentRequestId: matched && request ? text(request.id) : undefined,
      version: request ? number(request.version, 1) : 1, depositor: text(transaction.memo, '입금자 미상'), amount: requiredMoney(transaction.amount, 'bank transaction amount'),
      transferredAt: formatApiDate(text(transaction.occurredAt)), storeName: store ? text(store.name) : undefined,
      status: matched ? 'auto_matched' : 'manual_review', candidates: candidateOptions.length, candidateOptions,
    };
  });
  const invoices: Invoice[] = array(raw.taxInvoices).map((invoice) => {
    const store = stores.get(text(invoice.storeId)) ?? currentStore;
    const issueType = text(invoice.issueType);
    const internalStatement = issueType === 'internal_statement';
    return {
      id: text(invoice.id), version: number(invoice.version, 1), storeName: text(store.name, '매장'), period: formatPeriod(text(invoice.issueDate)),
      grossAmount: requiredMoney(invoice.gross, 'invoice gross'), supplyAmount: requiredMoney(invoice.supply, 'invoice supply'), vatAmount: requiredMoney(invoice.vat, 'invoice vat'),
      status: invoiceStatus(invoice.status, internalStatement),
      preparedBy: actorName(array(raw.availableActors), text(invoice.preparedBy)), preparedById: text(invoice.preparedBy), dueDate: text(invoice.dueDate, '기한 미등록'), sameBusinessNumber: internalStatement, issueDate: text(invoice.issueDate),
      supplierName: text(record(invoice.supplier).legalName), supplierBusinessNumber: text(record(invoice.supplier).businessNumber), recipientName: text(record(invoice.recipient).legalName), recipientBusinessNumber: text(record(invoice.recipient).businessNumber),
    };
  });
  const documents: DocumentItem[] = [
    ...array(raw.settlements).map((settlement) => ({ id: text(settlement.id), type: 'monthly_statement' as const, title: `${formatPeriod(text(settlement.periodEnd))} 월 정산서`, period: `${text(settlement.periodStart)}–${text(settlement.periodEnd)}`, amount: requiredMoney(settlement.gross, 'settlement gross'), status: text(settlement.status) === 'locked' ? 'issued' as const : 'scheduled' as const })),
    ...invoices.map((invoice) => ({ id: invoice.id, type: invoice.sameBusinessNumber ? 'internal_statement' as const : 'tax_invoice' as const, title: `${invoice.period} ${invoice.sameBusinessNumber ? '내부거래 명세서' : '전자세금계산서'}`, period: invoice.dueDate, amount: invoice.grossAmount, status: invoice.status })),
    ...paymentRequests.map((request) => ({ id: text(request.id), type: 'payment_request' as const, title: '결제 요청', period: `납부기한 ${text(request.dueDate)}`, amount: requiredMoney(request.amount, 'payment request amount'), status: text(request.status) === 'paid' ? 'paid' as const : 'pending' as const })),
  ];
  const meta = record(raw.meta);
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((value): value is string => typeof value === 'string') : Object.entries(record(raw.capabilities)).filter(([, enabled]) => enabled === true).map(([capability]) => capability);
  const allowedDeliveryDates = Array.isArray(raw.allowedDeliveryDates) ? raw.allowedDeliveryDates.filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) : [];
  return {
    actor: { id: text(actor.id), name: text(actor.name), role: text(actor.role) },
    availableActors: array(raw.availableActors).map((item) => ({ id: text(item.id), name: text(item.name), role: text(item.role) })),
    store: {
      id: text(currentStore.id), name: text(currentStore.name), businessName: text(business.legalName, text(currentStore.name)),
      billingPolicy: text(currentStore.billingCycle) === 'per_delivery' ? '배송 건별' : text(currentStore.billingCycle) === 'monthly' ? '월 합산' : '확인 필요',
      paymentTerm: text(currentStore.paymentMethod) === 'prepaid' ? '선결제' : text(currentStore.paymentMethod) === 'monthly_credit' ? '월 외상' : '확인 필요',
    },
    products, orders, deliveries, bankMatches, invoices, documents,
    capabilities,
    allowedDeliveryDates,
    meta: { apiVersion: text(meta.apiVersion, 'v2'), appMode: text(meta.appMode), providerMode: text(meta.providerMode), externalIssueEnabled: Boolean(meta.externalIssueEnabled) },
    generatedAt: text(meta.generatedAt),
    supportEmail: text(record(raw.headquarters).email),
  };
}

function orderFor(orders: Order[], id: string) { return orders.find((order) => order.id === id); }
function actorName(actors: Dict[], id: string) { return text(actors.find((actor) => text(actor.id) === id)?.name, id || '담당자 미등록'); }
function formatPeriod(value: string) { const match = value.match(/^(\d{4})-(\d{2})/); return match ? `${match[1]}년 ${Number(match[2])}월` : '정산 기간'; }
function formatApiDate(value: string) { if (!value) return '시간 미상'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
export async function loadBootstrap(): Promise<BootstrapResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}/bootstrap`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) throw await apiErrorFrom(response);
    const data = normalizeBootstrap(await response.json());
    if (data.meta.appMode !== 'production') {
      throw new ApiError(503, 'NON_PRODUCTION_API', '운영 데이터가 아닌 API 연결이 감지되어 화면을 차단했습니다.');
    }
    return { data, source: 'live' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const reason = error instanceof Error ? error.message : 'API 연결 실패';
    throw new ApiError(0, 'NETWORK_ERROR', `운영 API 연결 실패: ${reason}`);
  } finally {
    window.clearTimeout(timer);
  }
}

export async function mutateV2<T>(path: string, body: Record<string, unknown>, options: MutationOptions): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey,
      'X-OFD': '1',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await apiErrorFrom(response);
  }
  return (await response.json()) as T;
}

async function apiErrorFrom(response: Response) {
  let payload: Dict = {};
  try { payload = record(await response.json()); } catch { /* JSON이 아닌 오류 응답 */ }
  const nested = record(payload.error);
  const flatError = typeof payload.error === 'string' ? payload.error : '';
  const code = text(nested.code, text(payload.code, flatError || (response.status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_FAILED')));
  const message = text(nested.message, text(payload.message, `요청을 처리하지 못했습니다. (${response.status})`));
  const requestId = text(nested.requestId, text(payload.requestId));
  const details = nested.details ?? payload.details;
  return new ApiError(response.status, code, message, requestId, details);
}

async function authPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-OFD': '1' }, body: JSON.stringify(body) });
  if (!response.ok) throw await apiErrorFrom(response);
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

export function logoutV2() { return authPost<Record<string, unknown>>('/auth/logout', {}); }
