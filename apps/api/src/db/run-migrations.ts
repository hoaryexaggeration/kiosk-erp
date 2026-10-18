import { applyMigrations } from './migrator';
import { config } from '../config';

applyMigrations(config.DATABASE_URL, (m) => console.log(m))
  .then(() => {
    console.log('Migrations complete.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
