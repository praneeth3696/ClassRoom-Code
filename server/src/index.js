import { config, assertProductionConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { describeDb, closeDb } from './db/index.js';
import { shutdownEngines } from './services/dbEngines/index.js';
import { createShutdown } from './lib/shutdown.js';

assertProductionConfig();

const info = await describeDb();
console.log(`[db] ${info.driver} -> ${info.target}`);
await migrate({ quiet: true });

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});

const shutdown = createShutdown({ server, cleanups: [shutdownEngines, closeDb] });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
