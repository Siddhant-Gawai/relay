import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { canonical, digest, fail } from './lib/security.js';
import { metrics, routeHealth } from './lib/metrics.js';

const id = prefix => prefix + '_' + randomUUID();
const now = () => new Date().toISOString();
const clean = doc => { if (!doc) return null; const { _id, ...rest } = doc; return rest; };
export const publicRoute = route => { if (!route) return null; const { secretBox, ...rest } = clean(route); return rest; };
export function matches(pattern, type) {
  return new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(type);
}

export class MongoStore {
  constructor(database, client) {
    this.database = database; this.client = client; this.clock = Date.now;
    for (const name of ['routes', 'ingresses', 'deliveries', 'workspaces', 'memberships', 'users', 'audits', 'limits']) this[name] = database.collection('relay_' + name);
  }
  static async connect(uri, name = 'relay') {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    try {
      await client.connect();
      const hello = await client.db('admin').command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Relay requires a MongoDB replica set for atomic ingress');
      const store = new MongoStore(client.db(name), client);
      await store.initialize(); return store;
    } catch (error) { await client.close(); throw error; }
  }
  async initialize() {
    await Promise.all([
      this.routes.createIndex({ workspaceId: 1, id: 1 }, { unique: true }),
      this.ingresses.createIndex({ workspaceId: 1, keyHash: 1 }, { unique: true }),
      this.deliveries.createIndex({ id: 1 }, { unique: true }),
      this.deliveries.createIndex({ workspaceId: 1, ingressId: 1, endpointId: 1 }, { unique: true }),
      this.deliveries.createIndex({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }),
      this.deliveries.createIndex({ workspaceId: 1, createdAt: -1 }),
      this.deliveries.createIndex({ workspaceId: 1, correlationId: 1 }),
      this.deliveries.createIndex({ workspaceId: 1, endpointId: 1, createdAt: -1 }),
      this.workspaces.createIndex({ id: 1 }, { unique: true }),
      this.memberships.createIndex({ workspaceId: 1, userId: 1 }, { unique: true }),
      this.users.createIndex({ id: 1 }, { unique: true }),
      this.audits.createIndex({ workspaceId: 1, at: -1 }),
      this.limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);
  }
  async transaction(fn) {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => fn(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
    finally { await session.endSession(); }
  }
  async audit(workspaceId, actorId, action, targetId, session, details = {}) {
    await this.audits.insertOne({ id: id('aud'), workspaceId, actorId, action, targetId, details, at: now() }, { session });
  }
  async ensureUser(user) {
    const existingWorkspace = 'ws_' + digest(user.id).slice(0, 24);
    if (await this.memberships.findOne({ workspaceId: existingWorkspace, userId: user.id })) return existingWorkspace;
    await this.users.updateOne({ id: user.id }, { $setOnInsert: { id: user.id, createdAt: now() } }, { upsert: true });
    const workspaceId = 'ws_' + digest(user.id).slice(0, 24);
    try {
      await this.transaction(async session => {
        await this.workspaces.updateOne({ id: workspaceId }, { $setOnInsert: { id: workspaceId, name: user.id === 'local-operator' ? 'Local workspace' : 'My workspace', createdAt: now() } }, { upsert: true, session });
        await this.memberships.updateOne({ workspaceId, userId: user.id }, { $setOnInsert: { workspaceId, userId: user.id, role: 'owner' } }, { upsert: true, session });
      });
    } catch (error) { if (error.code !== 11000) throw error; }
    return workspaceId;
  }
  async workspaceList(userId) {
    const memberships = await this.memberships.find({ userId }).toArray();
    const rows = await this.workspaces.find({ id: { $in: memberships.map(m => m.workspaceId) } }).toArray();
    return rows.map(w => ({ ...clean(w), role: memberships.find(m => m.workspaceId === w.id).role }));
  }
  async membership(workspaceId, userId) { return clean(await this.memberships.findOne({ workspaceId, userId })); }
  async createWorkspace(userId, name) {
    const workspace = { id: id('ws'), name, createdAt: now() };
    await this.transaction(async session => {
      await this.workspaces.insertOne(workspace, { session });
      await this.memberships.insertOne({ workspaceId: workspace.id, userId, role: 'owner' }, { session });
      await this.audit(workspace.id, userId, 'workspace.created', workspace.id, session);
    });
    return clean(workspace);
  }
  async addMember(workspaceId, actorId, userId, role) {
    if (!await this.users.findOne({ id: userId })) fail(422, 'User must sign in to Relay before being added');
    return this.transaction(async session => {
      const previous = await this.memberships.findOne({ workspaceId, userId }, { session });
      if (previous?.role === 'owner') fail(409, 'Owner membership cannot be changed here');
      await this.memberships.updateOne({ workspaceId, userId }, { $set: { role } }, { upsert: true, session });
      await this.audit(workspaceId, actorId, 'membership.changed', userId, session, { role });
      return { userId, role };
    });
  }
  async route(workspaceId, routeId) { return clean(await this.routes.findOne({ workspaceId, id: routeId })); }
  async createRoute(workspaceId, actorId, route) {
    await this.transaction(async session => {
      if (await this.routes.countDocuments({ workspaceId }, { session }) >= 50) fail(422, 'Workspace route limit is 50');
      // Serialize route creation and ingress against the workspace to enforce the cap.
      await this.workspaces.updateOne({ id: workspaceId }, { $inc: { revision: 1 } }, { session });
      await this.routes.insertOne({ ...route, workspaceId, createdAt: now() }, { session });
      await this.audit(workspaceId, actorId, 'route.created', route.id, session);
    });
    return publicRoute(await this.route(workspaceId, route.id));
  }
  async updateRoute(workspaceId, actorId, routeId, changes, action = 'route.updated') {
    return this.transaction(async session => {
      const route = await this.routes.findOneAndUpdate({ workspaceId, id: routeId }, { $set: { ...changes, updatedAt: now() } }, { session, returnDocument: 'after' });
      if (!route) fail(404, 'Route not found');
      await this.audit(workspaceId, actorId, action, routeId, session, { fields: Object.keys(changes).filter(key => key !== 'secretBox') });
      return publicRoute(route);
    });
  }
  async accept(workspaceId, actorId, input, key) {
    const keyHash = digest(key);
    const fingerprint = digest(canonical({ type: input.type, payload: input.payload, endpointId: input.endpointId || null, correlationId: input.correlationId || null }));
    const existing = async () => {
      const ingress = await this.ingresses.findOne({ workspaceId, keyHash });
      if (!ingress) return null;
      if (ingress.fingerprint !== fingerprint) fail(409, 'Idempotency key already used with different content');
      return { accepted: true, duplicate: true, ingressId: ingress.id, correlationId: ingress.correlationId, routed: ingress.routeIds.length, deliveries: (await this.deliveries.find({ workspaceId, ingressId: ingress.id }).toArray()).map(clean) };
    };
    const previous = await existing(); if (previous) return previous;
    try {
      return await this.transaction(async session => {
        const routes = (await this.routes.find({ workspaceId, enabled: true, ...(input.endpointId ? { id: input.endpointId } : {}) }, { session }).toArray()).filter(r => input.endpointId || matches(r.eventPattern, input.type));
        if (!routes.length) fail(422, 'No enabled destination matches this event');
        const ingressId = id('ing'); const correlationId = input.correlationId || id('cor'); const createdAt = now();
        const ingress = { id: ingressId, workspaceId, keyHash, fingerprint, correlationId, routeIds: routes.map(r => r.id), createdAt };
        await this.ingresses.insertOne(ingress, { session });
        const deliveries = routes.map(r => ({ id: id('evt'), workspaceId, ingressId, correlationId, endpointId: r.id, type: input.type, payload: input.payload,
          policy: r.retryPolicy, status: 'queued', attempts: 0, cycleAttempts: 0, replayCount: 0, attemptLog: [], responseCode: null, latency: null,
          nextAttemptAt: createdAt, leaseUntil: null, leaseToken: null, createdAt }));
        await this.deliveries.insertMany(deliveries, { session });
        await this.audit(workspaceId, actorId, 'ingress.accepted', ingressId, session, { correlationId, destinations: routes.length });
        return { accepted: true, duplicate: false, ingressId, correlationId, routed: deliveries.length, deliveries: deliveries.map(clean) };
      });
    } catch (error) { if (error.code === 11000) { const previous = await existing(); if (previous) return previous; } throw error; }
  }
  async event(workspaceId, eventId) {
    const event = clean(await this.deliveries.findOne({ workspaceId, id: eventId }));
    return event && { ...event, endpoint: (await this.route(workspaceId, event.endpointId))?.name || 'Unknown route' };
  }
  async replay(workspaceId, actorId, eventId) {
    return this.transaction(async session => {
      const old = await this.deliveries.findOne({ workspaceId, id: eventId }, { session });
      if (!old) fail(404, 'Delivery not found');
      if (!['dead_letter', 'failed'].includes(old.status)) fail(409, 'Only dead-letter deliveries can be replayed');
      if (old.replayCount >= 20) fail(409, 'Replay history limit reached');
      const route = await this.routes.findOne({ workspaceId, id: old.endpointId }, { session });
      if (!route?.enabled) fail(409, 'Resume the route before replaying');
      const event = await this.deliveries.findOneAndUpdate({ workspaceId, id: eventId, status: old.status }, { $set: {
        status: 'queued', cycleAttempts: 0, policy: route.retryPolicy, nextAttemptAt: now(), replayedAt: now(), leaseToken: null, leaseUntil: null
      }, $inc: { replayCount: 1 } }, { session, returnDocument: 'after' });
      await this.audit(workspaceId, actorId, 'delivery.replayed', eventId, session, { correlationId: old.correlationId });
      return clean(event);
    });
  }
  async claim(leaseMs = 60000) {
    const at = now();
    const enabled = await this.routes.find({ enabled: true }, { projection: { id: 1 } }).toArray();
    const eligible = { endpointId: { $in: enabled.map(r => r.id) }, $or: [{ status: { $in: ['queued', 'retrying'] }, nextAttemptAt: { $lte: at } }, { status: 'processing', leaseUntil: { $lte: at } }] };
    const candidate = await this.deliveries.findOne(eligible, { sort: { nextAttemptAt: 1, createdAt: 1 } });
    if (!candidate) return null;
    const token = id('lease');
    // CAS prevents simultaneous workers reserving the same attempt. A crashed attempt remains visible.
    return clean(await this.deliveries.findOneAndUpdate({ ...eligible, id: candidate.id, attempts: candidate.attempts }, {
      $set: { status: 'processing', leaseToken: token, leaseUntil: new Date(Date.now() + leaseMs).toISOString() },
      $inc: { attempts: 1, cycleAttempts: 1 },
      $push: { attemptLog: { token, number: candidate.attempts + 1, cycle: candidate.replayCount, at, outcome: 'started', responseCode: null, latency: null, error: null } }
    }, { returnDocument: 'after' }));
  }
  async finish(event, result, nextAttemptAt) {
    const status = !result.error ? 'delivered' : event.cycleAttempts >= event.policy.maxAttempts ? 'dead_letter' : 'retrying';
    return this.transaction(async session => {
      const changed = await this.deliveries.updateOne({ id: event.id, leaseToken: event.leaseToken, status: 'processing' }, {
        $set: { status, nextAttemptAt, leaseToken: null, leaseUntil: null, responseCode: result.responseCode, latency: result.latency, lastError: result.error,
          ...(status === 'delivered' ? { deliveredAt: now() } : {}),
          'attemptLog.$[attempt].outcome': result.error ? 'failed' : 'delivered', 'attemptLog.$[attempt].responseCode': result.responseCode,
          'attemptLog.$[attempt].latency': result.latency, 'attemptLog.$[attempt].error': result.error }
      }, { session, arrayFilters: [{ 'attempt.token': event.leaseToken }] });
      if (changed.modifiedCount) await this.audit(event.workspaceId, 'worker', 'delivery.' + status, event.id, session, { correlationId: event.correlationId, attempt: event.attempts, reason: result.error });
      return changed.modifiedCount === 1;
    });
  }
  async defer(event) {
    await this.deliveries.updateOne({ id: event.id, leaseToken: event.leaseToken }, { $set: { status: 'queued', nextAttemptAt: now(), leaseToken: null, leaseUntil: null }, $inc: { attempts: -1, cycleAttempts: -1 }, $pop: { attemptLog: 1 } });
  }
  async consumeLimit(key, max, windowMs = 60000) {
    const window = Math.floor(this.clock() / windowMs); const _id = digest(key + ':' + window);
    let row;
    try { row = await this.limits.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * windowMs) } }, { upsert: true, returnDocument: 'after' }); }
    catch (e) { if (e.code !== 11000) throw e; row = await this.limits.findOneAndUpdate({ _id }, { $inc: { count: 1 } }, { returnDocument: 'after' }); }
    return row.count <= max;
  }
  async list(workspaceId, filter = {}) {
    const query = { workspaceId };
    if (filter.endpointId) query.endpointId = filter.endpointId;
    if (filter.status) query.status = filter.status;
    if (filter.type) query.type = { $regex: filter.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (filter.correlationId) query.correlationId = filter.correlationId;
    if (filter.from || filter.to) query.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lte: filter.to } : {}) };
    const [rows, total] = await Promise.all([this.deliveries.find(query).sort({ createdAt: -1, id: -1 }).skip(filter.offset || 0).limit(50).toArray(), this.deliveries.countDocuments(query)]);
    const routes = await this.routes.find({ workspaceId }).toArray();
    return { events: rows.map(e => ({ ...clean(e), endpoint: routes.find(r => r.id === e.endpointId)?.name || 'Unknown route' })), total, offset: filter.offset || 0, limit: 50 };
  }
  async dashboard(workspaceId, from = Date.now() - 86400000, to = Date.now(), endpointId) {
    const query = { workspaceId, createdAt: { $gte: new Date(from).toISOString(), $lte: new Date(to).toISOString() }, ...(endpointId ? { endpointId } : {}) };
    // Bounded exact aggregation: explicitly reject oversized windows rather than silently sampling.
    const count = await this.deliveries.countDocuments(query);
    if (count > 20000) fail(422, 'Metrics window exceeds 20,000 deliveries; choose a smaller date range');
    const [events, routes, queue] = await Promise.all([
      this.deliveries.find(query, { projection: { payload: 0 } }).toArray(),
      this.routes.find({ workspaceId, ...(endpointId ? { id: endpointId } : {}) }).toArray(),
      this.deliveries.aggregate([{ $match: { workspaceId, ...(endpointId ? { endpointId } : {}), status: { $in: ['queued', 'retrying', 'processing', 'dead_letter'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray()
    ]);
    const backlog = await this.deliveries.aggregate([{ $match: { workspaceId, status: { $in: ['queued', 'retrying', 'processing', 'dead_letter'] }, ...(endpointId ? { endpointId } : {}) } }, { $group: { _id: { endpointId: '$endpointId', status: '$status' }, count: { $sum: 1 } } }]).toArray();
    return { endpoints: routes.map(r => {
      const health = routeHealth(r, events);
      const unresolved = backlog.filter(row => row._id.endpointId === r.id);
      const dead = unresolved.find(row => row._id.status === 'dead_letter')?.count || 0;
      return { ...publicRoute(r), health: { ...health, unresolved: dead, state: !r.enabled ? 'paused' : dead ? 'attention' : unresolved.length ? 'recovering' : health.state } };
    }), stats: metrics(events, from, to),
      queue: Object.fromEntries(queue.map(q => [q._id, q.count])), window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), basis: 'Deliveries accepted in this window; completed outcomes exclude pending work. Attempt metrics use recorded attempts within the window.' } };
  }
  async auditList(workspaceId) { return (await this.audits.find({ workspaceId }).sort({ at: -1 }).limit(100).toArray()).map(clean); }
  async close() { await this.client.close(); }
}

