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

/**
 * Cross-branch stock transfer (item 4.7, ADR 0008): ONE document, TWO per-branch steps.
 *
 * The `action` is the state machine. The source branch dispatches (`dispatch`), which is the only
 * moment stock leaves it; the destination branch receives (`receive`), which is the only moment
 * stock arrives there. Neither command ever writes the other branch's ledger — the branch a command
 * applies to is `command.branchId`, which the server checks against the device's enrolment.
 *
 * A receipt must name EVERY dispatched line: the UI prefills them with what was sent, so a missing
 * line is a stale or invented receipt rather than an oversight.
 */
export const StockTransferSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('dispatch'),
    transfer: z.object({
      id: z.string().uuid(),
      toBranchId: z.string().uuid(),
      note: z.string().max(500).optional(),
      /** Supervisor note — only needed when the dispatch would leave this branch below zero. */
      approvedBy: z.string().uuid().optional(),
      approvalNote: z.string().max(500).optional(),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().positive(),
            unit: z.string().max(16).optional(),
          }),
        )
        .min(1)
        .max(500),
    }),
  }),
  z.object({
    action: z.literal('receive'),
    transfer: z.object({
      id: z.string().uuid(),
      /** Mandatory when ANY line is received short of what was sent (§3.D approval rule). */
      approvedBy: z.string().uuid().optional(),
      approvalNote: z.string().max(500).optional(),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            /** 0 is a real count: none of this line arrived. */
            quantityReceived: z.number().min(0),
          }),
        )
        .min(1)
        .max(500),
    }),
  }),
]);
export type StockTransferPayload = z.infer<typeof StockTransferSchema>;

/**
 * Query for the transfer list (item 4.7). `branchId` is required: the server has no branch in the
 * session — the device states which branch it is asking about, and the service checks that against
 * the device's enrolment so a till can only read its own branch's transfers (ADR 0008 item 5).
 */
export const TransfersQuerySchema = z.object({
  branchId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type TransfersQuery = z.infer<typeof TransfersQuerySchema>;

/** The dispatch half of a transfer: what left this branch, and where it went. */
export type DispatchTransfer = Extract<StockTransferPayload, { action: 'dispatch' }>['transfer'];
/** The receipt half: what the destination actually counted, and who approved it being short. */
export type ReceiveTransfer = Extract<StockTransferPayload, { action: 'receive' }>['transfer'];

/**
 * Opening-stock import (item 4.5). `csv` or `records` (not both); `commit: false` is a pure preview
 * and a file with any bad row is reported, never partially applied.
 *
 * `branchId` is required because this is a management call made by an enrolled device rather than a
 * sync command that carries its own branch. `requestId` is the idempotency key the operator's one
 * tap is retried under: it becomes the movement's `source_id`, so a timed-out commit that is retried
 * is recognised instead of applying the same opening stock twice — which the ledger's own unique
 * index would otherwise have to refuse.
 */
export const OpeningStockImportSchema = z
  .object({
    branchId: z.string().uuid(),
    requestId: z.string().uuid(),
    csv: z.string().max(5_000_000).optional(),
    records: z.array(z.unknown()).max(5000).optional(),
    commit: z.boolean().default(false),
  })
  .refine((value) => (value.csv === undefined) !== (value.records === undefined), {
    message: 'Provide exactly one of csv or records',
  });
export type OpeningStockImportInput = z.infer<typeof OpeningStockImportSchema>;
