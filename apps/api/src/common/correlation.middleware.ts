import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { newId } from './ids';

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

/** Attach a correlation id to every request/response (§6, §9). */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && incoming.length <= 128 ? incoming : newId();
    (req as CorrelatedRequest).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  }
}
