import { randomUUID } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import {
  assertInvoiceApprovalSegregation,
  assertInvoiceEligible,
  assertLegalModifiedInvoice,
  assertInvoiceTransition,
  assertOrderTransition,
  assertPaymentTransition,
  assertRecentStepUp,
  assertRole,
  assertSettlementTransition,
  assertSettlementPaymentSatisfied,
  assertShipmentTransition,
  assertStoreScope,
  assertVersion,
  ACCESS_PAGES,
  buildInvoiceLineParts,
  calculateLineGross,
  capabilitiesForPages,
  defaultPagesForRole,
  selectablePagesForRole,
  DomainError,
  invoiceIssueType,
  isPaymentMatchCandidate,
  invariant,
  nextInvoiceDeadline,
  nextPaymentDeadline,
  popbillManagementKey,
  splitVatInclusive,
  type Actor,
  type AdminInvariant,
  type BankTransaction,
  type DeliveryWindow,
  type DriverDeliveryCompletion,
  type DeliveryUploadSession,
  type GoodsReceipt,
  type HolidayCalendar,
  type LegalEntitySnapshot,
  type OriginalDocument,
  type OriginalDocumentMetadata,
  type PaymentRequest,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Settlement,
  type Shipment,
  type Store,
  type TaxInvoice,
} from "@ofd/domain";
import type { ObjectStorage } from "@ofd/integrations";
import { audit, outbox } from "./events.ts";

/** 계정 유형별·계정별 페이지 노출 정책(싱글턴 애그리게이트). */
export interface AccessPolicyDocument {
  id: "access-policy";
  version: number;
  rolePages: Partial<Record<Actor["role"], string[]>>;
  actorPages: Record<string, string[]>;
  /** 메뉴 노출 순서(경로 배열). 비어 있으면 카탈로그 기본 순서를 쓴다. */
  menuOrder?: string[];
}
export const ACCESS_POLICY_ID = "access-policy";
const ACCESS_POLICY_SYSTEM_SCOPE = "__system__";

interface CreateOrderInput {
  storeId: string;
  requestedDeliveryDate: string;
  note?: string | undefined;
  items: Array<{ productId: string; quantity: number }>;
}

interface ResubmitOrderInput extends CreateOrderInput {
  expectedVersion: number;
}

interface DeliveryInput {
  expectedVersion: number;
  photoKey: string;
  recipientName: string;
  note?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
}

export class ProcurementService {
  constructor(
    private readonly repository: StateRepository,
    private readonly storage: ObjectStorage,
    private readonly appMode: "demo" | "test" | "production",
    private readonly approvedBankAccountId = "ofd-main",
    private readonly providerMode: "mock" | "production" = "mock",
    private readonly externalIssueEnabled = false,
    private readonly now: () => Date = () => new Date(),
    private readonly holidayCalendar: HolidayCalendar = () => false,
  ) {}

  withRepository(repository: StateRepository): ProcurementService {
    return new ProcurementService(repository, this.storage, this.appMode, this.approvedBankAccountId, this.providerMode,
      this.externalIssueEnabled, this.now, this.holidayCalendar);
  }

