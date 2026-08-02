export * from "./demo-seed.ts";
export * from "./claims.ts";
export * from "./memory-repository.ts";
export * from "./postgres-repository.ts";
export * from "./repository.ts";

import type { StateRepository } from "./repository.ts";
import { DomainError } from "@ofd/domain";
import { createDemoRepository } from "./demo-seed.ts";
import { PostgresRepository } from "./postgres-repository.ts";

export function createRepository(env: NodeJS.ProcessEnv = process.env): StateRepository {
  if (env.APP_MODE === "production" && !env.DATABASE_URL) {
    throw new DomainError("DATABASE_URL_REQUIRED", "production에서는 DATABASE_URL이 반드시 필요합니다.", 503);
  }
  if (env.APP_MODE === "demo" || env.APP_MODE === "test" || !env.DATABASE_URL) return createDemoRepository();
  return PostgresRepository.connect(env.DATABASE_URL);
}
