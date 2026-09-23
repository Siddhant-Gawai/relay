import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { destination, fail, jsonBody, policy, textField } from './security.js';
import { publicRoute } from '../storage.js';

const staticFiles = new Map([['/', 'relay.html'], ['/relay.html', 'relay.html'], ['/relay.css', 'relay.css'], ['/relay.js', 'relay.js']]);
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
const cleanEvent = event => {
  if (!event) return null;
  const { leaseToken, leaseUntil, ...result } = event;
  return { ...result, attemptLog: event.attemptLog.map(({ token, ...attempt }) => attempt) };
};
const cleanAccepted = result => ({ ...result, deliveries: result.deliveries.map(cleanEvent) });
function dateFilter(value, name) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(422, 'Invalid ' + name);
  return new Date(value).toISOString();
}
export function createRelay({ store, box, auth, allowPrivate = false, origin = 'http://localhost:3000', worker, rateLimit = 600, resolve, onError = () => {} }) {
  const options = { allowPrivate, ...(resolve ? { resolve } : {}) };
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('cache-control', 'no-store');
    const send = (status, result) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); };
    try {
      const url = new URL(req.url, 'http://relay.local'); const path = url.pathname;
      if (req.method === 'GET' && staticFiles.has(path)) {
        const filename = staticFiles.get(path); const content = await readFile(publicRoot + filename);
        res.writeHead(200, { 'content-type': types[filename.split('.').pop()] }); return res.end(content);
      }
      if (req.method === 'GET' && path === '/api/health') {
        await store.database.command({ ping: 1 });
        return send(200, { ok: true, service: 'relay', store: 'mongodb', auth: auth.mode, worker: worker?.status() || { running: false } });
      }
      if (!path.startsWith('/api/')) fail(404, 'Not found');
      const mutation = !['GET', 'HEAD'].includes(req.method);
      const expectedOrigin = typeof origin === 'function' ? origin() : origin;
      if (mutation && (req.headers.origin && req.headers.origin !== expectedOrigin || req.headers.cookie && !req.headers.authorization && req.headers.origin !== expectedOrigin)) fail(403, 'Same-origin request required');
      const ip = req.socket.remoteAddress || 'unknown';
      if (!await store.consumeLimit('ip:' + ip, 1200)) { res.setHeader('retry-after', '60'); fail(429, 'Too many requests'); }
      if (path.startsWith('/api/auth/') && req.method === 'POST') {
        if (!await store.consumeLimit('auth:' + ip, 20)) { res.setHeader('retry-after', '60'); fail(429, 'Too many sign-in attempts'); }
        if (path === '/api/auth/login') return send(200, await auth.login(res, await jsonBody(req)));
        if (path === '/api/auth/refresh') return send(200, await auth.refresh(req, res));
        if (path === '/api/auth/logout') return send(200, await auth.logout(req, res));
      }
      const user = await auth.user(req);
      const defaultWorkspace = await store.ensureUser(user);
      if (req.method === 'GET' && path === '/api/session') return send(200, { user, mode: auth.mode, workspaces: await store.workspaceList(user.id), defaultWorkspace });
      if (path === '/api/workspaces' && req.method === 'POST') {
        if (!await store.consumeLimit('workspace-create:' + user.id, 10)) fail(429, 'Workspace creation limit reached');
        const input = await jsonBody(req); return send(201, await store.createWorkspace(user.id, textField(input.name, 'workspace name', 80)));
      }
      const workspaceId = textField(req.headers['x-workspace-id'] || defaultWorkspace, 'workspace ID');
      const member = await store.membership(workspaceId, user.id);
      if (!member) fail(403, 'Workspace access denied');
      if (mutation && member.role === 'viewer') fail(403, 'Viewer access is read-only');
      if (!await store.consumeLimit('workspace:' + workspaceId + ':user:' + user.id, rateLimit)) { res.setHeader('retry-after', '60'); fail(429, 'Workspace rate limit reached'); }
      const owner = () => { if (member.role !== 'owner') fail(403, 'Workspace owner access required'); };
      if (path === '/api/members' && req.method === 'POST') {
        owner(); const input = await jsonBody(req);
        if (!['operator', 'viewer'].includes(input.role)) fail(422, 'Role must be operator or viewer');
        return send(200, await store.addMember(workspaceId, user.id, textField(input.userId, 'user ID'), input.role));
      }
      if (path === '/api/members' && req.method === 'GET') {
        owner(); return send(200, await store.memberships.find({ workspaceId }, { projection: { _id: 0 } }).toArray());
      }
      if (path === '/api/audit' && req.method === 'GET') return send(200, { entries: await store.auditList(workspaceId) });
      const from = dateFilter(url.searchParams.get('from'), 'from date'); const to = dateFilter(url.searchParams.get('to'), 'to date');
      if (from && to && from >= to) fail(422, 'From date must precede to date');
      if (path === '/api/dashboard' && req.method === 'GET') return send(200, await store.dashboard(workspaceId, from ? Date.parse(from) : undefined, to ? Date.parse(to) : undefined));
      if (path === '/api/events' && req.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        if (status && !['queued', 'processing', 'retrying', 'dead_letter', 'delivered'].includes(status)) fail(422, 'Invalid outcome filter');
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000) fail(422, 'Invalid page offset');
        const filter = { from, to, status, offset };
        for (const key of ['endpointId', 'type', 'correlationId']) if (url.searchParams.has(key) && url.searchParams.get(key)) filter[key] = textField(url.searchParams.get(key), key);
        const result = await store.list(workspaceId, filter);
        return send(200, { ...result, events: result.events.map(cleanEvent) });
      }
      if (['/api/ingest', '/api/events'].includes(path) && req.method === 'POST') {
        const input = await jsonBody(req); const type = textField(input.type, 'event type', 120);
        if (!/^[a-zA-Z0-9_.:-]+$/.test(type)) fail(422, 'Invalid event type');
        if (input.payload === undefined) fail(422, 'Payload is required');
        const correlationId = input.correlationId || req.headers['x-correlation-id'];
        if (input.correlationId && req.headers['x-correlation-id'] && input.correlationId !== req.headers['x-correlation-id']) fail(422, 'Correlation ID values disagree');
        if (correlationId && !/^[A-Za-z0-9_.:-]{1,120}$/.test(correlationId)) fail(422, 'Correlation ID must be an ASCII identifier');
        const key = textField(req.headers['idempotency-key'], 'Idempotency-Key header', 200);
        const accepted = await store.accept(workspaceId, user.id, { type, payload: input.payload,
          ...(correlationId ? { correlationId: textField(correlationId, 'correlation ID', 120) } : {}),
          ...(path === '/api/events' ? { endpointId: textField(input.endpointId, 'destination') } : {})
        }, key);
        return send(accepted.duplicate ? 200 : 202, cleanAccepted(accepted));
      }
      const eventMatch = path.match(/^\/api\/events\/([^/]+)(\/replay)?$/);
      if (eventMatch) {
        if (req.method === 'GET' && !eventMatch[2]) { const result = await store.event(workspaceId, eventMatch[1]); if (!result) fail(404, 'Delivery not found'); return send(200, cleanEvent(result)); }
        if (req.method === 'POST' && eventMatch[2]) return send(202, cleanEvent(await store.replay(workspaceId, user.id, eventMatch[1])));
      }
      if (path === '/api/endpoints' && req.method === 'POST') {
        owner(); const input = await jsonBody(req);
        const routeId = 'ep_' + randomUUID();
        const validated = await destination(textField(input.url, 'URL', 2000), options);
        const eventPattern = textField(input.eventPattern || '*', 'event pattern', 120);
        if (!/^[a-zA-Z0-9_.:*\-]+$/.test(eventPattern)) fail(422, 'Invalid route pattern');
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail(422, 'Enabled must be boolean');
        const route = { id: routeId, name: textField(input.name, 'route name', 80), url: validated.url.href, eventPattern,
          enabled: input.enabled ?? true, retryPolicy: policy(input.retryPolicy), secretVersion: 1,
          secretBox: box.encrypt(randomBytes(32).toString('base64url'), routeId), secretProvisioned: false };
        return send(201, { endpoint: await store.createRoute(workspaceId, user.id, route) });
      }
      const routeMatch = path.match(/^\/api\/endpoints\/([^/]+)(\/rotate-secret)?$/);
      if (routeMatch) {
        const routeId = routeMatch[1]; const route = await store.route(workspaceId, routeId); if (!route) fail(404, 'Route not found');
        if (req.method === 'GET' && !routeMatch[2]) {
          const data = await store.dashboard(workspaceId, from ? Date.parse(from) : undefined, to ? Date.parse(to) : undefined, routeId);
          const recent = await store.list(workspaceId, { endpointId: routeId });
          return send(200, { route: publicRoute(route), ...data, events: recent.events.map(cleanEvent) });
        }
        if (req.method === 'PATCH' && !routeMatch[2]) {
          owner(); const input = await jsonBody(req); const changes = {};
          if (input.name !== undefined) changes.name = textField(input.name, 'route name', 80);
          if (input.url !== undefined) changes.url = (await destination(textField(input.url, 'URL', 2000), options)).url.href;
          if (input.eventPattern !== undefined) {
            changes.eventPattern = textField(input.eventPattern, 'event pattern', 120);
            if (!/^[a-zA-Z0-9_.:*\-]+$/.test(changes.eventPattern)) fail(422, 'Invalid route pattern');
          }
          if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') fail(422, 'Enabled must be boolean'); changes.enabled = input.enabled; }
          if (input.retryPolicy !== undefined) changes.retryPolicy = policy({ ...route.retryPolicy, ...input.retryPolicy });
          if (!Object.keys(changes).length) fail(422, 'No supported route fields supplied');
          return send(200, { endpoint: await store.updateRoute(workspaceId, user.id, routeId, changes) });
        }
        if (req.method === 'POST' && routeMatch[2]) {
          owner(); const input = await jsonBody(req);
          if (typeof input.secret !== 'string' || !/^[A-Za-z0-9_\-]{43,128}$/.test(input.secret)) fail(422, 'Supply a generated base64url signing secret through the provisioning CLI');
          return send(200, { endpoint: await store.updateRoute(workspaceId, user.id, routeId, { secretBox: box.encrypt(input.secret, routeId), secretProvisioned: true, secretVersion: route.secretVersion + 1 }, 'route.secret_rotated') });
        }
      }
      fail(404, 'Not found');
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) onError({ requestId, code: 'REQUEST_FAILED' });
      if (!res.headersSent) send(status, { error: status >= 500 ? 'Service temporarily unavailable' : error.message, requestId });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}

