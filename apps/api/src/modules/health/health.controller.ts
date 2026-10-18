import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth-context';
import { DbService } from '../../db/db.service';
import { config } from '../../config';

const BUILD = {
  app: 'kiosk-erp-api',
  version: '0.1.0',
  schemaVersion: 1,
  minClientSchemaVersion: 1,
};

@Controller('health')
export class HealthController {
  constructor(private readonly dbs: DbService) {}

  @Public()
  @Get()
  liveness() {
    return { status: 'ok', env: config.NODE_ENV, build: BUILD, time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async readiness() {
    try {
      await this.dbs.ping();
      return { status: 'ready', db: 'up', build: BUILD };
    } catch (err) {
      return { status: 'degraded', db: 'down', error: (err as Error).message, build: BUILD };
    }
  }
}
