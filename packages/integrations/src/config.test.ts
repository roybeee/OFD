import assert from "node:assert/strict";
import test from "node:test";
import { readProviderConfig } from "./config.ts";

test("mock provider는 자격증명 없이 안전하게 기동한다", () => {
  assert.equal(readProviderConfig({ PROVIDER_MODE: "mock", APP_MODE: "demo" }).providerMode, "mock");
});

test("production provider는 모든 명시적 게이트가 없으면 fail-closed 한다", () => {
  assert.throws(() => readProviderConfig({ PROVIDER_MODE: "production" }), /안전 조건/);
});

test("production provider는 인증서와 계좌 권한까지 확인한다", () => {
  const config = readProviderConfig({
    PROVIDER_MODE: "production", APP_MODE: "production", POPBILL_PRODUCTION_ENABLED: "true", POPBILL_TAX_INVOICE_ENABLED: "true",
    POPBILL_LINK_ID: "link", POPBILL_SECRET_KEY: "secret", POPBILL_CORP_NUM: "1234567890", POPBILL_USER_ID: "user",
    POPBILL_CERTIFICATE_CONFIGURED: "true", POPBILL_BANK_ACCOUNT_AUTHORIZED: "true", POPBILL_BANK_CODE: "004",
    POPBILL_BANK_ACCOUNT: "000000000000", POPBILL_SMS_SENDER: "0212345678", POPBILL_WEBHOOK_API_KEY: "webhook-key",
    STORAGE_MODE: "s3", S3_REGION: "ap-northeast-2", S3_BUCKET: "ofd", S3_KMS_KEY_ID: "kms-key",
    EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com",
  });
  assert.equal(config.providerMode, "production");
});

test("NODE_ENV production은 APP_MODE 누락이나 demo를 거부한다", () => {
  assert.throws(() => readProviderConfig({ NODE_ENV: "production" }), /APP_MODE=production/);
  assert.throws(() => readProviderConfig({ NODE_ENV: "production", APP_MODE: "demo" }), /APP_MODE=production/);
});

const productionBase = {
  PROVIDER_MODE: "production", APP_MODE: "production", POPBILL_PRODUCTION_ENABLED: "true",
  POPBILL_LINK_ID: "link", POPBILL_SECRET_KEY: "secret", POPBILL_CORP_NUM: "1234567890", POPBILL_USER_ID: "user",
  POPBILL_WEBHOOK_API_KEY: "webhook-key",
  STORAGE_MODE: "s3", S3_REGION: "ap-northeast-2", S3_BUCKET: "ofd", S3_KMS_KEY_ID: "kms-key",
  EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com",
};

test("Popbill 기능별 안전 조건을 독립적으로 강제한다", () => {
  assert.throws(() => readProviderConfig({ ...productionBase, POPBILL_TAX_INVOICE_ENABLED: "true" }), /CERTIFICATE/);
  assert.throws(() => readProviderConfig({ ...productionBase, POPBILL_BANK_SYNC_ENABLED: "true" }), /BANK_ACCOUNT_AUTHORIZED/);
  assert.throws(() => readProviderConfig({ ...productionBase, POPBILL_SMS_ENABLED: "true" }), /SMS_SENDER/);
  assert.doesNotThrow(() => readProviderConfig(productionBase));
});
