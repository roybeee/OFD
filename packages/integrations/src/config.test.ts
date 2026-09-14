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

const localBase = {
  NODE_ENV: "production", APP_MODE: "local", WORKSTATION_BRAND: "oda", REPOSITORY_MODE: "postgres", ODA_LOCAL_ENABLED: "true",
  WEB_ORIGIN: "http://127.0.0.1:4175", PUBLIC_APP_URL: "http://127.0.0.1:4175",
  SESSION_SECRET: "local-config-test-session-secret-32characters", ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
};

test("ODA local accepts a production build only with all durable loopback enablers", () => {
  const config = readProviderConfig(localBase);
  assert.equal(config.appMode, "local");
  assert.equal(config.providerMode, "mock");
  for (const field of ["WORKSTATION_BRAND", "REPOSITORY_MODE", "ODA_LOCAL_ENABLED", "WEB_ORIGIN", "PUBLIC_APP_URL", "SESSION_SECRET", "ENCRYPTION_KEY"]) {
    assert.throws(() => readProviderConfig({ ...localBase, [field]: undefined }), field);
  }
});

test("ODA local rejects exposure, demo persistence and external side effects", () => {
  for (const changed of [
    { WORKSTATION_BRAND: "ofd" }, { REPOSITORY_MODE: "memory" }, { ODA_LOCAL_ENABLED: "false" },
    { WEB_ORIGIN: "http://localhost:4175" }, { PUBLIC_APP_URL: "https://oda.example" },
    { SESSION_SECRET: "short" }, { ENCRYPTION_KEY: "invalid" }, { PROVIDER_MODE: "production" },
    { STORAGE_MODE: "s3" }, { EMAIL_PROVIDER: "smtp" }, { POPBILL_TAX_INVOICE_ENABLED: "true" },
    { POPBILL_BANK_SYNC_ENABLED: "true" }, { POPBILL_SMS_ENABLED: "true" }, { POPBILL_PRODUCTION_ENABLED: "true" },
  ]) assert.throws(() => readProviderConfig({ ...localBase, ...changed }), JSON.stringify(changed));
});
