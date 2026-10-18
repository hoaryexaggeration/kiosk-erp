/**
 * Structured API error contract (architecture §9):
 *   { code, message, fieldErrors?, retryable, conflictId?, correlationId? }
 * Never leak internal details; `code` is stable for clients and fixtures.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly extra: {
      fieldErrors?: Record<string, string>;
      retryable?: boolean;
      conflictId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message, 401);
  }
  static forbidden(message = 'Not permitted'): AppError {
    return new AppError('FORBIDDEN', message, 403);
  }
  static notFound(code = 'NOT_FOUND', message = 'Not found'): AppError {
    return new AppError(code, message, 404);
  }
  static validation(message: string, fieldErrors?: Record<string, string>): AppError {
    return new AppError('VALIDATION_ERROR', message, 422, { fieldErrors });
  }
  static conflict(code: string, message: string, conflictId?: string): AppError {
    return new AppError(code, message, 409, { conflictId });
  }
  static retryable(message = 'Temporarily unavailable'): AppError {
    return new AppError('RETRYABLE', message, 503, { retryable: true });
  }
}

export const SyncErrorCode = {
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  STALE_PRICE_SNAPSHOT: 'STALE_PRICE_SNAPSHOT',
  CREDIT_EXCEEDED: 'CREDIT_EXCEEDED',
  NEGATIVE_STOCK: 'NEGATIVE_STOCK',
  DUPLICATE_PROVIDER_REF: 'DUPLICATE_PROVIDER_REF',
  OFFLINE_PERMISSION_EXPIRED: 'OFFLINE_PERMISSION_EXPIRED',
  DELETED_REFERENCE: 'DELETED_REFERENCE',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
} as const;
