import type { AdminActorSummary, BankMatch, BankTransactionItem, BootstrapData, Delivery, DocumentItem, Invoice, ManualMatchCandidate, ModificationReasonCode, Order, PaymentRequestItem, PaymentRequestStatus, Product, ProvisionableActorRole, PublicActor, SettlementItem, SettlementStatus , MonthlySettlementSummary } from '../types';

export type BootstrapResult = { data: BootstrapData; source: 'live' };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export type MutationOptions = { idempotencyKey: string };
type StepUpRequester = () => Promise<void>;
let stepUpRequester: StepUpRequester | null = null;
let stepUpGeneration = 0;

export function registerStepUpRequester(requester: StepUpRequester | null) {
  stepUpRequester = requester;
}

export type ShipmentScheduleDraft = {
  driverId: string;
  plannedDate: string;
  routeSequence: string;
  windowStart: string;
  windowEnd: string;
};

export function defaultShipmentSchedule(order: Pick<Order, 'deliveryDate'>): ShipmentScheduleDraft {
  const requestedDate = order.deliveryDate.slice(0, 10);
  return { driverId: '', plannedDate: /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : '',
    routeSequence: '', windowStart: '', windowEnd: '' };
}

export function shipmentMutationPayload(orderId: string, draft: ShipmentScheduleDraft) {
  const routeSequence = Number(draft.routeSequence);
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!orderId || !draft.driverId || !/^\d{4}-\d{2}-\d{2}$/.test(draft.plannedDate)
    || !Number.isInteger(routeSequence) || routeSequence < 1 || routeSequence > 9_999
    || !time.test(draft.windowStart) || !time.test(draft.windowEnd) || draft.windowStart >= draft.windowEnd) {
    throw new Error('배송일·기사·경로 순번·배송 시간대를 모두 확인해 주세요.');
  }
  return {
    orderId, driverId: draft.driverId, plannedDate: draft.plannedDate, routeSequence,
    deliveryWindow: { start: draft.windowStart, end: draft.windowEnd },
  };
}

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
function signedMoney(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function positiveMoney(value: unknown) { const amount = money(value); return amount !== undefined && amount > 0 ? amount : undefined; }
function requiredMoney(value: unknown, label: string) {
  const amount = money(value);
  if (amount === undefined) throw new Error(`bootstrap ${label} money mismatch`);
  return amount;
}
function requiredSignedMoney(value: unknown, label: string) {
  const amount = signedMoney(value);
  if (amount === undefined) throw new Error(`bootstrap ${label} signed money mismatch`);
  return amount;
}

const invoiceStatuses: Invoice['status'][] = ['draft', 'reviewed', 'approved', 'queued', 'issued', 'nts_pending', 'nts_success', 'failed', 'cancelled'];
function invoiceStatus(value: unknown): Invoice['status'] {
  const status = text(value);
  if (!invoiceStatuses.includes(status as Invoice['status'])) throw new Error('bootstrap invoice status mismatch');
  return status as Invoice['status'];
}

const paymentRequestStatuses: PaymentRequestStatus[] = ['pending', 'matching', 'manual_review', 'paid', 'reversed', 'cancelled'];
function paymentRequestStatus(value: unknown): PaymentRequestStatus {
  const status = text(value);
  if (!paymentRequestStatuses.includes(status as PaymentRequestStatus)) throw new Error('bootstrap payment request status mismatch');
  return status as PaymentRequestStatus;
}

const settlementStatuses: SettlementStatus[] = ['open', 'draft', 'reviewed', 'approved', 'locked'];
function settlementStatus(value: unknown): SettlementStatus {
  const status = text(value);
  if (!settlementStatuses.includes(status as SettlementStatus)) throw new Error('bootstrap settlement status mismatch');
  return status as SettlementStatus;
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
  const actorDirectory = [...array(raw.availableActors), ...array(raw.actorDirectory)];
  const drivers = array(raw.driverDirectory)
    .filter((driver) => Boolean(text(driver.id)) && Boolean(text(driver.name)))
    .map((driver) => ({ id: text(driver.id), name: text(driver.name) }));
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
    const destination = record(shipment.destination);
    const proof = record(shipment.proof);
    const rawSequence = money(shipment.routeSequence);
    const explicitSequence = rawSequence !== undefined && rawSequence > 0 ? rawSequence : undefined;
    const recipientName = text(proof.recipientName).trim() || undefined;
    const deliveryWindow = record(shipment.deliveryWindow);
    const windowStart = text(deliveryWindow.start);
    const windowEnd = text(deliveryWindow.end);
    const explicitItems = array(shipment.items).map((item) => ({
      name: text(item.name, '상품'), unit: text(item.unit), quantity: number(item.quantity),
    }));
    const lines = explicitItems.length
      ? explicitItems
      : orderFor(orders, text(shipment.orderId))?.lines?.map((line) => ({ name: line.name, unit: line.unit, quantity: line.quantity })) ?? [];
    return {
      id: text(shipment.id), orderId: text(shipment.orderId), driverId: text(shipment.driverId), plannedDate: text(shipment.plannedDate), version: number(shipment.version, 1), sequence: explicitSequence,
      storeName: text(destination.name, text(store.name, '매장')), address: text(destination.address, text(storeBusiness.address, '등록된 주소 없음')),
      phone: text(destination.phone, text(store.notificationPhone)),
      window: windowStart && windowEnd ? `${windowStart}–${windowEnd}` : '시간 미정',
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      status: text(shipment.status) === 'delivered' ? 'delivered' : text(shipment.status) === 'out_for_delivery' ? 'driving' : 'ready',
      notes: text(shipment.deliveryNote, text(array(raw.orders).find((item) => text(item.id) === text(shipment.orderId))?.note)), recipientName,
      lines,
    };
  });
  const rawPaymentRequests = array(raw.paymentRequests);
  const rawManualCandidates = array(raw.manualMatchCandidates);
  const bankMatches: BankMatch[] = array(raw.bankTransactions).map((transaction) => {
    const request = rawPaymentRequests.find((item) => text(item.matchedBankTransactionId) === text(transaction.id));
    const store = request ? stores.get(text(request.storeId)) : undefined;
    const matched = Boolean(transaction.matched) || Boolean(request && text(request.status) === 'paid');
    const candidateOptions = rawManualCandidates.filter((candidate) => text(candidate.bankTransactionId) === text(transaction.id)).map((candidate) => {
      const candidateRequest = rawPaymentRequests.find((item) => text(item.id) === text(candidate.paymentRequestId));
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
  const meta = record(raw.meta);
  const operationalDate = text(meta.operationalDate).slice(0, 10);
  const paymentRequests: PaymentRequestItem[] = rawPaymentRequests.map((request) => {
    const store = stores.get(text(request.storeId));
    const status = paymentRequestStatus(request.status);
    const dueDate = text(request.dueDate);
    return {
      id: text(request.id), storeId: text(request.storeId), storeName: text(store?.name, '매장 미상'),
      ...(text(request.orderId) ? { orderId: text(request.orderId) } : {}),
      ...(text(request.settlementId) ? { settlementId: text(request.settlementId) } : {}),
      amount: requiredMoney(request.amount, 'payment request amount'), dueDate, status,
      depositorHint: text(request.depositorHint),
      ...(text(request.matchedBankTransactionId) ? { matchedBankTransactionId: text(request.matchedBankTransactionId) } : {}),
      version: number(request.version, 1), createdAt: text(request.createdAt),
      overdue: Boolean(dueDate && operationalDate && dueDate < operationalDate && !['paid', 'cancelled'].includes(status)),
    };
  });
  const bankTransactions: BankTransactionItem[] = array(raw.bankTransactions).map((transaction) => {
    const direction = text(transaction.direction);
    if (direction !== 'credit' && direction !== 'debit') throw new Error('bootstrap bank transaction direction mismatch');
    return {
      id: text(transaction.id), providerId: text(transaction.providerId), accountId: text(transaction.accountId),
      occurredAt: text(transaction.occurredAt), amount: requiredMoney(transaction.amount, 'bank transaction amount'),
      direction, memo: text(transaction.memo), matched: Boolean(transaction.matched), version: number(transaction.version, 1),
    };
  });
  const manualMatchCandidates: ManualMatchCandidate[] = rawManualCandidates.map((candidate) => {
    const request = rawPaymentRequests.find((item) => text(item.id) === text(candidate.paymentRequestId));
    const storeId = text(candidate.storeId, text(request?.storeId));
    const storeName = text(stores.get(storeId)?.name, '매장 미상');
    const amount = requiredMoney(candidate.amount ?? request?.amount, 'payment candidate amount');
    return {
      paymentRequestId: text(candidate.paymentRequestId), bankTransactionId: text(candidate.bankTransactionId),
      storeId, storeName, amount, requestVersion: number(candidate.requestVersion, number(request?.version, 1)),
      label: text(candidate.label).trim() || `${storeName} · ${amount.toLocaleString('ko-KR')}원`,
    };
  }).filter((candidate) => candidate.paymentRequestId && candidate.bankTransactionId);
  const settlements: SettlementItem[] = array(raw.settlements).map((settlement) => {
    const storeId = text(settlement.storeId);
    const reviewedBy = text(settlement.reviewedBy);
    const approvedBy = text(settlement.approvedBy);
    return {
      id: text(settlement.id), storeId, storeName: text(stores.get(storeId)?.name, '매장 미상'),
      periodStart: text(settlement.periodStart), periodEnd: text(settlement.periodEnd), status: settlementStatus(settlement.status),
      receiptIds: Array.isArray(settlement.receiptIds) ? settlement.receiptIds.filter((value): value is string => typeof value === 'string') : [],
      grossAmount: requiredMoney(settlement.gross, 'settlement gross'), supplyAmount: requiredMoney(settlement.supply, 'settlement supply'), vatAmount: requiredMoney(settlement.vat, 'settlement vat'),
      ...(reviewedBy ? { reviewedBy, reviewedByName: actorName(actorDirectory, reviewedBy) } : {}),
      ...(text(settlement.reviewedAt) ? { reviewedAt: text(settlement.reviewedAt) } : {}),
      ...(approvedBy ? { approvedBy, approvedByName: actorName(actorDirectory, approvedBy) } : {}),
      ...(text(settlement.approvedAt) ? { approvedAt: text(settlement.approvedAt) } : {}),
      version: number(settlement.version, 1),
    };
  });
  const invoices: Invoice[] = array(raw.taxInvoices).map((invoice) => {
    const store = stores.get(text(invoice.storeId)) ?? currentStore;
    const rawIssueType = text(invoice.issueType);
    const issueType: NonNullable<Invoice['issueType']> = rawIssueType === 'internal_statement'
      ? 'internal_statement' : rawIssueType === 'modified' ? 'modified' : 'normal';
    const internalStatement = issueType === 'internal_statement';
    const invoiceMoney = issueType === 'modified' ? requiredSignedMoney : requiredMoney;
    const reviewedBy = text(invoice.reviewedBy);
    const approvedBy = text(invoice.approvedBy);
    return {
      id: text(invoice.id), version: number(invoice.version, 1), storeName: text(store.name, '매장'), period: formatPeriod(text(invoice.issueDate)),
      grossAmount: invoiceMoney(invoice.gross, 'invoice gross'), supplyAmount: invoiceMoney(invoice.supply, 'invoice supply'), vatAmount: invoiceMoney(invoice.vat, 'invoice vat'),
      status: invoiceStatus(invoice.status), issueType,
      preparedBy: actorName(actorDirectory, text(invoice.preparedBy)), preparedById: text(invoice.preparedBy), dueDate: text(invoice.dueDate, '기한 미등록'), sameBusinessNumber: internalStatement, issueDate: text(invoice.issueDate),
      supplierName: text(record(invoice.supplier).legalName), supplierBusinessNumber: text(record(invoice.supplier).businessNumber), recipientName: text(record(invoice.recipient).legalName), recipientBusinessNumber: text(record(invoice.recipient).businessNumber),
      ...(text(invoice.settlementId) ? { settlementId: text(invoice.settlementId) } : {}),
      ...(text(invoice.invoiceGroupId) ? { invoiceGroupId: text(invoice.invoiceGroupId) } : {}),
      ...(number(invoice.partNumber) > 0 ? { partNumber: number(invoice.partNumber) } : {}),
      ...(number(invoice.partCount) > 0 ? { partCount: number(invoice.partCount) } : {}),
      ...(reviewedBy ? { reviewedBy, reviewedByName: actorName(actorDirectory, reviewedBy) } : {}),
      ...(approvedBy ? { approvedBy, approvedByName: actorName(actorDirectory, approvedBy) } : {}),
      ...(text(invoice.serialNumber) ? { serialNumber: text(invoice.serialNumber) } : {}),
      ...(text(invoice.failureReason) ? { failureReason: text(invoice.failureReason) } : {}),
      ...(text(invoice.originalInvoiceId) ? { originalInvoiceId: text(invoice.originalInvoiceId) } : {}),
      ...(text(invoice.originalNtsConfirmNumber) ? { originalNtsConfirmNumber: text(invoice.originalNtsConfirmNumber) } : {}),
      ...(['01', '02', '03', '04', '05', '06'].includes(text(invoice.modificationReasonCode)) ? { modificationReasonCode: text(invoice.modificationReasonCode) as ModificationReasonCode } : {}),
      ...(text(invoice.preparedAt) ? { preparedAt: text(invoice.preparedAt) } : {}),
      ...(text(invoice.reviewedAt) ? { reviewedAt: text(invoice.reviewedAt) } : {}),
      ...(text(invoice.approvedAt) ? { approvedAt: text(invoice.approvedAt) } : {}),
      ...(number(invoice.retryCount) > 0 ? { retryCount: number(invoice.retryCount) } : {}),
      ...(text(invoice.lastRetriedAt) ? { lastRetriedAt: text(invoice.lastRetriedAt) } : {}),
    };
  });
  const originalsByAggregate = new Map<string, Dict>();
  for (const original of array(raw.documents)) {
    const key = `${text(original.aggregateType)}:${text(original.aggregateId)}`;
    const previous = originalsByAggregate.get(key);
    if (!previous || number(original.sourceVersion) > number(previous.sourceVersion)) originalsByAggregate.set(key, original);
  }
  const originalMetadata = (aggregateType: string, aggregateId: string, expectedSourceVersion?: number) => {
    const original = originalsByAggregate.get(`${aggregateType}:${aggregateId}`);
    if (!original || (expectedSourceVersion !== undefined && number(original.sourceVersion, -1) !== expectedSourceVersion)) return {};
    return {
      downloadDocumentId: text(original.id), fileName: text(original.fileName), mimeType: text(original.mimeType), sizeBytes: number(original.sizeBytes),
    };
  };
  const deliveryDocuments: DocumentItem[] = [...originalsByAggregate.values()]
    .filter((original) => text(original.aggregateType) === 'shipment' && text(original.kind) === 'delivery_statement')
    .map((original) => {
      const shipment = rawShipments.find((candidate) => text(candidate.id) === text(original.aggregateId));
      const order = shipment ? orderFor(orders, text(shipment.orderId)) : undefined;
      if (!shipment || !order || order.grossAmount === null) throw new Error('bootstrap delivery statement source mismatch');
      const store = stores.get(text(shipment.storeId)) ?? currentStore;
      return {
        id: `delivery-statement:${text(original.id)}`, type: 'delivery_statement' as const,
        title: `${text(store.name, '매장')} 거래명세서`, period: text(shipment.plannedDate, text(original.createdAt).slice(0, 10)),
        amount: order.grossAmount, status: 'issued' as const, downloadDocumentId: text(original.id),
        fileName: text(original.fileName), mimeType: text(original.mimeType), sizeBytes: number(original.sizeBytes),
      };
    });
  const documents: DocumentItem[] = [
    ...settlements.map((settlement) => ({ id: settlement.id, type: 'monthly_statement' as const, title: `${formatPeriod(settlement.periodEnd)} 월 정산서`, period: `${settlement.periodStart}–${settlement.periodEnd}`, amount: settlement.grossAmount, status: settlement.status === 'locked' ? 'issued' as const : 'scheduled' as const, ...(settlement.status === 'locked' ? originalMetadata('settlement', settlement.id, settlement.version) : {}) })),
    ...invoices.map((invoice) => ({ id: invoice.id, type: invoice.sameBusinessNumber ? 'internal_statement' as const : 'tax_invoice' as const, title: `${invoice.period} ${invoice.issueType === 'modified' ? '수정 전자세금계산서' : invoice.sameBusinessNumber ? '내부거래 명세서' : '전자세금계산서'}`, period: invoice.dueDate, amount: invoice.grossAmount, status: invoice.sameBusinessNumber && ['issued', 'nts_success'].includes(invoice.status) ? 'internal_statement' as const : invoice.status, ...originalMetadata('tax_invoice', invoice.id) })),
    ...paymentRequests.map((request) => ({ id: request.id, type: 'payment_request' as const, title: '결제 요청', period: `납부기한 ${request.dueDate}`, amount: request.amount, status: request.status === 'paid' ? 'paid' as const : 'pending' as const, ...originalMetadata('payment_request', request.id) })),
    ...deliveryDocuments,
  ];
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((value): value is string => typeof value === 'string') : Object.entries(record(raw.capabilities)).filter(([, enabled]) => enabled === true).map(([capability]) => capability);
  const allowedDeliveryDates = Array.isArray(raw.allowedDeliveryDates) ? raw.allowedDeliveryDates.filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) : [];
  const routeDates = Array.isArray(raw.routeDates) ? raw.routeDates.filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) : [];
  return {
    actor: { id: text(actor.id), name: text(actor.name), role: text(actor.role) },
    availableActors: array(raw.availableActors).map((item) => ({ id: text(item.id), name: text(item.name), role: text(item.role) })),
    drivers,
    stores: rawStores.filter((store) => Boolean(text(store.id))).map((store) => ({ id: text(store.id), name: text(store.name, '매장'),
      ...(store.storeKind === '직영' || store.storeKind === '가맹' ? { storeKind: store.storeKind } : {}),
      ...(text(store.code) ? { code: text(store.code) } : {}),
      ...(text(store.region) ? { region: text(store.region) } : {}),
      ...(text(store.roadAddress) ? { roadAddress: text(store.roadAddress) } : {}),
      ...(text(store.notificationPhone) ? { notificationPhone: text(store.notificationPhone) } : {}),
      ...(typeof store.openDate === 'string' ? { openDate: store.openDate } : {}),
      ...(typeof store.active === 'boolean' ? { active: store.active } : {}),
      ...(typeof store.version === 'number' ? { version: store.version } : {}) })),
    store: {
      id: text(currentStore.id), name: text(currentStore.name), businessName: text(business.legalName, text(currentStore.name)),
      billingPolicy: text(currentStore.billingCycle) === 'per_delivery' ? '배송 건별' : text(currentStore.billingCycle) === 'monthly' ? '월 합산' : '확인 필요',
      paymentTerm: text(currentStore.paymentMethod) === 'prepaid' ? '선결제' : text(currentStore.paymentMethod) === 'monthly_credit' ? '월 외상' : '확인 필요',
    },
    products, orders, deliveries, bankMatches, paymentRequests, bankTransactions, manualMatchCandidates, settlements, invoices, documents,
    capabilities,
    allowedDeliveryDates,
    routeDates,
    meta: {
      apiVersion: text(meta.apiVersion, 'v2'), appMode: text(meta.appMode), providerMode: text(meta.providerMode), externalIssueEnabled: Boolean(meta.externalIssueEnabled),
      ...(text(meta.operationalDate) ? { operationalDate: text(meta.operationalDate) } : {}),
      ...(text(meta.timeZone) ? { timeZone: text(meta.timeZone) } : {}),
    },
    generatedAt: text(meta.generatedAt),
    supportEmail: text(record(raw.headquarters).email),
  };
}

function orderFor(orders: Order[], id: string) { return orders.find((order) => order.id === id); }
function actorName(actors: Dict[], id: string) { return text(actors.find((actor) => text(actor.id) === id)?.name, id || '담당자 미등록'); }
function formatPeriod(value: string) { const match = value.match(/^(\d{4})-(\d{2})/); return match ? `${match[1]}년 ${Number(match[2])}월` : '정산 기간'; }
function formatApiDate(value: string) { if (!value) return '시간 미상'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }

export function isAllowedApiAppMode(appMode: string, devMode = !import.meta.env.PROD, allowTestApi = import.meta.env.VITE_ALLOW_TEST_API === 'true') {
  return appMode === 'production' || (devMode && allowTestApi && appMode === 'test');
}

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
    if (!isAllowedApiAppMode(data.meta.appMode)) {
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
  return apiRequest<T>(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey,
      'X-OFD': '1',
    },
    body: JSON.stringify(body),
  }, true);
}

