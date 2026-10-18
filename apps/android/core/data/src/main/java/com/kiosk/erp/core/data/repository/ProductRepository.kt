package com.kiosk.erp.core.data.repository

import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.network.ServerProduct
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The device's offline catalogue cache. Reads are always served from Room; the network only ever
 * fills the cache (§1.6 rule 1). Tax rates come from the server's tax categories — never a default.
 */
class ProductRepository(private val db: KioskDatabase) {

    fun observeProducts(): Flow<List<ProductEntity>> = db.productDao().observeAll()

    suspend fun refreshProducts(products: List<ServerProduct>) {
        db.productDao().upsertAll(products.map { it.toEntity() })
    }

    /** Apply a `product.created` / `product.updated` server event to the local cache (delta sync). */
    suspend fun applyProductEvent(obj: JsonObject) {
        val id = obj["id"]?.jsonPrimitive?.content ?: return
        db.productDao().upsertAll(
            listOf(
                ProductEntity(
                    id = id,
                    sku = obj["sku"]?.jsonPrimitive?.content ?: return,
                    name = obj["name"]?.jsonPrimitive?.content ?: return,
                    unit = obj["unit"]?.jsonPrimitive?.content ?: "ea",
                    priceMinor = obj["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    costMinor = obj["cost_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    taxRateBp = obj["tax_rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                    taxInclusive = obj["tax_inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
                    isStockTracked = obj["is_stock_tracked"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
                    version = obj["version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
                    updatedAtEpochMs = System.currentTimeMillis(),
                ),
            ),
        )
    }

    private fun ServerProduct.toEntity() = ProductEntity(
        id = id,
        sku = sku,
        name = name,
        unit = unit,
        priceMinor = priceMinor,
        costMinor = costMinor,
        taxRateBp = taxRateBp,
        taxInclusive = taxInclusive,
        isStockTracked = true,
        version = version,
        updatedAtEpochMs = System.currentTimeMillis(),
    )
}
