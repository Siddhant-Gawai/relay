import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import '../load-env.js';
import { MongoStore, matches } from '../storage.js';
import { secretBox, destination, isPublicAddress } from '../lib/security.js';
import { createAuth } from '../lib/auth.js';
import { createRelay } from '../lib/app.js';
import { startWorker } from '../delivery.js';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGODB_URI must be configured for Atlas integration tests');
let authServer, receiver, receiverUrl, authUrl;
const seen = []; const counts = new Map();
const key = randomBytes(32).toString('base64'); const box = secretBox(key);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(30); } throw new Error('Timed out waiting for expected state'); }
before(async () => {
  authServer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/auth/v1/token')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.email === 'alice@example.test' && body.password === 'test-password' || body.refresh_token === 'refresh-alice') return res.end(JSON.stringify({ access_token: 'token-alice', refresh_token: 'refresh-alice', expires_in: 3600, user: { id: 'alice' } }));
    }
    if (req.url === '/auth/v1/logout') { res.writeHead(204); return res.end(); }
    if (req.url === '/auth/v1/user' && ['Bearer token-alice', 'Bearer token-bob'].includes(req.headers.authorization)) return res.end(JSON.stringify({ id: req.headers.authorization.endsWith('alice') ? 'alice' : 'bob' }));
    res.writeHead(401); res.end(JSON.stringify({ error: 'invalid' }));
  });
  authUrl = await listen(authServer);
  receiver = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url, headers: req.headers, raw });
    const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
    if (req.url.startsWith('/timeout')) return;
    if (req.url.startsWith('/crash') && count === 1) return;
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: receiverUrl + '/redirect-target' }); return res.end(); }
    const code = req.url.startsWith('/fail') || req.url.startsWith('/recover') && count === 1 ? 503 : 204;
    res.writeHead(code); res.end();
  });
  receiverUrl = await listen(receiver);
});
after(async () => { if (receiver) await close(receiver); if (authServer) await close(authServer); });