async function apiRequest<T>(path: string, init: RequestInit, allowStepUp: boolean, observedGeneration = stepUpGeneration): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api/v2'}${path}`, { credentials: 'same-origin', ...init });
  if (response.ok) {
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
  const error = await apiErrorFrom(response);
  if (allowStepUp && error.code === 'STEP_UP_REQUIRED') {
    if (stepUpGeneration === observedGeneration) {
      if (!stepUpRequester) throw error;
      await stepUpRequester();
      if (stepUpGeneration === observedGeneration) stepUpGeneration += 1;
    }
    return apiRequest<T>(path, init, false, stepUpGeneration);
  }
  throw error;
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
  return apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OFD': '1' }, body: JSON.stringify(body) }, false);
}

/* ── POS·현장 운영 (V1 이식) ── */
export type PosReportUnit = 'day' | 'week' | 'month';
export type PosReportMix = { key: string; name: string; productId: string | null; qty: number; amount: number; stores: Array<{ storeId: string; qty: number; amount: number }> };
export type PosReportRow = { bucket: string; label: string; perStore: Record<string, { qty: number; amount: number }>; total: { qty: number; amount: number }; mix: PosReportMix[] };
export type PosReportResult = { unit: PosReportUnit; rows: PosReportRow[]; storeIds: string[] };
export type PosProduct = { id: string; sku: string; name: string; category: string; storeId: string | null; consumerPrice: number | null };
export type PosDeviation = { productId: string; productName: string; storeId: string; consumerPrice: number; avgSoldPrice: number; deviationPct: number };
export type PosUnmatched = { storeId: string; rawName: string; qty: number; amount: number; suggestion: { productId: string; productName: string; similarity: number } | null };
export type PosWasteItem = { productId: string; productName: string; received: number | null; sold: number; waste: number | null; over: number; wasteRatePct: number | null; lossAmount: number | null };
export type PosWasteResult = { storeId: string; date: string; hasReceipt: boolean; hasPos: boolean; items: PosWasteItem[]; totals: { received: number | null; sold: number; waste: number | null; wasteRatePct: number | null; lossAmount: number | null } };
export type OpeningTask = { id: string; phase: string; group: string; title: string; detail: string; owner: 'hq' | 'pt' | 'both'; dayOffset: number; deadline: string; done: boolean; doneAt: string | null; memo: string; overdue: boolean; custom: boolean };
export type OpeningSummary = { id: string; name: string; region: string | null; openDate: string; mode: string; storeType: string; stage: string; storeId: string | null; memo: string; total: number; done: number; overdue: number; progressPct: number; dDay: number; phases: Record<string, { total: number; done: number }> };
export type OpeningDetail = OpeningSummary & { tasks: OpeningTask[] };
export type OpeningBoard = { openings: OpeningSummary[]; board: Record<string, OpeningSummary[]>; kpi: { active: number; overdue: number; within30Days: number } };

