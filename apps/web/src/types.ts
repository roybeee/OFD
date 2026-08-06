export type Role = 'store' | 'hq' | 'driver';
export type ProviderMeta = {
  apiVersion: string;
  appMode: string;
  providerMode: 'disabled' | 'production' | string;
  externalIssueEnabled: boolean;
  operationalDate?: string;
  timeZone?: string;
};

export type Product = {
  id: string;
  name: string;
  unit: string;
  grossPrice: number;
  category: string;
  recommended?: boolean;
  note?: string;
};

export type OrderStatus = 'draft' | 'submitted' | 'change_requested' | 'approved' | 'rejected' | 'cancelled' | 'preparing' | 'out_for_delivery' | 'delivered';

export type Order = {
  id: string;
  code: string;
  storeName: string;
  createdAt: string;
  deliveryDate: string;
  itemCount: number;
  grossAmount: number | null;
  supplyAmount: number | null;
  vatAmount: number | null;
  status: OrderStatus;
  paymentTerm: 'prepaid' | 'monthly_credit' | 'unconfigured';
  risk?: 'price_changed' | 'new_store' | 'over_credit' | null;
  ownerName?: string;
  version: number;
  storeId?: string;
  storeAddress?: string;
  source?: 'native' | 'legacy_unverified';
  changeRequest?: { reason: string; requestedBy: string; requestedAt: string };
  lines?: Array<{ id: string; productId?: string; name: string; unit: string; quantity: number; unitGross: number | null; gross: number | null; supply: number | null; vat: number | null }>;
  timeline: Array<{ label: string; at?: string; active?: boolean; done?: boolean }>;
};

export type Delivery = {
  id: string;
  sequence?: number;
  storeName: string;
  address: string;
  phone: string;
  window: string;
  itemCount: number;
  status: 'ready' | 'driving' | 'delivered';
  notes?: string;
  recipientName?: string;
  version?: number;
  orderId?: string;
  driverId?: string;
  plannedDate?: string;
  lines?: Array<{ name: string; unit: string; quantity: number }>;
};

export type BankMatch = {
  id: string;
  depositor: string;
  amount: number;
  transferredAt: string;
  storeName?: string;
  status: 'auto_matched' | 'manual_review' | 'overdue';
  candidates?: number;
  paymentRequestId?: string;
  bankTransactionId?: string;
  version?: number;
  candidateOptions?: Array<{ paymentRequestId: string; bankTransactionId: string; storeName: string; version: number; label: string }>;
};

export type PaymentRequestStatus = 'pending' | 'matching' | 'manual_review' | 'paid' | 'reversed' | 'cancelled';
export type PaymentRequestItem = {
  id: string; storeId: string; storeName: string; orderId?: string; settlementId?: string;
  amount: number; dueDate: string; status: PaymentRequestStatus; depositorHint: string;
  matchedBankTransactionId?: string; version: number; createdAt: string; overdue: boolean;
};

export type BankTransactionItem = {
  id: string; providerId: string; accountId: string; occurredAt: string; amount: number;
  direction: 'credit' | 'debit'; memo: string; matched: boolean; version: number;
};

export type ManualMatchCandidate = {
  paymentRequestId: string; bankTransactionId: string; storeId: string; storeName: string;
  amount: number; requestVersion: number; label: string;
};

export type SettlementStatus = 'open' | 'draft' | 'reviewed' | 'approved' | 'locked';
export type SettlementItem = {
  id: string; storeId: string; storeName: string; periodStart: string; periodEnd: string;
  status: SettlementStatus; receiptIds: string[]; grossAmount: number; supplyAmount: number; vatAmount: number;
  reviewedBy?: string; reviewedByName?: string; reviewedAt?: string;
  approvedBy?: string; approvedByName?: string; approvedAt?: string; version: number;
};

