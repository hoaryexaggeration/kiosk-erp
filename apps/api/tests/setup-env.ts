process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://kiosk:kiosk@localhost:5432/kiosk_erp';
process.env.JWT_SECRET ??= 'test-secret-0123456789abcdefghij';
process.env.ACCESS_TOKEN_TTL_SECONDS ??= '900';
process.env.LICENSE_SIGNING_KID ??= 'test-kid';
process.env.LICENSE_SIGNING_PRIVATE_KEY_PATH ??= '/tmp/opencode/kiosk-test-license.key.pem';
process.env.LICENSE_SIGNING_PUBLIC_KEY_PATH ??= '/tmp/opencode/kiosk-test-license.pub.pem';