function getV2<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'GET', headers: { Accept: 'application/json' } }, true);
}
const query = (params: Record<string, string | undefined>) =>
  Object.entries(params).filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join('&');

export function loadMonthlySettlementV2(month: string) {
  return getV2<MonthlySettlementSummary>(`/settlements/monthly?${query({ month })}`);
}
export function loadPosReport(from: string, to: string, unit: PosReportUnit, stores: string[] = [], products: string[] = []) {
  return getV2<PosReportResult>(`/pos/report?${query({ from, to, unit, stores: stores.join(',') || undefined, products: products.join(',') || undefined })}`);
}
export function loadPosProducts(from: string, to: string) {
  return getV2<{ products: PosProduct[]; deviations: PosDeviation[] }>(`/pos/products?${query({ from, to })}`);
}
export function loadPosUnmatched(from: string, to: string) {
  return getV2<{ items: PosUnmatched[] }>(`/pos/unmatched?${query({ from, to })}`);
}
export function loadPosWaste(storeId: string, date: string) {
  return getV2<PosWasteResult>(`/pos/waste?${query({ storeId, date })}`);
}
export function loadPosLinks() {
  return getV2<{ links: Array<{ id: string; storeId: string; merchantId: string; status: string; lastSyncAt: string | null }> }>('/pos/links');
}

