package com.kiosk.erp.core.common

/**
 * Deterministic pricing/tax subset — MUST match packages/domain-fixtures and the TypeScript
 * implementation (verified by the same JSON vectors). Money = integer minor units; rates = basis
 * points; rounding = half-up per line.
 */
object Pricing {

    data class LineInput(
        val unitPriceMinor: Long,
        val quantity: Double,
        val discountBp: Int = 0,
        val taxRateBp: Int = 0,
        val taxInclusive: Boolean = false,
    )

    data class LineResult(
        val grossMinor: Long,
        val discountMinor: Long,
        val netMinor: Long,
        val taxMinor: Long,
        val lineTotalMinor: Long,
    )

    /** Round half-up for non-negative values. */
    fun roundHalfUp(x: Double): Long = Math.floor(x + 0.5).toLong()

    fun computeLine(input: LineInput): LineResult {
        val gross = (input.unitPriceMinor.toDouble() * input.quantity)
        val discount = roundHalfUp(gross * input.discountBp / 10000.0)
        val netBeforeTax = gross - discount

        return if (input.taxInclusive) {
            val tax = roundHalfUp(netBeforeTax * input.taxRateBp / (10000.0 + input.taxRateBp))
            LineResult(
                grossMinor = gross.toLong(),
                discountMinor = discount,
                netMinor = (netBeforeTax - tax).toLong(),
                taxMinor = tax,
                lineTotalMinor = netBeforeTax.toLong(),
            )
        } else {
            val tax = roundHalfUp(netBeforeTax * input.taxRateBp / 10000.0)
            LineResult(
                grossMinor = gross.toLong(),
                discountMinor = discount,
                netMinor = netBeforeTax.toLong(),
                taxMinor = tax,
                lineTotalMinor = (netBeforeTax + tax).toLong(),
            )
        }
    }

    data class DocumentTotals(val subtotalMinor: Long, val taxTotalMinor: Long, val totalMinor: Long, val discountTotalMinor: Long)

    fun computeDocument(lines: List<LineInput>): DocumentTotals {
        var subtotal = 0L
        var tax = 0L
        var total = 0L
        var discount = 0L
        for (line in lines) {
            val r = computeLine(line)
            subtotal += r.netMinor
            tax += r.taxMinor
            total += r.lineTotalMinor
            discount += r.discountMinor
        }
        return DocumentTotals(subtotal, tax, total, discount)
    }

    fun formatMinor(minor: Long): String {
        val sign = if (minor < 0) "-" else ""
        val abs = kotlin.math.abs(minor)
        return "$sign${abs / 100}.${(abs % 100).toString().padStart(2, '0')}"
    }

    /**
     * Parse an operator-typed money amount into integer minor units, exactly. Mirror of
     * `parseMinorInput` in packages/domain-fixtures and apps/api/src/domain/pricing.ts — keep all
     * three identical, as the fixture vectors require.
     *
     * Integer/string arithmetic only: money never passes through binary floating point (§7).
     * Over-precise input (more than two decimals) is REJECTED rather than rounded, because silently
     * rounding a typed price is a money error.
     *
     * @return minor units, or null when the input is not a valid amount
     */
    fun parseMinorInput(text: String?): Long? {
        if (text == null) return null
        val trimmed = text.trim().replace(",", "").replace(" ", "")
        if (!Regex("^\\d+(\\.\\d{1,2})?$").matches(trimmed)) return null
        val parts = trimmed.split(".")
        val whole = parts[0]
        val fraction = if (parts.size > 1) parts[1] else ""
        val cents = (fraction + "00").substring(0, 2)
        return try {
            whole.toLong() * 100 + cents.toLong()
        } catch (_: NumberFormatException) {
            null
        }
    }
}
