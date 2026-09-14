/*
 * FD-00 / FD-01 front-desk rail — shared "5 human verbs" navigation shell.
 *
 * Plain browser script (no modules, no external resources): both
 * presence-studio pages (`index.html`, `home.html`, `ask.html`, `progress.html`,
 * `help.html`) load this file
 * with a plain <script> tag and call `FrontDeskRail.mount(el, { current })`.
 *
 * All labels, hrefs, and ports come from the server (`/api/front-desk/nav`,
 * `/api/me`) — this file never hardcodes a surface port or host. See
 * docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / §2.2 / §3 FD-00 / FD-01.
 */
/* global window, document, navigator, fetch */
(function () {
  'use strict';

  var STORAGE_KEY = 'front-desk.tenant';

  // Every injected string goes through this before it reaches innerHTML —
  // including attribute values (href, aria-label, data-*), so quotes and
  // ampersands are escaped too, not only `<`.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeLocale() {
    var raw = String((navigator && navigator.language) || 'en').toLowerCase();
    return raw.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  function renderTemplate(template, params) {
    return String(template || '').replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
    });
  }

  function readStoredTenant() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || null;
    } catch (err) {
      return null;
    }
  }

  function storeTenant(slug) {
    try {
      window.localStorage.setItem(STORAGE_KEY, slug);
    } catch (err) {
      // Best-effort only — the rail still works without persistence.
    }
  }

  var ICON_PATHS = {
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    ask: '<path d="M4 5h16v11H9l-5 4z"/>',
    decide: '<path d="M4 12l5 5L20 6"/>',
    progress: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h0"/>',
  };

  function svgIcon(id) {
    var body = ICON_PATHS[id] || '';
    return (
      '<svg class="fd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  function renderItem(item, current) {
    if (item.allowed === false) return '';
    var isCurrent = current && item.id === current;
    return (
      '<a class="fd-item' +
      (isCurrent ? ' fd-item-current' : '') +
      '" href="' +
      escapeHtml(item.href) +
      '"' +
      (isCurrent ? ' aria-current="page"' : '') +
      '>' +
      svgIcon(item.id) +
      '<span class="fd-item-text">' +
      '<span class="fd-item-label">' +
      escapeHtml(item.label) +
      '</span>' +
      '<span class="fd-item-sublabel">' +
      escapeHtml(item.sublabel) +
      '</span>' +
      '</span>' +
      '</a>'
    );
  }

  function tenantSummaryText(nav, me) {
    var roleLabel = (nav.role_labels && nav.role_labels[me.viewing.role]) || me.viewing.role;
    if (me.can_switch) {
      return renderTemplate(nav.tenant_viewing_summary, {
        role: roleLabel,
        count: me.tenants.length,
      });
    }
    return renderTemplate(nav.tenant_viewing_single, { role: roleLabel });
  }

  function renderTenantBlock(nav, me) {
    if (!me.viewing) return '';
    var summary = tenantSummaryText(nav, me);
    var listItems = me.can_switch
      ? me.tenants
          .map(function (tenant) {
            var selected = tenant.tenant_slug === me.viewing.tenant_slug;
            return (
              '<li role="option" aria-selected="' +
              (selected ? 'true' : 'false') +
              '" data-tenant-slug="' +
              escapeHtml(tenant.tenant_slug) +
              '" class="fd-tenant-option' +
              (selected ? ' fd-tenant-option-selected' : '') +
              '">' +
              escapeHtml(tenant.display_name) +
              '</li>'
            );
          })
          .join('')
      : '';
    return (
      '<div class="fd-tenant">' +
      '<button type="button" class="fd-tenant-button" aria-label="' +
      escapeHtml(nav.tenant_switch_aria) +
      '" aria-haspopup="listbox" aria-expanded="false"' +
      (me.can_switch ? '' : ' disabled') +
      '>' +
      '<span class="fd-tenant-name">' +
      escapeHtml(me.viewing.display_name) +
      '</span>' +
      '<span class="fd-tenant-summary">' +
      escapeHtml(summary) +
      '</span>' +
      '</button>' +
      (me.can_switch
        ? '<ul class="fd-tenant-list hidden" role="listbox">' + listItems + '</ul>'
        : '') +
      '</div>'
    );
  }

  function render(el, nav, me, current) {
    el.setAttribute('aria-label', nav.aria_label || '');
    var itemsHtml = (nav.items || []).map(function (item) {
      return renderItem(item, current);
    });
    el.innerHTML =
      '<div class="fd-brand">' +
      '<span class="fd-brand-mark" aria-hidden="true"></span>' +
      '<span class="fd-brand-text"><strong>Kyberion</strong><small>' +
      escapeHtml(nav.brand_tagline) +
      '</small></span>' +
      '</div>' +
      '<div class="fd-tenant-slot">' +
      renderTenantBlock(nav, me) +
      '</div>' +
      '<nav class="fd-nav">' +
      itemsHtml.join('') +
      '</nav>' +
      (nav.help
        ? '<a class="fd-help" href="' +
          escapeHtml(nav.help.href) +
          '">' +
          svgIcon('help') +
          '<span class="fd-item-label">' +
          escapeHtml(nav.help.label) +
          '</span></a>'
        : '');

    var tenantButton = el.querySelector('.fd-tenant-button');
    var tenantList = el.querySelector('.fd-tenant-list');
    if (tenantButton && tenantList) {
      tenantButton.addEventListener('click', function () {
        var expanded = tenantButton.getAttribute('aria-expanded') === 'true';
        tenantButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        tenantList.classList.toggle('hidden', expanded);
      });
      tenantList.querySelectorAll('.fd-tenant-option').forEach(function (option) {
        option.addEventListener('click', function () {
          var slug = option.getAttribute('data-tenant-slug');
          if (!slug) return;
          storeTenant(slug);
          tenantList.classList.add('hidden');
          tenantButton.setAttribute('aria-expanded', 'false');
          loadMe(el, nav, current, slug);
        });
      });
    }
  }

  function loadMe(el, nav, current, tenantSlug) {
    var url = tenantSlug ? '/api/me?tenant=' + encodeURIComponent(tenantSlug) : '/api/me';
    return fetch(url)
      .then(function (response) {
        return response.json();
      })
      .then(function (me) {
        if (me && me.ok) render(el, nav, me, current);
        return me;
      })
      .catch(function () {
        // A failed refresh must not blank out the previously rendered rail.
      });
  }

  function mount(el, options) {
    if (!el) return;
    var current = (options && options.current) || null;
    var locale = normalizeLocale();
    fetch('/api/front-desk/nav?locale=' + encodeURIComponent(locale))
      .then(function (response) {
        return response.json();
      })
      .then(function (nav) {
        if (!nav || !nav.ok) return;
        var storedTenant = readStoredTenant();
        var meUrl = storedTenant ? '/api/me?tenant=' + encodeURIComponent(storedTenant) : '/api/me';
        return fetch(meUrl)
          .then(function (response) {
            return response.json();
          })
          .then(function (me) {
            if (!me || !me.ok) return;
            render(el, nav, me, current);
          });
      })
      .catch(function () {
        // The rail is additive chrome — a fetch failure must never block the
        // rest of the page (voice panel, onboarding wizard, etc.) from
        // working.
      });
  }

  window.FrontDeskRail = { mount: mount };
})();
