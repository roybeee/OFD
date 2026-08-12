import assert from "node:assert/strict";
import test from "node:test";
import { assertEncryptionKey, assertStrongPassword, decryptMfaSecret, encryptMfaSecret } from "./credentials.ts";

const key = Buffer.alloc(32, 0xa5).toString("base64");

test("비밀번호는 10자 이상이며 숫자와 특수문자를 포함해야 한다", () => {
  assert.doesNotThrow(() => assertStrongPassword("ab1!ab1!ab"));   // 10자, 숫자·특수문자
  assert.doesNotThrow(() => assertStrongPassword("소문자만있어도숫자1!"));  // 대소문자 조합은 더 이상 요구하지 않음
  assert.throws(() => assertStrongPassword("short1!"), /10자 이상/);          // 길이 부족
  assert.throws(() => assertStrongPassword("abcdefghij"), /숫자와 특수문자/);  // 숫자·특수문자 없음
  assert.throws(() => assertStrongPassword("nodigitsss!"), /숫자와 특수문자/); // 숫자 없음
  assert.throws(() => assertStrongPassword("nospecial12"), /숫자와 특수문자/); // 특수문자 없음
});

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