/** 매장 POS에 앱이 설치되면 웹훅으로 자동 수집된, 아직 매장 미연결 merchantId 목록 */
export function loadPosDiscovered() {
  return getV2<{ merchants: Array<{ merchantId: string; eventType: string; lastSeenAt: string }> }>('/pos/discovered');
}
export function syncPosV2(from: string, to: string, idempotencyKey: string) {
  return mutateV2<{ from: string; to: string; results: Array<{ merchantId: string; rows: number; status: string; error?: string }> }>('/pos/sync', { from, to }, { idempotencyKey });
}
export function createPosAliasV2(rawName: string, productId: string, idempotencyKey: string) {
  return mutateV2<{ aliasId: string; scopeStoreId: string | null; relinked: number }>('/pos/aliases', { rawName, productId }, { idempotencyKey });
}
export function createPosProductV2(input: { name: string; category: string; storeId: string | null; consumerPrice: number | null; rawName?: string }, idempotencyKey: string) {
  return mutateV2<{ product: PosProduct }>('/pos/products', input, { idempotencyKey });
}

export function updatePosProductV2(id: string, patch: { category?: string; storeId?: string | null; consumerPrice?: number | null }) {
  return jsonRequest<{ product: PosProduct }>(`/pos/products/${encodeURIComponent(id)}`, 'PATCH', patch);
}
export function createPosStoreV2(input: { name: string; code?: string; billingCycle: string; paymentMethod: string; notificationPhone?: string; storeKind?: string }, idempotencyKey: string) {
  return mutateV2<{ store: { id: string; code: string; name: string } }>('/pos/stores', input, { idempotencyKey });
}
export function createPosLinkV2(input: { storeId: string; merchantId: string; accessKey: string; secretKey: string }, idempotencyKey: string) {
  return mutateV2<{ id: string; storeId: string; merchantId: string; status: string }>('/pos/links', input, { idempotencyKey });
}
/* ── 현장 운영 (매장 대장·가맹 영업·감사·공지) ── */
export type StoreLedgerRow = {
  id: string; code: string; name: string; storeKind?: '직영' | '가맹'; region?: string; roadAddress?: string;
  notificationPhone: string; openDate?: string | null; active: boolean; version: number;
};
export type FranchiseLead = {
  id: string; name: string; phone: string; area: string; storeName: string; stage: number;
  docDate: string | null; advisor: boolean; openTarget: string; memo: string; flag: boolean;
  storeId: string | null; version: number;
  cooling: { has: boolean; days?: number; gate?: string; ok?: boolean };
};
export type AuditRow = {
  id: string; aggregateType: string; aggregateId: string; action: string; actorId: string; actorRole: string;
  storeId?: string; metadata: Record<string, unknown>; occurredAt: string;
};
export type NoticeRow = { id: string; date: string; title: string; body: string; pinned: boolean };

