package com.kiosk.erp.core.security

import android.util.Base64
import com.nimbusds.jose.JWSObject
import com.nimbusds.jose.crypto.ECDSAVerifier
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.KeyFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec

/** Portable, signed license grant (server §13.5 payload). */
@Serializable
data class LicensePayload(
    val formatVersion: Int,
    val licenseId: String,
    val tenantId: String,
    val planId: String,
    val editionId: String,
    val entitlementIds: List<String> = emptyList(),
    val perpetualCore: Boolean = false,
    val maintenanceExpiresAt: String? = null,
    val connectedServicesExpiresAt: String? = null,
    val deviceQuota: Int = 1,
    val branchQuota: Int = 1,
    val minAppBuild: Int = 1,
    val packageSerial: String,
    val revision: Int,
    val requestNonce: String? = null,
    val issuedAt: String,
    val deviceKeyFingerprints: List<String> = emptyList(),
    val kid: String,
)

/**
 * Verifies an offline license package using a VETTED JOSE library (ADR 0003).
 * The app holds only the public key, pins the allowed algorithm and `kid`, and rejects
 * anything it does not recognise — it never trusts the package's own choices.
 */
object LicenseVerifier {

    /** Key-id allowlist (rotate by shipping a new app build — §13.5). */
    private val allowedKids = setOf("dev-2026-10", "production-1")

    private val json = Json { ignoreUnknownKeys = true }

    fun verify(jws: String, publicKeyPem: String): LicensePayload {
        val jwsObject = JWSObject.parse(jws)

        val alg = jwsObject.header.algorithm.name
        require(alg == "ES256") { "Unsupported signature algorithm: $alg" }
        val kid = jwsObject.header.keyID ?: ""
        require(allowedKids.contains(kid)) { "Untrusted signing key id: $kid" }

        val publicKey = parseEcPublicKey(publicKeyPem)
        if (!jwsObject.verify(ECDSAVerifier(publicKey))) {
            throw IllegalArgumentException("License signature is not valid")
        }

        val payload = json.decodeFromString(LicensePayload.serializer(), jwsObject.payload.toString())
        require(payload.formatVersion == 1) { "Unsupported package formatVersion ${payload.formatVersion}" }
        return payload
    }

    private fun parseEcPublicKey(pem: String): ECPublicKey {
        val base64 = pem
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace("\\s".toRegex(), "")
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val spec = X509EncodedKeySpec(bytes)
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }
}
