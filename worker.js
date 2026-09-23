import './load-env.js';
import { pathToFileURL } from 'node:url';
import { MongoStore } from './storage.js';
import { secretBox } from './lib/security.js';
import { startWorker } from './delivery.js';

export async function runWorker(config = process.env, options = {}) {
  if (!config.MONGODB_URI || !config.RELAY_ENCRYPTION_KEY) throw new Error('Worker requires MongoDB and encryption-key configuration');
  if (config.NODE_ENV === 'production' && config.RELAY_ALLOW_PRIVATE_DESTINATIONS === 'true') throw new Error('Private destinations are not permitted in production');
  const box = secretBox(config.RELAY_ENCRYPTION_KEY);
  const store = await MongoStore.connect(config.MONGODB_URI, config.MONGODB_DB || 'relay');
  const worker = startWorker(store, box, { ...options, allowPrivate: config.RELAY_ALLOW_PRIVATE_DESTINATIONS === 'true',
    onError: () => console.error(JSON.stringify({ code: 'WORKER_STORAGE_ERROR' })) });
  return { store, worker, async close() { await worker.stop(); await store.close(); } };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runWorker().then(runtime => {
    console.log('Relay worker ready');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      if (stopping) return; stopping = true; await runtime.close(); process.exit(0);
    });
  }).catch(() => { console.error('Worker startup failed. Check MongoDB and encryption-key configuration.'); process.exitCode = 1; });
}

