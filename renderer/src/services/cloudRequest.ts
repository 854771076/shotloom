import { cloudOrigin } from '../utils/cloudConfig';
export { cloudEnabled, cloudOrigin } from '../utils/cloudConfig';

// Keep an open workspace bound to its original account across login recovery.
let sessionUserId: string | undefined;
let sessionExpired = false;
let sessionCheck: Promise<void> | undefined;
let sessionVersion = 0;
export function bindCloudUser(id: string): boolean {
  if (sessionUserId && sessionUserId !== id) return false;
  sessionUserId = id;
  sessionExpired = false;
  sessionVersion++;
  sessionCheck = undefined;
  return true;
}
export function cloudUserHeaders(): Record<string, string> {
  return sessionUserId ? { 'x-shotloom-user': sessionUserId } : {};
}

function expireSession() {
  if (sessionExpired || typeof window === 'undefined') return;
  sessionExpired = true;
  window.dispatchEvent(new Event('shotloom-session-expired'));
}

export function verifyCloudSession(): Promise<void> {
  if (sessionCheck) return sessionCheck;
  const version = sessionVersion;
  const check = (async () => {
    try {
      const response = await fetch(`${cloudOrigin}/api/auth/me`, {
        credentials: 'include', headers: cloudUserHeaders(), signal: AbortSignal.timeout(15000),
      });
      const changed = response.status === 409 && (await response.json()).code === 'ACCOUNT_CHANGED';
      if (version === sessionVersion && (response.status === 401 || changed)) expireSession();
    } catch { /* An unavailable auth endpoint does not prove the session expired. */ }
  })().finally(() => { if (sessionCheck === check) sessionCheck = undefined; });
  sessionCheck = check;
  return check;
}

export async function cloudRequest<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const version = sessionVersion;
  const response = await fetch(`${cloudOrigin}/api${path}`, {
    method, credentials: 'include',
    headers: { ...cloudUserHeaders(), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const result = await response.json() as { success: boolean; message: string; data: T };
  if (version === sessionVersion && response.status === 401) {
    if (path === '/auth/me') expireSession();
    else await verifyCloudSession();
  }
  if (version === sessionVersion && response.status === 409 && (result as { code?: string }).code === 'ACCOUNT_CHANGED') expireSession();
  if (version === sessionVersion && path === '/auth/me' && response.ok && result.success) sessionExpired = false;
  if (!response.ok || !result.success) throw Object.assign(new Error(result.message || `HTTP ${response.status}`), { status: response.status });
  if (method !== 'GET' && typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('native') === 'embedded') window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'workspace-mutated', path }));
  return result.data;
}
