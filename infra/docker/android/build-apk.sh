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
# versionCode is derived from the semantic version (0.5.0 -> 500, 0.4.1 -> 401) so it is always
# monotonic and can never disagree with the artifact name or the manifest.
VERSION_CODE="${VERSION_CODE:-$(echo "${VERSION}" | awk -F. '{printf "%d", ($1*10000)+($2*100)+$3}')}"
ARTIFACTS="${ROOT}/artifacts"

mkdir -p "${ARTIFACTS}"

echo "==> Building ${IMAGE} (first run downloads the Android SDK; be patient)"
docker build -t "${IMAGE}" -f "${SCRIPT_DIR}/Dockerfile" "${SCRIPT_DIR}"

# --- Stable internal-test signing key (ADR 0005) ------------------------------------------------
# Generated once, on disk, and never committed. Without it the APK falls back to the debug key,
# which is not upgrade-stable, so the phase phone checklists cannot be verified for real.
KEYSTORE_DIR="${ROOT}/apps/android/keystore"
KEYSTORE_FILE="${KEYSTORE_DIR}/internal-test.jks"
KEYSTORE_PROPS="${KEYSTORE_DIR}/keystore.properties"
if [[ ! -f "${KEYSTORE_FILE}" || ! -f "${KEYSTORE_PROPS}" ]]; then
  echo "==> Generating stable internal-test signing key (one-off)"
  mkdir -p "${KEYSTORE_DIR}"
  KS_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  docker run --rm -v "${KEYSTORE_DIR}":/ks "${IMAGE}" keytool -genkeypair \
    -keystore /ks/internal-test.jks -storetype PKCS12 \
    -alias kiosk-internal -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "${KS_PASSWORD}" -keypass "${KS_PASSWORD}" \
    -dname "CN=Kiosk ERP Internal Test, OU=QA, O=Kiosk, L=Nairobi, C=KE"
  cat > "${KEYSTORE_PROPS}" <<EOF
storeFile=keystore/internal-test.jks
storePassword=${KS_PASSWORD}
keyAlias=kiosk-internal
keyPassword=${KS_PASSWORD}
EOF
  chmod 600 "${KEYSTORE_PROPS}"
  echo "    key: ${KEYSTORE_FILE}"
fi

echo "==> Compiling debug APK (phase ${PHASE}, v${VERSION}, versionCode ${VERSION_CODE})"
docker run --rm \
  -v "${ROOT}/apps/android":/workspace \
  -v "${ARTIFACTS}":/artifacts \
  -v kiosk-erp-gradle-cache:/opt/gradle-home \
  -w /workspace \
  "${IMAGE}" gradle --no-daemon \
  -PappVersionCode="${VERSION_CODE}" \
  -PappVersionName="${VERSION}" \
  assembleDebug

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
