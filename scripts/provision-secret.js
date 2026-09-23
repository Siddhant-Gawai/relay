import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Credentials are read from environment, never command-line arguments or console output.
const [routeId, output] = process.argv.slice(2);
try {
  if (!routeId || !output) throw new Error();
  const relativeOutput = relative(fileURLToPath(new URL('../', import.meta.url)), resolve(output));
  if (!relativeOutput.startsWith('..') && !isAbsolute(relativeOutput)) throw new Error();
  const origin = new URL(process.env.RELAY_API_ORIGIN || 'http://localhost:3000');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error();
  const secret = randomBytes(32).toString('base64url');
  // Exclusive creation prevents overwriting a receiver's working credential.
  await writeFile(resolve(output), secret, { flag: 'wx', mode: 0o600 });
  const response = await fetch(new URL('/api/endpoints/' + encodeURIComponent(routeId) + '/rotate-secret', origin), {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(process.env.RELAY_ACCESS_TOKEN ? { authorization: 'Bearer ' + process.env.RELAY_ACCESS_TOKEN } : {}),
      ...(process.env.RELAY_WORKSPACE_ID ? { 'x-workspace-id': process.env.RELAY_WORKSPACE_ID } : {}) },
    body: JSON.stringify({ secret }), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error();
  console.log('Receiver credential saved and route updated. Transfer the file securely to your receiver.');
} catch {
  console.error('Provisioning did not complete. Check owner authentication, route ID and a new private output filename outside the repository. A file may have been saved; retain it until the route state is confirmed.');
  process.exitCode = 1;
}

