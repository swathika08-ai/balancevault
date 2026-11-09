import { config } from './config.js';
import { createApp } from './app.js';
import { runMigrations } from './migrate.js';

if (process.env.RUN_MIGRATIONS === 'true') {
  await runMigrations();
}

const server = createApp().listen(config.port, () => {
  console.log(`BalanceVault API listening on :${config.port}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
