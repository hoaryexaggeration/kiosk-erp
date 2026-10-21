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

    /**
     * One price-list row as the pricing maths sees it (item 4.11) — kept in primitives so this
     * object stays the dependency-free mirror of the server's resolution.
     */
    data class PriceWindow(
        val branchId: String?,
        val priceMinor: Long,
        val validFromEpochMs: Long,
        val validToEpochMs: Long?,
    )

    /**
     * The effective list price for one shelf at one instant (item 4.11). Most specific scope wins
     * — a row naming this branch beats the tenant-wide row — then the latest window start, exactly
     * as the server sorts them, so a till prices itself offline the way the cloud would, and a
     * scheduled flip takes over the moment its window opens with no push required.
     */
    fun effectiveListPrice(baseMinor: Long, windows: List<PriceWindow>, branchId: String?, asOfEpochMs: Long): Long {
        val inForce = windows
            .filter { window -> window.branchId == null || window.branchId == branchId }
            .filter { window -> window.validFromEpochMs <= asOfEpochMs && (window.validToEpochMs == null || window.validToEpochMs > asOfEpochMs) }
            .sortedWith(compareByDescending<PriceWindow> { it.branchId != null }.thenByDescending { it.validFromEpochMs })
            .firstOrNull()
        return inForce?.priceMinor ?: baseMinor
    }

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

    /**
     * Parse an operator-typed date for a price-list window (item 4.11): `yyyy-MM-dd` is taken as
     * the start of that UTC day, a full ISO instant is taken as itself. Anything else is null —
     * a window is never guessed from junk.
     */
    fun parseDateInput(text: String?): Long? {
        val trimmed = text?.trim() ?: return null
        if (trimmed.isEmpty()) return null
        return runCatching {
            if (Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(trimmed)) {
                java.time.LocalDate.parse(trimmed).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
            } else {
                java.time.Instant.parse(trimmed).toEpochMilli()
            }
        }.getOrNull()
    }
}
