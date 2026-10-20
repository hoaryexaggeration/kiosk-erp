package com.kiosk.erp.core.data.repository

import androidx.room.withTransaction
import com.kiosk.erp.core.database.BarcodeEntity
import com.kiosk.erp.core.database.KioskDatabase
import com.kiosk.erp.core.database.ProductConversionEntity
import com.kiosk.erp.core.database.ProductEntity
import com.kiosk.erp.core.network.ServerConversion
import com.kiosk.erp.core.network.ServerProduct
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The device's offline catalogue cache. Reads are always served from Room; the network only ever
 * fills the cache (§1.6 rule 1). Tax rates come from the server's tax categories — never a default.
 *
 * Barcodes and pack sizes are cached as SETs. When the server reports a product's barcodes or
 * conversions, whatever it reports replaces what is stored for that product, so a tag or a pack size
 * removed on the server stops resolving on the device. Only ever adding would leave a stale
 * identifier usable for ever — a scannable barcode, or a receipt in a crate that no longer exists.
 */
class ProductRepository(private val db: KioskDatabase) {

    fun observeProducts(): Flow<List<ProductEntity>> = db.productDao().observeAll()

    /** Catalogue search for the management screen (name, SKU or barcode). */
    fun observeMatching(query: String): Flow<List<ProductEntity>> = db.productDao().observeMatching(query.trim())

    suspend fun byId(id: String): ProductEntity? = db.productDao().byId(id)

    /** The barcodes currently cached for a product (used to seed the editor). */
    suspend fun barcodes(productId: String): List<String> = db.productDao().barcodesFor(productId)

    /**
     * The pack sizes cached for a product (item 4.6). Seeded into the editor and used to convert an
     * adjustment in packs without a round-trip, so the operator sees the base quantity they are about
     * to queue before they queue it.
     */
    suspend fun conversions(productId: String): List<ProductConversionEntity> = db.productDao().conversionsFor(productId)

    /** Resolve a scanned/manual barcode from the LOCAL cache only — scanning never needs a network. */
    suspend fun findByBarcode(code: String): ProductEntity? = db.productDao().byBarcode(code.trim())

    suspend fun refreshProducts(products: List<ServerProduct>) {
        db.withTransaction {
            db.productDao().upsertAll(products.map { it.toEntity() })
            for (p in products) {
                replaceBarcodes(p.id, p.barcodes)
                replaceConversions(p.id, p.conversions)
            }
        }
    }

    /** Cache a single product returned by a create/update so the change is visible immediately. */
    suspend fun cacheProduct(product: ServerProduct) {
        db.withTransaction {
            db.productDao().upsertAll(listOf(product.toEntity()))
            replaceBarcodes(product.id, product.barcodes)
            replaceConversions(product.id, product.conversions)
        }
    }

    /** Apply a `product.created` / `product.updated` server event to the local cache (delta sync). */
    suspend fun applyProductEvent(obj: JsonObject) {
        val id = obj["id"]?.jsonPrimitive?.content ?: return
        val sku = obj["sku"]?.jsonPrimitive?.content ?: return
        val name = obj["name"]?.jsonPrimitive?.content ?: return
        val barcodes = obj["barcodes"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
        val conversions = obj["conversions"]?.jsonArray?.mapNotNull { element ->
            val conversion = element.jsonObject
            val unit = conversion["unit"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val factor = conversion["factor"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: return@mapNotNull null
            ServerConversion(unit = unit, factor = factor)
        } ?: emptyList()
        db.withTransaction {
            db.productDao().upsertAll(
                listOf(
                    ProductEntity(
                        id = id,
                        sku = sku,
                        name = name,
                        unit = obj["unit"]?.jsonPrimitive?.content ?: "ea",
                        priceMinor = obj["price_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                        costMinor = obj["cost_minor"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                        taxRateBp = obj["tax_rate_bp"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                        taxInclusive = obj["tax_inclusive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
                        isStockTracked = obj["is_stock_tracked"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
                        version = obj["version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
                        updatedAtEpochMs = System.currentTimeMillis(),
                        description = obj["description"]?.jsonPrimitive?.contentOrNull,
                        categoryId = obj["category_id"]?.jsonPrimitive?.contentOrNull,
                        taxCategoryId = obj["tax_category_id"]?.jsonPrimitive?.contentOrNull,
                        brandId = obj["brand_id"]?.jsonPrimitive?.contentOrNull,
                        brandName = obj["brand_name"]?.jsonPrimitive?.contentOrNull,
                        unitKind = obj["unit_kind"]?.jsonPrimitive?.contentOrNull,
                        // A product event carries the WHOLE payload (item 4.9 included), so a
                        // threshold set on the server lands on a device that is already synced.
                        reorderPoint = obj["reorder_point"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull(),
                        isActive = obj["is_active"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: true,
                    ),
                ),
            )
            replaceBarcodes(id, barcodes)
            replaceConversions(id, conversions)
        }
    }

    /** Delete-then-insert so the stored set is exactly what the server reports. */
    private suspend fun replaceBarcodes(productId: String, barcodes: List<String>) {
        db.productDao().deleteBarcodesFor(productId)
        if (barcodes.isNotEmpty()) {
            db.productDao().upsertBarcodes(barcodes.map { BarcodeEntity(barcode = it, productId = productId) })
        }
    }

    /** Same SET rule as barcodes: a pack size the server no longer reports stops converting here. */
    private suspend fun replaceConversions(productId: String, conversions: List<ServerConversion>) {
        db.productDao().deleteConversionsFor(productId)
        if (conversions.isNotEmpty()) {
            db.productDao().upsertConversions(
                conversions.map { ProductConversionEntity(productId = productId, unit = it.unit, factor = it.factor) },
            )
        }
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
        isStockTracked = isStockTracked,
        version = version,
        updatedAtEpochMs = System.currentTimeMillis(),
        description = description,
        categoryId = categoryId,
        taxCategoryId = taxCategoryId,
        brandId = brandId,
        brandName = brandName,
        unitKind = unitKind,
        reorderPoint = reorderPoint,
        isActive = isActive,
    )
}