  async bootstrap(actor: Actor): Promise<Record<string, unknown>> {
    const accessPolicy = await this.loadAccessPolicy();
    const isStoreActor = actor.role === "store_owner" || actor.role === "store_staff";
    const isDriver = actor.role === "driver";
    const storeScope = isStoreActor ? actor.storeIds : undefined;
    const today = operationalDateKst(this.now());
    let stores = await this.repository.list<Store>("store", storeScope);
    let orders = await this.repository.list<PurchaseOrder>("order", storeScope);
    let shipments = await this.repository.list<Shipment>("shipment", storeScope);
    // Scope and operational-day filtering happens before related DTOs or proof URLs are constructed.
    if (isDriver) {
      shipments = shipments.filter((shipment) => shipment.driverId === actor.id && shipment.plannedDate === today)
        .sort((left, right) => (left.routeSequence ?? Number.MAX_SAFE_INTEGER) - (right.routeSequence ?? Number.MAX_SAFE_INTEGER));
    }
    let receipts = isDriver ? [] : await this.repository.list<GoodsReceipt>("receipt", storeScope);
    const canSeeFinance = isStoreActor || actor.role === "hq_finance" || actor.role === "hq_master" || actor.role === "auditor";
    let paymentRequests = canSeeFinance ? await this.repository.list<PaymentRequest>("payment_request", storeScope) : [];
    let settlements = canSeeFinance ? await this.repository.list<Settlement>("settlement", storeScope) : [];
    let taxInvoices = canSeeFinance ? await this.repository.list<TaxInvoice>("tax_invoice", storeScope) : [];
    let documents = canSeeFinance ? await this.repository.list<OriginalDocument>("document", storeScope) : [];
    let products = isDriver ? [] : await this.repository.list<Product>("product");
    const hqEntities = await this.repository.list<LegalEntitySnapshot & { id: string; isHeadquarters: boolean }>("legal_entity");
    const headquarters = hqEntities.find((entity) => entity.isHeadquarters);
    invariant(headquarters, "HQ_BUSINESS_MISSING", "본사 사업자 정보가 없습니다.", 503);
    const bankTransactions = actor.role === "hq_finance" || actor.role === "hq_master" || actor.role === "auditor"
      ? await this.repository.list<BankTransaction>("bank_transaction") : [];
    const auditEvents = actor.role === "hq_master" || actor.role === "auditor" ? await this.repository.listAudit(30) : [];
    const allActors = await this.repository.list<Actor>("actor");
    const availableActors = this.appMode !== "production" && !isDriver ? allActors.map(publicActorDto) : [];
    const driverDirectory = actor.role === "hq_ops" || actor.role === "hq_master"
      ? allActors.filter((candidate) => candidate.role === "driver" && candidate.active)
        .map(({ id, name }) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, "ko"))
      : [];
    if (isDriver) {
      const orderIds = new Set(shipments.map((shipment) => shipment.orderId));
      orders = orders.filter((order) => orderIds.has(order.id));
      const storeIds = new Set(shipments.map((shipment) => shipment.storeId));
      stores = stores.filter((store) => storeIds.has(store.id));
      receipts = [];
      paymentRequests = [];
      settlements = [];
      taxInvoices = [];
      documents = [];
      products = [];
    }
    const canSeeMakerChecker = actor.role === "hq_finance" || actor.role === "hq_master";
    const makerCheckerIds = new Set<string>();
    if (canSeeMakerChecker) {
      for (const settlement of settlements) {
        if (settlement.reviewedBy) makerCheckerIds.add(settlement.reviewedBy);
        if (settlement.approvedBy) makerCheckerIds.add(settlement.approvedBy);
      }
      for (const invoice of taxInvoices) {
        makerCheckerIds.add(invoice.preparedBy);
        if (invoice.reviewedBy) makerCheckerIds.add(invoice.reviewedBy);
        if (invoice.approvedBy) makerCheckerIds.add(invoice.approvedBy);
      }
    }
    const actorDirectory = canSeeMakerChecker
      ? allActors.filter((candidate) => makerCheckerIds.has(candidate.id)).map(({ id, name }) => ({ id, name }))
        .sort((left, right) => left.name.localeCompare(right.name, "ko"))
      : [];
    const routeDates = actor.role === "hq_ops" || actor.role === "hq_master"
      ? [today, ...[...new Set(shipments.map((shipment) => shipment.plannedDate).filter((date) => date !== today))].sort()]
      : [];
    const metrics = {
      ordersAwaitingApproval: orders.filter((order) => order.status === "submitted").length,
      deliveriesToday: shipments.filter((shipment) => shipment.plannedDate === today && shipment.status !== "delivered").length,
      paymentsNeedReview: paymentRequests.filter((request) => request.status === "manual_review").length,
      invoicesNeedApproval: taxInvoices.filter((invoice) => invoice.status === "reviewed").length,
      openReceivables: paymentRequests.filter((request) => !["paid", "reversed", "cancelled"].includes(request.status)).reduce((sum, request) => sum + request.amount, 0),
    };
    const manualMatchCandidates = actor.role === "hq_finance"
      ? paymentRequests.filter((paymentRequest) => isPaymentMatchCandidate(paymentRequest.status)).flatMap((paymentRequest) => bankTransactions
        .filter((transaction) => !transaction.matched && transaction.direction === "credit" && transaction.accountId === this.approvedBankAccountId
          && transaction.amount === paymentRequest.amount)
        .map((transaction) => ({ paymentRequestId: paymentRequest.id, bankTransactionId: transaction.id,
          storeId: paymentRequest.storeId, amount: paymentRequest.amount, requestVersion: paymentRequest.version,
          occurredAt: transaction.occurredAt, depositorMemo: transaction.memo,
          depositorReferenceMatched: normalizeName(transaction.memo).includes(normalizeName(paymentRequest.depositorHint)),
          inAutomaticWindow: inAutomaticMatchWindow(paymentRequest, transaction) }))) : [];
    const shipmentViews = isDriver ? shipments.map((shipment) => {
      const order = orders.find((candidate) => candidate.id === shipment.orderId);
      const store = stores.find((candidate) => candidate.id === shipment.storeId);
      invariant(order && store, "DRIVER_ROUTE_DATA_MISSING", "배송 경로 정보를 불러올 수 없습니다.", 503);
      const items = shipment.lines.map((shipmentLine) => {
        const orderLine = order.lines.find((candidate) => candidate.id === shipmentLine.orderLineId);
        invariant(orderLine, "DRIVER_ROUTE_ITEM_MISSING", "배송 상품 정보를 불러올 수 없습니다.", 503);
        return { name: orderLine.snapshot.name, unit: orderLine.snapshot.unit, quantity: shipmentLine.quantity };
      });
      return {
        id: shipment.id, status: shipment.status, plannedDate: shipment.plannedDate,
        routeSequence: shipment.routeSequence, deliveryWindow: shipment.deliveryWindow, version: shipment.version,
        destination: { name: store.name, address: store.business.address, phone: store.notificationPhone },
        items, deliveryNote: order.note,
        ...(shipment.proof ? { proof: { recipientName: shipment.proof.recipientName, capturedAt: shipment.proof.capturedAt } } : {}),
      };
    }) : await Promise.all(shipments.map(async (shipment) => {
      if (!shipment.proof) return shipment;
      const { photoObjectKey, objectVersionId, ...proofMetadata } = shipment.proof;
      return { ...shipment, proof: proofMetadata, proofUrl: await this.storage.createReadUrl(photoObjectKey, objectVersionId) };
    }));
    return {
      meta: { apiVersion: "v2", appMode: this.appMode, providerMode: this.providerMode,
        externalIssueEnabled: this.externalIssueEnabled, generatedAt: this.now().toISOString(),
        operationalDate: today, timeZone: "Asia/Seoul" },
      capabilities: capabilitiesFor(actor, accessPolicy),
      menuOrder: accessPolicy.menuOrder ?? [],
      allowedDeliveryDates: allowedDeliveryDates(this.now()),
      currentActor: publicActorDto(actor),
      availableActors,
      driverDirectory,
      actorDirectory,
      routeDates,
      headquarters: isDriver ? null : headquarters,
      stores: isDriver ? [] : stores,
      products,
      orders: isDriver ? [] : orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      shipments: shipmentViews,
      receipts,
      paymentRequests,
      bankTransactions,
      manualMatchCandidates,
      settlements,
      taxInvoices,
      documents: documents.map(documentMetadataDto),
      auditEvents,
      metrics,
    };
  }

  /** 저장된 페이지 노출 정책을 읽는다(없으면 기본 정책). */
  async loadAccessPolicy(): Promise<AccessPolicyDocument> {
    const stored = await this.repository.get<AccessPolicyDocument>("access_policy", ACCESS_POLICY_ID);
    return stored ?? { id: ACCESS_POLICY_ID, version: 0, rolePages: {}, actorPages: {}, menuOrder: [] };
  }

  /** GET 계정 관리 > 접근 설정: 정책 + 각 역할의 기본 페이지 + 계정별 유효 페이지를 함께 내린다. */
  async getAccessSettings(actor: Actor): Promise<Record<string, unknown>> {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
    const policy = await this.loadAccessPolicy();
    const actors = (await this.repository.list<Actor>("actor")).filter((candidate) => candidate.role !== "system");
    const roleDefaults = Object.fromEntries((["store_owner", "store_staff", "driver", "hq_ops", "hq_finance", "hq_master", "auditor"] as Actor["role"][])
      .map((role) => [role, defaultPagesForRole(role, baseCapabilitiesFor(role))]));
    return {
      pages: ACCESS_PAGES.map(({ path, label, domain }) => ({ path, label, domain })),
      roleDefaults,
      rolePages: policy.rolePages,
      actorPages: policy.actorPages,
      actorEffectivePages: Object.fromEntries(actors.map((candidate) => [candidate.id, resolveVisiblePages(candidate, policy)])),
      menuOrder: policy.menuOrder ?? [],
    };
  }

  /** 역할 또는 계정의 노출 페이지를 저장한다. pages=null이면 기본값(역할)/역할 상속(계정)으로 되돌린다. */
  async updateAccessPolicy(actor: Actor, target: { role?: Actor["role"]; actorId?: string }, pages: string[] | null): Promise<{ policy: AccessPolicyDocument }> {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
    const current = await this.loadAccessPolicy();
    const nextRolePages: AccessPolicyDocument["rolePages"] = { ...current.rolePages };
    const nextActorPages: AccessPolicyDocument["actorPages"] = { ...current.actorPages };

    if (target.role !== undefined) {
      invariant(target.role !== "system", "INVALID_ACCESS_TARGET", "시스템 계정 유형은 설정할 수 없습니다.", 422);
      if (pages === null) delete nextRolePages[target.role];
      else nextRolePages[target.role] = sanitizePages(target.role, pages);
    } else if (target.actorId !== undefined) {
      const targetActor = await this.repository.get<Actor>("actor", target.actorId);
      invariant(targetActor && targetActor.role !== "system", "ACTOR_NOT_FOUND", "계정을 찾을 수 없습니다.", 404);
      if (pages === null) delete nextActorPages[target.actorId];
      else nextActorPages[target.actorId] = sanitizePages(targetActor!.role, pages);
    } else {
      throw new DomainError("INVALID_ACCESS_TARGET", "role 또는 actorId가 필요합니다.", 422);
    }

    const next: AccessPolicyDocument = { id: ACCESS_POLICY_ID, version: current.version + 1,
      rolePages: nextRolePages, actorPages: nextActorPages, menuOrder: current.menuOrder ?? [] };
    await this.repository.commit({
      changes: [{ type: "access_policy", id: ACCESS_POLICY_ID, storeId: ACCESS_POLICY_SYSTEM_SCOPE,
        expectedVersion: current.version === 0 ? null : current.version, value: next }],
      audits: [audit(actor, "access_policy", ACCESS_POLICY_ID, "admin.access_policy_updated", undefined, undefined, undefined,
        { target: target.role ? { role: target.role } : { actorId: target.actorId }, pages: pages ?? "reset" })],
    });
    return { policy: next };
  }

  /** 메뉴 노출 순서를 저장한다(마스터 전용). 카탈로그에 없는 경로는 버린다. */
  async updateMenuOrder(actor: Actor, order: string[]): Promise<{ menuOrder: string[] }> {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
    const known = new Set(ACCESS_PAGES.map((page) => page.path));
    const menuOrder = [...new Set(order)].filter((path) => known.has(path));
    const current = await this.loadAccessPolicy();
    const next: AccessPolicyDocument = { ...current, id: ACCESS_POLICY_ID, version: current.version + 1, menuOrder };
    await this.repository.commit({
      changes: [{ type: "access_policy", id: ACCESS_POLICY_ID, storeId: ACCESS_POLICY_SYSTEM_SCOPE,
        expectedVersion: current.version === 0 ? null : current.version, value: next }],
      audits: [audit(actor, "access_policy", ACCESS_POLICY_ID, "admin.menu_order_updated", undefined, undefined, undefined,
        { count: menuOrder.length })],
    });
    return { menuOrder };
  }

  async createOrder(actor: Actor, input: CreateOrderInput): Promise<{ order: PurchaseOrder }> {
    assertRole(actor, ["store_owner", "store_staff"]);
    assertStoreScope(actor, input.storeId);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(input.requestedDeliveryDate), "INVALID_DELIVERY_DATE", "희망 배송일이 올바르지 않습니다.");
    invariant(allowedDeliveryDates(this.now()).includes(input.requestedDeliveryDate), "DELIVERY_DATE_NOT_ALLOWED", "선택 가능한 배송일을 다시 확인해 주세요.");
    const store = await this.required<Store>("store", input.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    invariant(store.active, "STORE_INACTIVE", "운영 중인 매장만 발주할 수 있습니다.", 409);
    const { lines, vat } = await this.priceOrderItems(input.items);
    const now = new Date().toISOString();
    const order: PurchaseOrder = {
      id: randomUUID(), number: makeNumber("PO"), storeId: input.storeId, status: "draft", source: "native",
      requestedDeliveryDate: input.requestedDeliveryDate, note: input.note?.trim().slice(0, 500) ?? "", lines,
      gross: vat.gross, supply: vat.supply, vat: vat.vat, createdBy: actor.id, createdAt: now, updatedAt: now, version: 1,
    };
    await this.repository.commit({
      changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order }],
      audits: [audit(actor, "order", order.id, "order.created", order.storeId, undefined, order)],
    });
    return { order };
  }

  async createSubmittedOrder(actor: Actor, input: CreateOrderInput): Promise<{ order: PurchaseOrder }> {
    const created = await this.createOrder(actor, input);
    return this.submitOrder(actor, created.order.id, created.order.version);
  }

  async submitOrder(actor: Actor, orderId: string, expectedVersion: number): Promise<{ order: PurchaseOrder }> {
    const order = await this.orderForActor(actor, orderId);
    assertRole(actor, ["store_owner", "store_staff"]);
    assertVersion(order.version, expectedVersion);
    assertOrderTransition(order.status, "submitted");
    this.assertNative(order);
    const updated = { ...order, status: "submitted" as const, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: order.version + 1 };
    await this.repository.commit({
      changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "order", order.id, "order.submitted", order.storeId, order, updated)],
      outbox: [outbox("order.submitted", order.id, { orderId: order.id, storeId: order.storeId, orderNumber: order.number })],
    });
    return { order: updated };
  }

  async requestOrderChange(actor: Actor, orderId: string, expectedVersion: number, reason: string): Promise<{ order: PurchaseOrder }> {
    assertRole(actor, ["hq_ops"]);
    invariant(reason.trim().length >= 3, "REASON_REQUIRED", "변경 요청 사유를 3자 이상 입력해 주세요.");
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    assertVersion(order.version, expectedVersion);
    assertOrderTransition(order.status, "change_requested");
    this.assertNative(order);
    const requestedAt = this.now().toISOString();
    const updated = { ...order, status: "change_requested" as const, changeRequest: {
      reason: reason.trim(), requestedBy: actor.id, requestedAt,
    }, updatedAt: requestedAt, version: order.version + 1 };
    await this.repository.commit({
      changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "order", order.id, "order.change_requested", order.storeId, order, updated, { reason })],
      outbox: [outbox("order.change_requested", order.id, { orderId: order.id, storeId: order.storeId, reason })],
    });
    return { order: updated };
  }

  async resubmitOrder(actor: Actor, orderId: string, input: Omit<ResubmitOrderInput, "storeId">): Promise<{ order: PurchaseOrder }> {
    assertRole(actor, ["store_owner", "store_staff"]);
    const order = await this.orderForActor(actor, orderId);
    assertVersion(order.version, input.expectedVersion);
    assertOrderTransition(order.status, "submitted");
    this.assertNative(order);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(input.requestedDeliveryDate), "INVALID_DELIVERY_DATE", "희망 배송일이 올바르지 않습니다.");
    invariant(allowedDeliveryDates(this.now()).includes(input.requestedDeliveryDate), "DELIVERY_DATE_NOT_ALLOWED", "선택 가능한 배송일을 다시 확인해 주세요.");
    const store = await this.required<Store>("store", order.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    invariant(store.active, "STORE_INACTIVE", "운영 중인 매장만 발주할 수 있습니다.", 409);
    const { lines, vat } = await this.priceOrderItems(input.items);
    const now = this.now().toISOString();
    const { changeRequest: addressedChangeRequest, ...orderWithoutChangeRequest } = order;
    const updated: PurchaseOrder = {
      ...orderWithoutChangeRequest, status: "submitted", requestedDeliveryDate: input.requestedDeliveryDate,
      note: input.note?.trim().slice(0, 500) ?? "", lines,
      gross: vat.gross, supply: vat.supply, vat: vat.vat,
      submittedAt: now, updatedAt: now, version: order.version + 1,
    };
    await this.repository.commit({
      changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: input.expectedVersion, value: updated }],
      audits: [audit(actor, "order", order.id, "order.resubmitted", order.storeId, order, updated,
        { addressedChangeRequest })],
      outbox: [outbox("order.resubmitted", order.id, { orderId: order.id, storeId: order.storeId, orderNumber: order.number })],
    });
    return { order: updated };
  }

  async cancelOrder(actor: Actor, orderId: string, expectedVersion: number, reason: string): Promise<{ order: PurchaseOrder; paymentRequest?: PaymentRequest }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).cancelOrderLocked(actor, orderId, expectedVersion, reason));
  }

  private async cancelOrderLocked(actor: Actor, orderId: string, expectedVersion: number,
    reason: string): Promise<{ order: PurchaseOrder; paymentRequest?: PaymentRequest }> {
    assertRole(actor, ["store_owner", "hq_ops"]);
    invariant(reason.trim().length >= 3, "REASON_REQUIRED", "취소 사유를 3자 이상 입력해 주세요.");
    const order = await this.orderForActor(actor, orderId);
    assertVersion(order.version, expectedVersion);
    assertOrderTransition(order.status, "cancelled");
    this.assertNative(order);
    const shipment = (await this.repository.list<Shipment>("shipment", [order.storeId])).find((item) => item.orderId === order.id);
    invariant(!shipment, "ORDER_FULFILLMENT_STARTED", "이미 배송 처리가 시작된 주문은 취소할 수 없습니다.", 409);
    const paymentRequest = (await this.repository.list<PaymentRequest>("payment_request", [order.storeId])).find((item) => item.orderId === order.id);
    invariant(paymentRequest?.status !== "paid", "PAID_ORDER_CANNOT_CANCEL", "입금 완료 주문은 대사를 먼저 되돌린 뒤 취소해 주세요.", 409);
    const now = this.now().toISOString();
    const updated: PurchaseOrder = {
      ...order, status: "cancelled", cancelledBy: actor.id, cancelledAt: now,
      cancellationReason: reason.trim(), updatedAt: now, version: order.version + 1,
    };
    const changes: Parameters<StateRepository["commit"]>[0]["changes"] = [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion, value: updated },
    ];
    let cancelledPayment: PaymentRequest | undefined;
    if (paymentRequest && paymentRequest.status !== "cancelled") {
      assertPaymentTransition(paymentRequest.status, "cancelled");
      cancelledPayment = { ...paymentRequest, status: "cancelled", version: paymentRequest.version + 1 };
      changes.push({ type: "payment_request", id: paymentRequest.id, storeId: paymentRequest.storeId,
        expectedVersion: paymentRequest.version, value: cancelledPayment });
    }
    await this.repository.commit({
      changes,
      audits: [audit(actor, "order", order.id, "order.cancelled", order.storeId, order, updated, { reason: reason.trim() })],
      outbox: [outbox("order.cancelled", order.id, { orderId: order.id, storeId: order.storeId, reason: reason.trim() })],
    });
    return { order: updated, ...(cancelledPayment ? { paymentRequest: cancelledPayment } : {}) };
  }

  async rejectOrder(actor: Actor, orderId: string, expectedVersion: number, reason: string): Promise<{ order: PurchaseOrder }> {
    assertRole(actor, ["hq_ops"]);
    invariant(reason.trim().length >= 3, "REASON_REQUIRED", "반려 사유를 3자 이상 입력해 주세요.");
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    assertVersion(order.version, expectedVersion);
    assertOrderTransition(order.status, "rejected");
    this.assertNative(order);
    const updated = { ...order, status: "rejected" as const, updatedAt: new Date().toISOString(), version: order.version + 1 };
    await this.repository.commit({
      changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "order", order.id, "order.rejected", order.storeId, order, updated, { reason })],
      outbox: [outbox("order.rejected", order.id, { orderId: order.id, storeId: order.storeId, reason })],
    });
    return { order: updated };
  }

  async approveOrder(actor: Actor, orderId: string, expectedVersion: number): Promise<{ order: PurchaseOrder; paymentRequest?: PaymentRequest }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).approveOrderLocked(actor, orderId, expectedVersion));
  }

  private async approveOrderLocked(actor: Actor, orderId: string,
    expectedVersion: number): Promise<{ order: PurchaseOrder; paymentRequest?: PaymentRequest }> {
    assertRole(actor, ["hq_ops"]);
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    assertVersion(order.version, expectedVersion);
    assertOrderTransition(order.status, "approved");
    this.assertNative(order);
    const now = new Date().toISOString();
    const updated = { ...order, status: "approved" as const, approvedBy: actor.id, approvedAt: now, updatedAt: now, version: order.version + 1 };
    const store = await this.required<Store>("store", order.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    let paymentRequest: PaymentRequest | undefined;
    const changes: Parameters<StateRepository["commit"]>[0]["changes"] = [
      { type: "order", id: order.id, storeId: order.storeId, expectedVersion, value: updated },
    ];
    if (store.paymentMethod === "prepaid") {
      paymentRequest = { id: randomUUID(), storeId: store.id, orderId: order.id, amount: order.gross,
        dueDate: order.requestedDeliveryDate, status: "pending", depositorHint: store.business.representativeName, version: 1, createdAt: now };
      changes.push({ type: "payment_request", id: paymentRequest.id, storeId: store.id, expectedVersion: null, value: paymentRequest });
    }
    await this.repository.commit({
      changes,
      audits: [audit(actor, "order", order.id, "order.approved", order.storeId, order, updated)],
      outbox: [
        outbox("order.approved", order.id, { orderId: order.id, storeId: order.storeId, paymentRequestId: paymentRequest?.id }),
        ...(paymentRequest ? [outbox("payment.requested", paymentRequest.id,
          { paymentRequestId: paymentRequest.id, orderId: order.id, storeId: order.storeId })] : []),
      ],
    });
    return { order: updated, ...(paymentRequest ? { paymentRequest } : {}) };
  }

  async createShipment(actor: Actor, orderId: string, driverId: string, plannedDate: string,
    routeSequence: number, deliveryWindow: DeliveryWindow): Promise<{ shipment: Shipment }> {
    assertRole(actor, ["hq_ops"]);
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    invariant(order.status === "approved", "ORDER_NOT_APPROVED", "승인된 발주서만 배송 배차할 수 있습니다.", 409);
    this.assertNative(order);
    const driver = await this.required<Actor>("actor", driverId, "DRIVER_NOT_FOUND", "배송 기사를 찾을 수 없습니다.");
    invariant(driver.role === "driver", "INVALID_DRIVER", "배송 기사 계정을 선택해야 합니다.");
    invariant(driver.active, "DRIVER_INACTIVE", "비활성화된 배송 기사에게 배정할 수 없습니다.", 409);
    const allShipments = await this.repository.list<Shipment>("shipment");
    const existing = allShipments.find((item) => item.orderId === order.id);
    invariant(!existing, "SHIPMENT_EXISTS", "이미 이 발주서의 배송이 생성되었습니다.", 409);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(plannedDate), "INVALID_DATE", "배송 예정일이 올바르지 않습니다.");
    invariant(isCalendarDate(plannedDate), "INVALID_DATE", "배송 예정일이 올바르지 않습니다.");
    invariant(plannedDate >= operationalDateKst(this.now()), "PAST_OPERATIONAL_DATE", "서울 운영일 기준 과거 날짜에는 배송을 배정할 수 없습니다.", 409);
    invariant(plannedDate === order.requestedDeliveryDate, "SHIPMENT_DATE_MISMATCH",
      "배송 예정일은 승인된 주문의 요청 배송일과 같아야 합니다.", 409);
    invariant(Number.isInteger(routeSequence) && routeSequence >= 1 && routeSequence <= 9_999,
      "INVALID_ROUTE_SEQUENCE", "경로 순번은 1~9,999의 정수여야 합니다.");
    invariant(isDeliveryWindow(deliveryWindow), "INVALID_DELIVERY_WINDOW", "배송 시간은 같은 날의 HH:mm 시작·종료 순서로 입력해 주세요.");
    const shipment: Shipment = {
      id: randomUUID(), number: makeNumber("SHP"), orderId: order.id, storeId: order.storeId, driverId,
      status: "preparing", lines: order.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })),
      plannedDate, routeSequence, deliveryWindow, version: 1,
    };
    const invariantId: AdminInvariant["id"] = `driver-liveness:${driver.id}`;
    const currentInvariant = await this.repository.get<AdminInvariant>("admin_invariant", invariantId);
    const nextInvariant: AdminInvariant = { id: invariantId, version: (currentInvariant?.version ?? 0) + 1 };
    const changes: Parameters<StateRepository["commit"]>[0]["changes"] = [
      { type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: null, value: shipment },
      { type: "admin_invariant", id: invariantId, storeId: "__system__",
        expectedVersion: currentInvariant?.version ?? null, value: nextInvariant },
    ];
    changes.sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
    await this.repository.commit({
      changes,
      audits: [
        audit(actor, "shipment", shipment.id, "shipment.created", shipment.storeId, undefined, shipment),
        audit(actor, "admin_invariant", invariantId, "shipment.driver_assignment_serialized", undefined,
          currentInvariant, nextInvariant, { shipmentId: shipment.id, driverId: driver.id }),
      ],
      outbox: [outbox("shipment.created", shipment.id, { shipmentId: shipment.id, driverId, storeId: shipment.storeId,
        plannedDate, routeSequence, deliveryWindow })],
    });
    return { shipment };
  }

  async dispatchShipment(actor: Actor, shipmentId: string, expectedVersion: number): Promise<{ shipment: Shipment }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).dispatchShipmentLocked(actor, shipmentId, expectedVersion));
  }

  private async dispatchShipmentLocked(actor: Actor, shipmentId: string,
    expectedVersion: number): Promise<{ shipment: Shipment }> {
    assertRole(actor, ["hq_ops"]);
    const shipment = await this.required<Shipment>("shipment", shipmentId, "SHIPMENT_NOT_FOUND", "배송 건을 찾을 수 없습니다.");
    assertVersion(shipment.version, expectedVersion);
    assertShipmentTransition(shipment.status, "out_for_delivery");
    const assignedDriver = shipment.driverId ? await this.repository.get<Actor>("actor", shipment.driverId) : undefined;
    invariant(assignedDriver?.role === "driver" && assignedDriver.active, "DRIVER_INACTIVE",
      "활성 배송 기사에게 배정된 배송만 출발할 수 있습니다.", 409);
    invariant(shipment.plannedDate === operationalDateKst(this.now()), "NOT_OPERATIONAL_DATE",
      "서울 운영일 당일 배송만 출발 처리할 수 있습니다.", 409);
    const order = await this.required<PurchaseOrder>("order", shipment.orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    const store = await this.required<Store>("store", shipment.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    if (store.paymentMethod === "prepaid") {
      const prepayment = (await this.repository.list<PaymentRequest>("payment_request", [store.id])).find((request) => request.orderId === order.id);
      invariant(prepayment?.status === "paid", "PREPAYMENT_REQUIRED", "선불 매장은 입금 확인 후 배송 출발할 수 있습니다.", 409);
    }
    const updated = { ...shipment, status: "out_for_delivery" as const, version: shipment.version + 1 };
    await this.repository.commit({
      changes: [{ type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "shipment", shipment.id, "shipment.dispatched", shipment.storeId, shipment, updated)],
      outbox: [outbox("shipment.dispatched", shipment.id, { shipmentId: shipment.id, driverId: shipment.driverId, storeId: shipment.storeId })],
    });
    return { shipment: updated };
  }

  async createDeliveryUpload(actor: Actor, shipmentId: string, contentType: string): Promise<unknown> {
    assertRole(actor, ["driver"]);
    const shipment = await this.required<Shipment>("shipment", shipmentId, "SHIPMENT_NOT_FOUND", "배송 건을 찾을 수 없습니다.");
    invariant(shipment.driverId === actor.id, "DRIVER_SCOPE_DENIED", "본인에게 배정된 배송만 처리할 수 있습니다.", 403);
    invariant(shipment.status === "out_for_delivery", "SHIPMENT_NOT_OUT", "배송 출발 상태에서만 사진을 등록할 수 있습니다.", 409);
    invariant(shipment.plannedDate === operationalDateKst(this.now()), "NOT_OPERATIONAL_DATE",
      "서울 운영일 당일 배송만 증빙 사진을 등록할 수 있습니다.", 409);
    const ticket = await this.storage.createDeliveryProofUpload(shipmentId, contentType);
    const session: DeliveryUploadSession = {
      id: ticket.objectKey, shipmentId, storeId: shipment.storeId, objectKey: ticket.objectKey,
      contentType: contentType as DeliveryUploadSession["contentType"], issuedTo: actor.id,
      expiresAt: new Date(Date.now() + ticket.expiresInSeconds * 1_000).toISOString(), status: "issued", version: 1,
    };
    await this.repository.commit({
      changes: [{ type: "upload_session", id: session.id, storeId: shipment.storeId, expectedVersion: null, value: session }],
      audits: [audit(actor, "upload_session", session.id, "delivery_upload.issued", shipment.storeId, undefined, session)],
    });
    return { ...ticket, uploadSessionId: session.id };
  }

  async completeDelivery(actor: Actor, shipmentId: string, input: DeliveryInput): Promise<DriverDeliveryCompletion> {
    assertRole(actor, ["driver"]);
    const shipment = await this.required<Shipment>("shipment", shipmentId, "SHIPMENT_NOT_FOUND", "배송 건을 찾을 수 없습니다.");
    invariant(shipment.driverId === actor.id, "DRIVER_SCOPE_DENIED", "본인에게 배정된 배송만 처리할 수 있습니다.", 403);
    invariant(shipment.plannedDate === operationalDateKst(this.now()), "NOT_OPERATIONAL_DATE",
      "서울 운영일 당일 배송만 완료 처리할 수 있습니다.", 409);
    assertVersion(shipment.version, input.expectedVersion);
    assertShipmentTransition(shipment.status, "delivered");
    invariant(input.recipientName.trim().length > 0, "DELIVERY_PROOF_REQUIRED", "수령인 이름이 필요합니다.");
    const uploadSession = await this.required<DeliveryUploadSession>("upload_session", input.photoKey, "UPLOAD_SESSION_NOT_FOUND", "서버가 발급한 업로드 세션이 아닙니다.");
    invariant(uploadSession.shipmentId === shipment.id && uploadSession.issuedTo === actor.id, "PHOTO_SHIPMENT_MISMATCH", "다른 배송 건의 사진은 사용할 수 없습니다.", 409);
    invariant(uploadSession.status === "issued" && new Date(uploadSession.expiresAt) >= new Date(), "UPLOAD_TICKET_INVALID", "업로드 세션이 만료되었거나 이미 사용되었습니다.", 410);
    const verifiedPhoto = await this.storage.verifyDeliveryProof(shipment.id, input.photoKey);
    const order = await this.required<PurchaseOrder>("order", shipment.orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    const now = this.now().toISOString();
    const proof = {
      id: randomUUID(), shipmentId: shipment.id, photoObjectKey: verifiedPhoto.objectKey, objectVersionId: verifiedPhoto.versionId,
      etag: verifiedPhoto.etag, checksumSha256: verifiedPhoto.checksumSha256,
      recipientName: input.recipientName.trim(), note: input.note?.trim().slice(0, 300) ?? "",
      ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
      capturedAt: now, uploadedBy: actor.id,
    };
    const updated: Shipment = { ...shipment, status: "delivered", deliveredAt: now, proof, version: shipment.version + 1 };
    const receipt: GoodsReceipt = {
      id: randomUUID(), shipmentId: shipment.id, orderId: order.id, storeId: shipment.storeId, status: "confirmed",
      confirmedAt: now, confirmedBy: actor.id, gross: order.gross, supply: order.supply, vat: order.vat,
    };
    const completedUpload: DeliveryUploadSession = { ...uploadSession, status: "completed", completedAt: now, version: uploadSession.version + 1 };
    await this.repository.commit({
      changes: [
        { type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: input.expectedVersion, value: updated },
        { type: "receipt", id: receipt.id, storeId: receipt.storeId, expectedVersion: null, value: receipt },
        { type: "upload_session", id: completedUpload.id, storeId: completedUpload.storeId, expectedVersion: uploadSession.version, value: completedUpload },
      ],
      audits: [audit(actor, "shipment", shipment.id, "shipment.delivered_and_received", shipment.storeId, shipment, updated,
        { receiptId: receipt.id, proofId: proof.id })],
      outbox: [outbox("shipment.delivered", shipment.id, { shipmentId: shipment.id, receiptId: receipt.id, orderId: order.id, storeId: shipment.storeId })],
    });
    return {
      shipment: { id: updated.id, status: "delivered", plannedDate: updated.plannedDate, version: updated.version,
        proof: { recipientName: proof.recipientName, capturedAt: proof.capturedAt } },
      receipt: { id: receipt.id, shipmentId: receipt.shipmentId, status: "confirmed", confirmedAt: receipt.confirmedAt },
    };
  }

  async autoMatchPayments(actor: Actor): Promise<{ paid: PaymentRequest[]; manualReview: PaymentRequest[]; unmatched: number }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).autoMatchPaymentsLocked(actor));
  }

  private async autoMatchPaymentsLocked(actor: Actor): Promise<{ paid: PaymentRequest[]; manualReview: PaymentRequest[]; unmatched: number }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const requests = (await this.repository.list<PaymentRequest>("payment_request"))
      .filter((request) => isPaymentMatchCandidate(request.status));
    const transactions = (await this.repository.list<BankTransaction>("bank_transaction"))
      .filter((transaction) => transaction.direction === "credit" && !transaction.matched && transaction.accountId === this.approvedBankAccountId);
    const stores = await this.repository.list<Store>("store");
    const changes: Parameters<StateRepository["commit"]>[0]["changes"] = [];
    const audits: ReturnType<typeof audit>[] = [];
    const events: ReturnType<typeof outbox>[] = [];
    const paid: PaymentRequest[] = [];
    const manualReview: PaymentRequest[] = [];
    const requestEdges = new Map<string, BankTransaction[]>();
    const transactionEdges = new Map<string, PaymentRequest[]>();
    const amountTimeCandidates = new Set<string>();
    for (const current of [...requests].sort((a, b) => a.id.localeCompare(b.id))) {
      const store = stores.find((item) => item.id === current.storeId);
      for (const transaction of [...transactions].sort((a, b) => a.id.localeCompare(b.id))) {
        if (current.amount !== transaction.amount || !inAutomaticMatchWindow(current, transaction)) continue;
        amountTimeCandidates.add(current.id);
        const memo = normalizeName(transaction.memo);
        const depositorReference = normalizeName(current.depositorHint);
        const storeReference = store ? normalizeName(store.name) : "";
        const referenceMatched = (depositorReference.length > 0 && memo.includes(depositorReference))
          || (storeReference.length > 0 && memo.includes(storeReference));
        if (!referenceMatched) continue;
        requestEdges.set(current.id, [...(requestEdges.get(current.id) ?? []), transaction]);
        transactionEdges.set(transaction.id, [...(transactionEdges.get(transaction.id) ?? []), current]);
      }
    }
    const autoRequestIds = new Set<string>();
    const autoTransactionIds = new Set<string>();
    for (const current of [...requests].sort((a, b) => a.id.localeCompare(b.id))) {
      const edges = requestEdges.get(current.id) ?? [];
      if (edges.length === 1 && (transactionEdges.get(edges[0]!.id) ?? []).length === 1) {
        const transaction = edges[0]!;
        assertPaymentTransition(current.status, "paid");
        const updated: PaymentRequest = { ...current, status: "paid", matchedBankTransactionId: transaction.id, version: current.version + 1 };
        const matchedTransaction: BankTransaction = { ...transaction, matched: true, version: transaction.version + 1 };
        changes.push(
          { type: "payment_request", id: updated.id, storeId: updated.storeId, expectedVersion: current.version, value: updated },
          { type: "bank_transaction", id: matchedTransaction.id, expectedVersion: transaction.version, value: matchedTransaction },
        );
        audits.push(audit(actor, "payment_request", updated.id, "payment.auto_matched", updated.storeId, current, updated, { bankTransactionId: transaction.id }));
        events.push(outbox("payment.paid", updated.id, { paymentRequestId: updated.id, storeId: updated.storeId, matchType: "automatic" }));
        paid.push(updated);
        autoRequestIds.add(current.id);
        autoTransactionIds.add(transaction.id);
      }
    }
    for (const current of [...requests].sort((a, b) => a.id.localeCompare(b.id))) {
      if (autoRequestIds.has(current.id) || !amountTimeCandidates.has(current.id)) continue;
      if (current.status === "manual_review") {
        manualReview.push(current);
        continue;
      }
      assertPaymentTransition(current.status, "manual_review");
      const updated: PaymentRequest = { ...current, status: "manual_review", version: current.version + 1 };
      changes.push({ type: "payment_request", id: updated.id, storeId: updated.storeId, expectedVersion: current.version, value: updated });
      audits.push(audit(actor, "payment_request", updated.id, "payment.match_ambiguous", updated.storeId, current, updated,
        { candidateTransactionIds: (requestEdges.get(current.id) ?? []).map((item) => item.id), reason: "not_one_to_one_unique" }));
      manualReview.push(updated);
    }
    if (changes.length > 0) await this.repository.commit({ changes, audits, outbox: events });
    return { paid, manualReview, unmatched: transactions.length - autoTransactionIds.size };
  }

  async manualMatchPayment(actor: Actor, paymentRequestId: string, bankTransactionId: string, expectedVersion: number): Promise<{ paymentRequest: PaymentRequest }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).manualMatchPaymentLocked(actor, paymentRequestId, bankTransactionId, expectedVersion));
  }

  private async manualMatchPaymentLocked(actor: Actor, paymentRequestId: string, bankTransactionId: string,
    expectedVersion: number): Promise<{ paymentRequest: PaymentRequest }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const request = await this.required<PaymentRequest>("payment_request", paymentRequestId, "PAYMENT_NOT_FOUND", "입금 요청을 찾을 수 없습니다.");
    const transaction = await this.required<BankTransaction>("bank_transaction", bankTransactionId, "BANK_TRANSACTION_NOT_FOUND", "입금 내역을 찾을 수 없습니다.");
    assertVersion(request.version, expectedVersion);
    invariant(!transaction.matched && transaction.direction === "credit", "BANK_TRANSACTION_USED", "이미 대사되었거나 출금 거래입니다.", 409);
    invariant(transaction.accountId === this.approvedBankAccountId, "UNAPPROVED_BANK_ACCOUNT", "승인된 수취 계좌의 거래만 대사할 수 있습니다.", 409);
    invariant(request.amount === transaction.amount, "AMOUNT_MISMATCH", "입금 요청 금액과 거래 금액이 다릅니다.", 409);
    invariant(isPaymentMatchCandidate(request.status), "PAYMENT_NOT_MATCHABLE", "대기 또는 수동검토 상태의 결제요청만 매칭할 수 있습니다.", 409);
    assertPaymentTransition(request.status, "paid");
    const updated: PaymentRequest = { ...request, status: "paid", matchedBankTransactionId: transaction.id, version: request.version + 1 };
    const matched: BankTransaction = { ...transaction, matched: true, version: transaction.version + 1 };
    await this.repository.commit({
      changes: [
        { type: "payment_request", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated },
        { type: "bank_transaction", id: matched.id, expectedVersion: transaction.version, value: matched },
      ],
      audits: [audit(actor, "payment_request", updated.id, "payment.manually_matched", updated.storeId, request, updated, { bankTransactionId })],
      outbox: [outbox("payment.paid", updated.id, { paymentRequestId: updated.id, storeId: updated.storeId, matchType: "manual" })],
    });
    return { paymentRequest: updated };
  }

  async reversePaymentMatch(actor: Actor, paymentRequestId: string, expectedVersion: number, reason: string): Promise<{ paymentRequest: PaymentRequest; bankTransaction: BankTransaction }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).reversePaymentMatchLocked(actor, paymentRequestId, expectedVersion, reason));
  }

  private async reversePaymentMatchLocked(actor: Actor, paymentRequestId: string, expectedVersion: number,
    reason: string): Promise<{ paymentRequest: PaymentRequest; bankTransaction: BankTransaction }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    invariant(reason.trim().length >= 3, "REASON_REQUIRED", "대사 취소 사유를 3자 이상 입력해 주세요.");
    const request = await this.required<PaymentRequest>("payment_request", paymentRequestId, "PAYMENT_NOT_FOUND", "입금 요청을 찾을 수 없습니다.");
    assertVersion(request.version, expectedVersion);
    assertPaymentTransition(request.status, "reversed");
    invariant(Boolean(request.matchedBankTransactionId), "MATCHED_TRANSACTION_REQUIRED", "연결된 입금 거래가 없습니다.", 409);
    const transaction = await this.required<BankTransaction>("bank_transaction", request.matchedBankTransactionId!, "BANK_TRANSACTION_NOT_FOUND", "입금 내역을 찾을 수 없습니다.");
    invariant(transaction.matched, "BANK_TRANSACTION_NOT_MATCHED", "이미 대사가 해제된 입금 거래입니다.", 409);
    if (request.orderId) {
      const shipments = (await this.repository.list<Shipment>("shipment", [request.storeId]))
        .filter((shipment) => shipment.orderId === request.orderId);
      invariant(!shipments.some((shipment) => shipment.status === "out_for_delivery" || shipment.status === "delivered"),
        "PAYMENT_REVERSAL_BLOCKED", "이미 출발하거나 배송 완료된 선결제 주문의 입금은 취소할 수 없습니다.", 409);
    }
    if (request.settlementId) {
      const settlement = await this.required<Settlement>("settlement", request.settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
      const invoiceExists = (await this.repository.list<TaxInvoice>("tax_invoice", [request.storeId]))
        .some((invoice) => invoice.settlementId === settlement.id);
      invariant(!["reviewed", "approved", "locked"].includes(settlement.status) && !invoiceExists,
        "PAYMENT_REVERSAL_BLOCKED", "검토·승인·계산서 처리가 시작된 정산의 입금은 취소할 수 없습니다.", 409);
    }
    const { matchedBankTransactionId, ...requestWithoutMatch } = request;
    // The reversal is immutable in audit/outbox history while the operational request becomes matchable again.
    assertPaymentTransition("reversed", "pending");
    const updatedRequest: PaymentRequest = { ...requestWithoutMatch, status: "pending", version: request.version + 1 };
    const updatedTransaction: BankTransaction = { ...transaction, matched: false, version: transaction.version + 1 };
    await this.repository.commit({
      changes: [
        { type: "payment_request", id: request.id, storeId: request.storeId, expectedVersion, value: updatedRequest },
        { type: "bank_transaction", id: transaction.id, expectedVersion: transaction.version, value: updatedTransaction },
      ],
      audits: [
        audit(actor, "payment_request", request.id, "payment.match_reversed", request.storeId, request, updatedRequest,
          { bankTransactionId: matchedBankTransactionId, reason: reason.trim() }),
        audit(actor, "bank_transaction", transaction.id, "bank_transaction.match_reversed", request.storeId, transaction, updatedTransaction,
          { paymentRequestId: request.id, reason: reason.trim() }),
      ],
      outbox: [outbox("payment.reversed", request.id, { paymentRequestId: request.id, bankTransactionId: transaction.id,
        storeId: request.storeId, reason: reason.trim() })],
    });
    return { paymentRequest: updatedRequest, bankTransaction: updatedTransaction };
  }

  async requestBankSync(actor: Actor, from: string, to: string): Promise<{ queued: true; from: string; to: string }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to,
      "INVALID_BANK_SYNC_PERIOD", "계좌조회 기간이 올바르지 않습니다.");
    const start = new Date(`${from}T00:00:00+09:00`);
    const end = new Date(`${to}T23:59:59+09:00`);
    invariant(Number.isFinite(start.valueOf()) && Number.isFinite(end.valueOf()) && end.valueOf() - start.valueOf() < 32 * 86_400_000,
      "BANK_SYNC_PERIOD_TOO_LONG", "Popbill 계좌조회는 한 번에 최대 1개월까지 요청할 수 있습니다.");
    const today = this.now().valueOf();
    invariant(end.valueOf() <= today + 24 * 60 * 60 * 1_000 && start.valueOf() >= today - 94 * 86_400_000,
      "BANK_SYNC_PERIOD_OUT_OF_RANGE", "계좌조회는 오늘부터 최대 3개월 전 범위만 요청할 수 있습니다.");
    const event = outbox("bank.sync.requested", `${from}:${to}`, { from, to, requestedBy: actor.id });
    await this.repository.commit({
      changes: [],
      audits: [audit(actor, "bank_sync", event.id, "bank.sync_requested", undefined, undefined, { from, to })],
      outbox: [event],
    });
    return { queued: true, from, to };
  }

  async draftSettlement(actor: Actor, input: { storeId: string; periodStart: string; periodEnd: string; receiptIds?: string[] | undefined }): Promise<{
    settlement: Settlement; paymentRequest?: PaymentRequest;
  }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).draftSettlementLocked(actor, input));
  }

  private async draftSettlementLocked(actor: Actor,
    input: { storeId: string; periodStart: string; periodEnd: string; receiptIds?: string[] | undefined }): Promise<{
      settlement: Settlement; paymentRequest?: PaymentRequest;
    }> {
    /* 초안 '작성'은 재무·마스터 모두 허용 — 검토(재무)·최종 승인(마스터, 검토자≠승인자) 분리는 그대로다.
     * 재무 계정이 아직 없는 초기 구축 단계에서도 수명주기를 시작할 수 있어야 한다(V1 이식 요구). */
    assertRole(actor, ["hq_finance", "hq_master"]);
    assertRecentStepUp(actor);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) && /^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) && input.periodStart <= input.periodEnd,
      "INVALID_PERIOD", "정산 기간이 올바르지 않습니다.");
    const store = await this.required<Store>("store", input.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    const allReceipts = await this.repository.list<GoodsReceipt>("receipt", [store.id]);
    const usedIds = new Set((await this.repository.list<Settlement>("settlement", [store.id])).flatMap((settlement) => settlement.receiptIds));
    const selected = allReceipts.filter((receipt) => {
      // 정산 기간은 영업일(Asia/Seoul) 기준으로 들어온다. 확정 시각을 UTC로 자르면
      // 00~09시(KST)에 확정된 입고가 전날로 밀려 정산에서 누락된다.
      const date = operationalDateKst(new Date(receipt.confirmedAt));
      return receipt.status === "confirmed" && date >= input.periodStart && date <= input.periodEnd && !usedIds.has(receipt.id)
        && (!input.receiptIds || input.receiptIds.includes(receipt.id));
    });
    invariant(selected.length > 0, "NO_ELIGIBLE_RECEIPTS", "선택 기간에 정산 가능한 확정 입고가 없습니다.", 409);
    if (store.billingCycle === "per_delivery") invariant(selected.length === 1, "PER_DELIVERY_SINGLE_RECEIPT", "건별 정산 매장은 입고 1건씩 정산해야 합니다.", 409);
    for (const receipt of selected) {
      const order = await this.required<PurchaseOrder>("order", receipt.orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
      assertInvoiceEligible(order.source);
    }
    const gross = selected.reduce((sum, receipt) => sum + receipt.gross, 0);
    // 월 합산 세금계산서는 영수증별 세액 단순 합이 아니라 문서 총액 기준으로 다시 100/110 배분한다.
    const documentVat = splitVatInclusive(selected.map((receipt) => ({ id: receipt.id, gross: receipt.gross })));
    const supply = documentVat.supply;
    const vat = documentVat.vat;
    const settlement: Settlement = {
      id: randomUUID(), storeId: store.id, kind: store.billingCycle, periodStart: input.periodStart, periodEnd: input.periodEnd,
      status: "draft", receiptIds: selected.map((receipt) => receipt.id), gross, supply, vat, version: 1,
    };
    const paymentRequest: PaymentRequest | undefined = store.paymentMethod === "monthly_credit" ? {
      id: randomUUID(), storeId: store.id, settlementId: settlement.id, amount: settlement.gross,
      dueDate: nextPaymentDeadline(settlement.periodEnd, this.holidayCalendar), status: "pending",
      depositorHint: store.business.representativeName, version: 1, createdAt: this.now().toISOString(),
    } : undefined;
    await this.repository.commit({
      changes: [
        { type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement },
        ...(paymentRequest ? [{ type: "payment_request" as const, id: paymentRequest.id, storeId: paymentRequest.storeId,
          expectedVersion: null, value: paymentRequest }] : []),
      ],
      audits: [audit(actor, "settlement", settlement.id, "settlement.drafted", settlement.storeId, undefined, settlement)],
      outbox: [outbox("settlement.drafted", settlement.id, { settlementId: settlement.id, storeId: settlement.storeId,
        paymentRequestId: paymentRequest?.id })],
    });
    return { settlement, ...(paymentRequest ? { paymentRequest } : {}) };
  }

  async reviewSettlement(actor: Actor, settlementId: string, expectedVersion: number): Promise<{ settlement: Settlement }> {
    return this.repository.exclusiveTransaction(this.paymentMatchLockKey(), (scoped) =>
      this.withRepository(scoped).reviewSettlementLocked(actor, settlementId, expectedVersion));
  }

  private async reviewSettlementLocked(actor: Actor, settlementId: string,
    expectedVersion: number): Promise<{ settlement: Settlement }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const settlement = await this.required<Settlement>("settlement", settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
    assertVersion(settlement.version, expectedVersion);
    assertSettlementTransition(settlement.status, "reviewed");
    await this.assertSettlementPaymentGate(settlement);
    const updated: Settlement = { ...settlement, status: "reviewed", reviewedBy: actor.id, reviewedAt: this.now().toISOString(), version: settlement.version + 1 };
    await this.repository.commit({
      changes: [{ type: "settlement", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "settlement", updated.id, "settlement.reviewed", updated.storeId, settlement, updated)],
    });
    return { settlement: updated };
  }

  async approveSettlement(actor: Actor, settlementId: string, expectedVersion: number): Promise<{ settlement: Settlement }> {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
    const settlement = await this.required<Settlement>("settlement", settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
    assertVersion(settlement.version, expectedVersion);
    assertSettlementTransition(settlement.status, "approved");
    await this.assertSettlementPaymentGate(settlement);
    invariant(settlement.reviewedBy && settlement.reviewedBy !== actor.id, "SEGREGATION_OF_DUTIES", "검토자와 승인자는 서로 달라야 합니다.", 409);
    const updated: Settlement = { ...settlement, status: "approved", approvedBy: actor.id, approvedAt: this.now().toISOString(), version: settlement.version + 1 };
    await this.repository.commit({
      changes: [{ type: "settlement", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "settlement", updated.id, "settlement.approved", updated.storeId, settlement, updated)],
      outbox: [outbox("settlement.approved", updated.id, { settlementId: updated.id, storeId: updated.storeId })],
    });
    return { settlement: updated };
  }

  async createInvoiceDraft(actor: Actor, settlementId: string): Promise<{ invoice: TaxInvoice; invoices: TaxInvoice[]; deadline: string }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const settlement = await this.required<Settlement>("settlement", settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
    invariant(settlement.status === "approved", "SETTLEMENT_NOT_APPROVED", "승인된 정산서만 증빙을 작성할 수 있습니다.", 409);
    await this.assertSettlementPaymentGate(settlement);
    const existing = (await this.repository.list<TaxInvoice>("tax_invoice", [settlement.storeId])).find((invoice) => invoice.settlementId === settlement.id);
    invariant(!existing, "INVOICE_EXISTS", "이미 이 정산서의 증빙이 생성되었습니다.", 409);
    const store = await this.required<Store>("store", settlement.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    const headquarters = (await this.repository.list<LegalEntitySnapshot & { id: string; isHeadquarters: boolean }>("legal_entity"))
      .find((entity) => entity.isHeadquarters);
    invariant(headquarters, "HQ_BUSINESS_MISSING", "본사 사업자 정보가 없습니다.", 503);
    const receipts = await Promise.all(settlement.receiptIds.map((id) => this.required<GoodsReceipt>("receipt", id, "RECEIPT_NOT_FOUND", "입고확정서를 찾을 수 없습니다.")));
    const parts = buildInvoiceLineParts(receipts.map((receipt) => ({
      id: receipt.id, description: `식자재 공급 ${receipt.confirmedAt.slice(0, 10)}`, quantity: 1, gross: receipt.gross,
    })));
    const invoiceGroupId = randomUUID();
    const dueDate = nextInvoiceDeadline(settlement.periodEnd, this.holidayCalendar);
    const preparedAt = this.now().toISOString();
    const invoices: TaxInvoice[] = parts.map((lines, index) => {
      const id = randomUUID();
      return {
        id, storeId: store.id, settlementId: settlement.id, invoiceGroupId, partNumber: index + 1, partCount: parts.length,
        providerManagementKey: popbillManagementKey(id), issueType: invoiceIssueType(headquarters, store), status: "draft" as const,
        issueDate: settlement.periodEnd, dueDate, supplier: headquarters, recipient: store.business,
        gross: lines.reduce((sum, line) => sum + line.gross, 0), supply: lines.reduce((sum, line) => sum + line.supply, 0),
        vat: lines.reduce((sum, line) => sum + line.vat, 0), preparedBy: actor.id, preparedAt, lines, version: 1,
      };
    });
    await this.repository.commit({
      changes: invoices.map((invoice) => ({ type: "tax_invoice" as const, id: invoice.id, storeId: invoice.storeId, expectedVersion: null, value: invoice })),
      audits: invoices.map((invoice) => audit(actor, "tax_invoice", invoice.id, "invoice.drafted", invoice.storeId, undefined, invoice)),
    });
    return { invoice: invoices[0]!, invoices, deadline: dueDate };
  }

  async reviewInvoice(actor: Actor, invoiceId: string, expectedVersion: number): Promise<{ invoice: TaxInvoice }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId, "INVOICE_NOT_FOUND", "세금계산서를 찾을 수 없습니다.");
    assertVersion(invoice.version, expectedVersion);
    assertInvoiceTransition(invoice.status, "reviewed");
    const updated: TaxInvoice = { ...invoice, status: "reviewed", reviewedBy: actor.id,
      reviewedAt: this.now().toISOString(), version: invoice.version + 1 };
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "tax_invoice", updated.id, "invoice.reviewed", updated.storeId, invoice, updated)],
      outbox: [outbox("invoice.reviewed", updated.id, { invoiceId: updated.id, storeId: updated.storeId })],
    });
    return { invoice: updated };
  }

  async createModifiedInvoice(actor: Actor, originalInvoiceId: string,
    reasonCode: NonNullable<TaxInvoice["modificationReasonCode"]>): Promise<{ invoice: TaxInvoice }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const original = await this.required<TaxInvoice>("tax_invoice", originalInvoiceId, "INVOICE_NOT_FOUND", "원본 세금계산서를 찾을 수 없습니다.");
    invariant(original.status === "nts_success", "ORIGINAL_NOT_NTS_SUCCESS", "국세청 전송 성공 세금계산서만 수정할 수 있습니다.", 409);
    invariant(Boolean(original.serialNumber && /^\d{24}$/.test(original.serialNumber)), "ORIGINAL_NTS_NUMBER_REQUIRED", "원본의 24자리 국세청 승인번호가 필요합니다.", 409);
    invariant(original.issueType !== "internal_statement", "INTERNAL_STATEMENT_ONLY", "내부 거래명세서는 수정세금계산서 대상이 아닙니다.", 409);
    assertLegalModifiedInvoice(original, reasonCode);
    const groupId = randomUUID();
    const id = randomUUID();
    const invoiceBase: TaxInvoice = { ...original };
    delete invoiceBase.reviewedBy;
    delete invoiceBase.reviewedAt;
    delete invoiceBase.approvedBy;
    delete invoiceBase.approvedAt;
    delete invoiceBase.providerReceiptId;
    delete invoiceBase.serialNumber;
    delete invoiceBase.failureReason;
    delete invoiceBase.lastRetriedAt;
    const invoice: TaxInvoice = {
      ...invoiceBase, id, invoiceGroupId: groupId, partNumber: 1, partCount: 1, providerManagementKey: popbillManagementKey(id), issueType: "modified", status: "draft",
      originalInvoiceId: original.id, originalNtsConfirmNumber: original.serialNumber!, modificationReasonCode: reasonCode,
      dueDate: original.dueDate ?? nextInvoiceDeadline(original.issueDate, this.holidayCalendar),
      gross: -original.gross, supply: -original.supply, vat: -original.vat,
      lines: original.lines.map((line) => ({ ...line, id: randomUUID(), gross: -line.gross, supply: -line.supply, vat: -line.vat })),
      preparedBy: actor.id, preparedAt: this.now().toISOString(), retryCount: 0, version: 1,
    };
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: invoice.id, storeId: invoice.storeId, expectedVersion: null, value: invoice }],
      audits: [audit(actor, "tax_invoice", invoice.id, "invoice.modified_drafted", invoice.storeId, undefined, invoice,
        { originalInvoiceId, reasonCode })],
    });
    return { invoice };
  }

  async approveInvoice(actor: Actor, invoiceId: string, expectedVersion: number): Promise<{ invoice: TaxInvoice }> {
    const invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId, "INVOICE_NOT_FOUND", "세금계산서를 찾을 수 없습니다.");
    this.assertExternalInvoiceIssuanceAllowed(invoice);
    assertVersion(invoice.version, expectedVersion);
    assertInvoiceTransition(invoice.status, "approved");
    const settlement = await this.required<Settlement>("settlement", invoice.settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
    await this.assertSettlementPaymentGate(settlement);
    assertInvoiceApprovalSegregation(invoice.reviewedBy, actor);
    const updated: TaxInvoice = { ...invoice, status: "approved", approvedBy: actor.id,
      approvedAt: this.now().toISOString(), version: invoice.version + 1 };
    const topic = invoice.issueType === "internal_statement" ? "statement.generate" : "invoice.issue.requested";
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "tax_invoice", updated.id, "invoice.approved", updated.storeId, invoice, updated)],
      outbox: [outbox(topic, updated.id, { invoiceId: updated.id, settlementId: updated.settlementId, storeId: updated.storeId })],
    });
    return { invoice: updated };
  }

  async retryInvoice(actor: Actor, invoiceId: string, expectedVersion: number): Promise<{ invoice: TaxInvoice }> {
    assertRole(actor, ["hq_finance", "hq_master"]);
    assertRecentStepUp(actor);
    const invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId, "INVOICE_NOT_FOUND", "세금계산서를 찾을 수 없습니다.");
    this.assertExternalInvoiceIssuanceAllowed(invoice);
    assertVersion(invoice.version, expectedVersion);
    invariant(invoice.status === "failed", "INVOICE_NOT_RETRYABLE", "실패 상태의 세금계산서만 재시도할 수 있습니다.", 409);
    assertInvoiceTransition(invoice.status, "queued");
    const previousFailure = invoice.failureReason;
    const withoutProviderFailure: TaxInvoice = { ...invoice };
    delete withoutProviderFailure.failureReason;
    delete withoutProviderFailure.providerReceiptId;
    delete withoutProviderFailure.serialNumber;
    const retriedAt = this.now().toISOString();
    const retryCount = (invoice.retryCount ?? 0) + 1;
    const updated: TaxInvoice = { ...withoutProviderFailure, providerManagementKey: popbillManagementKey(invoice.id, retryCount),
      status: "queued", retryCount, lastRetriedAt: retriedAt, version: invoice.version + 1 };
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "tax_invoice", updated.id, "invoice.retry_requested", updated.storeId, invoice, updated,
        { previousFailure })],
      outbox: [outbox("invoice.retry.requested", updated.id, { invoiceId: updated.id, settlementId: updated.settlementId,
        storeId: updated.storeId, issueType: updated.issueType, retryCount: updated.retryCount })],
    });
    return { invoice: updated };
  }

  async downloadDocument(actor: Actor, documentId: string): Promise<{
    document: OriginalDocumentMetadata; downloadUrl: string; expiresInSeconds: 900;
  }> {
    assertRole(actor, ["store_owner", "store_staff", "hq_finance", "hq_master", "auditor"]);
    const document = await this.required<OriginalDocument>("document", documentId, "DOCUMENT_NOT_FOUND", "문서를 찾을 수 없습니다.");
    assertStoreScope(actor, document.storeId);
    invariant(document.objectKey.length > 0 && document.objectVersionId.length > 0, "DOCUMENT_STORAGE_METADATA_MISSING",
      "문서 원본 저장소 정보가 완전하지 않습니다.", 503);
    return {
      document: documentMetadataDto(document),
      downloadUrl: await this.storage.createReadUrl(document.objectKey, document.objectVersionId),
      expiresInSeconds: 900,
    };
  }

  async receivePopbillWebhook(eventId: string, payload: unknown): Promise<{ accepted: boolean }> {
    invariant(eventId.length > 0, "EVENT_ID_REQUIRED", "Webhook event ID가 필요합니다.");
    const accepted = await this.repository.receiveWebhook({
      provider: "popbill", eventId, payload, status: "received", receivedAt: new Date().toISOString(),
    });
    if (accepted) {
      await this.repository.commit({ changes: [], outbox: [outbox("popbill.webhook.received", eventId, { eventId, payload })] });
    }
    return { accepted };
  }

  async requeueDeadLetter(actor: Actor, eventId: string): Promise<{ event: unknown }> {
    assertRole(actor, ["hq_master"]);
    assertRecentStepUp(actor);
    const event = await this.repository.requeueOutbox(eventId);
    invariant(event, "OUTBOX_EVENT_NOT_FOUND", "재처리 가능한 dead-letter 이벤트를 찾을 수 없습니다.", 404);
    await this.repository.commit({ changes: [], audits: [audit(actor, "outbox", eventId, "outbox.requeued", undefined, undefined, event)] });
    return { event };
  }

  private async orderForActor(actor: Actor, orderId: string): Promise<PurchaseOrder> {
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    assertStoreScope(actor, order.storeId);
    return order;
  }

  private assertNative(order: PurchaseOrder): void {
    invariant(order.source === "native", "LEGACY_READ_ONLY", "이전 시스템에서 이관된 주문은 조회만 할 수 있습니다.", 409);
  }

  private async priceOrderItems(items: Array<{ productId: string; quantity: number }>): Promise<{
    lines: PurchaseOrderLine[];
    vat: ReturnType<typeof splitVatInclusive>;
  }> {
    invariant(items.length > 0 && items.length <= 99, "INVALID_ITEMS", "발주 품목은 1~99개여야 합니다.");
    const seen = new Set<string>();
    for (const item of items) {
      invariant(Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10_000,
        "INVALID_QUANTITY", "발주 수량은 품목별 1~10,000개여야 합니다.");
      invariant(!seen.has(item.productId), "DUPLICATE_PRODUCT", "같은 상품을 중복으로 담을 수 없습니다.");
      seen.add(item.productId);
    }
    const products = await Promise.all(items.map((item) => this.required<Product>("product", item.productId, "PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.")));
    const rawLines = items.map((item, index) => {
      const product = products[index]!;
      return { id: randomUUID(), gross: calculateLineGross(product.unitGross, item.quantity) };
    });
    const vat = splitVatInclusive(rawLines);
    const lines = items.map((item, index): PurchaseOrderLine => {
      const product = products[index]!;
      const line = vat.lines[index]!;
      return {
        id: line.id,
        snapshot: { productId: product.id, sku: product.sku, name: product.name, unit: product.unit,
          unitGross: product.unitGross, taxable: true, taxRate: 10 },
        quantity: item.quantity, gross: line.gross, supply: line.supply, vat: line.vat,
      };
    });
    return { lines, vat };
  }

  private async assertSettlementPaymentGate(settlement: Settlement): Promise<void> {
    const store = await this.required<Store>("store", settlement.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    const request = (await this.repository.list<PaymentRequest>("payment_request", [settlement.storeId]))
      .find((candidate) => candidate.settlementId === settlement.id);
    assertSettlementPaymentSatisfied(store, settlement.id, request);
  }

  private paymentMatchLockKey(): string {
    return `payment-auto-match:${this.approvedBankAccountId}`;
  }

  private assertExternalInvoiceIssuanceAllowed(invoice: TaxInvoice): void {
    if (this.appMode !== "production" || invoice.issueType === "internal_statement") return;
    invariant(this.providerMode === "production" && this.externalIssueEnabled,
      "EXTERNAL_INVOICE_ISSUANCE_DISABLED",
      "운영 환경에서 외부 세금계산서 발행 기능이 활성화되지 않았습니다.", 503);
  }

  private async required<T>(type: Parameters<StateRepository["get"]>[0], id: string, code: string, message: string): Promise<T> {
    const value = await this.repository.get<T>(type, id);
    if (!value) throw new DomainError(code, message, 404);
    return value;
  }
}

