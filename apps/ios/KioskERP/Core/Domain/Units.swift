import Foundation

/// Units of measure and conversion (item 4.6) — MUST match `packages/domain-fixtures`, the
/// TypeScript implementation and the Kotlin port byte-for-byte on the same JSON vectors
/// (Phase 13 conformance gate).
///
/// Stock is only ever held in a product's BASE unit, so this is the single place a crate becomes
/// 24 pieces: `factor` is how many base units one of that unit contains. Quantities are
/// fixed-point at 3 decimals rounded half-up (the ledger's precision).
public enum Units {

    /// Ledger precision for quantities — `numeric(18,3)` on the server.
    public static let quantityDecimals = 3
    private static let quantityScale = 1000.0

    public enum Kind: String {
        case count
        case weight
        case volume
    }

    public enum ConvertResult: Equatable {
        /// The quantity in the target unit, at ledger precision.
        case ok(Double)
        /// A STABLE machine code (`FRACTIONAL_QUANTITY`, `INVALID_CONVERSION_FACTOR`, ...).
        case failed(String)
    }

    /// Round to ledger precision, half-up — the same rule the server applies.
    public static func roundQuantity(_ x: Double) -> Double {
        floor(x * quantityScale + 0.5) / quantityScale
    }

    /// Convert a quantity from one unit of a product into another unit of the same product.
    ///
    /// A `count` result that is not a whole number is REFUSED: 0.2 of a bottle is not something a
    /// shop can receive.
    public static func convertQuantity(
        quantity: Double,
        fromFactor: Double,
        toFactor: Double,
        kind: Kind = .count
    ) -> ConvertResult {
        guard quantity.isFinite else { return .failed("INVALID_QUANTITY") }
        guard fromFactor.isFinite, toFactor.isFinite, fromFactor > 0, toFactor > 0 else {
            return .failed("INVALID_CONVERSION_FACTOR")
        }
        let scaled = roundQuantity(quantity * fromFactor / toFactor)
        guard scaled.isFinite else { return .failed("INVALID_QUANTITY") }
        if kind == .count && scaled != scaled.rounded() {
            return .failed("FRACTIONAL_QUANTITY")
        }
        return .ok(scaled)
    }
}