export type MonthlySettlementRow = {
  storeId: string; code: string; name: string; storeKind: '직영' | '가맹' | null;
  supplyConfirmed: number; receiptCount: number; settledGross: number; settlementCount: number;
  invoiceSummary: { total: number; ntsSuccess: number; failed: number; inProgress: number };
  posRevenue: number; posQty: number; supplyToPosPct: number | null;
  receivedQty: number | null; soldQty: number; wasteQty: number | null; lossRate: number | null;
};
export type MonthlySettlementSummary = {
  month: string;
  rows: MonthlySettlementRow[];
  totals: Omit<MonthlySettlementRow, 'storeId' | 'code' | 'name' | 'storeKind' | 'supplyToPosPct'>;
};

export type ModificationReasonCode = '01' | '02' | '03' | '04' | '05' | '06';

export type Invoice = {
  id: string;
  storeName: string;
  period: string;
  grossAmount: number;
  supplyAmount: number;
  vatAmount: number;
  status: 'draft' | 'reviewed' | 'approved' | 'queued' | 'issued' | 'nts_pending' | 'nts_success' | 'failed' | 'cancelled' | 'internal_statement';
  preparedBy: string;
  preparedById: string;
  dueDate: string;
  sameBusinessNumber?: boolean;
  version?: number;
  issueDate?: string;
  supplierName?: string;
  supplierBusinessNumber?: string;
  recipientName?: string;
  recipientBusinessNumber?: string;
  settlementId?: string;
  invoiceGroupId?: string;
  partNumber?: number;
  partCount?: number;
  issueType?: 'normal' | 'internal_statement' | 'modified';
  reviewedBy?: string;
  reviewedByName?: string;
  approvedBy?: string;
  approvedByName?: string;
  serialNumber?: string;
  failureReason?: string;
  originalInvoiceId?: string;
  originalNtsConfirmNumber?: string;
  modificationReasonCode?: ModificationReasonCode;
  preparedAt?: string;
  reviewedAt?: string;
  approvedAt?: string;
  retryCount?: number;
  lastRetriedAt?: string;
};

export type DocumentItem = {
  id: string;
  type: 'monthly_statement' | 'tax_invoice' | 'internal_statement' | 'delivery_statement' | 'payment_request';
  title: string;
  period: string;
  amount: number;
  status: Invoice['status'] | 'scheduled' | 'paid' | 'pending';
  downloadDocumentId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type BootstrapData = {
  actor: { id: string; name: string; role: string };
  store: { id: string; name: string; businessName: string; billingPolicy: string; paymentTerm: string };
  products: Product[];
  orders: Order[];
  deliveries: Delivery[];
  bankMatches: BankMatch[];
  paymentRequests: PaymentRequestItem[];
  bankTransactions: BankTransactionItem[];
  manualMatchCandidates: ManualMatchCandidate[];
  settlements: SettlementItem[];
  invoices: Invoice[];
  documents: DocumentItem[];
  generatedAt: string;
  supportEmail?: string;
  availableActors?: Array<{ id: string; name: string; role: string }>;
  drivers: Array<{ id: string; name: string }>;
  stores: Array<{ id: string; name: string; storeKind?: '직영' | '가맹'; code?: string;
    region?: string; roadAddress?: string; notificationPhone?: string; openDate?: string | null; active?: boolean; version?: number }>;
  capabilities: string[];
  allowedDeliveryDates: string[];
  routeDates: string[];
  meta: ProviderMeta;
};

export type PublicActor = { id: string; name: string; role: string; storeIds: string[] };
export type ProvisionableActorRole = 'store_owner' | 'store_staff' | 'driver' | 'hq_ops' | 'hq_finance' | 'hq_master' | 'auditor';
export type AdminActorSummary = PublicActor & {
  active: boolean;
  version: number;
  email: string;
  mfaEnabled: boolean;
  lastLoginAt?: string;
  lockedUntil?: string;
};

export type Toast = { id: number; tone: 'success' | 'info' | 'warning'; message: string };
