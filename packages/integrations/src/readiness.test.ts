import assert from "node:assert/strict";
import test from "node:test";
import { readProviderConfig } from "./config.ts";
import { MockObjectStorage, S3ObjectStorage } from "./storage.ts";

test("mock storage readiness has no external dependency", async () => {
  assert.deepEqual(await new MockObjectStorage().checkReadiness(), {
    ok: true, mode: "mock", reachable: true, notRequired: true, versioning: "NotRequired",
  });
});

test("production S3 readiness requires bucket reachability and Enabled versioning", async () => {
  const config = readProviderConfig({ APP_MODE: "production", PROVIDER_MODE: "mock", STORAGE_MODE: "s3",
    S3_REGION: "ap-northeast-2", S3_BUCKET: "documents", S3_KMS_KEY_ID: "alias/ofd", EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example", EMAIL_FROM: "ofd@example.com", POPBILL_BANK_POLL_MS: "1000" });
  const storage = new S3ObjectStorage(config);
  let versioning: "Enabled" | "Suspended" = "Suspended";
  Object.defineProperty(storage, "client", { configurable: true, value: {
    send: async (command: object) => command.constructor.name === "HeadBucketCommand" ? {} : { Status: versioning },
  } });
  assert.deepEqual(await storage.checkReadiness(), {
    ok: false, mode: "s3", reachable: true, versioning: "Suspended", code: "S3_VERSIONING_NOT_ENABLED",
  });
  versioning = "Enabled";
  assert.deepEqual(await storage.checkReadiness(), { ok: true, mode: "s3", reachable: true, versioning: "Enabled" });
  Object.defineProperty(storage, "client", { configurable: true, value: { send: async () => { throw new Error("offline"); } } });
  assert.deepEqual(await storage.checkReadiness(), {
    ok: false, mode: "s3", reachable: false, versioning: "Unknown", code: "S3_BUCKET_UNREACHABLE",
  });
});
