#!/usr/bin/env bash
# Build an installable debug APK for Android inside Docker (ADR 0005).
#
#   npm run android:build
#   PHASE=03 VERSION=0.3.0 bash infra/docker/android/build-apk.sh
#
# Produces artifacts/retail-erp-p<PHASE>-v<VERSION>.apk + .sha256
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
IMAGE="kiosk-erp-android-builder"
PHASE="${PHASE:-03}"
VERSION="${VERSION:-0.3.0}"
ARTIFACTS="${ROOT}/artifacts"

mkdir -p "${ARTIFACTS}"

echo "==> Building ${IMAGE} (first run downloads the Android SDK; be patient)"
docker build -t "${IMAGE}" -f "${SCRIPT_DIR}/Dockerfile" "${SCRIPT_DIR}"

echo "==> Compiling debug APK (phase ${PHASE}, v${VERSION})"
docker run --rm \
  -v "${ROOT}/apps/android":/workspace \
  -v "${ARTIFACTS}":/artifacts \
  -v kiosk-erp-gradle-cache:/opt/gradle-home \
  -w /workspace \
  "${IMAGE}" gradle --no-daemon assembleDebug

APK_SRC="${ROOT}/apps/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "${APK_SRC}" ]]; then
  echo "!! APK not found at ${APK_SRC}" >&2
  exit 1
fi

APK_OUT="${ARTIFACTS}/retail-erp-p${PHASE}-v${VERSION}.apk"
cp "${APK_SRC}" "${APK_OUT}"
( cd "${ARTIFACTS}" && sha256sum "retail-erp-p${PHASE}-v${VERSION}.apk" > "retail-erp-p${PHASE}-v${VERSION}.apk.sha256" )

echo "==> APK: ${APK_OUT}"
cat "${ARTIFACTS}/retail-erp-p${PHASE}-v${VERSION}.apk.sha256"
