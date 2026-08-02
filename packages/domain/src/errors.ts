export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function invariant(condition: unknown, code: string, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new DomainError(code, message, statusCode);
}
