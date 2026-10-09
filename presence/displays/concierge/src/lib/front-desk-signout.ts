import { createHash } from 'node:crypto';
import { escapeHtml, type SurfaceLoginLocale } from '@agent/core/surface/surface-login-pages';
import { frontDeskText } from './i18n';

/** Fixed code only: neither request data nor translated text enters the script. */
export const FRONT_DESK_SIGNOUT_SCRIPT = `(() => {
  try {
    const storage = window.sessionStorage;
    const owned = (key) => key === 'front-desk.token' || (key !== null && (key.startsWith('front-desk.draft.') || key.startsWith('front-desk.request.')));
    const keys = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (owned(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    document.cookie = 'kyberion_client_token=; Path=/; SameSite=Lax; Max-Age=0';
    for (let index = 0; index < storage.length; index++) {
      if (owned(storage.key(index))) return;
    }
    if (storage.getItem('front-desk.token') !== null) return;
    if (document.cookie.split(';').some((cookie) => cookie.trim().startsWith('kyberion_client_token='))) return;
    window.location.replace('/login?signedout=1');
  } catch {
    // Leave the visible close-tab instructions in place; never claim success.
  }
})();`;

export const FRONT_DESK_SIGNOUT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${createHash('sha256').update(FRONT_DESK_SIGNOUT_SCRIPT).digest('base64')}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
};

export function renderFrontDeskSignoutPage(locale: SurfaceLoginLocale): string {
  const title = escapeHtml(frontDeskText('signout_pending_title', locale));
  const fallback = escapeHtml(frontDeskText('signout_cleanup_fallback', locale));
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p role="status">${fallback}</p></main><script>${FRONT_DESK_SIGNOUT_SCRIPT}</script></body></html>`;
}
