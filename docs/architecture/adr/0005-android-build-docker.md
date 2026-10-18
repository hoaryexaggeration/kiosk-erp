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
- are generated once and **never committed** (`*.jks`/`*.keystore` are git-ignored);
- are supplied via an env/local secrets file path, defaulting to `infra/docker/android/secrets/`;
- use a distinct **internal-test** alias, never a public/app-store key (§15).

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
