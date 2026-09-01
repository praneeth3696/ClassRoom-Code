import { config, assertProductionConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { describeDb, closeDb } from './db/index.js';

assertProductionConfig();

const info = await describeDb();
console.log(`[db] ${info.driver} -> ${info.target}`);
await migrate({ quiet: true });

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  });
}
