import { z } from 'zod';

/** Command envelope (architecture §6). */
export const CommandEnvelopeSchema = z.object({
  commandId: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  branchId: z.string().uuid(),
  deviceId: z.string().uuid(),
  actorId: z.string().uuid().optional(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().uuid(),
  aggregateVersion: z.number().int().positive().optional(),
  localSequence: z.number().int().nonnegative().optional(),
  clientCreatedAt: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  idempotencyKey: z.string().optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
  payload: z.unknown(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const PushRequestSchema = z.object({
  commands: z.array(CommandEnvelopeSchema).min(1).max(200),
});

export const SalePayloadSchema = z.object({
  sale: z.object({
    id: z.string().uuid(),
    localNumber: z.string().max(60).optional(),
    customerId: z.string().uuid().optional(),
    cashSessionId: z.string().uuid().optional(),
    currency: z.string().length(3).default('KES'),
    priceSnapshotVersion: z.number().int().nonnegative().optional(),
    clientCreatedAt: z.string().optional(),
    lines: z
      .array(
        z.object({
          id: z.string().uuid(),
          productId: z.string().uuid().optional(),
          sku: z.string().min(1).max(64),
          name: z.string().min(1).max(200),
          unit: z.string().max(16).default('ea'),
          quantity: z.number().positive(),
          unitPriceMinor: z.number().int().nonnegative(),
          discountBp: z.number().int().nonnegative().default(0),
          taxRateBp: z.number().int().nonnegative().default(0),
          taxInclusive: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(500),
    tenders: z
      .array(
        z.object({
          id: z.string().uuid(),
          method: z.enum(['cash', 'card', 'mpesa', 'bank', 'voucher', 'credit']),
          amountMinor: z.number().int().nonnegative(),
          externalReference: z.string().max(120).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
});
export type SalePayload = z.infer<typeof SalePayloadSchema>;
