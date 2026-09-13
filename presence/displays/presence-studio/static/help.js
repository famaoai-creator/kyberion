/*
 * help.js — FD-08: the "使い方を見る" page (旧 /learn, superseded by this
 * single page under the shared front-desk rail).
 *
 * Plain browser script (no modules, no external resources) loaded by
 * `help.html` with a plain <script> tag, mirroring `front-desk-rail.js`.
 * Every label, sentence, and href comes from `GET /api/front-desk/nav`
 * (the same single source the rail itself reads) — this file never
 * hardcodes a surface port or host, and never invents copy the catalog
 * did not provide.
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * FD-08.
 */
/* global window, document, navigator, fetch */
(function () {
  'use strict';

  function normalizeLocale() {
    var raw = String((navigator && navigator.language) || 'en').toLowerCase();
    return raw.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  function fillSection(item) {
    if (!item) return;
    var titleEl = document.getElementById('help-' + item.id + '-title');
    var subEl = document.getElementById('help-' + item.id + '-sub');
    var linkEl = document.getElementById('help-' + item.id + '-link');
    if (titleEl) titleEl.textContent = item.label || '';
    if (subEl) subEl.textContent = item.sublabel || '';
    if (linkEl) {
      linkEl.href = item.href || '#';
      linkEl.textContent = item.label || '';
    }
  }

  function mount() {
    var titleEl = document.getElementById('help-title');
    var locale = normalizeLocale();
    fetch('/api/front-desk/nav?locale=' + encodeURIComponent(locale))
      .then(function (response) {
        return response.json();
      })
      .then(function (nav) {
        if (!nav || !nav.ok) return;
        if (titleEl && nav.help && nav.help.label) titleEl.textContent = nav.help.label;
        var byId = {};
        (nav.items || []).forEach(function (item) {
          byId[item.id] = item;
        });
        fillSection(byId.ask);
        fillSection(byId.decide);
        fillSection(byId.progress);
      })
      .catch(function () {
        // The static Japanese fallback already in help.html stays visible.
      });
  }

  window.KyberionHelp = { mount: mount };
})();
