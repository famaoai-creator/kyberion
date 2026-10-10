import { getFrontDeskAuthRevision, readFrontDeskRequestToken } from './front-desk-auth-token';
const MEMBER_PATHS = [
  '/api/management',
  '/api/me',
  '/api/front-desk/nav',
  '/api/front-desk/links',
  '/api/setup',
  '/api/notification-preferences',
  '/api/plugins',
  '/api/config-missions',
  '/api/members',
  '/api/invites',
  '/api/org-readiness',
  '/api/push',
  '/api/charters',
  '/api/ingest',
  '/api/training',
  '/api/voice',
  '/api/work-inventory',
  '/api/message',
  '/api/summary',
  '/api/response-status',
  '/api/hygiene',
  '/api/memory-queue',
  '/api/approvals',
  '/api/outcomes',
] as const;
export function isFrontDeskMemberApiPath(path: string): boolean {
  if (!path.startsWith('/api/') || /[\\\x00-\x20\x7f#]/.test(path)) return false;
  const pathname = path.split('?')[0];
  if (
    /%(?:2e|2f|5c)/i.test(pathname) ||
    pathname.split('/').some((part) => part === '.' || part === '..')
  )
    return false;
  if (
    pathname === '/api/me/avatar' ||
    pathname.startsWith('/api/me/avatar/') ||
    pathname === '/api/setup/avatar-generation' ||
    pathname.startsWith('/api/setup/avatar-generation/') ||
    pathname === '/api/setup/first-run' ||
    pathname.startsWith('/api/setup/first-run/') ||
    pathname === '/api/invites/join' ||
    pathname.startsWith('/api/invites/join/')
  )
    return false;
  return MEMBER_PATHS.some((root) => pathname === root || pathname.startsWith(root + '/'));
}
/** Same-origin member transport, with no retry, credential promotion or global fetch patch. */
export async function frontDeskFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isFrontDeskMemberApiPath(path)) throw new TypeError('Unsupported member API path');
  const token = readFrontDeskRequestToken();
  const revision = getFrontDeskAuthRevision();
  const current = () => {
    if (
      init.signal?.aborted ||
      token !== readFrontDeskRequestToken() ||
      revision !== getFrontDeskAuthRevision()
    )
      throw new DOMException('Member request context changed', 'AbortError');
  };
  current();
  const headers = new Headers(init.headers);
  headers.delete('Authorization');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  const response = await fetch(path, {
    ...init,
    headers,
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  current();
  for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData'] as const) {
    const read = response[method]?.bind(response);
    if (read)
      Object.defineProperty(response, method, {
        configurable: true,
        value: async () => {
          current();
          const value = await read();
          current();
          return value;
        },
      });
  }
  return response;
}
