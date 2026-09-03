/** seed-postgres.mjs의 타입 선언 — 스펙(.ts)에서 재시도 초기화에 재사용한다. */
export function assertIsolatedDatabase(env?: NodeJS.ProcessEnv): string;
export function seedPostgres(env?: NodeJS.ProcessEnv): Promise<void>;
