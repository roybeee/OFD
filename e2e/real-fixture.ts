import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
export const TEST_PASSWORD = 'OFD-demo-2026!';
export const WEBHOOK_KEY = 'e2e-webhook-c715bad7bf7196538d40dbf31d8569b7';
export const DRIVER_ID = '00000000-0000-4000-8000-000000000106';

export const accounts = {
  store: { email: 'store.owner@ofd.local', screen: 'store-home-screen' },
  ops: { email: 'hq.ops@ofd.local', screen: 'hq-order-screen' },
  finance: { email: 'hq.finance@ofd.local', screen: 'hq-reconciliation-screen' },
  master: { email: 'hq.master@ofd.local', screen: 'hq-order-screen' },
  driver: { email: 'driver@ofd.local', screen: 'driver-today-screen' },
} as const;

type ResponseLike = { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> };

export async function requireOk<T = Record<string, unknown>>(response: ResponseLike, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} failed (${response.status()}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function login(page: Page, account: keyof typeof accounts, throughUi = false) {
  await page.context().clearCookies();
  const selected = accounts[account];
  if (throughUi) {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByLabel('이메일').fill(selected.email);
    await page.getByLabel('비밀번호').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: '로그인' }).click();
    await page.getByTestId(selected.screen).waitFor();
    return;
  }

  const started = await requireOk<{ authenticated: boolean; mfaRequired: boolean }>(
    await page.request.post('/api/v2/auth/login', { data: { email: selected.email, password: TEST_PASSWORD } }),
    `${account} login`,
  );
  if (!started.authenticated) throw new Error(`${account} login did not authenticate`);
  // MFA 제거 후 중요 작업 본인 확인은 비밀번호만으로 스텝업한다 — 본사 계정의 정산 초안·승인 등에 필요.
  // (이전에는 본사 계정의 MFA 로그인이 최근 스텝업을 세워줬다)
  if (account === 'ops' || account === 'finance' || account === 'master') {
    await requireOk(await page.request.post('/api/v2/auth/step-up', { data: { password: TEST_PASSWORD } }), `${account} step-up`);
  }
}

export async function bootstrap<T = Record<string, unknown>>(page: Page): Promise<T> {
  return requireOk<T>(await page.request.get('/api/v2/bootstrap'), 'bootstrap');
}

export async function mutate<T = Record<string, unknown>>(page: Page, path: string, data: Record<string, unknown>, label = path): Promise<T> {
  return requireOk<T>(await page.request.post(`/api/v2${path}`, {
    data,
    headers: { 'Idempotency-Key': `e2e-${randomUUID()}` },
  }), label);
}

function isolatedDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL ?? '');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').toLowerCase();
  if (process.env.E2E_ALLOW_RESET !== '1' || !/(?:^|_)(?:e2e|test)(?:_|$)/.test(name)) {
    throw new Error('Direct E2E fixture writes require E2E_ALLOW_RESET=1 and an isolated e2e/test PostgreSQL database.');
  }
  return raw;
}

export function operationalDateKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function forceOrderToOperationalDate(orderId: string, date = operationalDateKst()) {
  const pool = new Pool({ connectionString: isolatedDatabaseUrl(), max: 1 });
  try {
    const result = await pool.query(
      `UPDATE aggregate_snapshots
       SET payload = jsonb_set(payload, '{requestedDeliveryDate}', to_jsonb($2::text), false), updated_at = now()
       WHERE aggregate_type = 'order' AND aggregate_id = $1`,
      [orderId, date],
    );
    if (result.rowCount !== 1) throw new Error(`E2E order ${orderId} was not found for the operational-date bridge`);
  } finally {
    await pool.end();
  }
  return date;
}

export async function injectBankTransaction(amount: number, memo: string) {
  const pool = new Pool({ connectionString: isolatedDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  const transaction = {
    id: '00000000-0000-4000-8000-00000000e201',
    providerId: 'e2e-isolated-bank-credit-001',
    accountId: 'ofd-main',
    occurredAt: new Date().toISOString(),
    amount,
    direction: 'credit',
    memo,
    matched: false,
    version: 1,
  };
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO aggregate_claims (claim_type,claim_key,aggregate_type,aggregate_id) VALUES ($1,$2,$3,$4)',
      ['bank.provider', transaction.providerId, 'bank_transaction', transaction.id],
    );
    await client.query(
      `INSERT INTO aggregate_snapshots (aggregate_type,aggregate_id,version,payload)
       VALUES ('bank_transaction',$1,1,$2::jsonb)`,
      [transaction.id, JSON.stringify(transaction)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  return transaction;
}

export async function readAggregate<T extends Record<string, unknown>>(type: string, id: string): Promise<T | undefined> {
  const pool = new Pool({ connectionString: isolatedDatabaseUrl(), max: 1 });
  try {
    const result = await pool.query('SELECT payload FROM aggregate_snapshots WHERE aggregate_type=$1 AND aggregate_id=$2', [type, id]);
    return result.rows[0]?.payload as T | undefined;
  } finally {
    await pool.end();
  }
}

export async function listAggregates<T extends Record<string, unknown>>(type: string): Promise<T[]> {
  const pool = new Pool({ connectionString: isolatedDatabaseUrl(), max: 1 });
  try {
    const result = await pool.query('SELECT payload FROM aggregate_snapshots WHERE aggregate_type=$1 ORDER BY aggregate_id', [type]);
    return result.rows.map((row) => row.payload as T);
  } finally {
    await pool.end();
  }
}

export async function waitForAggregate<T extends Record<string, unknown>>(
  type: string,
  id: string,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readAggregate<T>(type, id);
    if (value && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${type}:${id}`);
}
