import assert from "node:assert/strict";
import test from "node:test";
import { readProviderConfig, assertWorkerProfile } from "./config.ts";
import { createIntegrationProviders } from "./index.ts";

const env = { NODE_ENV: "production", APP_MODE: "production", WORKSTATION_BRAND: "oda", REPOSITORY_MODE: "postgres",
  ODA_SETTLEMENT_ONLY: "true", PROVIDER_MODE: "disabled", STORAGE_MODE: "postgres", EMAIL_PROVIDER: "disabled",
  DATABASE_URL: "postgresql://oda_app:unused@db/oda_production", WEB_ORIGIN: "https://oda.example.com", PUBLIC_APP_URL: "https://oda.example.com",
  SESSION_COOKIE_SECURE: "true", SESSION_SECRET: "test-oda-production-session-32characters", ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };

test("restricted ODA production requires durable evidence and explicit disabled external providers", () => {
  assert.equal(readProviderConfig(env).appMode, "production");
  assert.equal(readProviderConfig(env).storageMode, "postgres");
  assert.equal(readProviderConfig(env).providerMode, "disabled");
  for (const changed of [
    { NODE_ENV: "development" }, { APP_MODE: "local" }, { WORKSTATION_BRAND: "ofd" }, { REPOSITORY_MODE: "memory" },
    { ODA_SETTLEMENT_ONLY: undefined }, { PROVIDER_MODE: "mock" }, { STORAGE_MODE: "mock" }, { EMAIL_PROVIDER: "smtp" },
    { DATABASE_URL: "sqlite:memory" }, { WEB_ORIGIN: "https://other.example.com" }, { WEB_ORIGIN: "http://oda.example.com" },
    { WEB_ORIGIN: "https://oda.example.com/" }, { SESSION_COOKIE_SECURE: "false" }, { SESSION_SECRET: "short" }, { ENCRYPTION_KEY: "bad" },
    { POPBILL_PRODUCTION_ENABLED: "true" }, { POPBILL_BANK_SYNC_ENABLED: "1" }, { POPBILL_TAX_INVOICE_ENABLED: "true" }, { POPBILL_SMS_ENABLED: "true" },
  ]) assert.throws(() => readProviderConfig({ ...env, ...changed }), JSON.stringify(changed));
});

test("restricted provider factories fail visibly for every external operation and never mock success", async () => {
  const providers = createIntegrationProviders(readProviderConfig(env));
  for (const invoke of [
    () => providers.email.send("test@example.com", "subject", "body"),
    () => providers.popbill.fetchBankTransactions("2026-01-01", "2026-01-31"),
    () => providers.popbill.issueTaxInvoice({} as never),
    () => providers.popbill.getTaxInvoiceStatus({} as never),
    () => providers.popbill.getTaxInvoiceOriginal({} as never),
    () => providers.popbill.sendSms("01000000000", "test"),
    () => providers.storage.createDeliveryProofUpload("test", "image/png"),
    () => providers.storage.createReadUrl("test", "v1"),
    () => providers.storage.verifyDeliveryProof("test", "test"),
    () => providers.storage.getImmutableObject("test", "v1"),
    () => providers.storage.putImmutableObject({ objectKey: "original-documents/test", bytes: new Uint8Array([1]), mimeType: "text/plain", fileName: "test.txt" }),
  ]) await assert.rejects(invoke(), { code: "ODA_EXTERNAL_DISABLED" });
  assert.equal((await providers.storage.checkReadiness()).ok, false, "generic adapter cannot certify repository persistence");
});

test("ODA-only worker is rejected before boot; OFD and local defaults are unchanged", () => {
  assert.throws(() => assertWorkerProfile(readProviderConfig(env)), { code: "ODA_WORKER_DISABLED" });
  assert.throws(() => readProviderConfig({ ...env, SERVICE_ROLE: "worker" }), { code: "ODA_WORKER_DISABLED" });
  assert.doesNotThrow(() => assertWorkerProfile(readProviderConfig({ APP_MODE: "test" })));
  assert.throws(() => readProviderConfig({ APP_MODE: "production", NODE_ENV: "production", STORAGE_MODE: "mock", EMAIL_PROVIDER: "mock" }), /STORAGE_MODE=s3/);
});
