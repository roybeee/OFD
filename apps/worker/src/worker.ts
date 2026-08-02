import { createHash, randomUUID } from "node:crypto";
import { DEMO_IDS, type StateRepository } from "@ofd/db";
import {
  assertInvoiceTransition,
  assertSettlementTransition,
  splitVatInclusive,
  type Actor,
  type AuditEvent,
  type GoodsReceipt,
  type Notification,
  type OutboxEvent,
  type PurchaseOrder,
  type Settlement,
  type Store,
  type TaxInvoice,
} from "@ofd/domain";
import type { EmailProvider, PopbillProvider, ProviderConfig } from "@ofd/integrations";

const systemActor: Actor = { id: DEMO_IDS.system, name: "OFD 자동화", role: "system", storeIds: [], active: true, authVersion: 1, mfaVerified: true, mfaVerifiedAt: new Date().toISOString() };

export class OfdWorker {
  private readonly scheduleRuns = new Set<string>();

  constructor(
    private readonly repository: StateRepository,
    private readonly popbill: PopbillProvider,
    private readonly email: EmailProvider,
    private readonly config: ProviderConfig,
    private readonly workerId = `worker-${process.pid}`,
    private readonly maxAttempts = 12,
  ) {}

  async processOnce(limit = 20): Promise<{ claimed: number; completed: number; failed: number }> {
    const events = await this.repository.claimOutbox(limit, this.workerId, this.maxAttempts);
    let completed = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.handle(event);
        await this.repository.completeOutbox(event.id, undefined, this.maxAttempts);
        completed += 1;
      } catch (error) {
        if (event.attempts >= this.maxAttempts) {
          await this.repository.commit({ changes: [], audits: [this.audit("outbox", event.id, "outbox.dead_lettered", undefined, event, undefined)] });
        }
        await this.repository.completeOutbox(event.id, error instanceof Error ? error.message : String(error), this.maxAttempts);
        failed += 1;
      }
    }
    return { claimed: events.length, completed, failed };
  }

  async runScheduled(now = new Date()): Promise<void> {
    const seoul = seoulCalendar(now);
    if (seoul.day === 1 && !this.scheduleRuns.has(`monthly:${seoul.date}`)) {
      await this.createMonthlySettlementDrafts(seoul.year, seoul.month);
      this.scheduleRuns.add(`monthly:${seoul.date}`);
    }
    if (!this.scheduleRuns.has(`bank:${seoul.date}`) && (this.config.providerMode === "mock" || this.config.bankSyncEnabled)) {
      await this.syncBankTransactions(seoul.date, seoul.date);
      this.scheduleRuns.add(`bank:${seoul.date}`);
    }
  }

  private async handle(event: OutboxEvent): Promise<void> {
    switch (event.topic) {
      case "invoice.issue.requested": await this.issueTaxInvoice(String((event.payload as { invoiceId?: string }).invoiceId ?? event.aggregateId)); return;
      case "statement.generate": await this.issueInternalStatement(String((event.payload as { invoiceId?: string }).invoiceId ?? event.aggregateId)); return;
      case "shipment.delivered": await this.handleDelivered(event); return;
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
      case "order.submitted":
      case "order.approved":
      case "order.change_requested":
      case "order.resubmitted":
      case "order.cancelled":
      case "order.rejected":
      case "shipment.created":
      case "shipment.dispatched":
      case "payment.paid":
      case "payment.reversed":
      case "settlement.drafted":
      case "settlement.approved":
      case "invoice.reviewed":
        await this.sendStoreNotifications(event); return;
      default: return;
    }
  }

  private async issueTaxInvoice(invoiceId: string): Promise<void> {
    if (this.config.providerMode === "production" && !this.config.taxInvoiceEnabled) throw new Error("POPBILL_TAX_INVOICE_ENABLED=false");
    let invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId);
    if (["nts_pending", "nts_success"].includes(invoice.status)) return;
    if (invoice.status === "failed") invoice = await this.updateInvoice(invoice, "queued", "invoice.requeued");
    if (invoice.status === "approved") invoice = await this.updateInvoice(invoice, "queued", "invoice.queued");
    if (invoice.status === "issued") {
      await this.updateInvoice(invoice, "nts_pending", "invoice.nts_pending");
      return;
    }
    if (invoice.status !== "queued") throw new Error(`invoice ${invoice.id} is ${invoice.status}`);
    try {
      const result = await this.popbill.issueTaxInvoice(invoice);
      invoice = await this.updateInvoice({ ...invoice, providerReceiptId: result.receiptId,
        ...(result.serialNumber ? { serialNumber: result.serialNumber } : {}) }, "issued", "invoice.issued");
      await this.lockSettlement(invoice.settlementId);
      invoice = await this.updateInvoice(invoice, "nts_pending", "invoice.nts_pending");
      if (result.ntsStatus === "success") await this.updateInvoice(invoice, "nts_success", "invoice.nts_success");
    } catch (error) {
      const latest = await this.required<TaxInvoice>("tax_invoice", invoice.id);
      if (latest.status === "queued") await this.updateInvoice({ ...latest, failureReason: error instanceof Error ? error.message : String(error) }, "failed", "invoice.failed");
      throw error;
    }
  }

  private async issueInternalStatement(invoiceId: string): Promise<void> {
    let invoice = await this.required<TaxInvoice>("tax_invoice", invoiceId);
    if (invoice.status === "issued") return;
    if (invoice.status === "approved") invoice = await this.updateInvoice(invoice, "queued", "statement.queued");
    if (invoice.status !== "queued") throw new Error(`statement ${invoice.id} is ${invoice.status}`);
    await this.updateInvoice({ ...invoice, serialNumber: `INTERNAL-${invoice.id.slice(0, 8)}` }, "issued", "statement.issued");
    await this.lockSettlement(invoice.settlementId);
  }

  private async updateInvoice(invoice: TaxInvoice, status: TaxInvoice["status"], action: string): Promise<TaxInvoice> {
    assertInvoiceTransition(invoice.status, status);
    const updated: TaxInvoice = { ...invoice, status, version: invoice.version + 1 };
    await this.repository.commit({
      changes: [{ type: "tax_invoice", id: updated.id, storeId: updated.storeId, expectedVersion: invoice.version, value: updated }],
      audits: [this.audit("tax_invoice", updated.id, action, updated.storeId, invoice, updated)],
    });
    return updated;
  }

  private async lockSettlement(settlementId: string): Promise<void> {
    const settlement = await this.required<Settlement>("settlement", settlementId);
    if (settlement.status === "locked") return;
    if (settlement.status !== "approved") return;
    assertSettlementTransition(settlement.status, "locked");
    const updated: Settlement = { ...settlement, status: "locked", version: settlement.version + 1 };
    await this.repository.commit({
      changes: [{ type: "settlement", id: updated.id, storeId: updated.storeId, expectedVersion: settlement.version, value: updated }],
      audits: [this.audit("settlement", updated.id, "settlement.locked", updated.storeId, settlement, updated)],
    });
  }

  private async handleDelivered(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { receiptId: string; storeId: string };
    const store = await this.required<Store>("store", payload.storeId);
    if (store.billingCycle === "per_delivery") await this.createPerDeliverySettlement(payload.receiptId, store);
    await this.sendStoreNotifications(event);
  }

  private async createPerDeliverySettlement(receiptId: string, store: Store): Promise<void> {
    const receipt = await this.required<GoodsReceipt>("receipt", receiptId);
    const order = await this.required<PurchaseOrder>("order", receipt.orderId);
    if (order.source === "legacy_unverified") return;
    const date = receipt.confirmedAt.slice(0, 10);
    const settlement: Settlement = {
      id: randomUUID(), storeId: store.id, periodStart: date, periodEnd: date, status: "draft", receiptIds: [receipt.id],
      gross: receipt.gross, supply: receipt.supply, vat: receipt.vat, version: 1,
    };
    try {
      await this.repository.commit({
        changes: [{ type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement }],
        audits: [this.audit("settlement", settlement.id, "settlement.per_delivery_drafted", store.id, undefined, settlement)],
        outbox: [this.outbox("settlement.drafted", settlement.id, { settlementId: settlement.id, storeId: store.id })],
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT") throw error;
    }
  }

  private async createMonthlySettlementDrafts(currentYear: number, currentMonth: number): Promise<void> {
    const periodEnd = new Date(Date.UTC(currentYear, currentMonth - 1, 0));
    const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 1));
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
      const settlement: Settlement = { id: randomUUID(), storeId: store.id, periodStart: start, periodEnd: end, status: "draft",
        receiptIds: candidates.map((item) => item.id), gross: vat.gross, supply: vat.supply, vat: vat.vat, version: 1 };
      try {
        await this.repository.commit({
          changes: [{ type: "settlement", id: settlement.id, storeId: store.id, expectedVersion: null, value: settlement }],
          audits: [this.audit("settlement", settlement.id, "settlement.monthly_drafted", store.id, undefined, settlement)],
          outbox: [this.outbox("settlement.drafted", settlement.id, { settlementId: settlement.id, storeId: store.id })],
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT") throw error;
      }
    }
  }

  private async syncBankTransactions(from: string, to: string): Promise<void> {
    if (this.config.providerMode === "production" && !this.config.bankSyncEnabled) throw new Error("POPBILL_BANK_SYNC_ENABLED=false");
    for (const received of await this.popbill.fetchBankTransactions(from, to)) {
      const transaction = { ...received, version: received.version || 1 };
      try {
        await this.repository.commit({
          changes: [{ type: "bank_transaction", id: transaction.id, expectedVersion: null, value: transaction }],
          audits: [this.audit("bank_transaction", transaction.id, "bank.transaction_imported", undefined, undefined, transaction)],
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "BUSINESS_KEY_CONFLICT") throw error;
      }
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
      if (!invoice || ["nts_success", "cancelled"].includes(invoice.status)) continue;

      const providerFields = {
        ...(itemKey ? { providerReceiptId: itemKey } : {}),
        ...(typeof payload.ntsconfirmNum === "string" && /^\d{24}$/.test(payload.ntsconfirmNum)
          ? { serialNumber: payload.ntsconfirmNum } : {}),
      };
      if (invoice.status === "failed") {
        invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "queued", "invoice.webhook_reconciled_queued");
      }
      if (invoice.status === "queued") {
        invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "issued", "invoice.webhook_reconciled_issued");
        await this.lockSettlement(invoice.settlementId);
      }
      if (invoice.status === "issued") {
        invoice = await this.updateInvoice({ ...invoice, ...providerFields }, "nts_pending", "invoice.nts_pending");
      }
      if (invoice.status !== "nts_pending") continue;

      const status: TaxInvoice["status"] = stateCode === 304 ? "nts_success" : stateCode === 600 ? "cancelled" : "failed";
      await this.updateInvoice({
        ...invoice,
        ...providerFields,
        ...(status === "failed" ? { failureReason: String(payload.stateMemo ?? payload.ntssendErrCode ?? "NTS 전송 실패") } : {}),
      }, status, status === "nts_success" ? "invoice.nts_success" : status === "cancelled" ? "invoice.cancelled" : "invoice.nts_failed");
    }
  }

  private async sendStoreNotifications(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { storeId?: string; orderNumber?: string };
    if (!payload.storeId) return;
    const store = await this.required<Store>("store", payload.storeId);
    const owner = (await this.repository.list<Actor>("actor")).find((actor) => actor.role === "store_owner" && actor.storeIds.includes(store.id));
    const title = notificationTitle(event.topic);
    const body = `${store.name} · ${title}${payload.orderNumber ? ` (${payload.orderNumber})` : ""}`;
    const channels: Array<Notification["channel"]> = ["app", "email"];
    if (this.config.providerMode === "mock" || this.config.smsEnabled) channels.push("sms");
    for (const channel of channels) {
      const id = stableNotificationId(event.id, channel);
      const existing = await this.repository.get<Notification>("notification", id);
      if (existing?.status === "sent") continue;
      let notification: Notification = existing ?? {
        id, ...(owner ? { actorId: owner.id } : {}), storeId: store.id, channel, template: event.topic, title, body, status: "pending",
        createdAt: new Date().toISOString(), version: 1,
      };
      if (!existing) await this.repository.commit({ changes: [{ type: "notification", id, storeId: store.id, expectedVersion: null, value: notification }] });
      try {
        if (channel === "email") await this.email.send(store.business.email, title, body);
        if (channel === "sms") await this.popbill.sendSms(store.notificationPhone, body, id);
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
    return { id: randomUUID(), aggregateType, aggregateId, action, actorId: systemActor.id, actorRole: "system",
      ...(storeId !== undefined ? { storeId } : {}), ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}),
      metadata: { worker: true }, occurredAt: new Date().toISOString() };
  }

  private outbox(topic: string, aggregateId: string, payload: unknown): OutboxEvent {
    const now = new Date().toISOString();
    return { id: randomUUID(), topic, aggregateId, payload, status: "pending", attempts: 0, availableAt: now, createdAt: now };
  }

  private async required<T>(type: Parameters<StateRepository["get"]>[0], id: string): Promise<T> {
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

function notificationTitle(topic: string): string {
  const labels: Record<string, string> = {
    "order.submitted": "발주서 접수", "order.resubmitted": "수정 발주서 접수", "order.approved": "발주 승인", "order.change_requested": "발주 변경 요청",
    "order.cancelled": "발주 취소", "order.rejected": "발주 반려", "shipment.created": "배송 배차", "shipment.dispatched": "배송 출발",
    "shipment.delivered": "배송·입고 완료", "payment.paid": "입금 확인", "payment.reversed": "입금 확인 취소", "settlement.drafted": "정산서 초안",
    "settlement.approved": "정산 승인", "invoice.reviewed": "세금계산서 검토 완료",
  };
  return labels[topic] ?? "OFD 알림";
}

function stableNotificationId(eventId: string, channel: string): string {
  return `noti-${createHash("sha256").update(`${eventId}:${channel}`).digest("hex").slice(0, 32)}`;
}
