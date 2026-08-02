import assert from "node:assert/strict";
import test from "node:test";
import type { TaxInvoice } from "@ofd/domain";
import { readProviderConfig } from "./config.ts";
import { ProductionPopbillProvider, type PopbillSdkServices } from "./popbill.ts";

const config = readProviderConfig({
  APP_MODE: "test", PROVIDER_MODE: "production", POPBILL_PRODUCTION_ENABLED: "true", POPBILL_TAX_INVOICE_ENABLED: "true",
  POPBILL_LINK_ID: "link", POPBILL_SECRET_KEY: "secret", POPBILL_CORP_NUM: "1234567890", POPBILL_USER_ID: "user",
  POPBILL_CERTIFICATE_CONFIGURED: "true", POPBILL_WEBHOOK_API_KEY: "key", POPBILL_BANK_SYNC_ENABLED: "true",
  POPBILL_BANK_ACCOUNT_AUTHORIZED: "true", POPBILL_BANK_CODE: "0004", POPBILL_BANK_ACCOUNT: "1234567890",
  RECONCILIATION_ACCOUNT_ID: "ofd-approved-account", POPBILL_BANK_POLL_MS: "0", POPBILL_BANK_POLL_ATTEMPTS: "3",
  POPBILL_SMS_ENABLED: "true", POPBILL_SMS_SENDER: "0212345678",
});
const invoice: TaxInvoice = {
  id: "invoice-1", storeId: "store-1", settlementId: "settlement-1", issueType: "normal", status: "queued", issueDate: "2026-07-31",
  supplier: { businessNumber: "1234567890", legalName: "본사", representativeName: "본사", address: "서울", businessType: "도소매", businessCategory: "식자재", email: "hq@example.com" },
  recipient: { businessNumber: "2012345678", legalName: "매장", representativeName: "점주", address: "서울", businessType: "음식점", businessCategory: "카페", email: "store@example.com" },
  gross: 11_000, supply: 10_000, vat: 1_000, preparedBy: "finance", version: 2,
  invoiceGroupId: "group-1", partNumber: 1, partCount: 1,
  providerManagementKey: "OFD012345678901234567890",
  lines: [{ id: "line-1", description: "식자재", quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000 }],
};

function baseServices(): PopbillSdkServices {
  return {
    tax: {
      registIssue: (_corp, _invoice, _write, _force, _memo, _email, _dealKey, _user, success) => success({ code: 1 }),
      getInfo: (_corp, _type, _key, _user, _success, error) => error({ code: -110000, message: "not found" }),
    },
    bank: {
      requestJob: (_corp, _bank, _account, _from, _to, _user, success) => success("job"),
      getJobState: (_corp, _job, _user, success) => success({ jobID: "job", jobState: "3", errorCode: 1 }),
      search: (_corp, _job, _trade, _query, _page, _perPage, _order, _user, success) => success({
        code: 1, total: 0, perPage: 1_000, pageNum: 1, pageCount: 1, list: [],
      }),
    },
    message: { sendSMS: (_corp, _sender, _to, _name, _body, _reserve, _ads, _senderName, _requestNum, _user, success) => success("sms") },
  };
}

test("Popbill timeout 뒤 관리키 조회로 실제 접수번호를 확인한 경우만 성공 처리한다", async () => {
  let lookup = 0;
  const services = baseServices();
  services.tax.registIssue = (_corp, _body, _write, _force, _memo, _email, _dealKey, _user, _success, error) => error(new Error("timeout"));
  services.tax.getInfo = (_corp, _type, _key, _user, success, error) => {
    lookup += 1;
    if (lookup === 1) error({ code: -110000, message: "not found" });
    else success({ itemKey: "real-receipt", stateCode: 200 });
  };
  const provider = new ProductionPopbillProvider(config, services);
  const result = await provider.issueTaxInvoice(invoice);
  assert.equal(result.receiptId, "real-receipt");
  assert.equal(lookup, 2);
});

test("Popbill 응답과 관리키 조회 모두 접수번호가 없으면 성공을 금지한다", async () => {
  const services = baseServices();
  services.tax.registIssue = (_corp, _body, _write, _force, _memo, _email, _dealKey, _user, success) => success({ code: 1 });
  const provider = new ProductionPopbillProvider(config, services);
  await assert.rejects(provider.issueTaxInvoice(invoice), /실제 문서/);
});

test("공식 registIssue 인자 순서를 지키고 수정계산서 법정 필드를 전달한다", async () => {
  const services = baseServices();
  let captured: Record<string, unknown> | undefined;
  let lookups = 0;
  services.tax.registIssue = (_corp, body, writeSpecification, forceIssue, memo, emailSubject, _dealKey, _user, success) => {
    captured = { ...(body as Record<string, unknown>), writeSpecification, forceIssue, memo, emailSubject };
    success({ code: 1, message: "success" });
  };
  services.tax.getInfo = (_corp, _type, _key, _user, success, error) => {
    lookups += 1;
    if (lookups === 1) error({ code: -110000 }); else success({ itemKey: "item-key", stateCode: 300 });
  };
  const modified = { ...invoice, issueType: "modified" as const, originalInvoiceId: "original", originalNtsConfirmNumber: "123456789012345678901234", modificationReasonCode: "01" as const };
  await new ProductionPopbillProvider(config, services).issueTaxInvoice(modified);
  assert.equal(captured?.writeSpecification, false);
  assert.equal(captured?.forceIssue, false);
  assert.equal(captured?.modifyCode, 1);
  assert.equal(captured?.orgNTSConfirmNum, "123456789012345678901234");
});

