import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { applyMigrations, resetDatabase } from '../../src/db/migrator';
import { seedDev } from '../../src/db/seed-dev';
import { config } from '../../src/config';

export interface TestContext {
  app: INestApplication;
  dbs: DbService;
}

/**
 * Boot a Nest application against a freshly migrated, seeded test database.
 * Requires the Docker Postgres from infra/docker/docker-compose.yml.
 */
export async function createTestApp(options: { reset?: boolean } = {}): Promise<TestContext> {
  const reset = options.reset ?? true;
  if (reset) {
    await resetDatabase(config.DATABASE_URL);
    await applyMigrations(config.DATABASE_URL);
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  await app.init();
  const dbs = app.get(DbService);
  await seedDev(dbs);
  return { app, dbs };
}
