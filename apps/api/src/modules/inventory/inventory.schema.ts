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
 * A count (item 4.8, §3.D "cycle counts and full stocktakes").
 *
 * The payload carries COUNTED quantities, never deltas: the shelf holds N units is a fact about the
 * shelf, and only the server's book can be subtracted from it. A device whose cached balance has
 * drifted would otherwise post book + (stale book − counted) and land somewhere neither number
 * describes — so the variance is derived here, per line, against the balance this branch actually
 * has.
 *
 * `quantity >= 0`: a count cannot be negative — "counted −2 bottles" is not a reading of a shelf.
 * A line the operator left blank is a line nobody counted, and is simply absent: unlike a transfer
 * receipt, a cycle count is partial by design and only asserts what was physically seen.
 */
export const StocktakeSchema = z.object({
  stocktake: z.object({
    id: z.string().uuid(),
    /** Why this count happened — carried on the audit and the server event, not on each movement. */
    note: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          /** How many units are on the shelf, written in `unit` when the count used a pack. */
          quantity: z.number().min(0),
          unit: z.string().max(16).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
});
export type StocktakePayload = z.infer<typeof StocktakeSchema>;

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
