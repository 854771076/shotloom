import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

Object.assign(process.env, {
  NODE_ENV: 'test', GATEWAY_BASE_URL: 'https://gateway.example.com', GATEWAY_CLIENT_ID: 'nac_test',
  GATEWAY_CLIENT_SECRET: 'test-secret', GATEWAY_REDIRECT_URI: 'http://localhost:5173/api/auth/callback',
  FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role', SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SESSION_ENCRYPTION_KEY: '11'.repeat(32),
});
const { app } = await import('../src/index');
const { encrypt } = await import('../src/lib/crypto');

test('session authentication and /me use one tenant-filtered read and never cache revoked sessions', async () => {
  const original = globalThis.fetch;
  const id = randomUUID(), owner = { id: randomUUID(), sub: '1', username: 'Fixture', email: null };
  let exists = true, tenant = 'nac_test', age = 0, reads = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    reads++;
    assert.ok(url.pathname.endsWith('/sessions'), 'profile must come from the session query');
    assert.match(url.searchParams.get('select') || '', /owner:users!inner\(id,sub,username,email\)/);
    assert.equal(url.searchParams.get('owner.client_id'), 'eq.nac_test');
    return Response.json(exists && tenant === 'nac_test' ? {
      id, user_id: owner.id, owner, access_token_cipher: encrypt('private-provider-token'), refresh_token_cipher: null,
      created_at: new Date(Date.now() - age).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    } : null);
  };
  const request = (expectedUser?: string) => app.request('/api/auth/me', {
    headers: { cookie: `shotloom_session=${id}`, ...(expectedUser ? { 'x-shotloom-user': expectedUser } : {}) },
  });
  try {
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, owner);
    assert.equal(reads, 1);
    assert.equal((await request(randomUUID())).status, 409);
    tenant = 'another-app'; assert.equal((await request()).status, 401);
    tenant = 'nac_test'; age = 30 * 86400000; assert.equal((await request()).status, 401);
    age = 0; assert.equal((await request()).status, 200);
    exists = false; assert.equal((await request()).status, 401);
    assert.equal(reads, 6, 'each request must still validate current session ownership');
  } finally { globalThis.fetch = original; }
});
