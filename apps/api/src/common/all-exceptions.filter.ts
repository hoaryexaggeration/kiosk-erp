import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { Response } from 'express';
import { AppError } from './errors';
import { CorrelatedRequest } from './correlation.middleware';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<CorrelatedRequest>();
    const correlationId = req?.correlationId ?? 'unknown';

    let status = 500;
    let body: Record<string, unknown> = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      retryable: false,
    };

    if (exception instanceof AppError) {
      status = exception.httpStatus;
      body = {
        code: exception.code,
        message: exception.message,
        retryable: exception.extra.retryable ?? false,
        ...(exception.extra.fieldErrors ? { fieldErrors: exception.extra.fieldErrors } : {}),
        ...(exception.extra.conflictId ? { conflictId: exception.extra.conflictId } : {}),
      };
    } else if (exception instanceof ZodError) {
      status = 422;
      const fieldErrors: Record<string, string> = {};
      for (const issue of exception.issues) {
        fieldErrors[issue.path.join('.') || '_'] = issue.message;
      }
      body = { code: 'VALIDATION_ERROR', message: 'Invalid request', retryable: false, fieldErrors };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      body = {
        code: status === 404 ? 'NOT_FOUND' : `HTTP_${status}`,
        message: typeof resp === 'string' ? resp : (resp as { message?: string }).message ?? exception.message,
        retryable: status >= 500,
      };
    } else {
      this.logger.error(`Unhandled: ${(exception as Error)?.stack ?? String(exception)}`);
    }

    res.status(status).json({ ...body, correlationId });
  }
}
