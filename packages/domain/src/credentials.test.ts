import assert from "node:assert/strict";
import test from "node:test";
import { assertEncryptionKey, decryptMfaSecret, encryptMfaSecret } from "./credentials.ts";

const key = Buffer.alloc(32, 0xa5).toString("base64");

test("ENCRYPTION_KEY는 정확히 32바이트 base64 키만 허용한다", () => {
  assert.doesNotThrow(() => assertEncryptionKey(key));
  assert.throws(() => assertEncryptionKey("abcdefghijklmnopqrstuvwxyz0123456789-encryption"), /base64 32바이트/);
  assert.throws(() => assertEncryptionKey(Buffer.alloc(31).toString("base64")), /base64 32바이트/);
  assert.throws(() => assertEncryptionKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="), /개발용으로 공개된 키/);
});

test("MFA 비밀키는 AES-GCM으로 왕복하며 평문을 포함하지 않는다", () => {
  const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP", key);
  assert.ok(encrypted.startsWith("aesgcm:"));
  assert.ok(!encrypted.includes("JBSWY3DPEHPK3PXP"));
  assert.equal(decryptMfaSecret(encrypted, key), "JBSWY3DPEHPK3PXP");
});
