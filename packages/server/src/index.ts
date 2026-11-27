import { createMokie } from './app.ts';
import { ADMIN_PREFIX, loadConfig } from './config.ts';

const config = loadConfig();
const m = await createMokie(config);
await m.app.listen({ port: config.port, host: config.host });

console.log(`
  モキ Mokie
  ─────────────────────────────────────────
  Proxy / mock  → http://localhost:${config.port}
  Admin UI      → http://localhost:${config.port}${ADMIN_PREFIX}/
  Database      → ${config.dbPath}
`);

const shutdown = async () => {
  await m.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
