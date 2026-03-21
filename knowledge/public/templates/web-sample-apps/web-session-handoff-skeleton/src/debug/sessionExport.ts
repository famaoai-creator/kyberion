export function buildSessionHandoff() {
  return {
    kind: 'webview-session-handoff',
    target_url: `${window.location.origin}/app/home`,
    origin: window.location.origin,
    browser_session_id: 'example-web-login-guarded',
    prefer_persistent_context: true,
    cookies: parseCookies(),
    local_storage: Object.fromEntries(Object.entries(window.localStorage)),
    session_storage: Object.fromEntries(Object.entries(window.sessionStorage)),
    source: {
      platform: 'browser',
      app_id: 'example-web-login-guarded',
    },
  };
}

function parseCookies() {
  return document.cookie
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ...rest] = entry.split('=');
      return {
        name,
        value: rest.join('='),
        domain: window.location.hostname,
        path: '/',
      };
    });
}