test("Popbill stateCode를 304 성공, 305 실패, 600 취소로 정확히 매핑한다", async () => {
  for (const [stateCode, expected] of [[300, "pending"], [303, "pending"], [304, "success"], [305, "failed"], [600, "cancelled"]] as const) {
    const services = baseServices();
    services.tax.getInfo = (_corp, _type, _key, _user, success) => success({ itemKey: "item", stateCode });
    const status = await new ProductionPopbillProvider(config, services).getTaxInvoiceStatus(invoice);
    assert.equal(status?.ntsStatus, expected);
  }
});

test("계좌 수집 job 완료를 기다린 뒤 모든 페이지를 공식 인자 순서로 가져와 원장 거래로 변환한다", async () => {
  const services = baseServices();
  const states: string[] = [];
  let statePoll = 0;
  const searchedPages: number[] = [];
  services.bank.getJobState = (corp, job, user, success) => {
    states.push(`${corp}:${job}:${user}`);
    statePoll += 1;
    success({ jobID: job, jobState: statePoll === 1 ? "2" : "3", errorCode: statePoll === 1 ? 0 : 1 });
  };
  services.bank.search = (corp, job, tradeTypes, query, page, perPage, order, user, success) => {
    assert.equal(corp, "1234567890");
    assert.equal(job, "job");
    assert.deepEqual(tradeTypes, []);
    assert.equal(query, "");
    assert.equal(perPage, 1_000);
    assert.equal(order, "A");
    assert.equal(user, "user");
    searchedPages.push(page);
    success({
      code: 1,
      total: 2,
      perPage: 1,
      pageNum: page,
      pageCount: 2,
      list: page === 1
        ? [{ tid: "tid-credit", trdt: "20260802112233", accIn: "11000", accOut: "0", remark1: "독산점", remark2: "입금", memo: "7월분" }]
        : [{ tid: "tid-debit", trdt: "20260802130000", accIn: "0", accOut: "3000", remark3: "은행수수료" }],
    });
  };

  const transactions = await new ProductionPopbillProvider(config, services).fetchBankTransactions("2026-08-02", "2026-08-02");

  assert.equal(states.length, 2);
  assert.deepEqual(searchedPages, [1, 2]);
  assert.deepEqual(transactions.map(({ providerId, accountId, occurredAt, amount, direction, memo, matched, version }) => ({
    providerId, accountId, occurredAt, amount, direction, memo, matched, version,
  })), [
    { providerId: "tid-credit", accountId: "ofd-approved-account", occurredAt: "2026-08-02T02:22:33.000Z", amount: 11_000, direction: "credit", memo: "독산점 · 입금 · 7월분", matched: false, version: 1 },
    { providerId: "tid-debit", accountId: "ofd-approved-account", occurredAt: "2026-08-02T04:00:00.000Z", amount: 3_000, direction: "debit", memo: "은행수수료", matched: false, version: 1 },
  ]);
});

test("계좌 수집 실패나 완료 시간초과를 빈 거래 성공으로 숨기지 않는다", async () => {
  const failed = baseServices();
  failed.bank.getJobState = (_corp, _job, _user, success) => success({ jobID: "job", jobState: "3", errorCode: -99999999, errorReason: "은행 인증 만료" });
  await assert.rejects(new ProductionPopbillProvider(config, failed).fetchBankTransactions("2026-08-02", "2026-08-02"), /은행 인증 만료/);

  const timedOut = baseServices();
  timedOut.bank.getJobState = (_corp, _job, _user, success) => success({ jobID: "job", jobState: "2", errorCode: 0 });
  await assert.rejects(new ProductionPopbillProvider(config, timedOut).fetchBankTransactions("2026-08-02", "2026-08-02"), /시간 안에 완료되지/);
});

test("문자 발송은 공식 SDK 인자 순서를 사용하고 실제 접수번호가 없으면 실패한다", async () => {
  const services = baseServices();
  let captured: unknown[] = [];
  services.message.sendSMS = (...args) => {
    captured = args.slice(0, 10);
    args[10]("receipt-18-digits");
  };
  const provider = new ProductionPopbillProvider(config, services);
  assert.deepEqual(await provider.sendSms("010-1234-5678", "배송이 시작됐습니다."), { receiptId: "receipt-18-digits" });
  assert.deepEqual(captured, ["1234567890", "0212345678", "01012345678", "", "배송이 시작됐습니다.", "", false, "", "", "user"]);

  services.message.sendSMS = (...args) => args[10]("");
  await assert.rejects(provider.sendSms("01012345678", "배송 완료"), /접수번호/);
});
