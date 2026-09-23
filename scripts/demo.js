import '../load-env.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { secretBox, DEFAULT_POLICY } from '../lib/security.js';

if (!process.env.MONGODB_URI) throw new Error('Configure MONGODB_URI in .env before running the demo');
process.env.RELAY_IMPORT_ONLY = 'true';
const directory = resolve('.relay-local');
await mkdir(directory, { recursive: true });
const keyPath = resolve(directory, 'master-key');
let key;
try { key = await readFile(keyPath, 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = randomBytes(32).toString('base64'); await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
}
const box = secretBox(key);
const demoDatabase = process.env.RELAY_DEMO_DB || 'relay_demo';
if (demoDatabase === (process.env.MONGODB_DB || 'relay')) throw new Error('Demo database must differ from the app database');
const port = Number(process.env.RELAY_DEMO_PORT || 3100);
let app;
const attempts = new Map();
const receiver = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const event = await app.store.deliveries.findOne({ id: req.headers['relay-event-id'] });
  const route = event && await app.store.route(event.workspaceId, event.endpointId);
  if (!route) { res.writeHead(401); return res.end(); }
  const expected = Buffer.from('v1=' + createHmac('sha256', box.decrypt(route.secretBox, route.id)).update(req.headers['relay-timestamp'] + '.' + raw).digest('hex'));
  const actual = Buffer.from(req.headers['relay-signature'] || '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401); return res.end(); }
  const count = (attempts.get(event.id) || 0) + 1; attempts.set(event.id, count);
  res.writeHead(req.url === '/fail' || req.url === '/recover' && count === 1 ? 503 : 204); res.end();
});
await new Promise(resolve => receiver.listen(port + 1, '127.0.0.1', resolve));
const { start } = await import('../server-v2.js');
app = await start({ PORT: String(port), MONGODB_URI: process.env.MONGODB_URI, MONGODB_DB: demoDatabase, RELAY_ENCRYPTION_KEY: key,
  RELAY_AUTH_MODE: 'local', RELAY_PUBLIC_ORIGIN: 'http://localhost:' + port, RELAY_ALLOW_PRIVATE_DESTINATIONS: 'true' });
const workspaceId = await app.store.ensureUser({ id: 'local-operator' });
for (const [name, path, eventPattern] of [['Billing receiver', '/success', 'payment.*'], ['Recovering receiver', '/recover', 'payment.*'], ['Incident receiver', '/fail', 'incident.*']]) {
  const id = 'ep_demo_' + path.slice(1);
  if (!await app.store.route(workspaceId, id)) await app.store.createRoute(workspaceId, 'local-operator', { id, name,
    url: 'http://127.0.0.1:' + (port + 1) + path, eventPattern, enabled: true, retryPolicy: { ...DEFAULT_POLICY },
    secretVersion: 1, secretProvisioned: true, secretBox: box.encrypt(randomBytes(32).toString('base64url'), id) });
}
console.log('Atlas-backed demo ready. Send payment.created to see fan-out and recovery; incident.created reaches a failing receiver.');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return; stopping = true;
  await app.close(); await new Promise(resolve => receiver.close(resolve)); process.exit(0);
});

