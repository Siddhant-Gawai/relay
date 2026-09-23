import { test, expect } from '@playwright/test';
import '../../load-env.js';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { MongoStore } from '../../storage.js';
import { secretBox, DEFAULT_POLICY } from '../../lib/security.js';
import { createAuth } from '../../lib/auth.js';
import { createRelay } from '../../lib/app.js';
import { startWorker } from '../../delivery.js';
let store, server, receiver, worker, base, receiverUrl, database;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
test.beforeAll(async () => {
  database = 'relay_ui_' + randomUUID().replaceAll('-', '').slice(0, 24);
  store = await MongoStore.connect(process.env.MONGODB_URI, database);
  const box = secretBox(randomBytes(32).toString('base64'));
  const seen = new Map();
  receiver = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    const id = req.headers['relay-event-id']; const count = (seen.get(id) || 0) + 1; seen.set(id, count);
    res.writeHead(req.url === '/recover' && count === 1 ? 503 : 204); res.end();
  });
  receiverUrl = await listen(receiver);
  const workspaceId = await store.ensureUser({ id: 'local-operator' });
  for (const [name, path] of [['Billing receiver', '/success'], ['Recovering receiver', '/recover']]) {
    const id = 'ep_' + randomUUID();
    await store.createRoute(workspaceId, 'local-operator', { id, name, url: receiverUrl + path, eventPattern: 'payment.*', enabled: true,
      secretBox: box.encrypt(randomBytes(32).toString('base64url'), id), secretVersion: 1, secretProvisioned: true, retryPolicy: { ...DEFAULT_POLICY, baseDelayMs: 100 } });
  }
  worker = startWorker(store, box, { pollMs: 100, allowPrivate: true });
  server = createRelay({ store, box, auth: createAuth({ mode: 'local' }), allowPrivate: true, worker, origin: () => base });
  base = await listen(server);
});
test.afterAll(async () => {
  await worker?.stop(); if (server) await close(server); if (receiver) await close(receiver);
  if (store) {
    if (!/^relay_ui_[a-f0-9]{24}$/.test(database) || store.database.databaseName !== database) throw new Error('Unsafe UI test cleanup target');
    await store.database.dropDatabase(); await store.close();
  }
});
test('dispatch, deduplicate, inspect, search and configure routes without overflow or injected markup', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#view-deliveries')).toBeVisible();
  await expect(page.locator('#view-routes')).toBeHidden();
  await page.locator('#open-dispatch').click();
  await expect(page.locator('#route-match-count')).toHaveText('2 matches');
  await expect(page.locator('#received')).toHaveText('0');
  await expect(page.locator('#success-rate')).toHaveText('—');
  await page.locator('#dispatch-payload').fill(JSON.stringify({ amount: 42, note: '<img src=x onerror="window.injected=true">' }));
  await page.locator('#dispatch-correlation').fill('ui-checkout');
  await page.locator('#dispatch-submit').click();
  await expect(page.locator('#notice')).toContainText('Accepted');
  await expect.poll(async () => {
    const response = await page.request.get(base + '/api/events?correlationId=ui-checkout');
    const data = await response.json();
    return data.events.filter(e => e.status === 'delivered').length;
  }).toBe(2);
  await page.locator('#refresh').click();
  await expect(page.locator('#received')).toHaveText('2');
  await expect(page.locator('#success-rate')).toHaveText('100.0%');
  await page.locator('#open-dispatch').click();
  await page.locator('#dispatch-submit').click();
  await expect(page.locator('#notice')).toContainText('Duplicate prevented');
  await expect(page.locator('#received')).toHaveText('2');
  await expect(page.locator('#inspector .payload')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(page.locator('#inspector img')).toHaveCount(0);
  await page.locator('#search-form [name=correlationId]').fill('ui-checkout');
  await page.locator('#search-form button[type=reset]').click();
  await page.locator('#search-form [name=type]').fill('no.such.event');
  await page.locator('#search-form button').first().click();
  await expect(page.locator('#page-label')).toContainText('of 0');
  await page.locator('#search-form button[type=reset]').click();
  await expect(page.locator('#page-label')).toContainText('of 2');
  await page.locator('[data-view=routes]').click();
  await page.getByRole('button', { name: 'Recovering receiver', exact: true }).click();
  await expect(page.locator('#route-modal')).toBeVisible();
  await expect(page.locator('#route-detail')).toContainText('HTTP_503');
  await page.locator('#route-form [name=maxAttempts]').fill('5');
  await page.locator('#route-form [name=enabled]').selectOption('false');
  await page.locator('#route-form button').click();
  await expect(page.locator('#notice')).toContainText('configuration saved');
  await expect(page.locator('#route-form [name=maxAttempts]')).toHaveValue('5');
  await page.locator('#route-modal [data-close]').click();
  await expect(page.locator('#route-match-count')).toHaveText('1 matches');
  await page.locator('#open-endpoint').click();
  await page.locator('#endpoint-form [name=name]').fill('<svg onload=window.injected=true>');
  await page.locator('#endpoint-form [name=url]').fill(receiverUrl + '/success');
  await page.locator('#endpoint-form [name=eventPattern]').fill('invoice.*');
  await page.locator('#endpoint-form button[type=submit], #endpoint-form .submit').click();
  await expect(page.locator('#route-modal')).toBeVisible();
  await expect(page.locator('#route-detail h2')).toHaveText('<svg onload=window.injected=true>');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(page.locator('#route-detail svg')).toHaveCount(0);
  await page.locator('#route-modal [data-close]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('[data-view=activity]').click();
  await expect(page.locator('#audit-list')).toContainText('route.created');
  await page.locator('[data-view=deliveries]').click();
  await expect(page.locator('#view-routes')).toBeHidden();
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/relay-' + info.project.name + '.png', fullPage: true });
});

