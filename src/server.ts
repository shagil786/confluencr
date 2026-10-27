import 'dotenv/config';
import { createApp } from './app.js';
import { createPool } from './db.js';

const pool = createPool();
const server = createApp(pool).listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Ledger listening on port ${process.env.PORT ?? 3000}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { void pool.end(); });
  });
}
