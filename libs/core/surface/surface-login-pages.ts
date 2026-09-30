/**
 * surface-login-pages — the one login screen every surface serves.
 *
 * Server-rendered, script-free HTML (so it works under a strict CSP and needs
 * no client bundle in any of the five surfaces). Colors follow the
 * `kyberion-base` deep-blue tokens with light/dark via `prefers-color-scheme`;
 * text is en/ja, chosen by `?lang=` → Accept-Language. Every interpolated
 * value is HTML-escaped: the unbound-identity screen echoes the IdP-supplied
 * `iss`/`sub`, which is attacker-influenced text.
 */

import { t } from '../t.js';
import type { VocabularyKey } from '../knowledge/vocabulary-keys.generated.js';

export type SurfaceLoginLocale = 'en' | 'ja';

export type SurfaceLoginView =
  | { kind: 'ready'; providerLabel: string; startHref: string; tokenHref?: string }
  | { kind: 'unconfigured'; missing: string[]; tokenHref?: string }
  | { kind: 'unbound'; issuer: string; subject: string }
  | { kind: 'suspended' }
  | { kind: 'failed'; code: SurfaceLoginFailureCode }
  | { kind: 'signed-out'; startHref?: string; providerLabel?: string };

export type SurfaceLoginFailureCode =
  | 'idp_error'
  | 'state_mismatch'
  | 'expired'
  | 'exchange_failed'
  | 'token_invalid'
  | 'session_unavailable';

export function resolveLoginLocale(
  query: string | null | undefined,
  acceptLanguage: string | null | undefined
): SurfaceLoginLocale {
  if (query === 'ja' || query === 'en') return query;
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('ja') ? 'ja' : 'en';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{--bg:#f4f6fb;--panel:#fff;--fg:#0f1b33;--muted:#55627d;--accent:#1f4fd8;--accent-fg:#fff;--border:#d5dbea;--danger:#b42318;--code:#eef1f8}
@media (prefers-color-scheme:dark){:root{--bg:#0b1324;--panel:#121d36;--fg:#e6ecfb;--muted:#9aa8c7;--accent:#6b93ff;--accent-fg:#0b1324;--border:#26365c;--danger:#ff8a80;--code:#0e1830}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
main{width:min(92vw,30rem);background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:2rem 1.75rem;margin:1rem}
.surface{font-size:.8rem;letter-spacing:.04em;color:var(--muted);text-transform:uppercase;margin:0 0 .5rem}
h1{font-size:1.35rem;margin:0 0 .75rem}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.92rem}
.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.25rem;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none}
.btn:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.err{color:var(--danger)}
dl{margin:1rem 0 0;display:grid;gap:.25rem}
dt{font-size:.8rem;color:var(--muted)}
dd{margin:0 0 .5rem;padding:.4rem .6rem;background:var(--code);border-radius:7px;font:.85rem/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;user-select:all}
ul{padding-left:1.25rem;margin:.5rem 0}
code{background:var(--code);padding:.1rem .35rem;border-radius:5px;font-size:.88em}
`;

const FAILURE_KEYS: Record<SurfaceLoginFailureCode, VocabularyKey> = {
  idp_error: 'surface_login:failed_idp_error',
  state_mismatch: 'surface_login:failed_state_mismatch',
  expired: 'surface_login:failed_expired',
  exchange_failed: 'surface_login:failed_exchange_failed',
  token_invalid: 'surface_login:failed_token_invalid',
  session_unavailable: 'surface_login:failed_session_unavailable',
};

function tokenLink(href: string | undefined, label: string): string {
  return href ? `<p class="muted"><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>` : '';
}

export function renderSurfaceLoginPage(input: {
  surfaceLabel: string;
  view: SurfaceLoginView;
  locale: SurfaceLoginLocale;
}): string {
  const { locale, view } = input;
  const text = (key: VocabularyKey, params?: Record<string, string>): string =>
    escapeHtml(t(key, params, locale));
  let title: string;
  let body: string;
  switch (view.kind) {
    case 'ready':
      title = t('surface_login:title', undefined, locale);
      body = `<h1>${text('surface_login:title')}</h1><p>${text('surface_login:lead')}</p><a class="btn" href="${escapeHtml(view.startHref)}">${text('surface_login:button', { label: view.providerLabel })}</a>${tokenLink(view.tokenHref, t('surface_login:token_link', undefined, locale))}`;
      break;
    case 'unconfigured':
      title = t('surface_login:unconfigured_title', undefined, locale);
      body = `<h1>${text('surface_login:unconfigured_title')}</h1><p>${text('surface_login:unconfigured_lead')}</p><ul>${view.missing
        .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
        .join(
          ''
        )}</ul><p class="muted">${text('surface_login:unconfigured_hint')}</p>${tokenLink(view.tokenHref, t('surface_login:token_link', undefined, locale))}`;
      break;
    case 'unbound':
      title = t('surface_login:unbound_title', undefined, locale);
      body = `<h1>${text('surface_login:unbound_title')}</h1><p>${text('surface_login:unbound_lead')}</p><dl><dt>${text('surface_login:issuer')}</dt><dd>${escapeHtml(view.issuer)}</dd><dt>${text('surface_login:subject')}</dt><dd>${escapeHtml(view.subject)}</dd></dl>`;
      break;
    case 'suspended':
      title = t('surface_login:suspended_title', undefined, locale);
      body = `<h1>${text('surface_login:suspended_title')}</h1><p>${text('surface_login:suspended_lead')}</p>`;
      break;
    case 'failed':
      title = t('surface_login:failed_title', undefined, locale);
      body = `<h1>${text('surface_login:failed_title')}</h1><p class="err" role="alert">${text(FAILURE_KEYS[view.code])}</p><a class="btn" href="/login">${text('surface_login:retry')}</a>`;
      break;
    case 'signed-out':
      title = t('surface_login:signed_out_title', undefined, locale);
      body = `<h1>${text('surface_login:signed_out_title')}</h1><p>${text('surface_login:signed_out_lead')}</p>${
        view.startHref
          ? `<a class="btn" href="${escapeHtml(view.startHref)}">${text('surface_login:button', { label: view.providerLabel ?? 'SSO' })}</a>`
          : ''
      }`;
      break;
  }
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)} — ${escapeHtml(input.surfaceLabel)}</title><style>${CSS}</style></head><body><main><p class="surface">${text('surface_login:surface')} · ${escapeHtml(input.surfaceLabel)}</p>${body}</main></body></html>`;
}

/** Headers for every login-flow response: no caching, no framing, no script. */
export const SURFACE_LOGIN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
