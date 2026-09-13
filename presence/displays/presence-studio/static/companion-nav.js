/**
 * Shared companion hub navigation for Presence Studio pages.
 * Attach with: CompanionHubNav.mount(document.getElementById('hub-nav'), 'home'|'learn'|'discover'|'work')
 */
(function (global) {
  const LINKS = [
    { id: 'home', href: '/', label: 'Home' },
    { id: 'learn', href: '/learn', label: 'Learn' },
    { id: 'discover', href: '/discover', label: 'Discover' },
    { id: 'work', href: '/work', label: 'Work' },
    {
      id: 'connect',
      href: 'http://127.0.0.1:3050/setup#setup-services',
      label: 'Connect',
      external: true,
    },
  ];

  function mount(el, current) {
    if (!el) return;
    el.classList.add('hub-nav');
    el.setAttribute('aria-label', 'Companion Hub');
    el.innerHTML = LINKS.map((link) => {
      const attrs = [
        `href="${link.href}"`,
        link.id === current ? 'aria-current="page"' : '',
        link.external ? 'class="external" target="_blank" rel="noopener"' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<a ${attrs}>${link.label}</a>`;
    }).join('');
  }

  global.CompanionHubNav = { mount, LINKS };
})(globalThis);
