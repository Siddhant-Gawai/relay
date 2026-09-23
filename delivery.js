import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { destination } from './lib/security.js';

// Resolve and validate every attempt; pin the validated address in the actual socket lookup.
export async function sendWebhook(event, route, box, options = {}) {
  const started = performance.now();
  try {
    const { url, address } = await destination(route.url, options);
    const secret = box.decrypt(route.secretBox, route.id);
    const payload = JSON.stringify(event.payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
    const responseCode = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: 'POST', agent: false, signal: AbortSignal.timeout(event.policy.timeoutMs),
        lookup: (_hostname, opts, cb) => opts.all ? cb(null, [address]) : cb(null, address.address, address.family),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'user-agent': 'Relay/1.0',
          'relay-event-id': event.id, 'relay-ingress-id': event.ingressId, 'relay-correlation-id': event.correlationId,
          'relay-event-type': event.type, 'relay-timestamp': timestamp, 'relay-signature': 'v1=' + signature }
      }, response => { const status = response.statusCode; response.destroy(); resolve(status); });
      req.on('error', reject); req.end(payload);
    });
    return { responseCode, latency: Math.round(performance.now() - started), error: responseCode >= 200 && responseCode < 300 ? null : 'HTTP_' + responseCode };
  } catch (error) {
    return { responseCode: null, latency: Math.round(performance.now() - started),
      error: error.name === 'AbortError' ? 'TIMEOUT' : error.status === 422 ? 'DESTINATION_BLOCKED' : error.code?.startsWith('ERR_OSSL') || error.message?.includes('authenticate') ? 'SIGNING_UNAVAILABLE' : 'NETWORK_ERROR' };
  }
}
export function startWorker(store, box, { pollMs = 500, leaseMs = 60000, concurrency = 4, allowPrivate = false, resolve, onError = () => {} } = {}) {
  let stopping = false; let timer; let running = false;
  let lastPollAt = null; let lastErrorAt = null;
  async function runOne() {
    const event = await store.claim(leaseMs); if (!event) return;
    const route = await store.route(event.workspaceId, event.endpointId);
    if (!route?.enabled) { await store.defer(event); return; }
    // A crash reserves an attempt. Never exceed the configured send budget.
    const result = event.cycleAttempts > event.policy.maxAttempts
      ? { responseCode: null, latency: null, error: 'LEASE_EXPIRED' }
      : await sendWebhook(event, route, box, { allowPrivate, ...(resolve ? { resolve } : {}) });
    const delay = Math.min(86400000, event.policy.baseDelayMs * (event.policy.backoff === 'exponential' ? 2 ** (event.cycleAttempts - 1) : 1));
    await store.finish(event, result, new Date(Date.now() + delay).toISOString());
  }
  async function tick() {
    if (stopping || running) return;
    running = true;
    try {
      const results = await Promise.allSettled(Array.from({ length: concurrency }, runOne));
      lastPollAt = new Date().toISOString();
      if (results.some(r => r.status === 'rejected')) { lastErrorAt = lastPollAt; onError(); }
    } finally { running = false; if (!stopping) timer = setTimeout(tick, pollMs); }
  }
  timer = setTimeout(tick, 0);
  return { status: () => ({ lastPollAt, lastErrorAt, running: !stopping }),
    async stop() { stopping = true; clearTimeout(timer); while (running) await new Promise(r => setTimeout(r, 20)); } };
}

