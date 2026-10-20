package com.kiosk.erp.core.common

/**
 * Units of measure and conversion (item 4.6) — MUST match `packages/domain-fixtures` and the
 * TypeScript implementation (verified by the same JSON vectors in
 * `fixtures/unit-conversion.json`).
 *
 * Stock is only ever held in a product's BASE unit, so this is the single place a crate becomes
 * 24 pieces: `factor` is how many base units one of that unit contains. Quantities are fixed-point
 * at 3 decimals rounded half-up (the ledger's precision); money itself stays integer minor units.
 */
object Units {

    /** Ledger precision for quantities — `numeric(18,3)` on the server. */
    const val QUANTITY_DECIMALS = 3
    private const val QUANTITY_SCALE = 1000.0

    /** Kind of the product's BASE unit. A counted base must stay whole. */
    const val KIND_COUNT = "count"
    const val KIND_WEIGHT = "weight"
    const val KIND_VOLUME = "volume"

    sealed interface ConvertResult {
        /** The quantity in the target unit, at ledger precision. */
        data class Ok(val quantity: Double) : ConvertResult

        /** A STABLE machine code (`FRACTIONAL_QUANTITY`, `INVALID_CONVERSION_FACTOR`, ...). */
        data class Failed(val code: String) : ConvertResult
    }

    /** Round to ledger precision, half-up — the same rule the server applies. */
    fun roundQuantity(x: Double): Double = Math.floor(x * QUANTITY_SCALE + 0.5) / QUANTITY_SCALE

    /**
     * Convert a quantity from one unit of a product into another unit of the same product.
     *
     * @param fromFactor how many base units one `from` unit contains (1 crate of 24 -> 24)
     * @param toFactor how many base units one `to` unit contains (base unit itself -> 1)
     * @param kind kind of the BASE unit; a `count` result that is not a whole number is REFUSED,
     *   because 0.2 of a bottle is not something a shop can receive
     */
    fun convertQuantity(
        quantity: Double,
        fromFactor: Double,
        toFactor: Double,
        kind: String = KIND_COUNT,
    ): ConvertResult {
        if (!quantity.isFinite()) return ConvertResult.Failed("INVALID_QUANTITY")
        if (!fromFactor.isFinite() || !toFactor.isFinite() || fromFactor <= 0.0 || toFactor <= 0.0) {
            return ConvertResult.Failed("INVALID_CONVERSION_FACTOR")
        }
        val scaled = roundQuantity(quantity * fromFactor / toFactor)
        if (!scaled.isFinite()) return ConvertResult.Failed("INVALID_QUANTITY")
        if (kind == KIND_COUNT && scaled != Math.round(scaled).toDouble()) {
            return ConvertResult.Failed("FRACTIONAL_QUANTITY")
        }
        return ConvertResult.Ok(scaled)
    }

    /**
     * How a quantity is said out loud: `3`, not `3.0` — the same shape the Stock list and the
     * movement history use, so one product never shows two spellings of one quantity.
     */
    fun formatQuantity(quantity: Double): String =
        if (quantity.isFinite() && quantity == Math.floor(quantity)) quantity.toLong().toString()
        else quantity.toString()
}