async function fixture(options = {}) {
  const db = 'relay_test_' + randomUUID().replaceAll('-', '').slice(0, 24);
  const store = await MongoStore.connect(mongoUri, db);
  const auth = createAuth({ mode: 'supabase', url: authUrl, key: 'test-publishable-key', secure: false });
  const app = createRelay({ store, box, auth, allowPrivate: true, ...options });
  const base = await listen(app); let worker;
  async function api(path, { method = 'GET', body, user = 'alice', workspace, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(user ? { authorization: 'Bearer token-' + user } : {}),
      ...(workspace ? { 'x-workspace-id': workspace } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const session = (await api('/api/session')).body;
  const workspace = session.defaultWorkspace;
  async function route(path = '/ok', extra = {}) {
    const response = await api('/api/endpoints', { method: 'POST', body: { name: 'Receiver', url: receiverUrl + path, eventPattern: 'payment.*',
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, timeoutMs: 300, backoff: 'fixed' }, ...extra } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.endpoint;
  }
  async function ingest(body = {}, idem = randomUUID(), request = {}) {
    return api('/api/ingest', { method: 'POST', body: { type: 'payment.created', payload: { amount: 42 }, ...body }, headers: { 'idempotency-key': idem }, ...request });
  }
  return { store, base, api, route, ingest, workspace, db,
    startWorker() { worker = startWorker(store, box, { allowPrivate: true, pollMs: 20, concurrency: 3 }); return worker; },
    async finished(id) { return until(async () => { const e = (await api('/api/events/' + id)).body; return ['delivered', 'dead_letter'].includes(e.status) && e; }); },
    async close() { await worker?.stop(); await close(app); if (!/^relay_test_[a-f0-9]{24}$/.test(db) || store.database.databaseName !== db) throw new Error('Unsafe test cleanup target'); await store.database.dropDatabase(); await store.close(); }
  };
}

test('atomic ingress, concurrent idempotency, correlation fan-out and content conflict', async () => {
  const f = await fixture(); try {
    await f.route('/ok-a'); await f.route('/ok-b');
    const idem = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.ingest({ correlationId: 'checkout-123' }, idem)));
    assert.ok(results.every(r => [200, 202].includes(r.status)), JSON.stringify(results));
    assert.equal(results.filter(r => r.status === 202).length, 1);
    assert.equal(new Set(results.map(r => r.body.ingressId)).size, 1);
    assert.equal(await f.store.deliveries.countDocuments({}), 2);
    assert.ok(results[0].body.deliveries.every(d => d.correlationId === 'checkout-123'));
    assert.equal((await f.ingest({ payload: { amount: 43 }, correlationId: 'checkout-123' }, idem)).status, 409);
    assert.equal((await f.api('/api/ingest', { method: 'POST', body: { type: 'payment.created', payload: {} } })).status, 422);
    assert.equal((await f.api('/api/dashboard')).body.stats.received, 2);
    assert.equal((await f.api('/api/dashboard')).body.stats.successRate, null);
  } finally { await f.close(); }
});

test('signed actual delivery, fresh retry timestamps, real metrics and attempt audit', async () => {
  const f = await fixture(); try {
    const path = '/recover-' + randomUUID(); const route = await f.route(path);
    const secret = randomBytes(32).toString('base64url');
    const rotated = await f.api('/api/endpoints/' + route.id + '/rotate-secret', { method: 'POST', body: { secret } });
    assert.equal(rotated.status, 200); assert.ok(!JSON.stringify(rotated.body).includes(secret));
    f.startWorker(); const accepted = await f.ingest(); assert.equal(accepted.status, 202);
    const event = await f.finished(accepted.body.deliveries[0].id);
    assert.equal(event.status, 'delivered'); assert.equal(event.attempts, 2);
    const requests = seen.filter(s => s.path === path);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const expected = 'v1=' + createHmac('sha256', secret).update(request.headers['relay-timestamp'] + '.' + request.raw).digest('hex');
      assert.equal(request.headers['relay-signature'], expected);
      assert.equal(request.headers['relay-correlation-id'], event.correlationId);
      assert.equal(request.headers['relay-event-id'], event.id);
    }
    assert.notEqual(requests[0].headers['relay-timestamp'], requests[1].headers['relay-timestamp']);
    const dashboard = (await f.api('/api/dashboard')).body;
    assert.equal(dashboard.stats.successRate, 100); assert.equal(dashboard.stats.attemptCount, 2);
    assert.equal(dashboard.stats.failureReasons.HTTP_503, 1); assert.ok(dashboard.stats.p95 >= dashboard.stats.p50);
    assert.equal(dashboard.stats.series.reduce((n, b) => n + b.attempts, 0), 2);
    assert.equal(dashboard.endpoints[0].health.state, 'healthy');
    const audit = (await f.api('/api/audit')).body.entries;
    assert.ok(audit.some(a => a.action === 'delivery.delivered'));
    assert.ok(!JSON.stringify(audit).includes(secret));
    const stored = await f.store.route(f.workspace, route.id);
    assert.ok(stored.secretBox); assert.ok(!JSON.stringify(stored).includes(secret)); assert.equal(box.decrypt(stored.secretBox, route.id), secret);
  } finally { await f.close(); }
});

test('pause holds queued work, retry policy validates, timeout dead-letters, replay retains history', async () => {
  const f = await fixture(); try {
    const route = await f.route('/timeout-' + randomUUID(), { retryPolicy: { maxAttempts: 2, backoff: 'exponential', baseDelayMs: 100, timeoutMs: 100 } });
    const accepted = await f.ingest(); const eventId = accepted.body.deliveries[0].id;
    assert.equal((await f.api('/api/endpoints/' + route.id, { method: 'PATCH', body: { enabled: false } })).status, 200);
    f.startWorker(); await sleep(250); assert.equal((await f.api('/api/events/' + eventId)).body.attempts, 0);
    assert.equal((await f.ingest()).status, 422);
    assert.equal((await f.api('/api/endpoints/' + route.id, { method: 'PATCH', body: { retryPolicy: { maxAttempts: 0 } } })).status, 422);
    await f.api('/api/endpoints/' + route.id, { method: 'PATCH', body: { enabled: true } });
    const dead = await f.finished(eventId); assert.equal(dead.status, 'dead_letter'); assert.equal(dead.attempts, 2); assert.equal(dead.lastError, 'TIMEOUT');
    await f.api('/api/endpoints/' + route.id, { method: 'PATCH', body: { url: receiverUrl + '/ok-replay', retryPolicy: { maxAttempts: 1 } } });
    assert.equal((await f.api('/api/events/' + eventId + '/replay', { method: 'POST' })).status, 202);
    const delivered = await f.finished(eventId);
    assert.equal(delivered.status, 'delivered'); assert.equal(delivered.attemptLog.length, 3); assert.equal(delivered.replayCount, 1);
    assert.equal(delivered.policy.maxAttempts, 1); assert.equal(delivered.correlationId, dead.correlationId);
    assert.equal((await f.api('/api/events/' + eventId + '/replay', { method: 'POST' })).status, 409);
  } finally { await f.close(); }
});

test('background worker process crash recovers persisted lease and rejects stale completion', async () => {
  const f = await fixture(); let child;
  try {
    const path = '/crash-' + randomUUID();
    await f.route(path, { retryPolicy: { maxAttempts: 3, timeoutMs: 30000, baseDelayMs: 100, backoff: 'fixed' } });
    const accepted = await f.ingest(); const eventId = accepted.body.deliveries[0].id;
    child = fork(new URL('./worker-process.js', import.meta.url), [], { env: { ...process.env, TEST_MONGO_URI: mongoUri, TEST_DB: f.db, TEST_KEY: key }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await once(child, 'message');
    await until(() => seen.some(s => s.path === path));
    const stale = await f.store.deliveries.findOne({ id: eventId });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null;
    await sleep(850); f.startWorker();
    const recovered = await f.finished(eventId);
    assert.equal(recovered.status, 'delivered'); assert.equal(recovered.attempts, 2);
    assert.equal(recovered.attemptLog[0].outcome, 'started');
    assert.equal(await f.store.finish(stale, { error: 'STALE', responseCode: 500, latency: 1 }, new Date().toISOString()), false);
    assert.equal((await f.api('/api/events/' + eventId)).body.status, 'delivered');
    assert.equal((await f.api('/api/dashboard')).body.stats.attemptCount, 1);
  } finally { child?.kill('SIGKILL'); await f.close(); }
});

test('two workers do not deliver one active lease twice and queued jobs survive reconnect', async () => {
  const f = await fixture(); let extra;
  try {
    const path = '/ok-multi-' + randomUUID(); await f.route(path);
    const accepted = await f.ingest();
    const second = await MongoStore.connect(mongoUri, f.db);
    extra = startWorker(second, box, { allowPrivate: true, pollMs: 20, concurrency: 4 });
    f.startWorker();
    const delivered = await f.finished(accepted.body.deliveries[0].id);
    assert.equal(delivered.attempts, 1); assert.equal(seen.filter(s => s.path === path).length, 1);
    await extra.stop(); extra = null; await second.close();
  } finally { await extra?.stop(); await f.close(); }
});

test('authentication, cross-workspace denial, viewer/operator/owner boundaries and cookie lifecycle', async () => {
  const f = await fixture(); try {
    const route = await f.route(); const accepted = await f.ingest(); const eventId = accepted.body.deliveries[0].id;
    assert.equal((await f.api('/api/events', { user: null })).status, 401);
    assert.equal((await f.api('/api/events', { user: 'forged' })).status, 401);
    const bob = (await f.api('/api/session', { user: 'bob' })).body;
    assert.equal((await f.api('/api/events/' + eventId, { user: 'bob' })).status, 404);
    assert.equal((await f.api('/api/endpoints/' + route.id, { user: 'bob' })).status, 404);
    assert.equal((await f.api('/api/dashboard', { user: 'bob', workspace: f.workspace })).status, 403);
    assert.equal((await f.api('/api/members', { method: 'POST', body: { userId: 'bob', role: 'viewer' } })).status, 200);
    assert.equal((await f.api('/api/dashboard', { user: 'bob', workspace: f.workspace })).status, 200);
    assert.equal((await f.ingest({}, randomUUID(), { user: 'bob', workspace: f.workspace })).status, 403);
    await f.api('/api/members', { method: 'POST', body: { userId: 'bob', role: 'operator' } });
    assert.equal((await f.ingest({}, randomUUID(), { user: 'bob', workspace: f.workspace })).status, 202);
    assert.equal((await f.api('/api/endpoints/' + route.id, { method: 'PATCH', user: 'bob', workspace: f.workspace, body: { enabled: false } })).status, 403);
    assert.equal((await f.api('/api/audit', { user: 'bob' })).body.entries.length, 0);
    assert.notEqual(bob.defaultWorkspace, f.workspace);
    const login = await f.api('/api/auth/login', { method: 'POST', user: null, body: { email: 'alice@example.test', password: 'test-password' } });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    assert.ok(!JSON.stringify(login.body).includes('token-alice'));
    const cookie = 'relay_access=token-alice; relay_refresh=refresh-alice';
    assert.equal((await f.api('/api/session', { user: null, headers: { cookie } })).status, 200);
    assert.equal((await f.api('/api/auth/refresh', { method: 'POST', user: null, headers: { cookie, origin: 'http://evil.test' } })).status, 403);
    assert.equal((await f.api('/api/auth/refresh', { method: 'POST', user: null, headers: { cookie, origin: 'http://localhost:3000' } })).status, 200);
    const logout = await f.api('/api/auth/logout', { method: 'POST', user: null, headers: { cookie, origin: 'http://localhost:3000' } });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await f.close(); }
});

test('search combines type, route, status, dates and correlation; route detail uses stored data', async () => {
  const f = await fixture(); try {
    const route = await f.route(); await f.ingest({ correlationId: 'find-me' }); await f.ingest({ type: 'payment.refunded' });
    const params = new URLSearchParams({ type: 'created', endpointId: route.id, status: 'queued', correlationId: 'find-me', from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 60000).toISOString() });
    const result = await f.api('/api/events?' + params); assert.equal(result.status, 200); assert.equal(result.body.total, 1);
    assert.equal((await f.api('/api/events?type=%5B')).body.total, 0);
    const detail = (await f.api('/api/endpoints/' + route.id)).body; assert.equal(detail.events.length, 2); assert.equal(detail.stats.received, 2);
    assert.equal((await f.api('/api/events?from=invalid')).status, 422);
    assert.equal((await f.api('/api/events?offset=-1')).status, 422);
    assert.equal((await f.api('/api/dashboard?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z')).status, 422);
    assert.ok(!JSON.stringify(detail).includes('secretBox'));
  } finally { await f.close(); }
});

test('request limits, malformed input, escaped data, URL restrictions and redirect refusal', async () => {
  const f = await fixture(); try {
    assert.equal((await f.api('/api/ingest', { method: 'POST', body: { type: 'x', payload: 'x'.repeat(100001) } })).status, 413);
    const bad = await fetch(f.base + '/api/ingest', { method: 'POST', headers: { authorization: 'Bearer token-alice', 'content-type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400);
    for (const url of ['file:///etc/passwd', 'http://user:pass@example.test/', receiverUrl + '/?token=secret', receiverUrl + '/#fragment']) {
      assert.equal((await f.api('/api/endpoints', { method: 'POST', body: { name: 'Bad', url } })).status, 422);
    }
    const path = '/redirect-' + randomUUID(); await f.route(path, { retryPolicy: { maxAttempts: 1, timeoutMs: 1000 } });
    f.startWorker(); const accepted = await f.ingest({ payload: { html: '<img src=x onerror=alert(1)>' } });
    const event = await f.finished(accepted.body.deliveries[0].id); assert.equal(event.lastError, 'HTTP_302');
    assert.ok(!seen.some(s => s.path === '/redirect-target'));
    const page = await fetch(f.base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(f.base + '/relay.css')).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(f.base + '/.env')).status, 404);
  } finally { await f.close(); }
});

test('SSRF rejects private DNS answers, IPv4-mapped IPv6 and non-public networks', async () => {
  const f = await fixture({ allowPrivate: false }); try {
    assert.equal((await f.api('/api/endpoints', { method: 'POST', body: { name: 'Local', url: receiverUrl } })).status, 422);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    await assert.rejects(destination('https://receiver.example/', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /disabled/);
  } finally { await f.close(); }
});

test('workspace rate limits are shared by server instances', async () => {
  const f = await fixture({ rateLimit: 2 }); const clock = Date.now(); f.store.clock = () => clock; try {
    assert.equal((await f.api('/api/events')).status, 200);
    assert.equal((await f.api('/api/events')).status, 200);
    const limited = await f.api('/api/events'); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
    const secondStore = await MongoStore.connect(mongoUri, f.db);
    secondStore.clock = () => clock;
    try { assert.equal(await secondStore.consumeLimit('workspace:' + f.workspace + ':user:alice', 2), false); } finally { await secondStore.close(); }
  } finally { await f.close(); }
});

test('route matching treats wildcard specially and all other metacharacters literally', () => {
  assert.equal(matches('payment.*', 'payment.created'), true);
  assert.equal(matches('payment.*', 'paymentXcreated'), false);
  assert.equal(matches('*', 'invoice.paid'), true);
});


test('single-destination API, canonical duplicate detection and workspace creation are scoped', async () => {
  const f = await fixture(); try {
    const route = await f.route();
    const idem = randomUUID();
    const first = await f.api('/api/events', { method: 'POST', body: { endpointId: route.id, type: 'manual.test', payload: { b: 2, a: 1 } }, headers: { 'idempotency-key': idem } });
    assert.equal(first.status, 202); assert.equal(first.body.routed, 1);
    const duplicate = await f.api('/api/events', { method: 'POST', body: { endpointId: route.id, type: 'manual.test', payload: { a: 1, b: 2 } }, headers: { 'idempotency-key': idem } });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.ingressId, first.body.ingressId);
    const workspace = await f.api('/api/workspaces', { method: 'POST', body: { name: 'Isolated team' } });
    assert.equal(workspace.status, 201);
    assert.equal((await f.api('/api/events/' + first.body.deliveries[0].id, { workspace: workspace.body.id })).status, 404);
    assert.equal((await f.api('/api/dashboard', { workspace: workspace.body.id })).body.stats.received, 0);
    assert.equal((await f.ingest({ correlationId: 'not a header-safe identifier' })).status, 422);
    const session = await f.api('/api/session');
    assert.equal(session.body.workspaces.length, 2);
  } finally { await f.close(); }
});

test('old unresolved deliveries affect route health outside the metric window', async () => {
  const f = await fixture(); try {
    const route = await f.route('/fail-' + randomUUID(), { retryPolicy: { maxAttempts: 1, timeoutMs: 1000 } });
    f.startWorker(); const result = await f.ingest();
    const delivery = await f.finished(result.body.deliveries[0].id);
    assert.equal(delivery.status, 'dead_letter');
    // Shift a real failed fixture outside the chart window to exercise backlog health.
    await f.store.deliveries.updateOne({ id: delivery.id }, { $set: { createdAt: new Date(Date.now() - 172800000).toISOString() } });
    const dashboard = (await f.api('/api/dashboard')).body;
    assert.equal(dashboard.stats.received, 0);
    assert.equal(dashboard.queue.dead_letter, 1);
    assert.equal(dashboard.endpoints.find(r => r.id === route.id).health.state, 'attention');
  } finally { await f.close(); }
});

