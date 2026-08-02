import { DomainError } from "@ofd/domain";

export interface ProviderConfig {
  appMode: "demo" | "production" | "test";
  providerMode: "mock" | "production";
  storageMode: "mock" | "s3";
  emailProvider: "mock" | "smtp";
  taxInvoiceEnabled: boolean;
  bankSyncEnabled: boolean;
  smsEnabled: boolean;
  popbillProductionEnabled: boolean;
  popbillLinkId?: string;
  popbillSecretKey?: string;
  popbillCorpNum?: string;
  popbillUserId?: string;
  popbillCertificateConfigured: boolean;
  popbillBankAccountAuthorized: boolean;
  popbillBankCode?: string;
  popbillBankAccount?: string;
  reconciliationAccountId: string;
  bankPollIntervalMs: number;
  bankPollAttempts: number;
  popbillSmsSender?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3KmsKeyId?: string;
  uploadMaxBytes: number;
  popbillWebhookApiKey?: string;
}

const bool = (value: string | undefined): boolean => value === "true";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new DomainError("INVALID_PROVIDER_INTERVAL", `${name}은(는) ${min}~${max} 범위의 정수여야 합니다.`, 503);
  }
  return parsed;
}

export function readProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const providerMode = env.PROVIDER_MODE === "production" ? "production" : "mock";
  if (env.APP_MODE && !new Set(["demo", "test", "production"]).has(env.APP_MODE)) {
    throw new DomainError("INVALID_APP_MODE", "APP_MODE는 demo, test, production 중 하나여야 합니다.", 503);
  }
  if (env.NODE_ENV === "production" && env.APP_MODE !== "production") {
    throw new DomainError("APP_MODE_FAIL_CLOSED", "NODE_ENV=production에서는 APP_MODE=production을 명시해야 합니다.", 503);
  }
  const appMode = env.APP_MODE === "production" ? "production" : env.APP_MODE === "test" ? "test" : "demo";
  const storageMode = env.STORAGE_MODE === "s3" ? "s3" : "mock";
  const emailProvider = env.EMAIL_PROVIDER === "smtp" ? "smtp" : "mock";
  if (appMode === "production" && storageMode !== "s3") throw new DomainError("STORAGE_FAIL_CLOSED", "production에서는 STORAGE_MODE=s3가 필요합니다.", 503);
  if (appMode === "production" && emailProvider !== "smtp") throw new DomainError("EMAIL_FAIL_CLOSED", "production에서는 EMAIL_PROVIDER=smtp가 필요합니다.", 503);
  const uploadMaxBytes = Number(env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes < 1 || uploadMaxBytes > 25 * 1024 * 1024) {
    throw new DomainError("INVALID_UPLOAD_LIMIT", "UPLOAD_MAX_BYTES는 1~25MB 범위의 정수여야 합니다.", 503);
  }
  const config: ProviderConfig = {
    appMode,
    providerMode,
    storageMode,
    emailProvider,
    taxInvoiceEnabled: bool(env.POPBILL_TAX_INVOICE_ENABLED),
    bankSyncEnabled: bool(env.POPBILL_BANK_SYNC_ENABLED),
    smsEnabled: bool(env.POPBILL_SMS_ENABLED),
    popbillProductionEnabled: bool(env.POPBILL_PRODUCTION_ENABLED),
    popbillLinkId: env.POPBILL_LINK_ID,
    popbillSecretKey: env.POPBILL_SECRET_KEY,
    popbillCorpNum: env.POPBILL_CORP_NUM,
    popbillUserId: env.POPBILL_USER_ID,
    popbillCertificateConfigured: bool(env.POPBILL_CERTIFICATE_CONFIGURED),
    popbillBankAccountAuthorized: bool(env.POPBILL_BANK_ACCOUNT_AUTHORIZED),
    popbillBankCode: env.POPBILL_BANK_CODE,
    popbillBankAccount: env.POPBILL_BANK_ACCOUNT,
    reconciliationAccountId: env.RECONCILIATION_ACCOUNT_ID?.trim() || "ofd-main",
    bankPollIntervalMs: boundedInteger(env.POPBILL_BANK_POLL_MS, 1_000, 0, 60_000, "POPBILL_BANK_POLL_MS"),
    bankPollAttempts: boundedInteger(env.POPBILL_BANK_POLL_ATTEMPTS, 120, 1, 3_600, "POPBILL_BANK_POLL_ATTEMPTS"),
    popbillSmsSender: env.POPBILL_SMS_SENDER,
    s3Region: env.S3_REGION,
    s3Bucket: env.S3_BUCKET,
    s3Endpoint: env.S3_ENDPOINT,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3KmsKeyId: env.S3_KMS_KEY_ID,
    uploadMaxBytes,
    popbillWebhookApiKey: env.POPBILL_WEBHOOK_API_KEY,
  };
  if (config.storageMode === "s3") {
    const storageMissing: string[] = [];
    if (!config.s3Region) storageMissing.push("S3_REGION");
    if (!config.s3Bucket) storageMissing.push("S3_BUCKET");
    if (config.appMode === "production" && !config.s3KmsKeyId) storageMissing.push("S3_KMS_KEY_ID");
    if (config.s3Endpoint && (!config.s3AccessKeyId || !config.s3SecretAccessKey)) storageMissing.push("S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY");
    if (storageMissing.length) throw new DomainError("S3_NOT_CONFIGURED", `S3 설정이 부족합니다: ${storageMissing.join(", ")}`, 503);
  }
  if (config.appMode === "production" && config.bankPollIntervalMs < 250) {
    throw new DomainError("INVALID_BANK_POLL_INTERVAL", "production POPBILL_BANK_POLL_MS는 250ms 이상이어야 합니다.", 503);
  }
  if (config.emailProvider === "smtp" && (!env.SMTP_HOST || !env.EMAIL_FROM)) {
    throw new DomainError("SMTP_NOT_CONFIGURED", "SMTP_HOST와 EMAIL_FROM이 필요합니다.", 503);
  }
  assertProviderSafety(config);
  return config;
}

