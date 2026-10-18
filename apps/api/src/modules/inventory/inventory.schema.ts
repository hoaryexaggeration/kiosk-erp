import { z } from 'zod';

/** Stock receipt (GRN). Increases on-hand and opens a FIFO valuation layer per line (ADR 0009). */
export const StockReceiptSchema = z.object({
  receipt: z.object({
    id: z.string().uuid(),
    supplierId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    reason: z.string().min(1).max(60).default('grn'),
    reference: z.string().max(120).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.number().positive(),
          unitCostMinor: z.number().int().nonnegative().optional(),
          unit: z.string().max(16).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
});
export type StockReceiptPayload = z.infer<typeof StockReceiptSchema>;

/** Stock adjustment. A reason is mandatory; a negative result needs a supervisor override (ADR 0009). */
export const StockAdjustmentSchema = z.object({
  adjustment: z.object({
    id: z.string().uuid(),
    locationId: z.string().uuid().optional(),
    reason: z.string().min(1).max(120),
    /** The supervisor who authorised a negative result; recorded on every movement. */
    approvedBy: z.string().uuid().optional(),
    approvalNote: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantityDelta: z.number().refine((v) => v !== 0, 'quantityDelta must be non-zero'),
          unit: z.string().max(16).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
});
export type StockAdjustmentPayload = z.infer<typeof StockAdjustmentSchema>;
