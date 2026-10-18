import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import { config } from '../config';
import { Database } from './database';

// Return bigint (OID 20) and numeric (OID 1700) as JS numbers.
// Safe for shop-scale money minor units and quantities; revisit if values approach 2^53.
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: Pool;
  readonly db: Kysely<Database>;

  constructor() {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ping();
      this.logger.log('Database connection established');
    } catch (err) {
      this.logger.error(`Database ping failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }

  async ping(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }

  /** Run a function inside a single database transaction (sale atomicity, §1.6 rule 2). */
  transaction<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(fn);
  }
}
