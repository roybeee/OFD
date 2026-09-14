import { DomainError } from "@ofd/domain";
import type { EmailProvider } from "./email.ts";
import type { PopbillProvider } from "./popbill.ts";
import type { ObjectStorage, StorageReadiness } from "./storage.ts";

function disabled(): never {
  throw new DomainError("ODA_EXTERNAL_DISABLED", "월정산 전용 운영에서 지원하지 않는 외부 처리입니다.", 503);
}

export class DisabledEmailProvider implements EmailProvider {
  async send(): Promise<never> { return disabled(); }
}
export class DisabledPopbillProvider implements PopbillProvider {
  async issueTaxInvoice(): Promise<never> { return disabled(); }
  async getTaxInvoiceStatus(): Promise<never> { return disabled(); }
  async getTaxInvoiceOriginal(): Promise<never> { return disabled(); }
  async fetchBankTransactions(): Promise<never> { return disabled(); }
  async sendSms(): Promise<never> { return disabled(); }
}

/** ODA evidence is committed atomically with its month in StateRepository.
 * This rejects every unrelated ObjectStorage operation. It cannot claim readiness;
 * the API must use the real repository's dedicated evidence readiness check.
 */
export class RepositoryEvidenceOnlyStorage implements ObjectStorage {
  async checkReadiness(): Promise<StorageReadiness> {
    return { ok: false, mode: "postgres", reachable: false, versioning: "Unknown", code: "ODA_REPOSITORY_CHECK_REQUIRED" };
  }
  async createDeliveryProofUpload(): Promise<never> { return disabled(); }
  async verifyDeliveryProof(): Promise<never> { return disabled(); }
  async createReadUrl(): Promise<never> { return disabled(); }
  async putImmutableObject(): Promise<never> { return disabled(); }
  async getImmutableObject(): Promise<never> { return disabled(); }
}
