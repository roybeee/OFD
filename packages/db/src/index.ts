export * from "./demo-seed.ts";
export * from "./claims.ts";
export * from "./memory-repository.ts";
export * from "./migration-runner.ts";
export * from "./postgres-repository.ts";
export * from "./repository.ts";

import { DomainError } from "@ofd/domain";
import { createDemoRepository } from "./demo-seed.ts";
import { PostgresRepository } from "./postgres-repository.ts";
import type { StateRepository } from "./repository.ts";

export function createRepository(env: NodeJS.ProcessEnv = process.env): StateRepository {
  const requestedMode = env.REPOSITORY_MODE;
  if (requestedMode && requestedMode !== "memory" && requestedMode !== "postgres") {
    throw new DomainError("INVALID_REPOSITORY_MODE", "REPOSITORY_MODE must be memory or postgres", 503);
  }
  if (env.APP_MODE === "production" && requestedMode === "memory") {
    throw new DomainError("REPOSITORY_FAIL_CLOSED", "Production requires the PostgreSQL repository", 503);
  }
  const usePostgres = requestedMode === "postgres" || (requestedMode !== "memory" && env.APP_MODE === "production");
  if (usePostgres && !env.DATABASE_URL) {
    throw new DomainError("DATABASE_URL_REQUIRED", "DATABASE_URL is required for the PostgreSQL repository", 503);
  }
  if (!usePostgres) return createDemoRepository();
  return PostgresRepository.connect(env.DATABASE_URL!, env);
}

export * from "./pos.ts";
