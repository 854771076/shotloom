import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererEnv } from './helpers/rendererSsr.mjs';

test('upstream failures verify the cookie session once without logging out or replaying writes', async () => {
  const env = await createRendererEnv({ withWindow: true });
  const originalFetch = globalThis.fetch;
  const events = [];
  window.dispatchEvent = event => { events.push(event.type); return true; };
  const calls = [];
  let status = 200;
  let release;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url), 'https://fixture.example').pathname;
    calls.push({ path, method: init.method });
    if (path === '/api/auth/me') {
      await new Promise(resolve => { release = resolve; });
      if (status === 0) throw new TypeError('Network unavailable');
      return Response.json({ success: status === 200, data: { id: 'user' } }, { status });
    }
    return Response.json({ success: false, message: 'Provider rejected token' }, { status: 401 });
  };
  try {
    const { cloudRequest, bindCloudUser } = await env.load('services/cloudRequest');
    bindCloudUser('user');
    for (const sessionStatus of [200, 503, 0, 401]) {
      status = sessionStatus;
      const start = calls.length;
      const pending = Promise.allSettled([cloudRequest('/models'), cloudRequest('/feedback', 'POST', { description: 'draft' })]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(events.length, 0, 'a provider 401 alone cannot expire the application session');
      assert.equal(calls.slice(start).filter(call => call.path === '/api/auth/me').length, 1);
      release();
      assert.ok((await pending).every(result => result.status === 'rejected'));
      assert.equal(calls.slice(start).filter(call => call.path === '/api/feedback').length, 1);
      assert.equal(events.length, sessionStatus === 401 ? 1 : 0);
    }
    status = 200;
    globalThis.fetch = async () => Response.json({ success: false, code: 'ACCOUNT_CHANGED' }, { status: 409 });
    bindCloudUser('user');
    await assert.rejects(cloudRequest('/projects'));
    assert.equal(events.length, 2, 'account changes must still block the workspace');
    globalThis.fetch = async url => {
      if (String(url).endsWith('/auth/me')) await new Promise(resolve => { release = resolve; });
      return Response.json({ success: false }, { status: 401 });
    };
    bindCloudUser('user');
    const stale = assert.rejects(cloudRequest('/models'));
    await new Promise(resolve => setImmediate(resolve));
    bindCloudUser('user');
    release(); await stale;
    assert.equal(events.length, 2, 'old auth checks cannot expire a recovered session');
    globalThis.fetch = async () => Response.json({ success: false }, { status: 401 });
    await assert.rejects(cloudRequest('/auth/me'));
    await assert.rejects(cloudRequest('/auth/me'));
    assert.equal(events.length, 3, 'a revoked session expires once');
    const mutations = [];
    window.location = { search: '?native=embedded' };
    window.ReactNativeWebView = { postMessage: value => mutations.push(JSON.parse(value)) };
    globalThis.fetch = async () => Response.json({ success: true, data: {} });
    await cloudRequest('/project/fixture', 'PUT', {});
    assert.deepEqual(mutations, [{ type: 'workspace-mutated', path: '/project/fixture' }]);
  } finally { globalThis.fetch = originalFetch; await env.dispose(); }
});
