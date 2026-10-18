# ADR 0003 — Offline license package signing

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 2 (issuance) / 3 (client import)
- **Supersedes:** an earlier working idea of raw Ed25519 over hand-canonicalized JSON

## Context

Section 10 ("Licensing trust boundary") and §13.5 ("Signed package contract") require: a strict,
versioned payload signed with a **vetted signature format/library — for example a standard signed
JSON/COSE format**; signing the **exact canonical payload**; **never inventing cryptography**;
packages declaring a **key id** with a small app-side **allowlist** of public keys for rotation;
the app containing **only the public verification key**; and, where device-bound, a **hardware-backed
installation keypair** (Android KeyStore / iOS Secure Enclave).

## Options considered

1. **Raw Ed25519 signature over RFC 8785 canonical JSON** (earlier lean).
2. **JWS compact serialization**, `EdDSA` (Ed25519).
3. **JWS compact serialization**, `ES256` (ECDSA P-256), with a pinned algorithm/`kid` allowlist.

## Decision

Use **JWS compact serialization via `jose`**, with an app-side **pinned allowlist of signature
algorithms and `kid`s** (primary `ES256`; `EdDSA` permitted where a deployment requires it).
Device-bound packages include the **SPKI fingerprint of an ECDSA P-256 installation keypair** held in
Android KeyStore / iOS Secure Enclave. The app **verifies only**; issuance signing happens server-side
behind a KMS/HSM or controlled signer (Phase 2 uses a file-based dev key; production key is never in
the repo, app bundle, CI logs or agent laptops).

Reasons:

- JWS signs the **base64url payload as transmitted**, eliminating the JSON **canonicalization footgun**
  (key order, unicode, number formatting) that made option 1 fragile across Node/Kotlin/Swift — and
  option 1's "invent a format" drift is exactly what §10 forbids.
- The JWS `kid` header is precisely the **rotation/allowlist** mechanism §13.5 asks for.
- **ES256** is chosen over EdDSA for maximum portability: it is the curve actually backed by **iOS
  Secure Enclave and Android KeyStore** for the device installation keypair, and it verifies natively
  on the oldest supported OS baselines. The device only verifies, so ECDSA nonce risk is irrelevant
  on-client; the server signs with a vetted library.
- The app **pins the algorithm** (never trusts the package's `alg`), satisfying "do not accept an
  algorithm specified by an untrusted package".

## Consequences

- **Positive:** standard, portable, rotates via `kid`; one crypto library (`jose`) shared with auth.
- **Negative:** ES256 public keys are larger than Ed25519; we maintain a key allowlist release path.
- **Mitigation:** document key rotation as a deliberate app-release/migration step (§13.5).

## Compliance check

Satisfies §10 and §13.5. No architectural rule violated; corrects a prior weak lean.
