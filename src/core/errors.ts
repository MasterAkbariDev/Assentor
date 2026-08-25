export class AssentorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssentorError";
    this.code = code;
  }
}

export class InvalidTransitionError extends AssentorError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(
      "INVALID_TRANSITION",
      `Illegal state transition: ${from} → ${to}`,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class BudgetExceededError extends AssentorError {
  readonly kind: string;
  readonly limit: number;
  readonly usage: number;

  constructor(kind: string, limit: number, usage: number) {
    super(
      "BUDGET_EXCEEDED",
      `Budget exceeded for ${kind}: usage ${usage} >= limit ${limit}`,
    );
    this.name = "BudgetExceededError";
    this.kind = kind;
    this.limit = limit;
    this.usage = usage;
  }
}

export class ValidationError extends AssentorError {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message);
    this.name = "ValidationError";
    this.details = details;
  }
}
