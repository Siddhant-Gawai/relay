import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function textField(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(422, 'Invalid ' + name);
  return value.trim();
}
export const DEFAULT_POLICY = { maxAttempts: 3, backoff: 'exponential', baseDelayMs: 1000, timeoutMs: 8000 };
export function policy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'Invalid retry policy');
  const result = { ...DEFAULT_POLICY, ...input };
  for (const [key, min, max] of [['maxAttempts', 1, 10], ['baseDelayMs', 100, 3600000], ['timeoutMs', 100, 30000]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) fail(422, key + ' must be between ' + min + ' and ' + max);
  }
  if (!['fixed', 'exponential'].includes(result.backoff)) fail(422, 'Backoff must be fixed or exponential');
  return Object.fromEntries(Object.keys(DEFAULT_POLICY).map(key => [key, result[key]]));
}
export function secretBox(encodedKey) {
  const key = Buffer.from(encodedKey || '', 'base64');
  if (key.length !== 32) throw new Error('RELAY_ENCRYPTION_KEY must encode exactly 32 bytes');
  return {
    encrypt(secret, routeId) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(routeId));
      return { v: 1, iv: iv.toString('base64'), data: Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    decrypt(box, routeId) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      decipher.setAAD(Buffer.from(routeId)); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const global = new BlockList(); global.addSubnet('2000::', 3, 'ipv6');
    const reserved = new BlockList(); reserved.addSubnet('2001::', 23, 'ipv6'); reserved.addSubnet('2002::', 16, 'ipv6'); reserved.addSubnet('3fff::', 20, 'ipv6');
    return global.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
  }
  return false;
}
export async function destination(value, { allowPrivate = false, resolve = lookup } = {}) {
  let url; try { url = new URL(value); } catch { fail(422, 'Invalid destination URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || value.length > 2000) fail(422, 'Use an HTTP(S) URL without credentials, query parameters or fragments');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses; try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([resolve(hostname, { all: true, verbatim: true }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); timer.unref(); })]); } catch { fail(422, 'Destination DNS lookup failed'); }
  if (!addresses.length || (!allowPrivate && addresses.some(item => !isPublicAddress(item.address)))) fail(422, 'Private or reserved destination addresses are disabled');
  return { url, address: addresses[0] };
}
export async function jsonBody(req, limit = 100000) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Content-Type must be application/json');
  if (Number(req.headers['content-length']) > limit) fail(413, 'Request exceeds 100 KB');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413, 'Request exceeds 100 KB'); chunks.push(chunk); }
  let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'Invalid JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(422, 'Expected a JSON object');
  return result;
}

