import { createHmac, timingSafeEqual } from "node:crypto";

export function generateTotp(base32Secret: string, now = Date.now(), periodSeconds = 30): string {
  const counter = Math.floor(now / 1_000 / periodSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(base32Secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(code: string, secret: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const received = Buffer.from(code);
  for (const drift of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(generateTotp(secret, now + drift));
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid base32 secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
