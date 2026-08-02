import { demoData } from './demo';
import type { BankMatch, BootstrapData, DataSource, Delivery, DocumentItem, Invoice, Order, Product } from '../types';

export type BootstrapResult = { data: BootstrapData; source: DataSource; reason?: string };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export type MutationOptions = { idempotencyKey: string; actorId?: string };

export function newIdempotencyKey() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ofd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isExplicitDemoMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('demo') === '1' || import.meta.env.VITE_DEMO_MODE === 'true';
}

type Dict = Record<string, unknown>;

function record(value: unknown): Dict { return value && typeof value === 'object' ? value as Dict : {}; }
function array(value: unknown): Dict[] { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function number(value: unknown, fallback = 0) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }

export function normalizeBootstrap(input: unknown): BootstrapData {
  const raw = record(input);
  const actor = record(raw.currentActor);
  const rawStores = array(raw.stores);
  if (!text(actor.id)) throw new Error('bootstrap shape mismatch');
  const stores = new Map(rawStores.map((store) => [text(store.id), store]));
  const currentStore: Dict = rawStores[0] ?? { id: '', name: '배정 매장 없음', business: {} };
  const business = record(currentStore.business);
  const rawProducts = array(raw.products);
  const products: Product[] = rawProducts.map((product, index) => ({
    id: text(product.id), name: text(product.name, '이름 없는 상품'), unit: `1${text(product.unit, '개')}`,
    grossPrice: number(product.unitGross), category: /컵|우유|부자재/.test(text(product.name)) ? '부자재' : '식자재',
    recommended: index < 3, note: index === 0 ? '최근 발주 상품' : undefined,
  }));
  const rawShipments = array(raw.shipments);
  const shipmentByOrder = new Map(rawShipments.map((shipment) => [text(shipment.orderId), shipment]));
  const orders: Order[] = array(raw.orders).map((order) => {
    const store = stores.get(text(order.storeId)) ?? currentStore;
    const shipment = shipmentByOrder.get(text(order.id));
    const baseStatus = text(order.status, 'submitted');
    const shipmentStatus = text(shipment?.status);
    const status = (shipmentStatus === 'out_for_delivery' || shipmentStatus === 'delivered' ? shipmentStatus : baseStatus === 'draft' ? 'change_requested' : baseStatus) as Order['status'];
    const timeline = [
      { label: '발주 제출', at: text(order.submittedAt) ? '제출 완료' : undefined, done: baseStatus !== 'draft' },
      { label: '본사 승인', at: text(order.approvedAt) ? '승인 완료' : undefined, done: ['approved'].includes(baseStatus), active: baseStatus === 'submitted' },
      { label: shipmentStatus === 'out_for_delivery' ? '배송 시작' : '배송 준비', done: ['out_for_delivery', 'delivered'].includes(shipmentStatus), active: baseStatus === 'approved' && !shipmentStatus },
      { label: '입고 완료', done: shipmentStatus === 'delivered', active: shipmentStatus === 'out_for_delivery' },
    ];
    return {
      id: text(order.id), storeId: text(order.storeId), storeAddress: text(record(store.business).address), code: text(order.number), storeName: text(store.name, '매장'),
      ownerName: text(record(store.business).representativeName), createdAt: text(order.createdAt, new Date().toISOString()),
      deliveryDate: `${text(order.requestedDeliveryDate)}T12:00:00`,
      itemCount: array(order.lines).reduce((sum, line) => sum + number(line.quantity, 1), 0), grossAmount: number(order.gross),
      status, paymentTerm: text(store.paymentMethod) === 'prepaid' ? 'prepaid' : 'monthly_credit',
      risk: null, version: number(order.version, 1), source: text(order.source, 'native') as Order['source'], timeline,
      changeRequest: text(record(order.changeRequest).reason) ? {
        reason: text(record(order.changeRequest).reason), requestedBy: text(record(order.changeRequest).requestedBy),
        requestedAt: text(record(order.changeRequest).requestedAt),
      } : undefined,
      lines: array(order.lines).map((line) => {
        const snapshot = record(line.snapshot);
        return { id: text(line.id), productId: text(snapshot.productId), name: text(snapshot.name, '품목'), unit: text(snapshot.unit, '개'), quantity: number(line.quantity), unitGross: number(snapshot.unitGross), gross: number(line.gross) };
      }),
    };
  });
  const deliveries: Delivery[] = rawShipments.map((shipment, index) => {
    const store = stores.get(text(shipment.storeId)) ?? currentStore;
    const storeBusiness = record(store.business);
    const proof = record(shipment.proof);
    return {
      id: text(shipment.id), orderId: text(shipment.orderId), driverId: text(shipment.driverId), plannedDate: text(shipment.plannedDate), version: number(shipment.version, 1), sequence: index + 1,
      storeName: text(store.name, '매장'), address: text(storeBusiness.address, '등록된 주소 없음'), phone: text(storeBusiness.phone),
      window: text(shipment.deliveryWindow, '시간 미정'), itemCount: array(shipment.lines).reduce((sum, line) => sum + number(line.quantity, 1), 0),
      status: text(shipment.status) === 'delivered' ? 'delivered' : text(shipment.status) === 'out_for_delivery' ? 'driving' : 'ready',
      notes: text(array(raw.orders).find((item) => text(item.id) === text(shipment.orderId))?.note), recipientName: text(proof.recipientName, text(storeBusiness.representativeName)),
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
      return {
        paymentRequestId: text(candidate.paymentRequestId), bankTransactionId: text(candidate.bankTransactionId),
        storeName: text(candidateStore?.name, '매장 미상'), version: number(candidate.requestVersion, number(candidateRequest?.version, 1)),
        label: text(candidate.label, `${text(candidateStore?.name, '매장 미상')} · ${number(candidate.amount, number(candidateRequest?.amount)).toLocaleString('ko-KR')}원`),
      };
    }).filter((candidate) => candidate.paymentRequestId && candidate.bankTransactionId);
    return {
      id: text(transaction.id), bankTransactionId: text(transaction.id), paymentRequestId: matched && request ? text(request.id) : undefined,
      version: request ? number(request.version, 1) : 1, depositor: text(transaction.memo, '입금자 미상'), amount: number(transaction.amount),
      transferredAt: formatApiDate(text(transaction.occurredAt)), storeName: store ? text(store.name) : undefined,
      status: matched ? 'auto_matched' : 'manual_review', candidates: candidateOptions.length, candidateOptions,
    };
  });
  const invoices: Invoice[] = array(raw.taxInvoices).map((invoice) => {
    const store = stores.get(text(invoice.storeId)) ?? currentStore;
    const issueType = text(invoice.issueType);
    return {
      id: text(invoice.id), version: number(invoice.version, 1), storeName: text(store.name, '매장'), period: formatPeriod(text(invoice.issueDate)),
      grossAmount: number(invoice.gross), supplyAmount: number(invoice.supply), vatAmount: number(invoice.vat),
      status: issueType === 'internal_statement' ? 'internal_statement' : text(invoice.status, 'draft') as Invoice['status'],
      preparedBy: actorName(array(raw.availableActors), text(invoice.preparedBy)), preparedById: text(invoice.preparedBy), dueDate: '익월 10일', sameBusinessNumber: issueType === 'internal_statement', issueDate: text(invoice.issueDate),
      supplierName: text(record(invoice.supplier).legalName), supplierBusinessNumber: text(record(invoice.supplier).businessNumber), recipientName: text(record(invoice.recipient).legalName), recipientBusinessNumber: text(record(invoice.recipient).businessNumber),
    };
  });
  const documents: DocumentItem[] = [
    ...array(raw.settlements).map((settlement) => ({ id: text(settlement.id), type: 'monthly_statement' as const, title: `${formatPeriod(text(settlement.periodEnd))} 월 정산서`, period: `${text(settlement.periodStart)}–${text(settlement.periodEnd)}`, amount: number(settlement.gross), status: text(settlement.status) === 'locked' ? 'issued' as const : 'scheduled' as const })),
    ...invoices.map((invoice) => ({ id: invoice.id, type: 'tax_invoice' as const, title: `${invoice.period} 전자세금계산서`, period: invoice.dueDate, amount: invoice.grossAmount, status: invoice.status === 'nts_success' ? 'issued' as const : 'scheduled' as const })),
    ...paymentRequests.map((request) => ({ id: text(request.id), type: 'payment_request' as const, title: '결제 요청', period: `납부기한 ${text(request.dueDate)}`, amount: number(request.amount), status: text(request.status) === 'paid' ? 'paid' as const : 'pending' as const })),
  ];
  const meta = record(raw.meta);
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((value): value is string => typeof value === 'string') : Object.entries(record(raw.capabilities)).filter(([, enabled]) => enabled === true).map(([capability]) => capability);
  const allowedDeliveryDates = Array.isArray(raw.allowedDeliveryDates) ? raw.allowedDeliveryDates.filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) : nextDeliveryDates();
  return {
    actor: { id: text(actor.id), name: text(actor.name), role: text(actor.role) },
    availableActors: array(raw.availableActors).map((item) => ({ id: text(item.id), name: text(item.name), role: text(item.role) })),
    store: { id: text(currentStore.id), name: text(currentStore.name), businessName: text(business.legalName, text(currentStore.name)), billingPolicy: text(currentStore.billingCycle) === 'per_delivery' ? '배송 건별' : '월 합산', paymentTerm: text(currentStore.paymentMethod) === 'prepaid' ? '선결제' : '월 외상 · 익월 7일' },
    products, orders, deliveries, bankMatches, invoices, documents,
    capabilities,
    allowedDeliveryDates: allowedDeliveryDates.length ? allowedDeliveryDates : nextDeliveryDates(),
    meta: { apiVersion: text(meta.apiVersion, 'v2'), appMode: text(meta.appMode, 'production'), providerMode: text(meta.providerMode, 'production'), externalIssueEnabled: Boolean(meta.externalIssueEnabled) },
    generatedAt: text(meta.generatedAt, new Date().toISOString()),
    supportEmail: text(record(raw.headquarters).email),
  };
}

