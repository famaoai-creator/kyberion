import { renderRoute } from './router';

renderRoute(window.location.pathname);

window.addEventListener('popstate', () => {
  renderRoute(window.location.pathname);
});
