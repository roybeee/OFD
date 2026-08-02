export type ActorRole =
  | "store_owner"
  | "store_staff"
  | "hq_ops"
  | "hq_finance"
  | "hq_master"
  | "auditor"
  | "driver"
  | "system";

export interface Actor {
  id: string;
  name: string;
  role: ActorRole;
  storeIds: string[];
  active: boolean;
  authVersion: number;
  mfaVerified?: boolean;
  mfaVerifiedAt?: string;
}

export interface UserCredential {
  id: string;
  actorId: string;
  email: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil?: string;
  mfaSecretEncrypted?: string;
  lastLoginAt?: string;
  version: number;
}

export type BillingCycle = "monthly" | "per_delivery";
export type PaymentMethod = "prepaid" | "monthly_credit";
export type OrderSource = "native" | "legacy_unverified";
export type OrderStatus =
  | "draft"
  | "submitted"
  | "change_requested"
  | "approved"
  | "rejected"
  | "cancelled";
export type ShipmentStatus = "preparing" | "out_for_delivery" | "delivered";
export type ReceiptStatus = "confirmed" | "returned";
export type PaymentStatus = "pending" | "matching" | "manual_review" | "paid" | "reversed" | "cancelled";
export type SettlementStatus = "open" | "draft" | "reviewed" | "approved" | "locked";
export type InvoiceStatus =
  | "draft"
  | "reviewed"
  | "approved"
  | "queued"
  | "issued"
  | "nts_pending"
  | "nts_success"
  | "failed"
  | "cancelled";

export interface LegalEntitySnapshot {
  businessNumber: string;
  legalName: string;
  representativeName: string;
  address: string;
  businessType: string;
  businessCategory: string;
  email: string;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  business: LegalEntitySnapshot;
  billingCycle: BillingCycle;
  paymentMethod: PaymentMethod;
  notificationPhone: string;
  active: boolean;
  version: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unitGross: number;
  taxable: true;
  taxRate: 10;
  active: boolean;
}

export interface ProductSnapshot {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  unitGross: number;
  taxable: true;
  taxRate: 10;
}

export interface PurchaseOrderLine {
  id: string;
  snapshot: ProductSnapshot;
  quantity: number;
  gross: number;
  supply: number;
  vat: number;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  storeId: string;
  status: OrderStatus;
  source: OrderSource;
  requestedDeliveryDate: string;
  note: string;
  lines: PurchaseOrderLine[];
  gross: number;
  supply: number;
  vat: number;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  submittedAt?: string;
  changeRequest?: {
    reason: string;
    requestedBy: string;
    requestedAt: string;
  };
  cancelledBy?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ShipmentLine {
  orderLineId: string;
  quantity: number;
}

export interface DeliveryProof {
  id: string;
  shipmentId: string;
  photoObjectKey: string;
  objectVersionId: string;
  etag: string;
  checksumSha256: string;
  recipientName: string;
  note: string;
  latitude?: number;
  longitude?: number;
  capturedAt: string;
  uploadedBy: string;
}

export interface DeliveryUploadSession {
  id: string;
  shipmentId: string;
  storeId: string;
  objectKey: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  issuedTo: string;
  expiresAt: string;
  status: "issued" | "completed";
  completedAt?: string;
  version: number;
}

export interface Shipment {
  id: string;
  number: string;
  orderId: string;
  storeId: string;
  driverId?: string;
  status: ShipmentStatus;
  lines: ShipmentLine[];
  plannedDate: string;
  deliveredAt?: string;
  proof?: DeliveryProof;
  version: number;
}

export interface GoodsReceipt {
  id: string;
  shipmentId: string;
  orderId: string;
  storeId: string;
  status: ReceiptStatus;
  confirmedAt: string;
  confirmedBy: string;
  gross: number;
  supply: number;
  vat: number;
}

export interface PaymentRequest {
  id: string;
  storeId: string;
  orderId?: string;
  settlementId?: string;
  amount: number;
  dueDate: string;
  status: PaymentStatus;
  depositorHint: string;
  matchedBankTransactionId?: string;
  version: number;
  createdAt: string;
}

export interface BankTransaction {
  id: string;
  providerId: string;
  accountId: string;
  occurredAt: string;
  amount: number;
  direction: "credit" | "debit";
  memo: string;
  matched: boolean;
  version: number;
}

export interface Settlement {
  id: string;
  storeId: string;
  periodStart: string;
  periodEnd: string;
  status: SettlementStatus;
  receiptIds: string[];
  gross: number;
  supply: number;
  vat: number;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  version: number;
}

export interface TaxInvoice {
  id: string;
  storeId: string;
  settlementId: string;
  invoiceGroupId: string;
  partNumber: number;
  partCount: number;
  providerManagementKey: string;
  issueType: "normal" | "internal_statement" | "modified";
  status: InvoiceStatus;
  serialNumber?: string;
  issueDate: string;
  supplier: LegalEntitySnapshot;
  recipient: LegalEntitySnapshot;
  gross: number;
  supply: number;
  vat: number;
  preparedBy: string;
  reviewedBy?: string;
  approvedBy?: string;
  providerReceiptId?: string;
  failureReason?: string;
  originalInvoiceId?: string;
  originalNtsConfirmNumber?: string;
  modificationReasonCode?: "01" | "02" | "03" | "04" | "05" | "06";
  lines: TaxInvoiceLine[];
  version: number;
}

export interface TaxInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  gross: number;
  supply: number;
  vat: number;
}

export interface Notification {
  id: string;
  actorId?: string;
  storeId?: string;
  channel: "app" | "email" | "sms";
  template: string;
  title: string;
  body: string;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  version: number;
}

export interface AuditEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  actorId: string;
  actorRole: ActorRole;
  storeId?: string;
  before?: unknown;
  after?: unknown;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface OutboxEvent {
  id: string;
  topic: string;
  aggregateId: string;
  payload: unknown;
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  attempts: number;
  availableAt: string;
  createdAt: string;
  processedAt?: string;
  lastError?: string;
  lockedAt?: string;
  lockedBy?: string;
  deadLetterAt?: string;
}
