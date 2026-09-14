import { assertEncryptionKey, DomainError } from "@ofd/domain";

export interface ProviderConfig {
  appMode: "demo" | "production" | "test" | "local";
  providerMode: "mock" | "production" | "disabled";
  odaSettlementOnly?: boolean;
  storageMode: "mock" | "s3" | "postgres";
  emailProvider: "mock" | "smtp" | "disabled";
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
  const odaSettlementOnly = env.ODA_SETTLEMENT_ONLY === "true";
  if (odaSettlementOnly) assertOdaSettlementConfig(env);
  if (!odaSettlementOnly && (env.PROVIDER_MODE === "disabled" || env.STORAGE_MODE === "postgres" || env.EMAIL_PROVIDER === "disabled")) {
    throw new DomainError("ODA_PROFILE_REQUIRED", "DB 증빙·외부 처리 비활성화는 명시된 ODA 월정산 전용 운영 프로필에서만 사용할 수 있습니다.", 503);
  }
  const providerMode = odaSettlementOnly ? "disabled" : env.PROVIDER_MODE === "production" ? "production" : "mock";
  if (env.APP_MODE && !new Set(["demo", "test", "production", "local"]).has(env.APP_MODE)) {
    throw new DomainError("INVALID_APP_MODE", "APP_MODE는 demo, test, production, local 중 하나여야 합니다.", 503);
  }
  if (env.APP_MODE === "local") assertOdaLocalConfig(env);
  if (env.NODE_ENV === "production" && env.APP_MODE !== "production" && env.APP_MODE !== "local") {
    throw new DomainError("APP_MODE_FAIL_CLOSED", "NODE_ENV=production에서는 APP_MODE=production을 명시해야 합니다.", 503);
  }
  const appMode: ProviderConfig["appMode"] = env.APP_MODE === "local" ? "local" : env.APP_MODE === "production" ? "production" : env.APP_MODE === "test" ? "test" : "demo";
  const storageMode = odaSettlementOnly ? "postgres" : env.STORAGE_MODE === "s3" ? "s3" : "mock";
  const emailProvider = odaSettlementOnly ? "disabled" : env.EMAIL_PROVIDER === "smtp" ? "smtp" : "mock";
  if (appMode === "production" && !odaSettlementOnly && storageMode !== "s3") throw new DomainError("STORAGE_FAIL_CLOSED", "production에서는 STORAGE_MODE=s3가 필요합니다.", 503);
  if (appMode === "production" && !odaSettlementOnly && emailProvider !== "smtp") throw new DomainError("EMAIL_FAIL_CLOSED", "production에서는 EMAIL_PROVIDER=smtp가 필요합니다.", 503);
  const uploadMaxBytes = Number(env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes < 1 || uploadMaxBytes > 25 * 1024 * 1024) {
    throw new DomainError("INVALID_UPLOAD_LIMIT", "UPLOAD_MAX_BYTES는 1~25MB 범위의 정수여야 합니다.", 503);
  }
  const config: ProviderConfig = {
    appMode,
    odaSettlementOnly,
    providerMode,
    storageMode,
    emailProvider,
    taxInvoiceEnabled: bool(env.POPBILL_TAX_INVOICE_ENABLED),
    bankSyncEnabled: bool(env.POPBILL_BANK_SYNC_ENABLED),
    smsEnabled: bool(env.POPBILL_SMS_ENABLED),
    popbillProductionEnabled: bool(env.POPBILL_PRODUCTION_ENABLED),
    ...(env.POPBILL_LINK_ID ? { popbillLinkId: env.POPBILL_LINK_ID } : {}),
    ...(env.POPBILL_SECRET_KEY ? { popbillSecretKey: env.POPBILL_SECRET_KEY } : {}),
    ...(env.POPBILL_CORP_NUM ? { popbillCorpNum: env.POPBILL_CORP_NUM } : {}),
    ...(env.POPBILL_USER_ID ? { popbillUserId: env.POPBILL_USER_ID } : {}),
    popbillCertificateConfigured: bool(env.POPBILL_CERTIFICATE_CONFIGURED),
    popbillBankAccountAuthorized: bool(env.POPBILL_BANK_ACCOUNT_AUTHORIZED),
    ...(env.POPBILL_BANK_CODE ? { popbillBankCode: env.POPBILL_BANK_CODE } : {}),
    ...(env.POPBILL_BANK_ACCOUNT ? { popbillBankAccount: env.POPBILL_BANK_ACCOUNT } : {}),
    reconciliationAccountId: env.RECONCILIATION_ACCOUNT_ID?.trim() || "ofd-main",
    bankPollIntervalMs: boundedInteger(env.POPBILL_BANK_POLL_MS, 1_000, 0, 60_000, "POPBILL_BANK_POLL_MS"),
    bankPollAttempts: boundedInteger(env.POPBILL_BANK_POLL_ATTEMPTS, 120, 1, 3_600, "POPBILL_BANK_POLL_ATTEMPTS"),
    ...(env.POPBILL_SMS_SENDER ? { popbillSmsSender: env.POPBILL_SMS_SENDER } : {}),
    ...(env.S3_REGION ? { s3Region: env.S3_REGION } : {}),
    ...(env.S3_BUCKET ? { s3Bucket: env.S3_BUCKET } : {}),
    ...(env.S3_ENDPOINT ? { s3Endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_ACCESS_KEY_ID ? { s3AccessKeyId: env.S3_ACCESS_KEY_ID } : {}),
    ...(env.S3_SECRET_ACCESS_KEY ? { s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY } : {}),
    ...(env.S3_KMS_KEY_ID ? { s3KmsKeyId: env.S3_KMS_KEY_ID } : {}),
    uploadMaxBytes,
    ...(env.POPBILL_WEBHOOK_API_KEY ? { popbillWebhookApiKey: env.POPBILL_WEBHOOK_API_KEY } : {}),
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

/** Local ODA has durable data and real authentication, but no network service providers. */
export const ODA_LOCAL_ORIGIN = "http://127.0.0.1:4175";
export function assertOdaLocalConfig(env: NodeJS.ProcessEnv): void {
  if (env.WORKSTATION_BRAND !== "oda" || env.REPOSITORY_MODE !== "postgres" || env.ODA_LOCAL_ENABLED !== "true") {
    throw new DomainError("LOCAL_CONFIG_REQUIRED", "local 모드는 ODA 전용 PostgreSQL 및 ODA_LOCAL_ENABLED=true 설정이 필요합니다.", 503);
  }
  if (env.WEB_ORIGIN !== ODA_LOCAL_ORIGIN || env.PUBLIC_APP_URL !== ODA_LOCAL_ORIGIN) {
    throw new DomainError("LOCAL_ORIGIN_REQUIRED", `local 접속 주소는 ${ODA_LOCAL_ORIGIN}이어야 합니다.`, 503);
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new DomainError("SESSION_CONFIG_ERROR", "local SESSION_SECRET은 고정된 32자 이상 비밀값이어야 합니다.", 503);
  }
  assertEncryptionKey(env.ENCRYPTION_KEY ?? "");
  if (env.PROVIDER_MODE && env.PROVIDER_MODE !== "mock" || env.STORAGE_MODE && env.STORAGE_MODE !== "mock"
    || env.EMAIL_PROVIDER && env.EMAIL_PROVIDER !== "mock"
    || ["POPBILL_PRODUCTION_ENABLED", "POPBILL_TAX_INVOICE_ENABLED", "POPBILL_BANK_SYNC_ENABLED", "POPBILL_SMS_ENABLED"]
      .some((key) => env[key] === "true")) {
    throw new DomainError("LOCAL_EXTERNAL_DISABLED", "local 모드에서는 외부 발행·송금·알림 공급자를 사용할 수 없습니다.", 503);
  }
}

/** A real, restricted production product. No mock provider or public local mode is used. */
export function assertOdaSettlementConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production" || env.APP_MODE !== "production" || env.WORKSTATION_BRAND !== "oda"
    || env.REPOSITORY_MODE !== "postgres" || env.ODA_SETTLEMENT_ONLY !== "true") {
    throw new DomainError("ODA_PROFILE_REQUIRED", "ODA 월정산 전용 운영은 production·ODA·PostgreSQL 명시 설정이 필요합니다.", 503);
  }
  if (env.PROVIDER_MODE !== "disabled" || env.STORAGE_MODE !== "postgres" || env.EMAIL_PROVIDER !== "disabled"
    || ["POPBILL_PRODUCTION_ENABLED", "POPBILL_TAX_INVOICE_ENABLED", "POPBILL_BANK_SYNC_ENABLED", "POPBILL_SMS_ENABLED"]
      .some(key => env[key] !== undefined && env[key] !== "false")) {
    throw new DomainError("ODA_EXTERNAL_DISABLED", "ODA 월정산 전용 운영은 DB 증빙 저장과 외부 발행·메일·동기화 비활성화가 필요합니다.", 503);
  }
  if (env.SERVICE_ROLE === "worker") assertWorkerProfile({ odaSettlementOnly: true });
  let database: URL;
  let origin: URL;
  try { database = new URL(env.DATABASE_URL ?? ""); origin = new URL(env.WEB_ORIGIN ?? ""); }
  catch { throw new DomainError("ODA_CONFIG_REQUIRED", "ODA PostgreSQL 연결과 HTTPS 접속 주소가 필요합니다.", 503); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)
    || origin.protocol !== "https:" || origin.origin !== env.WEB_ORIGIN || env.PUBLIC_APP_URL !== origin.origin
    || env.SESSION_COOKIE_SECURE !== "true") {
    throw new DomainError("ODA_CONFIG_REQUIRED", "ODA는 PostgreSQL·단일 HTTPS 주소·보안 쿠키를 요구합니다.", 503);
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new DomainError("SESSION_CONFIG_ERROR", "ODA 운영 SESSION_SECRET은 고정된 32자 이상 비밀값이어야 합니다.", 503);
  }
  assertEncryptionKey(env.ENCRYPTION_KEY ?? "");
}

/** Refuse a scheduler before creating providers, DB pools, heartbeats or jobs. */
export function assertWorkerProfile(config: Pick<ProviderConfig, "odaSettlementOnly">): void {
  if (config.odaSettlementOnly) throw new DomainError("ODA_WORKER_DISABLED", "ODA 월정산 전용 운영은 외부 작업 worker를 실행하지 않습니다.", 503);
}