function orderFor(orders: Order[], id: string) { return orders.find((order) => order.id === id); }
function actorName(actors: Dict[], id: string) { return text(actors.find((actor) => text(actor.id) === id)?.name, '재무 담당자'); }
function formatPeriod(value: string) { const match = value.match(/^(\d{4})-(\d{2})/); return match ? `${match[1]}년 ${Number(match[2])}월` : '정산 기간'; }
function formatApiDate(value: string) { if (!value) return '시간 미상'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
function nextDeliveryDates() {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  while (dates.length < 3) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() === 0) continue;
    dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
  }
  return dates;
}

export async function loadBootstrap(actorId?: string): Promise<BootstrapResult> {
  if (isExplicitDemoMode()) return { data: demoData, source: 'demo', reason: '명시적 데모 모드' };

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1_800);
  try {
    const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}/bootstrap`, {
      headers: { Accept: 'application/json', ...(actorId ? { 'x-demo-actor-id': actorId } : {}) },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) throw await apiErrorFrom(response);
    const data = normalizeBootstrap(await response.json());
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
      ...(options.actorId ? { 'x-demo-actor-id': options.actorId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await apiErrorFrom(response);
  }
  return (await response.json()) as T;
}

async function apiErrorFrom(response: Response) {
  let detail: Dict = {};
  try { detail = record(record(await response.json()).error); } catch { /* JSON이 아닌 오류 응답 */ }
  return new ApiError(response.status, text(detail.code, response.status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_FAILED'), text(detail.message, `요청을 처리하지 못했습니다. (${response.status})`), text(detail.requestId), detail.details);
}

async function authPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await apiErrorFrom(response);
  return (await response.json()) as T;
}

export function loginV2(email: string, password: string) { return authPost<{ mfaRequired?: boolean; challengeToken?: string }>('/auth/login', { email, password }); }
export function completeMfaV2(challengeToken: string, code: string) { return authPost<Record<string, unknown>>('/auth/mfa', { challengeToken, code }); }
export function logoutV2() { return authPost<Record<string, unknown>>('/auth/logout', {}); }
