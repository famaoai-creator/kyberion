import { clearSession, getSessionState, seedAuthenticatedSession } from './auth/sessionStore';
import { buildSessionHandoff } from './debug/sessionExport';

function navigate(path: string) {
  window.history.pushState({}, '', path);
  renderRoute(path);
}

function guarded(path: string) {
  const session = getSessionState();
  if (!session.localStorage.auth_state) {
    navigate('/login');
    return false;
  }
  return true;
}

export function renderRoute(path: string) {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;

  if (path === '/login') {
    app.innerHTML = `
      <main>
        <h1>Example Login</h1>
        <input data-testid="email" placeholder="email" />
        <input data-testid="password" placeholder="password" type="password" />
        <button data-testid="sign-in">Sign In</button>
      </main>
    `;
    app.querySelector('[data-testid="sign-in"]')?.addEventListener('click', () => {
      seedAuthenticatedSession();
      navigate('/app/home');
    });
    return;
  }

  if (path === '/logout') {
    clearSession();
    navigate('/login');
    return;
  }

  if (path === '/__kyberion/session-export') {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(buildSessionHandoff(), null, 2);
    app.replaceChildren(pre);
    return;
  }

  if (path === '/app/home') {
    if (!guarded(path)) return;
    app.innerHTML = `
      <main>
        <nav>
          <button data-testid="nav-home">Home</button>
          <button data-testid="nav-settings">Settings</button>
          <button data-testid="nav-logout">Logout</button>
        </nav>
        <h1>Home</h1>
      </main>
    `;
  } else if (path === '/app/settings') {
    if (!guarded(path)) return;
    app.innerHTML = `
      <main>
        <nav>
          <button data-testid="nav-home">Home</button>
          <button data-testid="nav-settings">Settings</button>
          <button data-testid="nav-logout">Logout</button>
        </nav>
        <h1>Settings</h1>
      </main>
    `;
  } else {
    navigate('/login');
    return;
  }

  app.querySelector('[data-testid="nav-home"]')?.addEventListener('click', () => navigate('/app/home'));
  app.querySelector('[data-testid="nav-settings"]')?.addEventListener('click', () => navigate('/app/settings'));
  app.querySelector('[data-testid="nav-logout"]')?.addEventListener('click', () => navigate('/logout'));
}