function jsonRequest<T>(path: string, method: 'PATCH' | 'PUT' | 'DELETE', body?: Record<string, unknown>) {
  return apiRequest<T>(path, {
    method, headers: { 'Content-Type': 'application/json', 'X-OFD': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, true);
}

export function updatePosStoreV2(id: string, patch: Record<string, unknown>) {
  return jsonRequest<{ store: StoreLedgerRow; changed: string[] }>(`/pos/stores/${encodeURIComponent(id)}`, 'PATCH', patch);
}
export function loadNaverMapKeyV2() { return getV2<{ keyId: string | null }>('/pos/config/navermap'); }
export function saveNaverMapKeyV2(keyId: string) { return jsonRequest<{ keyId: string }>('/pos/config/navermap', 'PUT', { keyId }); }

export function loadLeadsV2() { return getV2<{ stages: string[]; leads: FranchiseLead[] }>('/leads'); }
export function createLeadV2(input: Record<string, unknown>, idempotencyKey: string) {
  return mutateV2<{ lead: FranchiseLead }>('/leads', input, { idempotencyKey });
}
export function updateLeadV2(id: string, patch: Record<string, unknown>) {
  return jsonRequest<{ lead: FranchiseLead }>(`/leads/${encodeURIComponent(id)}`, 'PATCH', patch);
}
export function moveLeadStageV2(id: string, dir: 'next' | 'back', override: boolean, idempotencyKey: string) {
  return mutateV2<{ lead: FranchiseLead; createdStoreId?: string }>(`/leads/${encodeURIComponent(id)}/stage`,
    { dir, ...(override ? { override: true } : {}) }, { idempotencyKey });
}
export function deleteLeadV2(id: string) { return jsonRequest<{ ok: boolean }>(`/leads/${encodeURIComponent(id)}`, 'DELETE'); }

export function searchAuditV2(input: { q?: string; from?: string; to?: string; noSched?: boolean; page?: number; limit?: number }) {
  return getV2<{ rows: AuditRow[]; total: number }>(`/audit?${query({
    q: input.q, from: input.from, to: input.to,
    noSched: input.noSched ? '1' : undefined,
    page: String(input.page ?? 1), limit: String(input.limit ?? 50),
  })}`);
}

export function loadNoticesV2() { return getV2<{ notices: NoticeRow[] }>('/notices'); }
export function createNoticeV2(input: { title: string; body?: string; pinned?: boolean }, idempotencyKey: string) {
  return mutateV2<{ notice: NoticeRow }>('/notices', input, { idempotencyKey });
}
export function deleteNoticeV2(id: string) { return jsonRequest<{ ok: boolean }>(`/notices/${encodeURIComponent(id)}`, 'DELETE'); }

export function loadOpeningsV2() { return getV2<OpeningBoard>('/openings'); }
export function loadOpeningV2(id: string) { return getV2<OpeningDetail>(`/openings/${encodeURIComponent(id)}`); }
export function createOpeningV2(input: { name: string; region: string | null; openDate: string; mode: string; storeType: string; stage: string }, idempotencyKey: string) {
  return mutateV2<OpeningDetail>('/openings', input, { idempotencyKey });
}
export function patchOpeningV2(id: string, body: Record<string, unknown>) {
  return apiRequest<OpeningSummary>(`/openings/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-OFD': '1' }, body: JSON.stringify(body) }, true);
}
export function toggleOpeningTaskV2(taskId: string, done: boolean, memo?: string) {
  return apiRequest<{ ok: boolean }>(`/openings/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-OFD': '1' }, body: JSON.stringify(memo === undefined ? { done } : { done, memo }) }, true);
}

export function logoutV2() { return authPost<Record<string, unknown>>('/auth/logout', {}); }

export type LoginResult = { authenticated: boolean; mfaRequired: boolean; challengeToken?: string; actor: PublicActor };
export function loginV2(email: string, password: string) { return authPost<LoginResult>('/auth/login', { email, password }); }
export function completeMfaV2(challengeToken: string, code: string) {
  return authPost<{ authenticated: true; actor: PublicActor }>('/auth/mfa', { challengeToken, code });
}
export function stepUpV2(password: string, code: string) {
  return authPost<{ authenticated: true; mfaVerifiedAt: string; actor: PublicActor }>('/auth/step-up', { password, code });
}

export type ProvisionActorInput = {
  name: string;
  role: ProvisionableActorRole;
  storeIds: string[];
  email: string;
  password: string;
  mfaSecret?: string;
};

export function listActorAccountsV2() {
  return apiRequest<{ actors: AdminActorSummary[] }>('/admin/actors', { method: 'GET', headers: { Accept: 'application/json' } }, true);
}

export function provisionActorV2(input: ProvisionActorInput, idempotencyKey: string) {
  return apiRequest<{ actor: AdminActorSummary }>('/admin/actors', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-OFD': '1' }, body: JSON.stringify(input),
  }, true);
}

export function deactivateActorV2(actorId: string, expectedVersion: number, idempotencyKey: string) {
  return apiRequest<{ actor: AdminActorSummary }>('/admin/actors', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-OFD': '1' },
    body: JSON.stringify({ action: 'deactivate', actorId, expectedVersion }),
  }, true);
}

export function resetActorV2(actorId: string, expectedVersion: number, newPassword: string, mfaSecret: string | undefined, idempotencyKey: string) {
  return apiRequest<{ actor: AdminActorSummary }>('/admin/actors', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-OFD': '1' },
    body: JSON.stringify({ action: 'reset', actorId, expectedVersion, newPassword, ...(mfaSecret ? { mfaSecret } : {}) }),
  }, true);
}