function makeNumber(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/[^0-9A-Za-z가-힣]/g, "").toLowerCase();
}

function inAutomaticMatchWindow(request: PaymentRequest, transaction: BankTransaction): boolean {
  const occurred = new Date(transaction.occurredAt).valueOf();
  const earliest = new Date(request.createdAt).valueOf() - 24 * 60 * 60 * 1_000;
  const latest = new Date(`${request.dueDate}T23:59:59.999Z`).valueOf() + 3 * 24 * 60 * 60 * 1_000;
  return Number.isFinite(occurred) && occurred >= earliest && occurred <= latest;
}

export function baseCapabilitiesFor(role: Actor["role"]): string[] {
  const map: Record<Actor["role"], string[]> = {
    store_owner: ["store.orders.read", "store.orders.create", "store.orders.submit", "store.orders.cancel", "store.documents.read"],
    store_staff: ["store.orders.read", "store.orders.create", "store.orders.submit", "store.documents.read"],
    hq_ops: ["hq.orders.read", "hq.orders.approve", "hq.orders.change_request", "hq.shipments.manage", "hq.shipments.dispatch", "hq.drivers.read", "hq.pos.read",
      "hq.stores.manage", "hq.leads.manage", "hq.notices.manage"],
    hq_finance: ["hq.payments.reconcile", "hq.settlements.manage", "hq.settlements.draft", "hq.invoices.read", "hq.invoices.prepare", "hq.invoices.retry", "hq.documents.read", "hq.pos.read", "hq.audit.read"],
    hq_master: ["hq.settlements.approve", "hq.settlements.draft", "hq.invoices.read", "hq.invoices.approve", "hq.invoices.retry", "hq.documents.read",
      "hq.outbox.requeue", "hq.accounts.manage", "hq.actors.manage", "hq.settings.manage", "hq.drivers.read", "hq.pos.read",
      "hq.stores.manage", "hq.leads.manage", "hq.notices.manage", "hq.audit.read"],
    auditor: ["hq.orders.read", "hq.invoices.read", "hq.documents.read", "hq.audit.read", "hq.finance.read"],
    driver: ["driver.deliveries.read", "driver.deliveries.complete"],
    system: [],
  };
  return map[role];
}

