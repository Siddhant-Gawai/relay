import { runWorker } from '../worker.js';
const runtime = await runWorker({
  MONGODB_URI: process.env.TEST_MONGO_URI, MONGODB_DB: process.env.TEST_DB,
  RELAY_ENCRYPTION_KEY: process.env.TEST_KEY, RELAY_ALLOW_PRIVATE_DESTINATIONS: 'true'
}, { pollMs: 20, leaseMs: 800, concurrency: 1 });
process.send?.('ready');
process.on('message', async message => { if (message === 'stop') { await runtime.close(); process.exit(0); } });