export type DraftSettlementInput = { storeId: string; periodStart: string; periodEnd: string; receiptIds?: string[] };
export type AutoMatchResult = { paid: Array<Record<string, unknown>>; manualReview: Array<Record<string, unknown>>; unmatched: number };
export type BankSyncResult = { queued: true; from: string; to: string };
export type DocumentDownloadResult = {
  document: {
    id: string; storeId: string; kind: string; aggregateType: string; aggregateId: string; sourceVersion: number;
    fileName: string; mimeType: string; sizeBytes: number; createdAt: string;
  };
  downloadUrl: string;
  expiresInSeconds: number;
};

export async function autoMatchPaymentsV2(idempotencyKey: string): Promise<AutoMatchResult> {
  const payload = record(await mutateV2<unknown>('/payments/auto-match', {}, { idempotencyKey }));
  if (!Array.isArray(payload.paid) || !payload.paid.every((item) => Boolean(item) && typeof item === 'object')
    || !Array.isArray(payload.manualReview) || !payload.manualReview.every((item) => Boolean(item) && typeof item === 'object')
    || !Number.isInteger(payload.unmatched) || number(payload.unmatched, -1) < 0) {
    throw new Error('auto-match response contract mismatch: paid/manualReview must be arrays and unmatched must be a non-negative integer');
  }
  return { paid: payload.paid as Array<Record<string, unknown>>, manualReview: payload.manualReview as Array<Record<string, unknown>>, unmatched: payload.unmatched as number };
}

