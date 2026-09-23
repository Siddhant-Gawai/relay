import './load-env.js';
import { MongoStore } from './storage.js';
import { secretBox } from './lib/security.js';
import { createAuth } from './lib/auth.js';
import { createRelay } from './lib/app.js';
import { startWorker } from './delivery.js';

export async function start(config = process.env) {
  const production = config.NODE_ENV === 'production';
  const authMode = config.RELAY_AUTH_MODE || 'supabase';
  if (!config.MONGODB_URI) throw new Error('MONGODB_URI is required. For an isolated local demo, run npm run demo.');
  if (production && (authMode !== 'supabase' || config.RELAY_ALLOW_PRIVATE_DESTINATIONS === 'true' || !config.RELAY_PUBLIC_ORIGIN?.startsWith('https://'))) throw new Error('Production requires Supabase Auth, an HTTPS public origin, and public-only destinations');
  const encodedKey = config.RELAY_ENCRYPTION_KEY;
  if (!encodedKey) throw new Error('Set RELAY_ENCRYPTION_KEY; use npm run demo for isolated local setup');
  const box = secretBox(encodedKey);
  const auth = createAuth({ mode: authMode, url: config.SUPABASE_URL, key: config.SUPABASE_PUBLISHABLE_KEY, secure: production });
  const store = await MongoStore.connect(config.MONGODB_URI, config.MONGODB_DB || 'relay');
  const workerEnabled = config.RELAY_WORKER_ENABLED !== 'false';
  const worker = workerEnabled ? startWorker(store, box, { allowPrivate: config.RELAY_ALLOW_PRIVATE_DESTINATIONS === 'true',
    onError: () => console.error(JSON.stringify({ code: 'WORKER_STORAGE_ERROR' })) }) : undefined;
  const port = Number(config.PORT || 3000);
  const server = createRelay({ store, box, auth, worker, allowPrivate: config.RELAY_ALLOW_PRIVATE_DESTINATIONS === 'true',
    origin: config.RELAY_PUBLIC_ORIGIN || 'http://localhost:' + port, onError: value => console.error(JSON.stringify(value)) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, authMode === 'local' ? '127.0.0.1' : config.HOST || '0.0.0.0', resolve); });
  console.log('Relay listening on http://localhost:' + server.address().port);
  const close = async () => { await worker?.stop(); await new Promise(resolve => server.close(resolve)); await store.close(); };
  return { server, store, worker, close };
}
if (process.env.RELAY_IMPORT_ONLY !== 'true') {
  start().then(app => {
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
  }).catch(() => { console.error('Relay startup failed. Check MongoDB replica-set connectivity, auth settings and encryption-key configuration. No memory fallback is used.'); process.exitCode = 1; });
}

