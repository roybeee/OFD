import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** V1 server.js tossFetchRange를 V2 규약으로 이식. 집계 단위: date×품목명(시간대는 2단계). */
const TP_BASE = "https://open-api.tossplace.com/api-public/openapi/v1/merchants/";
const PAGE_SIZE = 500;
const PAGE_LIMIT = 80;
const PAGE_DELAY_MS = 150; // 토스 매장별 초당 10회 이내

export interface TossDailyItem { date: string; rawName: string; qty: number; amount: number }
export interface TossFetchInput {
  merchantId: string; accessKey: string; secretKey: string;
  from: string; to: string; // YYYY-MM-DD (KST, inclusive)
  fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const addDays = (date: string, days: number) => {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};
const kstParts = (ts: unknown): { date: string } | null => {
  if (typeof ts !== "string" || ts.length < 10) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.valueOf())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
  return { date: fmt };
};

async function tpGet(url: string, ak: string, sk: string, fetchImpl: typeof fetch): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetchImpl(url, {
      headers: { "x-access-key": ak, "x-secret-key": sk, "Content-Type": "application/json" },
      signal: ac.signal,
    });
    const body = (await res.json().catch(() => null)) as
      | { resultType?: string; success?: unknown; error?: { errorCode?: string; reason?: string } }
      | null;
    if (!res.ok) throw new Error(`HTTP ${res.status}${body?.error?.reason ? ` ${body.error.reason}` : ""}`);
    if (!body || body.resultType !== "SUCCESS") {
      throw new Error(body?.error ? `${body.error.errorCode ?? ""} ${body.error.reason ?? ""}`.trim() : "BAD_ENVELOPE");
    }
    return body.success;
  } finally { clearTimeout(timer); }
}

/** 기간 내 주문을 페이지 순회하며 일자×품목으로 집계한다. */
export async function fetchTossDailyItems(input: TossFetchInput): Promise<TossDailyItem[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? sleep;
  const fromParam = encodeURIComponent(`${input.from}T00:00:00+09:00`);
  const toParam = encodeURIComponent(`${addDays(input.to, 1)}T00:00:00+09:00`);
  const agg = new Map<string, TossDailyItem>();
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const url = `${TP_BASE}${encodeURIComponent(input.merchantId)}/orders?startDateTime=${fromParam}&endDateTime=${toParam}&page=${page}&size=${PAGE_SIZE}`;
    const success = await tpGet(url, input.accessKey, input.secretKey, fetchImpl);
    const orders = Array.isArray((success as { orders?: unknown[] })?.orders)
      ? ((success as { orders: unknown[] }).orders)
      : Array.isArray(success) ? (success as unknown[]) : [];
    for (const order of orders) {
      const o = order as { orderedAt?: string; completedAt?: string; lineItems?: Array<Record<string, unknown>> };
      const kp = kstParts(o.completedAt ?? o.orderedAt);
      if (!kp || kp.date < input.from || kp.date > input.to) continue;
      for (const li of o.lineItems ?? []) {
        const item = li.item as { title?: string } | undefined;
        const name = item?.title ?? "";
        const qty = Number(li.quantity) || 0;
        if (!name || qty <= 0) continue;
        const priceValue = (li.itemPrice as { priceValue?: unknown } | undefined)?.priceValue;
        let amount = (Number(priceValue) || 0) * qty;
        for (const choice of (li.optionChoices as Array<{ priceValue?: unknown; quantity?: unknown }> | undefined) ?? []) {
          amount += (Number(choice.priceValue) || 0) * (Number(choice.quantity) || 0);
        }
        for (const discount of (li.appliedDiscounts as Array<{ amount?: unknown }> | undefined) ?? []) {
          amount -= Number(discount.amount) || 0;
        }
        const key = `${kp.date}|${name}`;
        const current = agg.get(key) ?? { date: kp.date, rawName: name, qty: 0, amount: 0 };
        current.qty += qty;
        current.amount += Math.max(0, amount);
        agg.set(key, current);
      }
    }
    if (orders.length < PAGE_SIZE) break;
    if (page === PAGE_LIMIT) throw new Error("ORDER_PAGE_LIMIT");
    await sleepImpl(PAGE_DELAY_MS);
  }
  return [...agg.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rawName.localeCompare(b.rawName)));
}

/* ── 토스플레이스 웹훅 서명 검증 ──
 * 규칙(공식 문서): HMAC-SHA256, Key = 앱 웹훅 서명 secret,
 * Message = "<x-toss-timestamp>.<rawRequestBody>" (UTF-8), hex 인코딩 후 "v1=" 접두. */
export function verifyTossWebhookSignature(
  rawBody: string, timestampMs: string, signature: string, secret: string,
  nowMs = Date.now(), toleranceMs = 5 * 60_000,
): boolean {
  if (!secret || !/^\d{10,}$/.test(timestampMs)) return false;
  if (Math.abs(nowMs - Number(timestampMs)) > toleranceMs) return false;
  const expected = `v1=${createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`, "utf8").digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── POS 자격증명 암호화 (AES-256-GCM, 키 = sha256(ENCRYPTION_KEY)) ── */
const keyOf = (encryptionKey: string) => createHash("sha256").update(encryptionKey, "utf8").digest();

export function encryptPosSecret(plain: string, encryptionKey: string): string {
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY_REQUIRED");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(encryptionKey), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `p1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decryptPosSecret(encoded: string, encryptionKey: string): string {
  const [tag0, iv64, tag64, ct64] = encoded.split(":");
  if (tag0 !== "p1" || !iv64 || !tag64 || !ct64) throw new Error("POS_SECRET_FORMAT");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(encryptionKey), Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct64, "base64")), decipher.final()]).toString("utf8");
}
