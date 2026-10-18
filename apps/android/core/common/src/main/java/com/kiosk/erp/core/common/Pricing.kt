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
}
