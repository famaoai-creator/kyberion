const COOKIE_NAME = 'session';

export function seedAuthenticatedSession() {
  window.localStorage.setItem('auth_state', 'signed_in');
  window.sessionStorage.setItem('handoff_ready', 'true');
  document.cookie = `${COOKIE_NAME}=debug-web-session-cookie; Path=/; SameSite=Lax`;
}

export function clearSession() {
  window.localStorage.removeItem('auth_state');
  window.sessionStorage.removeItem('handoff_ready');
  document.cookie = `${COOKIE_NAME}=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function getSessionState() {
  return {
    localStorage: Object.fromEntries(Object.entries(window.localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(window.sessionStorage)),
    cookies: document.cookie,
  };
}
