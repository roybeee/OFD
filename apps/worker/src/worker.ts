import { createHash, randomUUID } from "node:crypto";
import { DEMO_IDS, type AggregateType, type StateRepository } from "@ofd/db";
import { createPosStore, type PosStore } from "@ofd/db";
import { decryptPosSecret, fetchTossDailyItems } from "@ofd/integrations";
import {
  DomainError,
  assertInvoiceTransition,
  assertPaymentTransition,
  assertSettlementTransition,
  nextPaymentDeadline,
  splitVatInclusive,
  type Actor,
  type AuditEvent,
  type BankTransaction,
  type GoodsReceipt,
  type HolidayCalendar,
  type Notification,
  type OriginalDocument,
  type OriginalDocumentAggregateType,
  type OriginalDocumentKind,
  type OutboxEvent,
  type PaymentRequest,
  type PurchaseOrder,
  type Settlement,
  type Shipment,
  type Store,
  type TaxInvoice,
} from "@ofd/domain";
import {
  MockObjectStorage,
  type EmailProvider,
  type ObjectStorage,
  type PopbillProvider,
  type ProviderConfig,
  type TaxInvoiceIssueResult,
  type TaxInvoiceOriginalDocument,
} from "@ofd/integrations";

const systemActor: Actor = {
  id: DEMO_IDS.system,
  name: "OFD 자동화",
  role: "system",
  storeIds: [],
  active: true,
  authVersion: 1,
  mfaVerified: true,
  mfaVerifiedAt: new Date().toISOString(),
};

export class OfdWorker {
  constructor(
    private readonly repository: StateRepository,
    private readonly popbill: PopbillProvider,
    private readonly email: EmailProvider,
    private readonly config: ProviderConfig,
    private readonly storage: ObjectStorage = new MockObjectStorage(config.uploadMaxBytes),
    private readonly holidayCalendar: HolidayCalendar = () => false,
    private readonly workerId = `worker-${process.pid}`,
    private readonly maxAttempts = 12,
    private readonly outboxLeaseMs = 10 * 60_000,
    private readonly providerTimeoutMs = 30_000,
    private readonly heartbeatTtlMs = 60_000,
  ) {}

  async processOnce(limit = 20): Promise<{ claimed: number; completed: number; failed: number; fenced: number }> {
    const events = await this.repository.claimOutbox(limit, this.workerId, this.maxAttempts, this.outboxLeaseMs);
    let completed = 0;
    let failed = 0;
    let fenced = 0;
    for (const event of events) {
      if (!event.leaseToken) {
        fenced += 1;
        continue;
      }
      try {
        await this.handle(event);
        if (await this.repository.completeOutbox(event.id, this.workerId, event.leaseToken, undefined, this.maxAttempts)) completed += 1;
        else fenced += 1;
      } catch (error) {
        const completionAccepted = await this.repository.completeOutbox(event.id, this.workerId, event.leaseToken,
          error instanceof Error ? error.message : String(error), this.maxAttempts);
        if (!completionAccepted) {
          fenced += 1;
          continue;
        }
        if (event.attempts >= this.maxAttempts) {
          await this.repository.commit({ changes: [], audits: [this.audit("outbox", event.id, "outbox.dead_lettered", undefined, event, undefined)] });
        }
        failed += 1;
      }
    }
    return { claimed: events.length, completed, failed, fenced };
  }

