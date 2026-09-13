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
        return fetch('/api/training/catalog', { cache: 'no-store' });
      })
      .then(function (response) {
        return response && response.json();
      })
      .then(function (payload) {
        if (!payload || !payload.ok || !payload.catalog) return;
        var content = document.getElementById('training-content');
        if (!content) return;
        var parts = window.location.pathname.split('/').filter(Boolean);
        var track = payload.catalog.tracks.filter(function (item) {
          return item.id === parts[1];
        })[0];
        if (!track) {
          content.innerHTML =
            '<h2 class="help-training-title">トラックから選ぶ</h2>' +
            payload.catalog.tracks
              .map(function (item) {
                return (
                  '<a class="help-card help-track-card" href="/help/' +
                  encodeURIComponent(item.id) +
                  '"><h2>' +
                  escapeHtml(item.title) +
                  '</h2><p>' +
                  escapeHtml(item.audience) +
                  '</p><span class="help-card-link">開く</span></a>'
                );
              })
              .join('');
          return;
        }
        content.innerHTML =
          '<a class="help-back" href="/help">使い方の一覧に戻る</a>' +
          '<h2 class="help-track-title">' +
          escapeHtml(track.title) +
          '</h2><p class="help-track-audience">' +
          escapeHtml(track.audience) +
          '</p>' +
          track.lessons
            .map(function (lesson) {
              var href =
                lesson.try.kind === 'ask'
                  ? '/ask?prefill=' + encodeURIComponent(lesson.try.prefill || '')
                  : lesson.try.kind === 'decide' || lesson.try.kind === 'progress'
                    ? '/progress'
                    : '/settings';
              return (
                '<article class="help-lesson"><h3>' +
                escapeHtml(lesson.title) +
                '</h3><p>' +
                escapeHtml(lesson.goal) +
                '</p><a class="help-card-link" href="' +
                escapeHtml(href) +
                '">やってみる</a>' +
                '<p class="help-check">できたこと: ' +
                escapeHtml(lesson.check.text) +
                '</p></article>'
              );
            })
            .join('');
      })
      .catch(function () {
        // The static Japanese fallback already in help.html stays visible.
      });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.KyberionHelp = { mount: mount };
})();
