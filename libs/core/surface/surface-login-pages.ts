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

const TEXT = {
  en: {
    title: 'Sign in',
    surface: 'Surface',
    lead: 'Sign in with your organization account to continue.',
    button: (label: string) => `Sign in with ${label}`,
    unconfiguredTitle: 'Single sign-on is not configured',
    unconfiguredLead:
      'This surface cannot verify who you are yet. An administrator must finish the sign-in setup:',
    unconfiguredHint:
      'Until then, use an access token (KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN). Loopback auto-admin only applies where the surface can see a real local peer; on Next.js surfaces it needs KYBERION_TRUST_PROXY=1 behind a trusted proxy.',
    unboundTitle: 'Your account is not registered',
    unboundLead:
      'You signed in successfully, but this identity is not bound to a Kyberion member, so no access was granted. Send the identifiers below to an administrator so they can bind them to your member profile.',
    issuer: 'Issuer',
    subject: 'Subject',
    suspendedTitle: 'Your member account is suspended',
    suspendedLead: 'Your identity is bound to a suspended member. Contact an administrator.',
    failedTitle: 'Sign-in could not be completed',
    failed: {
      idp_error: 'The identity provider returned an error. Try again.',
      state_mismatch:
        'The sign-in request could not be verified. Start again from the sign-in page.',
      expired: 'The sign-in attempt expired. Start again.',
      exchange_failed: 'The identity provider did not accept the sign-in. Try again.',
      token_invalid: 'The identity provider response failed verification.',
      session_unavailable: 'A session could not be created. Contact an administrator.',
    } as Record<SurfaceLoginFailureCode, string>,
    retry: 'Try again',
    tokenLink: 'Use an access token instead',
    signedOutTitle: 'Signed out',
    signedOutLead: 'Your session on this surface has ended.',
  },
  ja: {
    title: 'サインイン',
    surface: 'サーフェス',
    lead: '組織のアカウントでサインインして続けます。',
    button: (label: string) => `${label} でサインイン`,
    unconfiguredTitle: 'シングルサインオンが未設定です',
    unconfiguredLead:
      'この画面はまだ本人確認ができません。管理者がサインインの設定を完了する必要があります:',
    unconfiguredHint:
      'それまでは、アクセストークン(KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN)を使ってください。loopback の自動 admin は、サーフェスが実際のローカル接続元を判別できる場合だけ有効です(Next.js 系は、信頼できるプロキシの背後で KYBERION_TRUST_PROXY=1 が必要)。',
    unboundTitle: 'このアカウントは登録されていません',
    unboundLead:
      'サインイン自体は成功しましたが、この識別子は Kyberion のメンバーに紐付いていないため、アクセスは許可されませんでした。下の識別子を管理者に伝えて、あなたのメンバープロファイルに紐付けてもらってください。',
    issuer: '発行者 (issuer)',
    subject: '識別子 (subject)',
    suspendedTitle: 'メンバーアカウントが停止されています',
    suspendedLead: 'この識別子は停止中のメンバーに紐付いています。管理者に連絡してください。',
    failedTitle: 'サインインを完了できませんでした',
    failed: {
      idp_error: 'ID プロバイダーがエラーを返しました。もう一度お試しください。',
      state_mismatch:
        'サインイン要求を検証できませんでした。サインイン画面からやり直してください。',
      expired: 'サインインの有効期限が切れました。最初からやり直してください。',
      exchange_failed:
        'ID プロバイダーがサインインを受け付けませんでした。もう一度お試しください。',
      token_invalid: 'ID プロバイダーの応答を検証できませんでした。',
      session_unavailable: 'セッションを作成できませんでした。管理者に連絡してください。',
    } as Record<SurfaceLoginFailureCode, string>,
    retry: 'もう一度試す',
    tokenLink: 'アクセストークンでサインインする',
    signedOutTitle: 'サインアウトしました',
    signedOutLead: 'この画面でのセッションを終了しました。',
  },
} as const;

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

function tokenLink(href: string | undefined, label: string): string {
  return href ? `<p class="muted"><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>` : '';
}

export function renderSurfaceLoginPage(input: {
  surfaceLabel: string;
  view: SurfaceLoginView;
  locale: SurfaceLoginLocale;
}): string {
  const t = TEXT[input.locale];
  const { view } = input;
  let title: string;
  let body: string;
  switch (view.kind) {
    case 'ready':
      title = t.title;
      body = `<h1>${escapeHtml(t.title)}</h1><p>${escapeHtml(t.lead)}</p><a class="btn" href="${escapeHtml(view.startHref)}">${escapeHtml(t.button(view.providerLabel))}</a>${tokenLink(view.tokenHref, t.tokenLink)}`;
      break;
    case 'unconfigured':
      title = t.unconfiguredTitle;
      body = `<h1>${escapeHtml(t.unconfiguredTitle)}</h1><p>${escapeHtml(t.unconfiguredLead)}</p><ul>${view.missing
        .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
        .join(
          ''
        )}</ul><p class="muted">${escapeHtml(t.unconfiguredHint)}</p>${tokenLink(view.tokenHref, t.tokenLink)}`;
      break;
    case 'unbound':
      title = t.unboundTitle;
      body = `<h1>${escapeHtml(t.unboundTitle)}</h1><p>${escapeHtml(t.unboundLead)}</p><dl><dt>${escapeHtml(t.issuer)}</dt><dd>${escapeHtml(view.issuer)}</dd><dt>${escapeHtml(t.subject)}</dt><dd>${escapeHtml(view.subject)}</dd></dl>`;
      break;
    case 'suspended':
      title = t.suspendedTitle;
      body = `<h1>${escapeHtml(t.suspendedTitle)}</h1><p>${escapeHtml(t.suspendedLead)}</p>`;
      break;
    case 'failed':
      title = t.failedTitle;
      body = `<h1>${escapeHtml(t.failedTitle)}</h1><p class="err" role="alert">${escapeHtml(t.failed[view.code])}</p><a class="btn" href="/login">${escapeHtml(t.retry)}</a>`;
      break;
    case 'signed-out':
      title = t.signedOutTitle;
      body = `<h1>${escapeHtml(t.signedOutTitle)}</h1><p>${escapeHtml(t.signedOutLead)}</p>${
        view.startHref
          ? `<a class="btn" href="${escapeHtml(view.startHref)}">${escapeHtml(t.button(view.providerLabel ?? 'SSO'))}</a>`
          : ''
      }`;
      break;
  }
  return `<!doctype html>
<html lang="${input.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)} — ${escapeHtml(input.surfaceLabel)}</title><style>${CSS}</style></head><body><main><p class="surface">${escapeHtml(t.surface)} · ${escapeHtml(input.surfaceLabel)}</p>${body}</main></body></html>`;
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
