import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { invariant } from "./errors.ts";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KNOWN_DEVELOPMENT_ENCRYPTION_KEYS = new Set([
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
]);

export function hashPassword(password: string, salt = randomBytes(16)): string {
  assertStrongPassword(password);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
  try {
    const actual = scryptSync(password, Buffer.from(salt, "base64url"), 32,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
    const expectedBytes = Buffer.from(expected, "base64url");
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  } catch { return false; }
}

export function assertStrongPassword(password: string): void {
  invariant(password.length >= 12 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password),
    "WEAK_PASSWORD", "비밀번호는 12자 이상이며 대문자·소문자·숫자·특수문자를 포함해야 합니다.");
}

export function assertEncryptionKey(base64Key: string): void {
  const validEncoding = /^[A-Za-z0-9+/]{43}=$/.test(base64Key);
  const key = validEncoding ? Buffer.from(base64Key, "base64") : Buffer.alloc(0);
  invariant(key.length === 32, "INVALID_ENCRYPTION_KEY", "ENCRYPTION_KEY는 base64 32바이트 키여야 합니다.", 503);
  invariant(!KNOWN_DEVELOPMENT_ENCRYPTION_KEYS.has(base64Key), "KNOWN_DEVELOPMENT_ENCRYPTION_KEY",
    "ENCRYPTION_KEY에 개발용으로 공개된 키를 사용할 수 없습니다.", 503);
}

export function encryptMfaSecret(secret: string, base64Key: string): string {
  assertEncryptionKey(base64Key);
  const key = Buffer.from(base64Key, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `aesgcm:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptMfaSecret(encoded: string, base64Key?: string, allowDemo = false): string {
  if (encoded.startsWith("demo:") && allowDemo) return encoded.slice(5);
  invariant(Boolean(base64Key), "ENCRYPTION_KEY_REQUIRED", "ENCRYPTION_KEY가 필요합니다.", 503);
  const [algorithm, iv, tag, encrypted] = encoded.split(":");
  invariant(algorithm === "aesgcm" && iv && tag && encrypted, "INVALID_ENCRYPTED_SECRET", "MFA 비밀키 형식이 올바르지 않습니다.", 503);
  assertEncryptionKey(base64Key!);
  const key = Buffer.from(base64Key!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
