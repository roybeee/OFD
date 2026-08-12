export type ActorRole =
  | "store_owner"
  | "store_staff"
  | "hq_ops"
  | "hq_finance"
  | "hq_master"
  | "auditor"
  | "driver"
  | "system";

export type ProvisionableActorRole = Exclude<ActorRole, "system">;

export interface Actor {
  id: string;
  name: string;
  role: ActorRole;
  storeIds: string[];
  active: boolean;
  authVersion: number;
  /** 최근 스텝업(중요 작업 본인 확인) 여부. 세션 토큰에서 파생되며, 비밀번호 재확인으로만 세워진다. */
  mfaVerified?: boolean;
  mfaVerifiedAt?: string;
}

/** Safe identity DTOs. Credential hashes and MFA material must never be added here. */
export type PublicActor = Pick<Actor, "id" | "name" | "role" | "storeIds">;

export interface ActorDirectoryEntry {
  id: string;
  name: string;
}

export interface AdminActorSummary extends PublicActor {
  active: boolean;
  /** Optimistic concurrency token; changing it also revokes existing sessions. */
  version: number;
  email: string;
  lastLoginAt?: string;
  lockedUntil?: string;
}

export interface AdminInvariant {
  id: "hq-master-liveness" | `driver-liveness:${string}`;
  version: number;
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
  /** 관리자가 발급·재설정한 비밀번호. 본인이 바꾸기 전까지 업무 화면 진입을 막는다. */
  mustChangePassword?: boolean;
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
export type SettlementKind = "monthly" | "per_delivery";
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
  /* V1 매장 대장 이식 필드 — 기존 payload 하위호환을 위해 선택 필드 */
  storeKind?: "직영" | "가맹";
  region?: string;
  roadAddress?: string;
  openDate?: string | null;
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

export interface DeliveryWindow {
  /** Inclusive local time in Asia/Seoul, formatted HH:mm. */
  start: string;
  /** Exclusive local time in Asia/Seoul, formatted HH:mm. */
  end: string;
}

/** Price-free route projection returned only to the assigned driver. */
export interface DriverRouteStop {
  id: string;
  status: ShipmentStatus;
  plannedDate: string;
  routeSequence?: number;
  deliveryWindow?: DeliveryWindow;
  version: number;
  destination: { name: string; address: string; phone: string };
  items: Array<{ name: string; unit: string; quantity: number }>;
  deliveryNote: string;
  proof?: { recipientName: string; capturedAt: string };
}

export interface DriverDeliveryCompletion {
  shipment: {
    id: string;
    status: "delivered";
    plannedDate: string;
    version: number;
    proof: { recipientName: string; capturedAt: string };
  };
  receipt: { id: string; shipmentId: string; status: "confirmed"; confirmedAt: string };
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
  /** Optional only for records created before route scheduling was introduced. */
  routeSequence?: number;
  /** Optional only for records created before route scheduling was introduced. */
  deliveryWindow?: DeliveryWindow;
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
  kind: SettlementKind;
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
  /** Statutory issuance deadline. Optional only for records created before the Phase 3 migration. */
  dueDate?: string;
  supplier: LegalEntitySnapshot;
  recipient: LegalEntitySnapshot;
  gross: number;
  supply: number;
  vat: number;
  preparedBy: string;
  preparedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  providerReceiptId?: string;
  failureReason?: string;
  originalInvoiceId?: string;
  originalNtsConfirmNumber?: string;
  modificationReasonCode?: "01" | "02" | "03" | "04" | "05" | "06";
  retryCount?: number;
  lastRetriedAt?: string;
  lines: TaxInvoiceLine[];
  version: number;
}

export type OriginalDocumentKind =
  | "payment_request"
  | "delivery_statement"
  | "delivery_proof"
  | "monthly_statement"
  | "tax_invoice";

export type OriginalDocumentAggregateType = "payment_request" | "shipment" | "settlement" | "tax_invoice";

/** Immutable metadata for a versioned original business document stored outside the database. */
export interface OriginalDocument {
  id: string;
  storeId: string;
  kind: OriginalDocumentKind;
  aggregateType: OriginalDocumentAggregateType;
  aggregateId: string;
  /** Version of the source aggregate used to render this immutable document. */
  sourceVersion: number;
  objectKey: string;
  objectVersionId: string;
  contentHashSha256: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  version: number;
}

/** Public metadata intentionally excludes storage coordinates and integrity material. */
export type OriginalDocumentMetadata = Pick<OriginalDocument,
  "id" | "storeId" | "kind" | "aggregateType" | "aggregateId" | "sourceVersion" | "mimeType" | "fileName" | "sizeBytes" | "createdAt">;

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
  /** Opaque fencing token minted for the current lease claim. */
  leaseToken?: string;
  /** The current owner may complete the event only before this instant. */
  leaseExpiresAt?: string;
  deadLetterAt?: string;
}