/** 계정 유형별·계정별 페이지 노출 정책. capability는 선택된 페이지 묶음으로부터 계산된다. */
export function resolveVisiblePages(actor: Actor, policy?: AccessPolicyDocument): string[] {
  const actorPages = policy?.actorPages?.[actor.id];
  if (actorPages) return actorPages;
  const rolePages = policy?.rolePages?.[actor.role];
  if (rolePages) return rolePages;
  return defaultPagesForRole(actor.role, baseCapabilitiesFor(actor.role));
}

function capabilitiesFor(actor: Actor, policy?: AccessPolicyDocument): string[] {
  if (actor.role === "system") return [];
  return capabilitiesForPages(actor.role, resolveVisiblePages(actor, policy));
}

/** 요청된 페이지 목록을 해당 역할의 영역 안 페이지로만 정제한다(중복·역할 밖 경로 제거). */
function sanitizePages(role: Actor["role"], pages: string[]): string[] {
  const allowed = new Set(selectablePagesForRole(role).map((page) => page.path));
  return [...new Set(pages)].filter((path) => allowed.has(path));
}

function publicActorDto(actor: Actor): Pick<Actor, "id" | "name" | "role" | "storeIds"> {
  return { id: actor.id, name: actor.name, role: actor.role, storeIds: actor.storeIds };
}

function documentMetadataDto(document: OriginalDocument): OriginalDocumentMetadata {
  return {
    id: document.id, storeId: document.storeId, kind: document.kind, aggregateType: document.aggregateType,
    aggregateId: document.aggregateId, sourceVersion: document.sourceVersion, mimeType: document.mimeType,
    fileName: document.fileName, sizeBytes: document.sizeBytes, createdAt: document.createdAt,
  };
}

function operationalDateKst(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function isDeliveryWindow(window: DeliveryWindow): boolean {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return time.test(window.start) && time.test(window.end) && window.start < window.end;
}

function allowedDeliveryDates(now = new Date()): string[] {
  const dates: string[] = [];
  const operationalDate = operationalDateKst(now);
  for (let offset = 1; offset <= 21 && dates.length < 14; offset += 1) {
    const date = new Date(`${operationalDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    if (date.getUTCDay() !== 0) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}
