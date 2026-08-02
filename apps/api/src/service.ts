import { randomUUID } from "node:crypto";
import type { StateRepository } from "@ofd/db";
import {
  assertInvoiceApprovalSegregation,
  assertInvoiceEligible,
  assertInvoiceTransition,
  assertOrderTransition,
  assertPaymentTransition,
  assertRecentStepUp,
  assertRole,
  assertSettlementTransition,
  assertShipmentTransition,
  assertStoreScope,
  assertVersion,
  buildInvoiceLineParts,
  calculateLineGross,
  DomainError,
  invoiceIssueType,
  invariant,
  nextInvoiceDeadline,
  popbillManagementKey,
  splitVatInclusive,
  type Actor,
  type BankTransaction,
  type DeliveryUploadSession,
  type GoodsReceipt,
  type LegalEntitySnapshot,
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

interface CreateOrderInput {
  storeId: string;
  requestedDeliveryDate: string;
  note?: string;
  items: Array<{ productId: string; quantity: number }>;
}

interface ResubmitOrderInput extends CreateOrderInput {
  expectedVersion: number;
}

interface DeliveryInput {
  expectedVersion: number;
  photoKey: string;
  recipientName: string;
  note?: string;
  capturedAt: string;
  latitude?: number;
  longitude?: number;
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
  ) {}

  withRepository(repository: StateRepository): ProcurementService {
    return new ProcurementService(repository, this.storage, this.appMode, this.approvedBankAccountId, this.providerMode, this.externalIssueEnabled, this.now);
  }

  async bootstrap(actor: Actor): Promise<Record<string, unknown>> {
    const storeScope = actor.role.startsWith("store_") ? actor.storeIds : undefined;
    let stores = await this.repository.list<Store>("store", storeScope);
    let orders = await this.repository.list<PurchaseOrder>("order", storeScope);
    let shipments = await this.repository.list<Shipment>("shipment", storeScope);
    if (actor.role === "driver") shipments = shipments.filter((shipment) => shipment.driverId === actor.id);
    let receipts = await this.repository.list<GoodsReceipt>("receipt", storeScope);
    let paymentRequests = await this.repository.list<PaymentRequest>("payment_request", storeScope);
    let settlements = await this.repository.list<Settlement>("settlement", storeScope);
    let taxInvoices = await this.repository.list<TaxInvoice>("tax_invoice", storeScope);
    let products = await this.repository.list<Product>("product");
    const hqEntities = await this.repository.list<LegalEntitySnapshot & { id: string; isHeadquarters: boolean }>("legal_entity");
    const headquarters = hqEntities.find((entity) => entity.isHeadquarters);
    invariant(headquarters, "HQ_BUSINESS_MISSING", "본사 사업자 정보가 없습니다.", 503);
    const canSeeFinance = actor.role === "hq_finance" || actor.role === "hq_master" || actor.role === "auditor";
    const bankTransactions = canSeeFinance ? await this.repository.list<BankTransaction>("bank_transaction") : [];
    const auditEvents = actor.role.startsWith("hq_") || actor.role === "auditor" ? await this.repository.listAudit(30) : [];
    const availableActors = this.appMode !== "production" ? await this.repository.list<Actor>("actor") : [];
    if (actor.role === "driver") {
      const orderIds = new Set(shipments.map((shipment) => shipment.orderId));
      orders = orders.filter((order) => orderIds.has(order.id));
      const storeIds = new Set(shipments.map((shipment) => shipment.storeId));
      stores = stores.filter((store) => storeIds.has(store.id));
      receipts = [];
      paymentRequests = [];
      settlements = [];
      taxInvoices = [];
      products = [];
    }
    const today = new Date().toISOString().slice(0, 10);
    const metrics = {
      ordersAwaitingApproval: orders.filter((order) => order.status === "submitted").length,
      deliveriesToday: shipments.filter((shipment) => shipment.plannedDate === today && shipment.status !== "delivered").length,
      paymentsNeedReview: paymentRequests.filter((request) => request.status === "manual_review").length,
      invoicesNeedApproval: taxInvoices.filter((invoice) => invoice.status === "reviewed").length,
      openReceivables: paymentRequests.filter((request) => !["paid", "reversed", "cancelled"].includes(request.status)).reduce((sum, request) => sum + request.amount, 0),
    };
    const manualMatchCandidates = actor.role === "hq_finance"
      ? paymentRequests.flatMap((paymentRequest) => bankTransactions
        .filter((transaction) => !transaction.matched && transaction.direction === "credit" && transaction.accountId === this.approvedBankAccountId
          && transaction.amount === paymentRequest.amount)
        .map((transaction) => ({ paymentRequestId: paymentRequest.id, bankTransactionId: transaction.id,
          storeId: paymentRequest.storeId, amount: paymentRequest.amount, requestVersion: paymentRequest.version,
          occurredAt: transaction.occurredAt, depositorMemo: transaction.memo,
          depositorReferenceMatched: normalizeName(transaction.memo).includes(normalizeName(paymentRequest.depositorHint)),
          inAutomaticWindow: inAutomaticMatchWindow(paymentRequest, transaction) }))) : [];
    const shipmentViews = await Promise.all(shipments.map(async (shipment) => shipment.proof
      ? { ...shipment, proofUrl: await this.storage.createReadUrl(shipment.proof.photoObjectKey, shipment.proof.objectVersionId) }
      : shipment));
    return {
      meta: { apiVersion: "v2", appMode: this.appMode, providerMode: this.providerMode,
        externalIssueEnabled: this.externalIssueEnabled, generatedAt: new Date().toISOString() },
      capabilities: capabilitiesFor(actor),
      allowedDeliveryDates: allowedDeliveryDates(),
      currentActor: actor,
      availableActors,
      headquarters,
      stores,
      products,
      orders: orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      shipments: shipmentViews,
      receipts,
      paymentRequests,
      bankTransactions,
      manualMatchCandidates,
      settlements,
      taxInvoices,
      auditEvents,
      metrics,
    };
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
    return { order: updated, paymentRequest: cancelledPayment };
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
      outbox: [outbox("order.approved", order.id, { orderId: order.id, storeId: order.storeId, paymentRequestId: paymentRequest?.id })],
    });
    return { order: updated, paymentRequest };
  }

  async createShipment(actor: Actor, orderId: string, driverId: string, plannedDate: string): Promise<{ shipment: Shipment }> {
    assertRole(actor, ["hq_ops"]);
    const order = await this.required<PurchaseOrder>("order", orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    invariant(order.status === "approved", "ORDER_NOT_APPROVED", "승인된 발주서만 배송 배차할 수 있습니다.", 409);
    this.assertNative(order);
    const driver = await this.required<Actor>("actor", driverId, "DRIVER_NOT_FOUND", "배송 기사를 찾을 수 없습니다.");
    invariant(driver.role === "driver", "INVALID_DRIVER", "배송 기사 계정을 선택해야 합니다.");
    const existing = (await this.repository.list<Shipment>("shipment", [order.storeId])).find((item) => item.orderId === order.id);
    invariant(!existing, "SHIPMENT_EXISTS", "이미 이 발주서의 배송이 생성되었습니다.", 409);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(plannedDate), "INVALID_DATE", "배송 예정일이 올바르지 않습니다.");
    const shipment: Shipment = {
      id: randomUUID(), number: makeNumber("SHP"), orderId: order.id, storeId: order.storeId, driverId,
      status: "preparing", lines: order.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })), plannedDate, version: 1,
    };
    await this.repository.commit({
      changes: [{ type: "shipment", id: shipment.id, storeId: shipment.storeId, expectedVersion: null, value: shipment }],
      audits: [audit(actor, "shipment", shipment.id, "shipment.created", shipment.storeId, undefined, shipment)],
      outbox: [outbox("shipment.created", shipment.id, { shipmentId: shipment.id, driverId, storeId: shipment.storeId })],
    });
    return { shipment };
  }

  async dispatchShipment(actor: Actor, shipmentId: string, expectedVersion: number): Promise<{ shipment: Shipment }> {
    assertRole(actor, ["hq_ops"]);
    const shipment = await this.required<Shipment>("shipment", shipmentId, "SHIPMENT_NOT_FOUND", "배송 건을 찾을 수 없습니다.");
    assertVersion(shipment.version, expectedVersion);
    assertShipmentTransition(shipment.status, "out_for_delivery");
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

  async completeDelivery(actor: Actor, shipmentId: string, input: DeliveryInput): Promise<{ shipment: Shipment; receipt: GoodsReceipt; proofUrl: string }> {
    assertRole(actor, ["driver"]);
    const shipment = await this.required<Shipment>("shipment", shipmentId, "SHIPMENT_NOT_FOUND", "배송 건을 찾을 수 없습니다.");
    invariant(shipment.driverId === actor.id, "DRIVER_SCOPE_DENIED", "본인에게 배정된 배송만 처리할 수 있습니다.", 403);
    assertVersion(shipment.version, input.expectedVersion);
    assertShipmentTransition(shipment.status, "delivered");
    invariant(input.recipientName.trim().length > 0, "DELIVERY_PROOF_REQUIRED", "수령인 이름이 필요합니다.");
    invariant(!Number.isNaN(new Date(input.capturedAt).valueOf()), "INVALID_CAPTURE_TIME", "촬영 시간이 올바르지 않습니다.");
    const uploadSession = await this.required<DeliveryUploadSession>("upload_session", input.photoKey, "UPLOAD_SESSION_NOT_FOUND", "서버가 발급한 업로드 세션이 아닙니다.");
    invariant(uploadSession.shipmentId === shipment.id && uploadSession.issuedTo === actor.id, "PHOTO_SHIPMENT_MISMATCH", "다른 배송 건의 사진은 사용할 수 없습니다.", 409);
    invariant(uploadSession.status === "issued" && new Date(uploadSession.expiresAt) >= new Date(), "UPLOAD_TICKET_INVALID", "업로드 세션이 만료되었거나 이미 사용되었습니다.", 410);
    const verifiedPhoto = await this.storage.verifyDeliveryProof(shipment.id, input.photoKey);
    const order = await this.required<PurchaseOrder>("order", shipment.orderId, "ORDER_NOT_FOUND", "발주서를 찾을 수 없습니다.");
    const now = new Date().toISOString();
    const proof = {
      id: randomUUID(), shipmentId: shipment.id, photoObjectKey: verifiedPhoto.objectKey, objectVersionId: verifiedPhoto.versionId,
      etag: verifiedPhoto.etag, checksumSha256: verifiedPhoto.checksumSha256,
      recipientName: input.recipientName.trim(), note: input.note?.trim().slice(0, 300) ?? "", latitude: input.latitude,
      longitude: input.longitude, capturedAt: input.capturedAt, uploadedBy: actor.id,
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
    return { shipment: updated, receipt, proofUrl: await this.storage.createReadUrl(proof.photoObjectKey, proof.objectVersionId) };
  }

  async autoMatchPayments(actor: Actor): Promise<{ paid: PaymentRequest[]; manualReview: PaymentRequest[]; unmatched: number }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const requests = (await this.repository.list<PaymentRequest>("payment_request"))
      .filter((request) => request.status === "pending" || request.status === "matching");
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
        const referenceMatched = memo.includes(normalizeName(current.depositorHint)) || Boolean(store && memo.includes(normalizeName(store.name)));
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
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const request = await this.required<PaymentRequest>("payment_request", paymentRequestId, "PAYMENT_NOT_FOUND", "입금 요청을 찾을 수 없습니다.");
    const transaction = await this.required<BankTransaction>("bank_transaction", bankTransactionId, "BANK_TRANSACTION_NOT_FOUND", "입금 내역을 찾을 수 없습니다.");
    assertVersion(request.version, expectedVersion);
    invariant(!transaction.matched && transaction.direction === "credit", "BANK_TRANSACTION_USED", "이미 대사되었거나 출금 거래입니다.", 409);
    invariant(transaction.accountId === this.approvedBankAccountId, "UNAPPROVED_BANK_ACCOUNT", "승인된 수취 계좌의 거래만 대사할 수 있습니다.", 409);
    invariant(request.amount === transaction.amount, "AMOUNT_MISMATCH", "입금 요청 금액과 거래 금액이 다릅니다.", 409);
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
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    invariant(reason.trim().length >= 3, "REASON_REQUIRED", "대사 취소 사유를 3자 이상 입력해 주세요.");
    const request = await this.required<PaymentRequest>("payment_request", paymentRequestId, "PAYMENT_NOT_FOUND", "입금 요청을 찾을 수 없습니다.");
    assertVersion(request.version, expectedVersion);
    assertPaymentTransition(request.status, "reversed");
    invariant(Boolean(request.matchedBankTransactionId), "MATCHED_TRANSACTION_REQUIRED", "연결된 입금 거래가 없습니다.", 409);
    const transaction = await this.required<BankTransaction>("bank_transaction", request.matchedBankTransactionId!, "BANK_TRANSACTION_NOT_FOUND", "입금 내역을 찾을 수 없습니다.");
    invariant(transaction.matched, "BANK_TRANSACTION_NOT_MATCHED", "이미 대사가 해제된 입금 거래입니다.", 409);
    const { matchedBankTransactionId, ...requestWithoutMatch } = request;
    const updatedRequest: PaymentRequest = { ...requestWithoutMatch, status: "reversed", version: request.version + 1 };
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

  async draftSettlement(actor: Actor, input: { storeId: string; periodStart: string; periodEnd: string; receiptIds?: string[] }): Promise<{ settlement: Settlement }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) && /^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) && input.periodStart <= input.periodEnd,
      "INVALID_PERIOD", "정산 기간이 올바르지 않습니다.");
    const store = await this.required<Store>("store", input.storeId, "STORE_NOT_FOUND", "매장을 찾을 수 없습니다.");
    const allReceipts = await this.repository.list<GoodsReceipt>("receipt", [store.id]);
    const usedIds = new Set((await this.repository.list<Settlement>("settlement", [store.id])).flatMap((settlement) => settlement.receiptIds));
    const selected = allReceipts.filter((receipt) => {
      const date = receipt.confirmedAt.slice(0, 10);
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
      id: randomUUID(), storeId: store.id, periodStart: input.periodStart, periodEnd: input.periodEnd,
      status: "draft", receiptIds: selected.map((receipt) => receipt.id), gross, supply, vat, version: 1,
    };
    await this.repository.commit({
      changes: [{ type: "settlement", id: settlement.id, storeId: settlement.storeId, expectedVersion: null, value: settlement }],
      audits: [audit(actor, "settlement", settlement.id, "settlement.drafted", settlement.storeId, undefined, settlement)],
      outbox: [outbox("settlement.drafted", settlement.id, { settlementId: settlement.id, storeId: settlement.storeId })],
    });
    return { settlement };
  }

  async reviewSettlement(actor: Actor, settlementId: string, expectedVersion: number): Promise<{ settlement: Settlement }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const settlement = await this.required<Settlement>("settlement", settlementId, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");
    assertVersion(settlement.version, expectedVersion);
    assertSettlementTransition(settlement.status, "reviewed");
    const updated: Settlement = { ...settlement, status: "reviewed", reviewedBy: actor.id, reviewedAt: new Date().toISOString(), version: settlement.version + 1 };
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
    invariant(settlement.reviewedBy && settlement.reviewedBy !== actor.id, "SEGREGATION_OF_DUTIES", "검토자와 승인자는 서로 달라야 합니다.", 409);
    const updated: Settlement = { ...settlement, status: "approved", approvedBy: actor.id, approvedAt: new Date().toISOString(), version: settlement.version + 1 };
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
    const invoices: TaxInvoice[] = parts.map((lines, index) => {
      const id = randomUUID();
      return {
        id, storeId: store.id, settlementId: settlement.id, invoiceGroupId, partNumber: index + 1, partCount: parts.length,
        providerManagementKey: popbillManagementKey(id), issueType: invoiceIssueType(headquarters, store), status: "draft" as const,
        issueDate: settlement.periodEnd, supplier: headquarters, recipient: store.business,
        gross: lines.reduce((sum, line) => sum + line.gross, 0), supply: lines.reduce((sum, line) => sum + line.supply, 0),
        vat: lines.reduce((sum, line) => sum + line.vat, 0), preparedBy: actor.id, lines, version: 1,
      };
    });
    await this.repository.commit({
      changes: invoices.map((invoice) => ({ type: "tax_invoice" as const, id: invoice.id, storeId: invoice.storeId, expectedVersion: null, value: invoice })),
      audits: invoices.map((invoice) => audit(actor, "tax_invoice", invoice.id, "invoice.drafted", invoice.storeId, undefined, invoice)),
    });
    return { invoice: invoices[0]!, invoices, deadline: nextInvoiceDeadline(settlement.periodEnd) };
  }

  async reviewInvoice(actor: Actor, invoiceId: string, expectedVersion: number): Promise<{ invoice: TaxInvoice }> {
    assertRole(actor, ["hq_finance"]);
    assertRecentStepUp(actor);
    const invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId, "INVOICE_NOT_FOUND", "세금계산서를 찾을 수 없습니다.");
    assertVersion(invoice.version, expectedVersion);
    assertInvoiceTransition(invoice.status, "reviewed");
    const updated: TaxInvoice = { ...invoice, status: "reviewed", reviewedBy: actor.id, version: invoice.version + 1 };
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
    const groupId = randomUUID();
    const id = randomUUID();
    const invoice: TaxInvoice = {
      ...original, id, invoiceGroupId: groupId, partNumber: 1, partCount: 1, providerManagementKey: popbillManagementKey(id), issueType: "modified", status: "draft",
      originalInvoiceId: original.id, originalNtsConfirmNumber: original.serialNumber!, modificationReasonCode: reasonCode,
      gross: -original.gross, supply: -original.supply, vat: -original.vat,
      lines: original.lines.map((line) => ({ ...line, id: randomUUID(), gross: -line.gross, supply: -line.supply, vat: -line.vat })),
      preparedBy: actor.id, reviewedBy: undefined, approvedBy: undefined, providerReceiptId: undefined, serialNumber: undefined,
      failureReason: undefined, version: 1,
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
    assertVersion(invoice.version, expectedVersion);
    assertInvoiceTransition(invoice.status, "approved");
    assertInvoiceApprovalSegregation(invoice.reviewedBy, actor);
    const updated: TaxInvoice = { ...invoice, status: "approved", approvedBy: actor.id, version: invoice.version + 1 };
    const topic = invoice.issueType === "internal_statement" ? "statement.generate" : "invoice.issue.requested";
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion, value: updated }],
      audits: [audit(actor, "tax_invoice", updated.id, "invoice.approved", updated.storeId, invoice, updated)],
      outbox: [outbox(topic, updated.id, { invoiceId: updated.id, settlementId: updated.settlementId, storeId: updated.storeId })],
    });
    return { invoice: updated };
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

function capabilitiesFor(actor: Actor): string[] {
  const map: Record<Actor["role"], string[]> = {
    store_owner: ["store.orders.read", "store.orders.create", "store.orders.submit", "store.orders.cancel", "store.documents.read"],
    store_staff: ["store.orders.read", "store.orders.create", "store.orders.submit", "store.documents.read"],
    hq_ops: ["hq.orders.read", "hq.orders.approve", "hq.orders.change_request", "hq.shipments.manage", "hq.shipments.dispatch"],
    hq_finance: ["hq.payments.reconcile", "hq.settlements.manage", "hq.invoices.read", "hq.invoices.prepare"],
    hq_master: ["hq.settlements.approve", "hq.invoices.read", "hq.invoices.approve", "hq.outbox.requeue"],
    auditor: ["hq.orders.read", "hq.invoices.read", "hq.audit.read", "hq.finance.read"],
    driver: ["driver.deliveries.read", "driver.deliveries.complete"],
    system: [],
  };
  return map[actor.role];
}

function allowedDeliveryDates(now = new Date()): string[] {
  const dates: string[] = [];
  for (let offset = 1; offset <= 21 && dates.length < 14; offset += 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset);
    if (date.getUTCDay() !== 0) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}
