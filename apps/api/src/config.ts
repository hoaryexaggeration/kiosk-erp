import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://kiosk:kiosk@localhost:5432/kiosk_erp'),
  JWT_SECRET: z.string().min(16).default('dev-only-change-me-please-0123456789abcdef'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  LICENSE_SIGNING_PRIVATE_KEY_PATH: z.string().default('./.secrets/license-signing.key.pem'),
  LICENSE_SIGNING_PUBLIC_KEY_PATH: z.string().default('./.secrets/license-signing.pub.pem'),
  LICENSE_SIGNING_KID: z.string().default('dev-2026-10'),
  CORS_ORIGINS: z.string().default(''),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export const config: AppConfig = EnvSchema.parse(process.env);

export const isTest = config.NODE_ENV === 'test';