export function requestBankSyncV2(from: string, to: string, idempotencyKey: string) {
  return mutateV2<BankSyncResult>('/bank-sync', { from, to }, { idempotencyKey });
}

export function manualMatchPaymentV2(paymentRequestId: string, bankTransactionId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ paymentRequest: unknown }>(`/payments/${encodeURIComponent(paymentRequestId)}/manual-match`, { expectedVersion, bankTransactionId }, { idempotencyKey });
}

export function reversePaymentMatchV2(paymentRequestId: string, expectedVersion: number, reason: string, idempotencyKey: string) {
  return mutateV2<{ paymentRequest: unknown }>(`/payments/${encodeURIComponent(paymentRequestId)}/reverse-match`, { expectedVersion, reason }, { idempotencyKey });
}

export function draftSettlementV2(input: DraftSettlementInput, idempotencyKey: string) {
  return mutateV2<{ settlement: unknown }>('/settlements', input, { idempotencyKey });
}

export function reviewSettlementV2(settlementId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ settlement: unknown }>(`/settlements/${encodeURIComponent(settlementId)}/review`, { expectedVersion }, { idempotencyKey });
}

export function approveSettlementV2(settlementId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ settlement: unknown }>(`/settlements/${encodeURIComponent(settlementId)}/approve`, { expectedVersion }, { idempotencyKey });
}

