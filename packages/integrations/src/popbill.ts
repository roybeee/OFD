import { createHash } from "node:crypto";
import { DomainError, type BankTransaction, type TaxInvoice } from "@ofd/domain";
import type { ProviderConfig } from "./config.ts";

export interface TaxInvoiceIssueResult {
  receiptId: string;
  serialNumber?: string;
  issuedAt: string;
  ntsStatus: "pending" | "success" | "failed" | "cancelled";
}

export interface SmsResult {
  receiptId: string;
}

export interface PopbillProvider {
  issueTaxInvoice(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult>;
  getTaxInvoiceStatus(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult | undefined>;
  fetchBankTransactions(from: string, to: string): Promise<BankTransaction[]>;
  sendSms(to: string, body: string, requestKey?: string): Promise<SmsResult>;
}

export class MockPopbillProvider implements PopbillProvider {
  private readonly invoices = new Map<string, TaxInvoiceIssueResult>();

  async issueTaxInvoice(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult> {
    if (invoice.issueType === "internal_statement") {
      throw new DomainError("INTERNAL_STATEMENT_ONLY", "동일 사업자번호 직영점에는 세금계산서를 발행하지 않습니다.", 409);
    }
    const digest = createHash("sha256").update(invoice.id).digest("hex").slice(0, 12).toUpperCase();
    const existing = this.invoices.get(invoice.id);
    if (existing) return existing;
    const result = { receiptId: `MOCK-PB-${digest}`, serialNumber: `2026-${digest.slice(0, 8)}`, issuedAt: new Date().toISOString(), ntsStatus: "pending" as const };
    this.invoices.set(invoice.id, result);
    return result;
  }

  async getTaxInvoiceStatus(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult | undefined> { return this.invoices.get(invoice.id); }

  async fetchBankTransactions(_from: string, _to: string): Promise<BankTransaction[]> {
    return [];
  }

  async sendSms(to: string, body: string): Promise<SmsResult> {
    if (!/^01[016789][0-9]{7,8}$/.test(to.replaceAll("-", ""))) throw new DomainError("INVALID_PHONE", "수신 번호가 올바르지 않습니다.");
    if (body.length === 0) throw new DomainError("EMPTY_MESSAGE", "메시지 내용이 필요합니다.");
    return { receiptId: `MOCK-SMS-${createHash("sha1").update(`${to}:${body}`).digest("hex").slice(0, 12)}` };
  }
}

type CallbackSuccess<T> = (result: T) => void;
type CallbackError = (error: { code?: number; message?: string } | Error) => void;

interface PopbillTaxService {
  registIssue(corpNum: string, invoice: unknown, writeSpecification: boolean, forceIssue: boolean, memo: string,
    emailSubject: string, dealInvoiceMgtKey: string | null, userId: string,
    success: CallbackSuccess<{ code?: number; message?: string; ntsConfirmNum?: string }>, error: CallbackError): void;
  getInfo(corpNum: string, mgtKeyType: "SELL", mgtKey: string, userId: string,
    success: CallbackSuccess<{ itemKey?: string; ntsconfirmNum?: string; stateCode?: number; writeDate?: string }>, error: CallbackError): void;
}

interface PopbillBankService {
  requestJob(corpNum: string, bankCode: string, accountNumber: string, startDate: string, endDate: string,
    userId: string, success: CallbackSuccess<string>, error: CallbackError): void;
  getJobState(corpNum: string, jobId: string, userId: string,
    success: CallbackSuccess<PopbillBankJobState>, error: CallbackError): void;
  search(corpNum: string, jobId: string, tradeTypes: string[], searchString: string, page: number, perPage: number,
    order: "A" | "D", userId: string, success: CallbackSuccess<PopbillBankSearchResult>, error: CallbackError): void;
}

interface PopbillMessageService {
  sendSMS(corpNum: string, sender: string, receiver: string, receiverName: string, content: string, reserveDT: string,
    adsYN: boolean, senderName: string, requestNum: string, userId: string,
    success: CallbackSuccess<string>, error: CallbackError): void;
}

interface PopbillBankJobState {
  jobID?: string;
  jobState?: string | number;
  errorCode?: number;
  errorReason?: string;
}

interface PopbillBankSearchDetail {
  tid?: string;
  trdt?: string;
  accIn?: string;
  accOut?: string;
  remark1?: string;
  remark2?: string;
  remark3?: string;
  remark4?: string;
  memo?: string;
}

interface PopbillBankSearchResult {
  code?: number;
  message?: string;
  total?: number;
  perPage?: number;
  pageNum?: number;
  pageCount?: number;
  list?: PopbillBankSearchDetail[];
}

export interface PopbillSdkServices {
  tax: PopbillTaxService;
  bank: PopbillBankService;
  message: PopbillMessageService;
}

export async function loadPopbillSdkServices(config: ProviderConfig): Promise<PopbillSdkServices> {
  const imported = await import("popbill");
  const sdk = imported.default;
  sdk.config({
    LinkID: config.popbillLinkId,
    SecretKey: config.popbillSecretKey,
    IsTest: false,
    IPRestrictOnOff: true,
    UseStaticIP: false,
    UseLocalTimeYN: true,
  });
  return {
    tax: sdk.TaxinvoiceService() as PopbillTaxService,
    bank: sdk.EasyFinBankService() as PopbillBankService,
    message: sdk.MessageService() as PopbillMessageService,
  };
}

export class ProductionPopbillProvider implements PopbillProvider {
  constructor(private readonly config: ProviderConfig, private readonly services: PopbillSdkServices) {}

  async issueTaxInvoice(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult> {
    if (!this.config.taxInvoiceEnabled) throw new DomainError("TAX_ISSUANCE_DISABLED", "실세금계산서 발행 스위치가 비활성화되어 있습니다.", 503);
    if (invoice.issueType !== "normal" && invoice.issueType !== "modified") {
      throw new DomainError("INTERNAL_STATEMENT_ONLY", "동일 사업자번호 직영점에는 세금계산서를 발행하지 않습니다.", 409);
    }
    if (invoice.issueType === "modified") {
      if (!invoice.originalInvoiceId || !invoice.modificationReasonCode || !invoice.originalNtsConfirmNumber || !/^\d{24}$/.test(invoice.originalNtsConfirmNumber)) {
        throw new DomainError("MODIFIED_INVOICE_NOT_READY", "수정세금계산서는 원본과 24자리 국세청 승인번호, 법정 수정사유가 필요합니다.", 409);
      }
    }
    const issuePayload = {
      writeDate: invoice.issueDate.replaceAll("-", ""),
      chargeDirection: "정과금", issueType: "정발행", purposeType: "영수", taxType: "과세",
      invoicerCorpNum: invoice.supplier.businessNumber.replaceAll("-", ""), invoicerCorpName: invoice.supplier.legalName,
      invoicerMgtKey: invoice.providerManagementKey, invoicerCEOName: invoice.supplier.representativeName,
      invoicerAddr: invoice.supplier.address, invoicerBizType: invoice.supplier.businessType,
      invoicerBizClass: invoice.supplier.businessCategory, invoicerEmail: invoice.supplier.email,
      invoiceeType: "사업자", invoiceeCorpNum: invoice.recipient.businessNumber.replaceAll("-", ""),
      invoiceeCorpName: invoice.recipient.legalName, invoiceeCEOName: invoice.recipient.representativeName,
      invoiceeAddr: invoice.recipient.address, invoiceeBizType: invoice.recipient.businessType,
      invoiceeBizClass: invoice.recipient.businessCategory, invoiceeEmail1: invoice.recipient.email,
      supplyCostTotal: String(invoice.supply), taxTotal: String(invoice.vat), totalAmount: String(invoice.gross),
      detailList: invoice.lines.map((line, index) => ({ serialNum: index + 1, purchaseDT: invoice.issueDate.replaceAll("-", ""),
        itemName: line.description, qty: String(line.quantity), supplyCost: String(line.supply), tax: String(line.vat) })),
      ...(invoice.issueType === "modified" ? { modifyCode: Number(invoice.modificationReasonCode), orgNTSConfirmNum: invoice.originalNtsConfirmNumber } : {}),
    };
    const existing = await this.getTaxInvoiceStatus(invoice);
    if (existing) return existing;
    let result: { code?: number; message?: string; ntsConfirmNum?: string };
    try {
      result = await new Promise<{ code?: number; message?: string; ntsConfirmNum?: string }>((resolve, reject) => {
        this.services.tax.registIssue(this.config.popbillCorpNum!, issuePayload, false, false, "OFD 자동 발행", "", null,
          this.config.popbillUserId!, resolve, (error) => reject(toProviderError(error)));
      });
    } catch (error) {
      const reconciled = await this.getTaxInvoiceStatus(invoice);
      if (reconciled) return reconciled;
      throw error;
    }
    if (result.code !== 1) throw new DomainError("POPBILL_ISSUE_REJECTED", result.message ?? "Popbill 발행이 거절되었습니다.", 502, { providerCode: result.code });
    const reconciled = await this.getTaxInvoiceStatus(invoice);
    if (!reconciled) throw new DomainError("POPBILL_AMBIGUOUS_RESULT", "발행 응답 후 관리키 조회에서 실제 문서를 확인하지 못했습니다.", 502);
    if (reconciled.ntsStatus === "failed" || reconciled.ntsStatus === "cancelled") {
      throw new DomainError("POPBILL_ISSUE_NOT_ACTIVE", "Popbill 문서가 실패 또는 취소 상태입니다.", 502, { ntsStatus: reconciled.ntsStatus });
    }
    return reconciled;
  }

  async getTaxInvoiceStatus(invoice: TaxInvoice): Promise<TaxInvoiceIssueResult | undefined> {
    try {
      const result = await new Promise<{ itemKey?: string; ntsconfirmNum?: string; stateCode?: number }>((resolve, reject) => {
        this.services.tax.getInfo(this.config.popbillCorpNum!, "SELL", invoice.providerManagementKey, this.config.popbillUserId!, resolve, reject);
      });
      if (!result.itemKey) return undefined;
      const stateCode = Number(result.stateCode ?? 0);
      const ntsStatus: TaxInvoiceIssueResult["ntsStatus"] = stateCode === 304 ? "success"
        : stateCode === 305 ? "failed" : stateCode === 600 ? "cancelled" : "pending";
      return { receiptId: result.itemKey, ...(result.ntsconfirmNum ? { serialNumber: result.ntsconfirmNum } : {}),
        issuedAt: new Date().toISOString(), ntsStatus };
    } catch (error) {
      const code = error instanceof Error ? undefined : (error as { code?: number }).code;
      if (code === -110000 || code === -120000) return undefined;
      throw toProviderError(error as { code?: number; message?: string } | Error);
    }
  }

  async fetchBankTransactions(from: string, to: string): Promise<BankTransaction[]> {
    if (!this.config.bankSyncEnabled) throw new DomainError("BANK_SYNC_DISABLED", "Popbill 계좌조회 기능이 비활성화되어 있습니다.", 503);
    const jobId = await new Promise<string>((resolve, reject) => {
      this.services.bank.requestJob(this.config.popbillCorpNum!, this.config.popbillBankCode!, this.config.popbillBankAccount!,
        from.replaceAll("-", ""), to.replaceAll("-", ""), this.config.popbillUserId!, resolve,
        (error) => reject(toProviderError(error)));
    });
    if (!jobId) throw new DomainError("POPBILL_BANK_JOB_MISSING", "Popbill 계좌 수집 작업번호가 반환되지 않았습니다.", 502);

    for (let attempt = 1; attempt <= this.config.bankPollAttempts; attempt += 1) {
      const state = await new Promise<PopbillBankJobState>((resolve, reject) => {
        this.services.bank.getJobState(this.config.popbillCorpNum!, jobId, this.config.popbillUserId!, resolve,
          (error) => reject(toProviderError(error)));
      });
      if (Number(state.jobState) === 3) {
        if (state.errorCode !== 1) {
          throw new DomainError("POPBILL_BANK_COLLECTION_FAILED", state.errorReason || "Popbill 계좌 거래내역 수집에 실패했습니다.", 502,
            { providerCode: state.errorCode, jobId });
        }
        return this.searchBankTransactions(jobId);
      }
      if (attempt < this.config.bankPollAttempts) await delay(this.config.bankPollIntervalMs);
    }
    throw new DomainError("POPBILL_BANK_JOB_TIMEOUT", "Popbill 계좌 수집 작업이 제한 시간 안에 완료되지 않았습니다.", 504, { jobId });
  }

  async sendSms(to: string, body: string, requestKey?: string): Promise<SmsResult> {
    if (!this.config.smsEnabled) throw new DomainError("SMS_DISABLED", "Popbill 문자 기능이 비활성화되어 있습니다.", 503);
    const receiver = to.replaceAll("-", "");
    if (!/^01[016789][0-9]{7,8}$/.test(receiver)) throw new DomainError("INVALID_PHONE", "수신 번호가 올바르지 않습니다.");
    if (!body.trim()) throw new DomainError("EMPTY_MESSAGE", "메시지 내용이 필요합니다.");
    const requestNum = requestKey ? `OFD-${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}` : "";
    const receiptId = await new Promise<string>((resolve, reject) => {
      this.services.message.sendSMS(this.config.popbillCorpNum!, this.config.popbillSmsSender!, receiver, "", body, "", false,
        "", requestNum, this.config.popbillUserId!, resolve, (error) => reject(toProviderError(error)));
    });
    if (!receiptId) throw new DomainError("POPBILL_SMS_AMBIGUOUS_RESULT", "Popbill 문자 접수번호를 확인하지 못했습니다.", 502);
    return { receiptId };
  }

  private async searchBankTransactions(jobId: string): Promise<BankTransaction[]> {
    const transactions = new Map<string, BankTransaction>();
    let page = 1;
    let pageCount = 1;
    do {
      const result = await new Promise<PopbillBankSearchResult>((resolve, reject) => {
        this.services.bank.search(this.config.popbillCorpNum!, jobId, [], "", page, 1_000, "A", this.config.popbillUserId!, resolve,
          (error) => reject(toProviderError(error)));
      });
      if (result.code !== undefined && result.code !== 1) {
        throw new DomainError("POPBILL_BANK_SEARCH_REJECTED", result.message || "Popbill 계좌 거래내역 조회가 거절되었습니다.", 502,
          { providerCode: result.code, jobId, page });
      }
      const reportedPageCount = Number(result.pageCount ?? 1);
      if (!Number.isSafeInteger(reportedPageCount) || reportedPageCount < 1 || reportedPageCount > 10_000) {
        throw new DomainError("POPBILL_BANK_INVALID_PAGE_COUNT", "Popbill 계좌 거래내역 페이지 정보가 올바르지 않습니다.", 502, { jobId });
      }
      pageCount = reportedPageCount;
      for (const detail of result.list ?? []) {
        const transaction = bankTransactionFrom(detail, this.config.reconciliationAccountId);
        const existing = transactions.get(transaction.providerId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(transaction)) {
          throw new DomainError("POPBILL_BANK_DUPLICATE_CONFLICT", "같은 Popbill 거래 ID가 서로 다른 내용으로 반환되었습니다.", 502,
            { providerId: transaction.providerId });
        }
        transactions.set(transaction.providerId, transaction);
      }
      page += 1;
    } while (page <= pageCount);
    return [...transactions.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.providerId.localeCompare(b.providerId));
  }
}

function bankTransactionFrom(detail: PopbillBankSearchDetail, accountId: string): BankTransaction {
  const providerId = detail.tid?.trim() ?? "";
  if (!providerId) throw new DomainError("POPBILL_BANK_TID_MISSING", "Popbill 계좌 거래 ID가 없습니다.", 502);
  const credit = parseProviderMoney(detail.accIn);
  const debit = parseProviderMoney(detail.accOut);
  if ((credit > 0) === (debit > 0)) {
    throw new DomainError("POPBILL_BANK_DIRECTION_AMBIGUOUS", "Popbill 계좌 거래의 입출금 방향을 확정할 수 없습니다.", 502, { providerId });
  }
  const memo = [detail.remark1, detail.remark2, detail.remark3, detail.remark4, detail.memo]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join(" · ") || "적요 없음";
  return {
    id: `pb-bank-${createHash("sha256").update(providerId).digest("hex").slice(0, 32)}`,
    providerId,
    accountId,
    occurredAt: parsePopbillKst(detail.trdt, providerId),
    amount: credit || debit,
    direction: credit > 0 ? "credit" : "debit",
    memo,
    matched: false,
    version: 1,
  };
}

function parseProviderMoney(value: string | undefined): number {
  const normalized = (value ?? "0").replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) throw new DomainError("POPBILL_BANK_INVALID_AMOUNT", "Popbill 계좌 거래 금액이 올바르지 않습니다.", 502);
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) throw new DomainError("POPBILL_BANK_INVALID_AMOUNT", "Popbill 계좌 거래 금액이 안전한 범위를 벗어났습니다.", 502);
  return amount;
}

function parsePopbillKst(value: string | undefined, providerId: string): string {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) throw new DomainError("POPBILL_BANK_INVALID_TIME", "Popbill 계좌 거래시각이 올바르지 않습니다.", 502, { providerId });
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!, hour! - 9, minute!, second!);
  const local = new Date(timestamp + 9 * 60 * 60 * 1_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month! - 1 || local.getUTCDate() !== day
    || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) {
    throw new DomainError("POPBILL_BANK_INVALID_TIME", "Popbill 계좌 거래시각이 존재하지 않는 날짜입니다.", 502, { providerId });
  }
  return new Date(timestamp).toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function toProviderError(error: { code?: number; message?: string } | Error): DomainError {
  const message = error instanceof Error ? error.message : error.message ?? "Popbill 요청에 실패했습니다.";
  const code = error instanceof Error ? undefined : error.code;
  return new DomainError("POPBILL_ERROR", message, 502, { providerCode: code });
}