export function assertProviderSafety(config: ProviderConfig): void {
  if (config.providerMode !== "production") return;
  const missing: string[] = [];
  if (!config.popbillProductionEnabled) missing.push("POPBILL_PRODUCTION_ENABLED=true");
  if (!config.popbillLinkId) missing.push("POPBILL_LINK_ID");
  if (!config.popbillSecretKey) missing.push("POPBILL_SECRET_KEY");
  if (!config.popbillCorpNum) missing.push("POPBILL_CORP_NUM");
  if (!config.popbillUserId) missing.push("POPBILL_USER_ID");
  if (config.taxInvoiceEnabled && !config.popbillCertificateConfigured) missing.push("POPBILL_CERTIFICATE_CONFIGURED=true");
  if (config.bankSyncEnabled && !config.popbillBankAccountAuthorized) missing.push("POPBILL_BANK_ACCOUNT_AUTHORIZED=true");
  if (config.bankSyncEnabled && !config.popbillBankCode) missing.push("POPBILL_BANK_CODE");
  if (config.bankSyncEnabled && !config.popbillBankAccount) missing.push("POPBILL_BANK_ACCOUNT");
  if (config.smsEnabled && !config.popbillSmsSender) missing.push("POPBILL_SMS_SENDER");
  if (!config.popbillWebhookApiKey) missing.push("POPBILL_WEBHOOK_API_KEY");
  if (missing.length > 0) {
    throw new DomainError(
      "PRODUCTION_PROVIDER_NOT_READY",
      `실거래 공급자 안전 조건이 충족되지 않았습니다: ${missing.join(", ")}`,
      503,
      { missing },
    );
  }
}
