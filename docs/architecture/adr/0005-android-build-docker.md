# ADR 0005 — Building the Android APK in Docker

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 0–12 (every APK gate)

## Context

§15 makes an installable, internally-signed APK a **mandatory artifact at the end of every Phase
0–12**, testable on a physical phone and installable as an upgrade over the previous build. The
working environment for this repository has **no host JDK and no Android SDK**, and iOS cannot be
compiled on Linux at all. Docker (with a working daemon) is available.

## Decision

Build the Android APK **inside a Docker image** that contains a JDK, Android command-line SDK,
platform/build-tools and Gradle, using a **stable internal-test signing keystore** kept out of source
control. The host requires only Docker. Grading the build: `infra/docker/android/Dockerfile` +
`build-apk.sh`, invoked by `npm run android:build`, writing artifacts to `artifacts/`.

The signing keystore and its password:

- are generated **once** by `build-apk.sh` (JDK `keytool`, run inside the builder image) so the host
  needs nothing but Docker;
- live at `apps/android/keystore/` and are **git-ignored** — the store itself plus a
  `keystore.properties` holding the randomly generated store/key password (`chmod 600`);
- use a distinct **internal-test** alias (`kiosk-internal`) and identity, never a public/app-store key
  (§15);
- are applied to the `debug` build type, so internal builds are **upgrade-stable** across phases;
- fall back to the Android debug keystore only when the internal key is absent (e.g. a fresh clone
  before the first `build-apk.sh` run), which is fine for a one-off build but not for the phase phone
  checklists.

## Consequences

- **Positive:** satisfies the APK gate without a host toolchain; reproducible CI story (same image).
- **Negative:** first build downloads a large SDK image; Docker must be running; build is slower than
  a warm host Gradle.
- **Open risk:** if image download or Gradle dependency resolution is blocked by the environment, the
  APK gate cannot be met on that machine and the repo must be built on a host with the SDK. This is a
  genuine constraint, not a design choice, and is logged here rather than hidden.

## Compliance check

Preserves the mandated stack (Kotlin/Compose/Room/Gradle) and the §15 APK delivery protocol; only the
*build host* changes. iOS remains scaffold-only, consistent with deferring it to Phase 13.
