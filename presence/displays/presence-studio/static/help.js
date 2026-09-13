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
 * HT-06: the training block's fixed UI chrome (back link, "try it",
 * "done:" prefix, level/status names) comes from `GET /api/help-vocabulary`
 * (`front_desk:*` keys, see `HELP_VOCABULARY_KEYS` in `front-desk-pages.ts`)
 * — only the track/lesson content itself (title, goal, check text) is
 * free-form catalog data from `GET /api/training/catalog`.
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * FD-08 and FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md §2.3/§2.4.
 */
/* global window, document, navigator, fetch */
(function () {
  'use strict';

  // `/api/help-vocabulary`'s `texts` object is keyed by the fully-qualified
  // `namespace:key` form (same as `/api/ask-vocabulary`).
  function vt(vocab, key) {
    return (vocab && vocab[key]) || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var TRAINING_LEVEL_KEY = {
    beginner: 'front_desk:training_level_beginner',
    intermediate: 'front_desk:training_level_intermediate',
    advanced: 'front_desk:training_level_advanced',
  };

  var TRAINING_STATUS_KEY = {
    not_started: 'front_desk:training_status_not_started',
    in_progress: 'front_desk:training_status_in_progress',
    complete: 'front_desk:training_status_complete',
  };

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
    var vocab = {};
    Promise.all([
      fetch('/api/front-desk/nav?locale=' + encodeURIComponent(locale)).then(function (response) {
        return response.json();
      }),
      fetch('/api/help-vocabulary?locale=' + encodeURIComponent(locale)).then(function (response) {
        return response.json();
      }),
    ])
      .then(function (pair) {
        var nav = pair[0];
        var vocabResult = pair[1];
        if (vocabResult && vocabResult.ok) vocab = vocabResult.texts || {};
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
        if (!payload || !payload.ok || !payload.catalog) return null;
        // Best-effort — an anonymous or remote-token viewer has no
        // server-resolved member, so this legitimately 404s; the lesson
        // list still renders without a status badge in that case.
        return fetch('/api/training/progress', { cache: 'no-store' })
          .then(function (response) {
            return response.ok ? response.json() : null;
          })
          .catch(function () {
            return null;
          })
          .then(function (progressResult) {
            return { payload: payload, progress: progressResult && progressResult.progress };
          });
      })
      .then(function (combined) {
        if (!combined || !combined.payload) return;
        var payload = combined.payload;
        var lessonStatus = (combined.progress && combined.progress.lessons) || {};
        var content = document.getElementById('training-content');
        if (!content) return;
        var parts = window.location.pathname.split('/').filter(Boolean);
        var track = payload.catalog.tracks.filter(function (item) {
          return item.id === parts[1];
        })[0];
        if (!track) {
          content.innerHTML =
            '<h2 class="help-training-title">' +
            escapeHtml(vt(vocab, 'front_desk:training_choose_track')) +
            '</h2>' +
            payload.catalog.tracks
              .map(function (item) {
                return (
                  '<a class="help-card help-track-card" href="/help/' +
                  encodeURIComponent(item.id) +
                  '"><h2>' +
                  escapeHtml(item.title) +
                  '</h2><p>' +
                  escapeHtml(item.audience) +
                  ' · ' +
                  escapeHtml(vt(vocab, TRAINING_LEVEL_KEY[item.level] || '')) +
                  '</p><span class="help-card-link">' +
                  escapeHtml(vt(vocab, 'front_desk:training_open')) +
                  '</span></a>'
                );
              })
              .join('');
          return;
        }
        content.innerHTML =
          '<a class="help-back" href="/help">' +
          escapeHtml(vt(vocab, 'front_desk:training_back')) +
          '</a>' +
          '<h2 class="help-track-title">' +
          escapeHtml(track.title) +
          '</h2><p class="help-track-audience">' +
          escapeHtml(track.audience) +
          ' · ' +
          escapeHtml(vt(vocab, TRAINING_LEVEL_KEY[track.level] || '')) +
          '</p>' +
          track.lessons
            .map(function (lesson) {
              var href =
                lesson.try.kind === 'ask'
                  ? '/ask?prefill=' + encodeURIComponent(lesson.try.prefill || '')
                  : lesson.try.kind === 'decide' || lesson.try.kind === 'progress'
                    ? '/progress'
                    : '/settings';
              var status = (lessonStatus[lesson.id] || {}).status || 'not_started';
              var statusKey = TRAINING_STATUS_KEY[status] || TRAINING_STATUS_KEY.not_started;
              return (
                '<article class="help-lesson"><h3>' +
                escapeHtml(lesson.title) +
                ' <span class="status-chip">' +
                escapeHtml(vt(vocab, statusKey)) +
                '</span></h3><p>' +
                escapeHtml(lesson.goal) +
                '</p><a class="help-card-link" href="' +
                escapeHtml(href) +
                '">' +
                escapeHtml(vt(vocab, 'front_desk:training_try')) +
                '</a>' +
                '<p class="help-check">' +
                escapeHtml(vt(vocab, 'front_desk:training_done_prefix')) +
                ' ' +
                escapeHtml(lesson.check.text) +
                '</p></article>'
              );
            })
            .join('');
      })
      .catch(function () {
        // The static fallback already in help.html stays visible.
      });
  }

  window.KyberionHelp = { mount: mount };
})();
