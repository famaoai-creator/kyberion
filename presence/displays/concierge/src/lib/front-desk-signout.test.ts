import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  FRONT_DESK_SIGNOUT_HEADERS,
  FRONT_DESK_SIGNOUT_SCRIPT,
  renderFrontDeskSignoutPage,
} from './front-desk-signout';

function browser(failure?: string) {
  const data = new Map([
    ['front-desk.token', 'synthetic-bearer'],
    ['front-desk.draft.alpha', 'draft-a'],
    ['front-desk.draft.beta', 'draft-b'],
    ['front-desk.request.alpha', 'request-a'],
    ['front-desk.theme', 'dark'],
    ['front-desk.draft', 'unrelated-exact-key'],
    ['another-app.token', 'unrelated-token'],
  ]);
  const cookieWrites: string[] = [];
  let cookie = 'kyberion_client_token=1; kb-ui-locale=ja';
  const storage = {
    get length() {
      if (failure === 'length') throw new Error('blocked');
      return data.size;
    },
    key: (index: number) => {
      if (failure === 'key') throw new Error('blocked');
      return [...data.keys()][index] ?? null;
    },
    removeItem: (key: string) => {
      if (failure === 'remove') throw new Error('blocked');
      if (failure !== 'silent-remove') data.delete(key);
    },
    getItem: (key: string) => {
      if (failure === 'get') throw new Error('blocked');
      return data.get(key) ?? null;
    },
  };
  const replace = vi.fn();
  const window = {
    get sessionStorage() {
      if (failure === 'storage') throw new Error('blocked');
      return storage;
    },
    get localStorage() {
      throw new Error('unrelated storage must never be touched');
    },
    location: { replace },
  };
  const document = {
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      cookieWrites.push(value);
      if (failure === 'cookie') throw new Error('blocked');
      if (failure !== 'silent-cookie') cookie = 'kb-ui-locale=ja';
    },
  };
  return { data, replace, cookieWrites, window, document };
}

describe('explicit front-desk signout document', () => {
  it('uses the exact fixed script hash and forbids unrelated resources', () => {
    const en = renderFrontDeskSignoutPage('en');
    const ja = renderFrontDeskSignoutPage('ja');
    const script = FRONT_DESK_SIGNOUT_SCRIPT;
    // This renderer emits a fixed document, so assert its exact script suffix rather than parse HTML with a regexp.
    for (const html of [en, ja]) {
      expect(html.endsWith('<script>' + script + '</script></body></html>')).toBe(true);
      expect(html.toLowerCase().split('<script')).toHaveLength(2);
      expect(html.toLowerCase().split('</script')).toHaveLength(2);
    }
    expect(FRONT_DESK_SIGNOUT_HEADERS['Content-Security-Policy']).toBe(
      `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
    );
    expect(FRONT_DESK_SIGNOUT_HEADERS['Cache-Control']).toBe('no-store');
    expect(en).toContain('close this tab');
    expect(en).toContain('Sign-out is not complete');
    expect(ja).toContain('このタブを閉じて');
    expect(en).not.toContain('http-equiv="refresh"');
  });

  it('removes only the tab bearer and request drafts before replacing history', () => {
    const b = browser();
    b.replace.mockImplementation(() => {
      expect([...b.data.keys()]).toEqual([
        'front-desk.theme',
        'front-desk.draft',
        'another-app.token',
      ]);
      expect(b.cookieWrites).toEqual(['kyberion_client_token=; Path=/; SameSite=Lax; Max-Age=0']);
    });
    runInNewContext(FRONT_DESK_SIGNOUT_SCRIPT, { window: b.window, document: b.document });
    expect(b.replace).toHaveBeenCalledExactlyOnceWith('/login?signedout=1');
  });

  it.each([
    'storage',
    'length',
    'key',
    'remove',
    'silent-remove',
    'get',
    'cookie',
    'silent-cookie',
  ])('keeps the visible fallback and never navigates after %s failure', (failure) => {
    const b = browser(failure);
    expect(() =>
      runInNewContext(FRONT_DESK_SIGNOUT_SCRIPT, { window: b.window, document: b.document })
    ).not.toThrow();
    expect(b.replace).not.toHaveBeenCalled();
  });
});
