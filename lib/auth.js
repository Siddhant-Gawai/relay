import { fail } from './security.js';

export function createAuth({ mode = 'supabase', url, key, secure = true, fetchImpl = fetch }) {
  if (!['supabase', 'local'].includes(mode)) throw new Error('Unknown authentication mode');
  if (mode === 'supabase' && (!url || !key)) throw new Error('Supabase authentication requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
  const cookieOptions = '; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=')));
  async function upstream(path, { token, body, method = 'GET' } = {}) {
    let response;
    try { response = await fetchImpl(url + '/auth/v1' + path, { method, headers: { apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) }); }
    catch { fail(503, 'Authentication provider unavailable'); }
    if (!response.ok) fail(response.status >= 500 ? 503 : 401, response.status >= 500 ? 'Authentication provider unavailable' : 'Sign-in failed or session expired');
    if (response.status === 204) return {};
    return response.json();
  }
  function setSession(res, result) {
    if (!result.access_token || !result.refresh_token || !result.user?.id) fail(502, 'Invalid authentication response');
    res.setHeader('set-cookie', [
      'relay_access=' + result.access_token + '; Path=/; Max-Age=' + Math.min(result.expires_in || 3600, 86400) + cookieOptions,
      'relay_refresh=' + result.refresh_token + '; Path=/api/auth; Max-Age=2592000' + cookieOptions
    ]);
  }
  return {
    mode,
    async user(req) {
      if (mode === 'local') return { id: 'local-operator' };
      const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1] || cookies(req).relay_access;
      if (!token) fail(401, 'Sign in to Relay');
      const user = await upstream('/user', { token });
      if (!user.id || user.is_anonymous) fail(401, 'A registered Supabase user is required');
      return { id: user.id };
    },
    async login(res, input) {
      if (mode === 'local') fail(409, 'Local mode does not use passwords');
      if (typeof input.email !== 'string' || input.email.length > 320 || typeof input.password !== 'string' || input.password.length > 1000) fail(422, 'Email and password are required');
      const result = await upstream('/token?grant_type=password', { method: 'POST', body: { email: input.email, password: input.password } });
      setSession(res, result); return { user: { id: result.user.id } };
    },
    async refresh(req, res) {
      if (mode === 'local') fail(409, 'Local mode does not use sessions');
      const refresh_token = cookies(req).relay_refresh; if (!refresh_token) fail(401, 'Sign in again');
      const result = await upstream('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token } });
      setSession(res, result); return { user: { id: result.user.id } };
    },
    async logout(req, res) {
      res.setHeader('set-cookie', ['relay_access=; Path=/; Max-Age=0' + cookieOptions, 'relay_refresh=; Path=/api/auth; Max-Age=0' + cookieOptions]);
      const token = cookies(req).relay_access;
      if (mode === 'supabase' && token) await upstream('/logout', { method: 'POST', token });
      return { ok: true };
    }
  };
}