export function draftInvoiceV2(settlementId: string, idempotencyKey: string) {
  return mutateV2<{ invoice: unknown }>('/invoices', { settlementId }, { idempotencyKey });
}

export function reviewInvoiceV2(invoiceId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ invoice: unknown }>(`/invoices/${encodeURIComponent(invoiceId)}/review`, { expectedVersion }, { idempotencyKey });
}

export function modifyInvoiceV2(invoiceId: string, reasonCode: ModificationReasonCode, idempotencyKey: string) {
  return mutateV2<{ invoice: unknown }>(`/invoices/${encodeURIComponent(invoiceId)}/modify`, { reasonCode }, { idempotencyKey });
}

export function approveInvoiceV2(invoiceId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ invoice: unknown }>(`/invoices/${encodeURIComponent(invoiceId)}/approve`, { expectedVersion }, { idempotencyKey });
}

export function retryInvoiceV2(invoiceId: string, expectedVersion: number, idempotencyKey: string) {
  return mutateV2<{ invoice: unknown }>(`/invoices/${encodeURIComponent(invoiceId)}/retry`, { expectedVersion }, { idempotencyKey });
}

export function getDocumentDownloadV2(documentId: string) {
  return apiRequest<DocumentDownloadResult>(`/documents/${encodeURIComponent(documentId)}/download`, { method: 'GET', headers: { Accept: 'application/json' } }, true);
}