  async heartbeat(state: "running" | "stopping" = "running", now = new Date()): Promise<void> {
    await this.repository.recordWorkerHeartbeat({
      workerId: this.workerId,
      state,
      observedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.valueOf() + this.heartbeatTtlMs).toISOString(),
    });
  }

  async runScheduled(now = new Date()): Promise<void> {
    const seoul = seoulCalendar(now);
    const priorMonth = new Date(Date.UTC(seoul.year, seoul.month - 2, 1));
    const closeYear = priorMonth.getUTCFullYear();
    const closeMonth = priorMonth.getUTCMonth() + 1;
    const closePeriod = `${closeYear}-${String(closeMonth).padStart(2, "0")}`;
    await this.enqueueScheduledEvent(`monthly-close:${closePeriod}`, "settlement.monthly_close.requested",
      { year: closeYear, month: closeMonth }, now);
    const bankSyncReady = this.config.appMode === "production"
      ? this.config.providerMode === "production" && this.config.bankSyncEnabled
      : this.config.providerMode === "mock" || this.config.bankSyncEnabled;
    if (bankSyncReady) {
      await this.enqueueScheduledEvent(`bank-sync:${seoul.date}`, "bank.sync.requested",
        { from: seoul.date, to: seoul.date, schedule: true }, now);
    }
    const minute = now.toISOString().slice(0, 16);
    if (now.getUTCMinutes() % 5 === 0) {
      await this.enqueueScheduledEvent(`invoice-reconcile:${minute}`, "invoice.reconcile.requested", { schedule: true }, now);
    }
    if (now.getUTCMinutes() % 30 === 0) { /* V1 30분 주기 POS 수집 이식 */
      const slot = `${seoul.date}:${String(now.getUTCHours()).padStart(2, "0")}${now.getUTCMinutes() === 0 ? "00" : "30"}`;
      await this.enqueueScheduledEvent(`pos-sync:${slot}`, "pos.sync.requested", { date: seoul.date, schedule: true }, now);
    }
  }

  private async handle(event: OutboxEvent): Promise<void> {
    switch (event.topic) {
      case "invoice.issue.requested":
      case "invoice.retry.requested":
        await this.issueTaxInvoice(String((event.payload as { invoiceId?: string }).invoiceId ?? event.aggregateId));
        return;
      case "invoice.reconcile.requested":
        await this.reconcilePendingInvoices((event.payload as { invoiceId?: string }).invoiceId);
        return;
      case "statement.generate":
        await this.issueInternalStatement(String((event.payload as { invoiceId?: string }).invoiceId ?? event.aggregateId));
        return;
      case "settlement.monthly_close.requested": {
        const payload = event.payload as { year?: number; month?: number };
        if (!Number.isInteger(payload.year) || !Number.isInteger(payload.month) || payload.month! < 1 || payload.month! > 12) {
          throw new Error("monthly close period missing");
        }
        await this.createMonthlySettlementDrafts(payload.year!, payload.month!);
        return;
      }
      case "shipment.delivered":
        await this.handleDelivered(event);
        return;
      case "bank.sync.requested": {
        const payload = event.payload as { from?: string; to?: string };
        if (!payload.from || !payload.to) throw new Error("bank sync period missing");
        await this.syncBankTransactions(payload.from, payload.to);
        return;
      }
      case "popbill.webhook.received": {
        const wrapper = event.payload as { payload?: PopbillWebhookEnvelope };
        await this.applyPopbillWebhook(wrapper.payload ?? (event.payload as PopbillWebhookEnvelope));
        return;
      }
      case "settlement.drafted":
        await this.handleSettlementDrafted(event);
        return;
      case "payment.requested":
        await this.persistPaymentRequestOriginal(await this.required<PaymentRequest>("payment_request",
          String((event.payload as { paymentRequestId?: string }).paymentRequestId ?? event.aggregateId)));
        return;
      case "pos.sync.requested": {
        await this.runPosSync((event.payload as { date?: string }).date);
        return;
      }
      case "order.submitted":
      case "order.approved": {
        const paymentRequestId = (event.payload as { paymentRequestId?: string }).paymentRequestId;
        if (paymentRequestId) await this.persistPaymentRequestOriginal(await this.required<PaymentRequest>("payment_request", paymentRequestId));
        await this.sendStoreNotifications(event);
        return;
      }
      case "order.change_requested":
      case "order.resubmitted":
      case "order.cancelled":
      case "order.rejected":
      case "shipment.created":
      case "shipment.dispatched":
      case "payment.paid":
      case "payment.reversed":
      case "settlement.approved":
      case "invoice.reviewed":
        await this.sendStoreNotifications(event);
        return;
      default:
        return;
    }
  }

  private async issueTaxInvoice(invoiceId: string): Promise<void> {
    let invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId);
    if (invoice.issueType === "internal_statement") {
      await this.issueInternalStatement(invoice.id);
      return;
    }
    this.assertTaxInvoiceProviderReady();
    if (invoice.status === "nts_success") {
      await this.persistTaxInvoiceOriginal(invoice);
      await this.lockSettlementIfInvoiceGroupComplete(invoice);
      return;
    }
    if (invoice.status === "nts_pending" || invoice.status === "issued") {
      await this.reconcileInvoice(invoice);
      return;
    }
    if (invoice.status === "failed") {
      invoice = await this.updateInvoice({
        ...invoice,
        retryCount: (invoice.retryCount ?? 0) + 1,
        lastRetriedAt: new Date().toISOString(),
      }, "queued", "invoice.requeued");
    }
    if (invoice.status === "approved") invoice = await this.updateInvoice(invoice, "queued", "invoice.queued");
    if (invoice.status !== "queued") throw new Error(`invoice ${invoice.id} is ${invoice.status}`);

    try {
      const result = await this.providerCall("Popbill tax invoice issue", this.popbill.issueTaxInvoice(invoice), "POPBILL_OUTCOME_UNKNOWN");
      invoice = await this.updateInvoice({
        ...invoice,
        providerReceiptId: result.receiptId,
        ...(result.serialNumber ? { serialNumber: result.serialNumber } : {}),
      }, "issued", "invoice.issued");
      invoice = await this.updateInvoice(invoice, "nts_pending", "invoice.nts_pending");
      await this.persistTaxInvoiceOriginal(invoice);
      await this.applyProviderTerminalStatus(invoice, result, "issue");
    } catch (error) {
      const latest = await this.required<TaxInvoice>("tax_invoice", invoice.id);
      const outcomeUnknown = (error as { code?: string }).code === "POPBILL_OUTCOME_UNKNOWN";
      if (!outcomeUnknown && (latest.status === "queued" || latest.status === "issued")) {
        await this.updateInvoice({ ...latest, failureReason: error instanceof Error ? error.message : String(error) }, "failed", "invoice.failed");
      }
      throw error;
    }
  }

  private async reconcilePendingInvoices(invoiceId?: string): Promise<void> {
    const invoices = invoiceId
      ? [await this.required<TaxInvoice>("tax_invoice", invoiceId)]
      : (await this.repository.list<TaxInvoice>("tax_invoice")).filter((invoice) =>
          invoice.issueType !== "internal_statement" && ["queued", "issued", "nts_pending", "nts_success"].includes(invoice.status));
    for (const invoice of invoices) await this.reconcileInvoice(invoice);
  }

  private async reconcileInvoice(current: TaxInvoice): Promise<void> {
    let invoice = current;
    if (invoice.issueType === "internal_statement") return;
    this.assertTaxInvoiceProviderReady();
    if (invoice.status === "nts_success") {
      await this.persistTaxInvoiceOriginal(invoice);
      await this.lockSettlementIfInvoiceGroupComplete(invoice);
      return;
    }
    const result = await this.providerCall("Popbill tax invoice status", this.popbill.getTaxInvoiceStatus(invoice));
    if (!result) return;
    if (invoice.status === "queued") {
      invoice = await this.updateInvoice({
        ...invoice,
        providerReceiptId: result.receiptId,
        ...(result.serialNumber ? { serialNumber: result.serialNumber } : {}),
      }, "issued", "invoice.reconciled_issued");
    }
    if (invoice.status === "issued") invoice = await this.updateInvoice(invoice, "nts_pending", "invoice.nts_pending");
    if (invoice.status !== "nts_pending") return;
    await this.persistTaxInvoiceOriginal(invoice);
    await this.applyProviderTerminalStatus(invoice, result, "reconcile");
  }

  private async applyProviderTerminalStatus(invoice: TaxInvoice, result: TaxInvoiceIssueResult, source: string): Promise<void> {
    if (invoice.status !== "nts_pending" || result.ntsStatus === "pending") return;
    const status: TaxInvoice["status"] = result.ntsStatus === "success" ? "nts_success"
      : result.ntsStatus === "cancelled" ? "cancelled" : "failed";
    const updated = await this.updateInvoice({
      ...invoice,
      providerReceiptId: result.receiptId,
      ...(result.serialNumber ? { serialNumber: result.serialNumber } : {}),
      ...(status === "failed" ? { failureReason: `${source}: NTS transmission failed` } : {}),
    }, status, status === "nts_success" ? "invoice.nts_success" : status === "cancelled" ? "invoice.cancelled" : "invoice.nts_failed");
    if (updated.status === "nts_success") {
      await this.persistTaxInvoiceOriginal(updated);
      await this.lockSettlementIfInvoiceGroupComplete(updated);
    }
  }

  private async issueInternalStatement(invoiceId: string): Promise<void> {
    let invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId);
    if (invoice.status === "issued") {
      await this.persistInternalStatementOriginal(invoice);
      await this.lockSettlementIfInvoiceGroupComplete(invoice);
      return;
    }
    if (invoice.status === "failed") invoice = await this.updateInvoice(invoice, "queued", "statement.requeued");
    if (invoice.status === "approved") invoice = await this.updateInvoice(invoice, "queued", "statement.queued");
    if (invoice.status !== "queued") throw new Error(`statement ${invoice.id} is ${invoice.status}`);
    const issued = await this.updateInvoice({ ...invoice, serialNumber: `INTERNAL-${invoice.id.slice(0, 8)}` }, "issued", "statement.issued");
    await this.persistInternalStatementOriginal(issued);
    await this.lockSettlementIfInvoiceGroupComplete(issued);
  }

  private async updateInvoice(invoice: TaxInvoice, status: TaxInvoice["status"], action: string): Promise<TaxInvoice> {
    assertInvoiceTransition(invoice.status, status);
    const updated: TaxInvoice = { ...invoice, status, version: invoice.version + 1 };
    if (["queued", "issued", "nts_pending", "nts_success"].includes(status)) delete updated.failureReason;
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion: invoice.version, value: updated }],
      audits: [this.audit("tax_invoice", updated.id, action, updated.storeId, invoice, updated)],
    });
    return updated;
  }

  private async lockSettlementIfInvoiceGroupComplete(trigger: TaxInvoice): Promise<void> {
    const group = (await this.repository.list<TaxInvoice>("tax_invoice", [trigger.storeId]))
      .filter((invoice) => invoice.invoiceGroupId === trigger.invoiceGroupId);
    const expectedParts = trigger.partCount;
    const partNumbers = new Set(group.map((invoice) => invoice.partNumber));
    const consistent = expectedParts > 0 && group.every((invoice) => invoice.settlementId === trigger.settlementId
      && invoice.partCount === expectedParts && invoice.issueType === trigger.issueType && invoice.storeId === trigger.storeId);
    if (!consistent) throw new Error(`invoice group ${trigger.invoiceGroupId} has inconsistent settlement, type, or part count`);
    const complete = group.length === expectedParts && partNumbers.size === expectedParts
      && [...Array(expectedParts)].every((_, index) => partNumbers.has(index + 1))
      && group.every((invoice) => invoice.issueType === "internal_statement" ? invoice.status === "issued" : invoice.status === "nts_success");
    if (!complete) return;

    const settlement = await this.required<Settlement>("settlement", trigger.settlementId);
    if (settlement.status === "locked") {
      await this.persistSettlementOriginal(settlement);
      return;
    }
    if (settlement.status !== "approved") return;
    assertSettlementTransition(settlement.status, "locked");
    const updated: Settlement = { ...settlement, status: "locked", version: settlement.version + 1 };
    await this.repository.commit({
      changes: [{ type: "settlement", id: updated.id, storeId: updated.storeId, expectedVersion: settlement.version, value: updated }],
      audits: [this.audit("settlement", updated.id, "settlement.locked_after_invoice_group_final", updated.storeId, settlement, updated)],
    });
    await this.persistSettlementOriginal(updated);
  }

  private async handleDelivered(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { shipmentId?: string; receiptId: string; storeId: string };
    const store = await this.required<Store>("store", payload.storeId);
    const receipt = await this.required<GoodsReceipt>("receipt", payload.receiptId);
    const shipment = await this.required<Shipment>("shipment", payload.shipmentId ?? receipt.shipmentId);
    const order = await this.required<PurchaseOrder>("order", receipt.orderId);
    await this.persistDeliveryStatementOriginal(shipment, receipt, order);
    if (store.billingCycle === "per_delivery") await this.createPerDeliverySettlement(receipt, order, store);
    await this.sendStoreNotifications(event);
  }

  private async createPerDeliverySettlement(receipt: GoodsReceipt, order: PurchaseOrder, store: Store): Promise<void> {
    if (order.source === "legacy_unverified") return;
    const date = receipt.confirmedAt.slice(0, 10);
    const settlement: Settlement = {
      id: stableId("settlement-delivery", receipt.id),
      storeId: store.id,
      periodStart: date,
      periodEnd: date,
      status: "draft",
      kind: "per_delivery",
      receiptIds: [receipt.id],
      gross: receipt.gross,
      supply: receipt.supply,
      vat: receipt.vat,
      version: 1,
    };
    const persisted = await this.createSettlementWithPayment(settlement, store, "settlement.per_delivery_drafted");
    await this.persistSettlementOriginal(persisted.settlement);
    if (persisted.paymentRequest) await this.persistPaymentRequestOriginal(persisted.paymentRequest);
  }

  private async createMonthlySettlementDrafts(periodYear: number, periodMonth: number): Promise<void> {
    const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
    const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 0));
    const start = periodStart.toISOString().slice(0, 10);
    const end = periodEnd.toISOString().slice(0, 10);
    for (const store of (await this.repository.list<Store>("store")).filter((item) => item.active && item.billingCycle === "monthly")) {
      const used = new Set((await this.repository.list<Settlement>("settlement", [store.id])).flatMap((item) => item.receiptIds));
      const candidates: GoodsReceipt[] = [];
      for (const receipt of await this.repository.list<GoodsReceipt>("receipt", [store.id])) {
        const date = receipt.confirmedAt.slice(0, 10);
        if (used.has(receipt.id) || date < start || date > end || receipt.status !== "confirmed") continue;
        const order = await this.required<PurchaseOrder>("order", receipt.orderId);
        if (order.source === "native") candidates.push(receipt);
      }
      if (candidates.length === 0) continue;
      const vat = splitVatInclusive(candidates.map((receipt) => ({ id: receipt.id, gross: receipt.gross })));
      const settlement: Settlement = {
        id: stableId("settlement-month", `${store.id}:${start}:${end}`),
        storeId: store.id,
        periodStart: start,
        periodEnd: end,
        status: "draft",
        kind: "monthly",
        receiptIds: candidates.map((item) => item.id),
        gross: vat.gross,
        supply: vat.supply,
        vat: vat.vat,
        version: 1,
      };
      const persisted = await this.createSettlementWithPayment(settlement, store, "settlement.monthly_drafted");
      await this.persistSettlementOriginal(persisted.settlement);
      if (persisted.paymentRequest) await this.persistPaymentRequestOriginal(persisted.paymentRequest);
    }
  }

  private async createSettlementWithPayment(settlement: Settlement, store: Store, action: string): Promise<{
    settlement: Settlement;
    paymentRequest?: PaymentRequest;
  }> {
    const paymentRequest = store.paymentMethod === "monthly_credit" ? this.paymentRequestForSettlement(settlement, store) : undefined;
    const persist = async (repository: StateRepository): Promise<{ settlement: Settlement; paymentRequest?: PaymentRequest }> => {
      try {
        await repository.commit({
          changes: [
            { type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement },
            ...(paymentRequest ? [{ type: "payment_request" as const, id: paymentRequest.id, storeId: store.id, expectedVersion: null, value: paymentRequest }] : []),
          ],
          audits: [
            this.audit("settlement", settlement.id, action, store.id, undefined, settlement),
            ...(paymentRequest ? [this.audit("payment_request", paymentRequest.id, "payment.settlement_requested", store.id, undefined, paymentRequest)] : []),
          ],
          outbox: [
            this.outbox("settlement.drafted", settlement.id, { settlementId: settlement.id, storeId: store.id }),
            ...(paymentRequest ? [this.outbox("payment.requested", paymentRequest.id, { paymentRequestId: paymentRequest.id, settlementId: settlement.id, storeId: store.id })] : []),
          ],
        });
        return { settlement, ...(paymentRequest ? { paymentRequest } : {}) };
      } catch (error) {
        if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT" && (error as { code?: string }).code !== "AGGREGATE_EXISTS") throw error;
        const existing = (await repository.list<Settlement>("settlement", [store.id])).find((item) =>
          item.id === settlement.id || (item.periodStart === settlement.periodStart && item.periodEnd === settlement.periodEnd
            && item.receiptIds.length === settlement.receiptIds.length && item.receiptIds.every((id) => settlement.receiptIds.includes(id))));
        if (!existing) throw error;
        const existingPayment = (await repository.list<PaymentRequest>("payment_request", [store.id]))
          .find((item) => item.settlementId === existing.id);
        return { settlement: existing, ...(existingPayment ? { paymentRequest: existingPayment } : {}) };
      }
    };
    return paymentRequest
      ? this.repository.exclusiveTransaction(this.paymentAutoMatchLockKey(), persist)
      : persist(this.repository);
  }

  private paymentRequestForSettlement(settlement: Settlement, store: Store): PaymentRequest {
    return {
      id: stableId("payment-settlement", settlement.id),
      storeId: store.id,
      settlementId: settlement.id,
      amount: settlement.gross,
      dueDate: nextPaymentDeadline(settlement.periodEnd, this.holidayCalendar),
      status: "pending",
      depositorHint: store.business.representativeName,
      version: 1,
      createdAt: new Date().toISOString(),
    };
  }

  private async handleSettlementDrafted(event: OutboxEvent): Promise<void> {
    const settlementId = String((event.payload as { settlementId?: string }).settlementId ?? event.aggregateId);
    const settlement = await this.required<Settlement>("settlement", settlementId);
    const store = await this.required<Store>("store", settlement.storeId);
    let paymentRequest = (await this.repository.list<PaymentRequest>("payment_request", [store.id])).find((item) => item.settlementId === settlement.id);
    if (store.paymentMethod === "monthly_credit" && !paymentRequest) {
      paymentRequest = await this.repository.exclusiveTransaction(this.paymentAutoMatchLockKey(), async (repository) => {
        const existing = (await repository.list<PaymentRequest>("payment_request", [store.id]))
          .find((item) => item.settlementId === settlement.id);
        if (existing) return existing;
        const candidate = this.paymentRequestForSettlement(settlement, store);
        try {
          await repository.commit({
            changes: [{ type: "payment_request", id: candidate.id, storeId: store.id, expectedVersion: null, value: candidate }],
            audits: [this.audit("payment_request", candidate.id, "payment.settlement_requested", store.id, undefined, candidate)],
            outbox: [this.outbox("payment.requested", candidate.id, { paymentRequestId: candidate.id, settlementId: settlement.id, storeId: store.id })],
          });
          return candidate;
        } catch (error) {
          if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT" && (error as { code?: string }).code !== "AGGREGATE_EXISTS") throw error;
          return (await repository.list<PaymentRequest>("payment_request", [store.id]))
            .find((item) => item.settlementId === settlement.id);
        }
      });
    }
    await this.persistSettlementOriginal(settlement);
    if (paymentRequest) await this.persistPaymentRequestOriginal(paymentRequest);
    await this.sendStoreNotifications(event);
  }

  private posStore: PosStore | null = null;
  private posStoreOf(): PosStore {
    if (!this.posStore) this.posStore = createPosStore(process.env);
    return this.posStore;
  }
  private async runPosSync(date?: string): Promise<void> {
    const day = date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const store = this.posStoreOf();
    const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
    const links = (await store.listLinks()).filter((l) => l.status === "active");
    for (const link of links) {
      try {
        const items = await fetchTossDailyItems({
          merchantId: link.merchantId,
          accessKey: decryptPosSecret(link.accessKeyEnc, encryptionKey),
          secretKey: decryptPosSecret(link.secretKeyEnc, encryptionKey),
          from: day, to: day,
        });
        const rows = await store.recordSales(link.storeId, items, "sync");
        await store.resolveUnmatched(link.storeId);
        await store.touchLinkSynced(link.id, new Date());
        await store.recordRun({ storeId: link.storeId, from: day, to: day, rows, status: "ok" });
      } catch (error) {
        await store.recordRun({ storeId: link.storeId, from: day, to: day, rows: 0, status: "error",
          error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async enqueueScheduledEvent(scheduleKey: string, topic: string, payload: unknown, now: Date): Promise<void> {
    const id = stableId("worker-schedule", scheduleKey);
    await this.repository.exclusiveTransaction(`worker-schedule:${scheduleKey}`, async (repository) => {
      if (await repository.get<WorkerScheduleLedger>("admin_invariant", id)) return;
      const ledger: WorkerScheduleLedger = { id, scheduleKey, topic, createdAt: now.toISOString(), version: 1 };
      const scheduledEvent: OutboxEvent = {
        id: stableUuid("scheduled-outbox", scheduleKey),
        topic,
        aggregateId: scheduleKey,
        payload,
        status: "pending",
        attempts: 0,
        availableAt: now.toISOString(),
        createdAt: now.toISOString(),
      };
      await repository.commit({
        changes: [{ type: "admin_invariant", id, storeId: "__system__", expectedVersion: null, value: ledger }],
        audits: [this.audit("admin_invariant", id, "worker.schedule_enqueued", undefined, undefined, ledger)],
        outbox: [scheduledEvent],
      });
    });
  }

  private async syncBankTransactions(from: string, to: string): Promise<void> {
    if (this.config.appMode === "production" && this.config.providerMode !== "production") {
      throw new DomainError("PRODUCTION_MOCK_PROVIDER_FORBIDDEN", "production에서는 mock 공급자로 계좌조회를 실행할 수 없습니다.", 503);
    }
    if (this.config.providerMode === "production" && !this.config.bankSyncEnabled) {
      throw new DomainError("BANK_SYNC_DISABLED", "POPBILL_BANK_SYNC_ENABLED=false", 503);
    }
    const receivedTransactions = await this.providerCall("Popbill bank sync", this.popbill.fetchBankTransactions(from, to));
    await this.repository.exclusiveTransaction(this.paymentAutoMatchLockKey(), async (repository) => {
      for (const received of receivedTransactions) {
        const transaction = { ...received, version: received.version || 1 };
        try {
          await repository.commit({
            changes: [{ type: "bank_transaction", id: transaction.id, expectedVersion: null, value: transaction }],
            audits: [this.audit("bank_transaction", transaction.id, "bank.transaction_imported", undefined, undefined, transaction)],
          });
        } catch (error) {
          if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT" && (error as { code?: string }).code !== "AGGREGATE_EXISTS") throw error;
        }
      }
      await this.autoMatchEligiblePayments(repository);
    });
  }

  private paymentAutoMatchLockKey(): string {
    return `payment-auto-match:${this.config.reconciliationAccountId}`;
  }

  private async autoMatchEligiblePayments(repository: StateRepository): Promise<void> {
    const requests = (await repository.list<PaymentRequest>("payment_request"))
      .filter((request) => request.status === "pending" || request.status === "manual_review")
      .sort((a, b) => a.id.localeCompare(b.id));
    const transactions = (await repository.list<BankTransaction>("bank_transaction"))
      .filter((transaction) => transaction.direction === "credit" && !transaction.matched
        && transaction.accountId === this.config.reconciliationAccountId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const stores = await repository.list<Store>("store");
    const requestEdges = new Map<string, BankTransaction[]>();
    const transactionEdges = new Map<string, PaymentRequest[]>();
    const amountTimeCandidates = new Set<string>();
    for (const request of requests) {
      const store = stores.find((item) => item.id === request.storeId);
      for (const transaction of transactions) {
        if (request.amount !== transaction.amount || !inAutomaticMatchWindow(request, transaction)) continue;
        amountTimeCandidates.add(request.id);
        const memo = normalizeMatchText(transaction.memo);
        const depositorReference = normalizeMatchText(request.depositorHint);
        const storeReference = store ? normalizeMatchText(store.name) : "";
        const referenceMatched = (depositorReference.length > 0 && memo.includes(depositorReference))
          || (storeReference.length > 0 && memo.includes(storeReference));
        if (!referenceMatched) continue;
        requestEdges.set(request.id, [...(requestEdges.get(request.id) ?? []), transaction]);
        transactionEdges.set(transaction.id, [...(transactionEdges.get(transaction.id) ?? []), request]);
      }
    }

    const matchedRequestIds = new Set<string>();
    for (const request of requests) {
      const edges = requestEdges.get(request.id) ?? [];
      if (edges.length !== 1 || (transactionEdges.get(edges[0]!.id) ?? []).length !== 1) continue;
      const transaction = edges[0]!;
      const latestRequest = await repository.get<PaymentRequest>("payment_request", request.id);
      const latestTransaction = await repository.get<BankTransaction>("bank_transaction", transaction.id);
      if (!latestRequest || !latestTransaction || !["pending", "manual_review"].includes(latestRequest.status)
        || latestTransaction.matched || latestTransaction.direction !== "credit") continue;
      assertPaymentTransition(latestRequest.status, "paid");
      const paid: PaymentRequest = {
        ...latestRequest,
        status: "paid",
        matchedBankTransactionId: latestTransaction.id,
        version: latestRequest.version + 1,
      };
      const matched: BankTransaction = { ...latestTransaction, matched: true, version: latestTransaction.version + 1 };
      await repository.commit({
        changes: [
          { type: "payment_request", id: paid.id, storeId: paid.storeId, expectedVersion: latestRequest.version, value: paid },
          { type: "bank_transaction", id: matched.id, expectedVersion: latestTransaction.version, value: matched },
        ],
        audits: [this.audit("payment_request", paid.id, "payment.auto_matched_by_system", paid.storeId, latestRequest, paid)],
        outbox: [this.outbox("payment.paid", paid.id, { paymentRequestId: paid.id, storeId: paid.storeId, matchType: "automatic" })],
      });
      matchedRequestIds.add(request.id);
    }

    for (const request of requests) {
      if (matchedRequestIds.has(request.id) || request.status !== "pending" || !amountTimeCandidates.has(request.id)) continue;
      const edges = requestEdges.get(request.id) ?? [];
      if (edges.length === 1 && (transactionEdges.get(edges[0]!.id) ?? []).length === 1) continue;
      assertPaymentTransition(request.status, "manual_review");
      const review: PaymentRequest = { ...request, status: "manual_review", version: request.version + 1 };
      await repository.commit({
        changes: [{ type: "payment_request", id: review.id, storeId: review.storeId, expectedVersion: request.version, value: review }],
        audits: [this.audit("payment_request", review.id, "payment.match_ambiguous_by_system", review.storeId, request, review)],
      });
    }
  }

  private async applyPopbillWebhook(envelope: PopbillWebhookEnvelope): Promise<void> {
    const bodies = envelope.bodies ?? (envelope.body ? [envelope.body] : []);
    for (const payload of bodies) {
      const stateCode = Number(payload.stateCode ?? 0);
      if (![304, 305, 600].includes(stateCode)) continue;
      const itemKey = String(payload.itemKey ?? "");
      const managementKey = String(payload.invoicerMgtKey ?? "");
      if (!itemKey && !managementKey) continue;
      let invoice = (await this.repository.list<TaxInvoice>("tax_invoice")).find((item) =>
        (Boolean(itemKey) && item.providerReceiptId === itemKey) || (Boolean(managementKey) && item.providerManagementKey === managementKey));
      if (!invoice || invoice.status === "cancelled") continue;
      if (invoice.status === "nts_success") {
        await this.persistTaxInvoiceOriginal(invoice);
        await this.lockSettlementIfInvoiceGroupComplete(invoice);
        continue;
      }

      const providerFields = {
        ...(itemKey ? { providerReceiptId: itemKey } : {}),
        ...(typeof payload.ntsconfirmNum === "string" && /^\d{24}$/.test(payload.ntsconfirmNum)
          ? { serialNumber: payload.ntsconfirmNum } : {}),
      };
      if (invoice.status === "failed") invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "queued", "invoice.webhook_reconciled_queued");
      if (invoice.status === "queued") invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "issued", "invoice.webhook_reconciled_issued");
      if (invoice.status === "issued") invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "nts_pending", "invoice.nts_pending");
      if (invoice.status !== "nts_pending") continue;

      await this.persistTaxInvoiceOriginal(invoice);
      const status: TaxInvoice["status"] = stateCode === 304 ? "nts_success" : stateCode === 600 ? "cancelled" : "failed";
      const updated = await this.updateInvoice({
        ...invoice,
        ...providerFields,
        ...(status === "failed" ? { failureReason: String(payload.stateMemo ?? payload.ntssendErrCode ?? "NTS 전송 실패") } : {}),
      }, status, status === "nts_success" ? "invoice.nts_success" : status === "cancelled" ? "invoice.cancelled" : "invoice.nts_failed");
      if (updated.status === "nts_success") {
        await this.persistTaxInvoiceOriginal(updated);
        await this.lockSettlementIfInvoiceGroupComplete(updated);
      }
    }
  }

  private async persistDeliveryStatementOriginal(shipment: Shipment, receipt: GoodsReceipt, order: PurchaseOrder): Promise<void> {
    await this.persistRenderedOriginal({
      kind: "delivery_statement",
      aggregateType: "shipment",
      aggregateId: shipment.id,
      storeId: shipment.storeId,
      sourceVersion: shipment.version,
      fileName: `delivery-${shipment.number}-v${shipment.version}.pdf`,
      title: "OFD DELIVERY STATEMENT",
      payload: { shipment, receipt, order },
    });
  }

  private async persistPaymentRequestOriginal(paymentRequest: PaymentRequest): Promise<void> {
    await this.persistRenderedOriginal({
      kind: "payment_request",
      aggregateType: "payment_request",
      aggregateId: paymentRequest.id,
      storeId: paymentRequest.storeId,
      sourceVersion: paymentRequest.version,
      fileName: `payment-request-${paymentRequest.id}-v${paymentRequest.version}.pdf`,
      title: "OFD PAYMENT REQUEST",
      payload: paymentRequest,
    });
  }

  private async persistSettlementOriginal(settlement: Settlement): Promise<void> {
    await this.persistRenderedOriginal({
      kind: "monthly_statement",
      aggregateType: "settlement",
      aggregateId: settlement.id,
      storeId: settlement.storeId,
      sourceVersion: settlement.version,
      fileName: `settlement-${settlement.periodStart}-${settlement.periodEnd}-v${settlement.version}.pdf`,
      title: "OFD SETTLEMENT STATEMENT",
      payload: settlement,
    });
  }

  private async persistInternalStatementOriginal(invoice: TaxInvoice): Promise<void> {
    await this.persistRenderedOriginal({
      kind: "monthly_statement",
      aggregateType: "tax_invoice",
      aggregateId: invoice.id,
      storeId: invoice.storeId,
      sourceVersion: invoice.version,
      fileName: `internal-statement-${invoice.providerManagementKey}-v${invoice.version}.pdf`,
      title: "OFD INTERNAL TRANSACTION STATEMENT",
      payload: invoice,
    });
  }

  private async persistTaxInvoiceOriginal(invoice: TaxInvoice): Promise<void> {
    const existing = await this.findOriginalDocument("tax_invoice", invoice.id, invoice.version);
    if (existing) return;
    const original = await this.providerCall("Popbill tax invoice original", this.popbill.getTaxInvoiceOriginal(invoice));
    if (!original) throw new Error(`tax invoice original unavailable: ${invoice.id}`);
    await this.persistOriginalBytes({
      kind: "tax_invoice",
      aggregateType: "tax_invoice",
      aggregateId: invoice.id,
      storeId: invoice.storeId,
      sourceVersion: invoice.version,
      original,
    });
  }

  private async persistRenderedOriginal(input: {
    kind: OriginalDocumentKind;
    aggregateType: OriginalDocumentAggregateType;
    aggregateId: string;
    storeId: string;
    sourceVersion: number;
    fileName: string;
    title: string;
    payload: unknown;
  }): Promise<void> {
    if (await this.findOriginalDocument(input.kind, input.aggregateId, input.sourceVersion)) return;
    const original: TaxInvoiceOriginalDocument = {
      bytes: renderOriginalPdf(input.title, input.payload),
      mimeType: "application/pdf",
      fileName: input.fileName,
    };
    await this.persistOriginalBytes({ ...input, original });
  }

  private async persistOriginalBytes(input: {
    kind: OriginalDocumentKind;
    aggregateType: OriginalDocumentAggregateType;
    aggregateId: string;
    storeId: string;
    sourceVersion: number;
    original: TaxInvoiceOriginalDocument;
  }): Promise<void> {
    const objectKey = `original-documents/${input.kind}/${safeObjectSegment(input.aggregateId)}/v${input.sourceVersion}.pdf`;
    const stored = await this.providerCall("immutable object storage", this.storage.putImmutableObject({
      objectKey,
      bytes: input.original.bytes,
      mimeType: input.original.mimeType,
      fileName: input.original.fileName,
      metadata: { aggregateid: input.aggregateId, sourceversion: String(input.sourceVersion), kind: input.kind },
    }));
    const document: OriginalDocument = {
      id: stableId("document", `${input.kind}:${input.aggregateId}:${input.sourceVersion}`),
      storeId: input.storeId,
      kind: input.kind,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      sourceVersion: input.sourceVersion,
      objectKey: stored.objectKey,
      objectVersionId: stored.objectVersionId,
      contentHashSha256: stored.contentHashSha256,
      mimeType: "application/pdf",
      fileName: stored.fileName,
      sizeBytes: stored.sizeBytes,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    try {
      await this.repository.commit({
        changes: [{ type: "document", id: document.id, storeId: document.storeId, expectedVersion: null, value: document }],
        audits: [this.audit("document", document.id, "document.original_stored", document.storeId, undefined, document)],
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT" && (error as { code?: string }).code !== "AGGREGATE_EXISTS") throw error;
      const existing = await this.findOriginalDocument(input.kind, input.aggregateId, input.sourceVersion);
      if (!existing || existing.contentHashSha256 !== document.contentHashSha256 || existing.objectVersionId !== document.objectVersionId) throw error;
    }
  }

  private async findOriginalDocument(kind: OriginalDocumentKind, aggregateId: string, sourceVersion: number): Promise<OriginalDocument | undefined> {
    return (await this.repository.list<OriginalDocument>("document")).find((document) =>
      document.kind === kind && document.aggregateId === aggregateId && document.sourceVersion === sourceVersion);
  }

  private async sendStoreNotifications(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { storeId?: string; orderNumber?: string };
    if (!payload.storeId) return;
    const store = await this.required<Store>("store", payload.storeId);
    const owner = (await this.repository.list<Actor>("actor")).find((actor) => actor.role === "store_owner" && actor.storeIds.includes(store.id));
    const title = notificationTitle(event.topic);
    const body = `${store.name} · ${title}${payload.orderNumber ? ` (${payload.orderNumber})` : ""}`;
    const channels: Array<Notification["channel"]> = ["app", "email"];
    const smsReady = this.config.appMode === "production"
      ? this.config.providerMode === "production" && this.config.smsEnabled
      : this.config.providerMode === "mock" || this.config.smsEnabled;
    if (smsReady) channels.push("sms");
    for (const channel of channels) {
      const id = stableNotificationId(event.id, channel);
      const existing = await this.repository.get<Notification>("notification", id);
      if (existing?.status === "sent") continue;
      let notification: Notification = existing ?? {
        id,
        ...(owner ? { actorId: owner.id } : {}),
        storeId: store.id,
        channel,
        template: event.topic,
        title,
        body,
        status: "pending",
        createdAt: new Date().toISOString(),
        version: 1,
      };
      if (!existing) await this.repository.commit({ changes: [{ type: "notification", id, storeId: store.id, expectedVersion: null, value: notification }] });
      try {
        if (channel === "email") await this.providerCall("email notification", this.email.send(store.business.email, title, body));
        if (channel === "sms") await this.providerCall("SMS notification", this.popbill.sendSms(store.notificationPhone, body, id));
        const sent: Notification = { ...notification, status: "sent", version: notification.version + 1 };
        await this.repository.commit({
          changes: [{ type: "notification", id, storeId: store.id, expectedVersion: notification.version, value: sent }],
          audits: [this.audit("notification", id, "notification.sent", store.id, notification, sent)],
        });
        notification = sent;
      } catch (error) {
        const failed: Notification = { ...notification, status: "failed", version: notification.version + 1 };
        await this.repository.commit({ changes: [{ type: "notification", id, storeId: store.id, expectedVersion: notification.version, value: failed }] });
        throw error;
      }
    }
  }

  private audit(aggregateType: string, aggregateId: string, action: string, storeId: string | undefined, before: unknown, after: unknown): AuditEvent {
    return {
      id: randomUUID(),
      aggregateType,
      aggregateId,
      action,
      actorId: systemActor.id,
      actorRole: "system",
      ...(storeId !== undefined ? { storeId } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      metadata: { worker: true, authority: "system_automation" },
      occurredAt: new Date().toISOString(),
    };
  }

  private outbox(topic: string, aggregateId: string, payload: unknown): OutboxEvent {
    const now = new Date().toISOString();
    return { id: randomUUID(), topic, aggregateId, payload, status: "pending", attempts: 0, availableAt: now, createdAt: now };
  }

  private providerCall<T>(label: string, promise: Promise<T>, timeoutCode = "PROVIDER_CALL_TIMEOUT"): Promise<T> {
    return withTimeout(promise, this.providerTimeoutMs,
      () => new DomainError(timeoutCode, `${label} timed out after ${this.providerTimeoutMs}ms`, 503));
  }

  private assertTaxInvoiceProviderReady(): void {
    if (this.config.appMode === "production" && this.config.providerMode !== "production") {
      throw new DomainError("PRODUCTION_MOCK_PROVIDER_FORBIDDEN", "production에서는 mock 공급자로 세금계산서를 처리할 수 없습니다.", 503);
    }
    if (this.config.providerMode === "production" && !this.config.taxInvoiceEnabled) {
      throw new DomainError("TAX_ISSUANCE_DISABLED", "POPBILL_TAX_INVOICE_ENABLED=false", 503);
    }
  }

  private async required<T>(type: AggregateType, id: string): Promise<T> {
    const value = await this.repository.get<T>(type, id);
    if (!value) throw new Error(`${type}:${id} not found`);
    return value;
  }
}

interface PopbillWebhookEnvelope {
  headers?: { mid?: string; corpNum?: string };
  body?: Record<string, unknown>;
  bodies?: Array<Record<string, unknown>>;
}

interface WorkerScheduleLedger {
  id: string;
  scheduleKey: string;
  topic: string;
  createdAt: string;
  version: number;
}

function seoulCalendar(now: Date): { year: number; month: number; day: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    year,
    month,
    day,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function normalizeMatchText(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("ko-KR");
}

function inAutomaticMatchWindow(request: PaymentRequest, transaction: BankTransaction): boolean {
  const occurred = new Date(transaction.occurredAt).valueOf();
  const earliest = new Date(request.createdAt).valueOf() - 24 * 60 * 60 * 1_000;
  const latest = new Date(`${request.dueDate}T23:59:59.999Z`).valueOf() + 3 * 24 * 60 * 60 * 1_000;
  return Number.isFinite(occurred) && occurred >= earliest && occurred <= latest;
}

function stableId(namespace: string, value: string): string {
  return `${namespace}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function stableUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const valueHex = hex.join("");
  return `${valueHex.slice(0, 8)}-${valueHex.slice(8, 12)}-${valueHex.slice(12, 16)}-${valueHex.slice(16, 20)}-${valueHex.slice(20)}`;
}

function safeObjectSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, "_");
}

function renderOriginalPdf(title: string, payload: unknown): Uint8Array {
  const canonicalPayload = stableJson(payload);
  const payloadHash = createHash("sha256").update(canonicalPayload).digest("hex");
  const stream = `BT\n/F1 14 Tf\n72 750 Td\n(${escapePdfText(title)}) Tj\n0 -24 Td\n/F1 9 Tf\n(Source SHA-256: ${payloadHash}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const encodedPayload = Buffer.from(canonicalPayload, "utf8").toString("base64");
  for (let index = 0; index < encodedPayload.length; index += 76) pdf += `% OFD-PAYLOAD ${encodedPayload.slice(index, index + 76)}\n`;
  return new TextEncoder().encode(pdf);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function escapePdfText(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function notificationTitle(topic: string): string {
  const labels: Record<string, string> = {
    "order.submitted": "발주 접수",
    "order.resubmitted": "수정 발주 접수",
    "order.approved": "발주 승인",
    "order.change_requested": "발주 변경 요청",
    "order.cancelled": "발주 취소",
    "order.rejected": "발주 반려",
    "shipment.created": "배송 배차",
    "shipment.dispatched": "배송 출발",
    "shipment.delivered": "배송·입고 완료",
    "payment.paid": "입금 확인",
    "payment.reversed": "입금 확인 취소",
    "settlement.drafted": "정산서 초안",
    "settlement.approved": "정산 승인",
    "invoice.reviewed": "세금계산서 검토 완료",
  };
  return labels[topic] ?? "OFD 알림";
}

function stableNotificationId(eventId: string, channel: string): string {
  return `noti-${createHash("sha256").update(`${eventId}:${channel}`).digest("hex").slice(0, 32)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
