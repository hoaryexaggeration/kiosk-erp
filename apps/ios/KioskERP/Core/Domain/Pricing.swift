import Foundation

/// Deterministic pricing/tax subset — MUST match `packages/domain-fixtures` and the TypeScript and
/// Kotlin implementations byte-for-byte on the same JSON vectors (Phase 13 conformance gate).
/// Money = integer minor units; rates = basis points; rounding = half-up per line.
public enum Pricing {

    public struct LineInput {
        public let unitPriceMinor: Int
        public let quantity: Double
        public let discountBp: Int
        public let taxRateBp: Int
        public let taxInclusive: Bool

        public init(unitPriceMinor: Int, quantity: Double, discountBp: Int = 0, taxRateBp: Int = 0, taxInclusive: Bool = false) {
            self.unitPriceMinor = unitPriceMinor
            self.quantity = quantity
            self.discountBp = discountBp
            self.taxRateBp = taxRateBp
            self.taxInclusive = taxInclusive
        }
    }

    public struct LineResult: Equatable {
        public let grossMinor: Int
        public let discountMinor: Int
        public let netMinor: Int
        public let taxMinor: Int
        public let lineTotalMinor: Int
    }

    public static func roundHalfUp(_ x: Double) -> Int {
        Int(floor(x + 0.5))
    }

    public static func computeLine(_ input: LineInput) -> LineResult {
        let gross = Double(input.unitPriceMinor) * input.quantity
        let discount = Double(roundHalfUp(gross * Double(input.discountBp) / 10000.0))
        let netBeforeTax = gross - discount

        if input.taxInclusive {
            let tax = roundHalfUp(netBeforeTax * Double(input.taxRateBp) / (10000.0 + Double(input.taxRateBp)))
            return LineResult(
                grossMinor: Int(gross),
                discountMinor: Int(discount),
                netMinor: Int(netBeforeTax) - tax,
                taxMinor: tax,
                lineTotalMinor: Int(netBeforeTax)
            )
        }

        let tax = roundHalfUp(netBeforeTax * Double(input.taxRateBp) / 10000.0)
        return LineResult(
            grossMinor: Int(gross),
            discountMinor: Int(discount),
            netMinor: Int(netBeforeTax),
            taxMinor: tax,
            lineTotalMinor: Int(netBeforeTax) + tax
        )
    }
}
