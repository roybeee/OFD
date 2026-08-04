export * from "./config.ts";
export * from "./email.ts";
export * from "./popbill.ts";
export * from "./storage.ts";
export * from "./tossplace.ts";

import type { EmailProvider } from "./email.ts";
import { MockEmailProvider, SmtpEmailProvider } from "./email.ts";
import type { PopbillProvider, PopbillSdkServices } from "./popbill.ts";
import { MockPopbillProvider, ProductionPopbillProvider } from "./popbill.ts";
import type { ObjectStorage } from "./storage.ts";
import { MockObjectStorage, S3ObjectStorage } from "./storage.ts";
import type { ProviderConfig } from "./config.ts";

export function createIntegrationProviders(config: ProviderConfig, popbillServices?: PopbillSdkServices): {
  popbill: PopbillProvider; storage: ObjectStorage; email: EmailProvider;
} {
  return { popbill: createPopbillProvider(config, popbillServices), storage: createObjectStorage(config), email: createEmailProvider(config) };
}

export function createPopbillProvider(config: ProviderConfig, services?: PopbillSdkServices): PopbillProvider {
  if (config.providerMode === "mock") return new MockPopbillProvider();
  if (!services) throw new Error("production Popbill SDK services가 주입되지 않았습니다.");
  return new ProductionPopbillProvider(config, services);
}

export function createObjectStorage(config: ProviderConfig): ObjectStorage {
  return config.storageMode === "s3" ? new S3ObjectStorage(config) : new MockObjectStorage(config.uploadMaxBytes);
}

export function createEmailProvider(config: ProviderConfig): EmailProvider {
  return config.emailProvider === "smtp" ? new SmtpEmailProvider() : new MockEmailProvider();
}
