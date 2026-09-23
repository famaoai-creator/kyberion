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
 * HT-04/05 second pass: a lesson that is not yet `complete` renders a "mark
 * this done" button that POSTs `/api/training/progress`
 * `{ lesson_id, status: 'complete' }` for the server-resolved viewer, then
 * updates that lesson's status chip in place. `HELP_VOCABULARY_KEYS` is
 * frozen for this wave, so the button/notice copy comes from its own
 * `GET /api/training/vocabulary` instead (same shape as
 * `/api/help-vocabulary`, merged into the same `vocab` lookup table).
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

  // UI-06: the viewer's stored language choice (`front-desk-prefs.js`),
  // falling back to the language the page was served in.
  function normalizeLocale() {
    if (window.KyberionPrefs) return window.KyberionPrefs.locale();
    return document.documentElement.getAttribute('lang') === 'ja' ? 'ja' : 'en';
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
      fetch('/api/training/vocabulary?locale=' + encodeURIComponent(locale)).then(
        function (response) {
          return response.json();
        }
      ),
    ])
      .then(function (triplet) {
        var nav = triplet[0];
        var vocabResult = triplet[1];
        var trainingVocabResult = triplet[2];
        if (vocabResult && vocabResult.ok) vocab = vocabResult.texts || {};
        if (trainingVocabResult && trainingVocabResult.ok) {
          Object.keys(trainingVocabResult.texts || {}).forEach(function (key) {
            vocab[key] = trainingVocabResult.texts[key];
          });
        }
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
                '<article class="help-lesson" data-lesson-id="' +
                escapeHtml(lesson.id) +
                '"><h3>' +
                escapeHtml(lesson.title) +
                ' <span class="kb-badge status-chip" data-role="status-chip">' +
                escapeHtml(vt(vocab, statusKey)) +
                '</span></h3><p>' +
                escapeHtml(lesson.goal) +
                '</p><div class="help-lesson-actions"><a class="kb-btn kb-btn--primary" href="' +
                escapeHtml(href) +
                '">' +
                escapeHtml(vt(vocab, 'front_desk:training_try')) +
                '</a>' +
                (status === 'complete'
                  ? ''
                  : ' <button type="button" class="kb-btn kb-btn--secondary help-mark-done" data-lesson-id="' +
                    escapeHtml(lesson.id) +
                    '">' +
                    escapeHtml(vt(vocab, 'front_desk:training_mark_done')) +
                    '</button>') +
                '</div><p class="help-check">' +
                escapeHtml(vt(vocab, 'front_desk:training_done_prefix')) +
                ' ' +
                escapeHtml(lesson.check.text) +
                '</p><p class="help-mark-done-message" data-role="mark-done-message" hidden></p></article>'
              );
            })
            .join('');
        wireMarkDoneButtons(content, vocab);
      })
      .catch(function () {
        // The static fallback already in help.html stays visible.
      });
  }

  // HT-04/05 second pass: marks one lesson `complete` for the
  // server-resolved viewer, then updates that lesson's status chip and
  // shows a recorded/failed notice in place — never a page reload.
  function wireMarkDoneButtons(content, vocab) {
    var buttons = content.querySelectorAll('.help-mark-done');
    for (var i = 0; i < buttons.length; i += 1) {
      (function (button) {
        button.addEventListener('click', function () {
          var article = button.closest('.help-lesson');
          var lessonId = button.getAttribute('data-lesson-id');
          var chip = article && article.querySelector('[data-role="status-chip"]');
          var message = article && article.querySelector('[data-role="mark-done-message"]');
          button.disabled = true;
          fetch('/api/training/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lesson_id: lessonId, status: 'complete' }),
          })
            .then(function (response) {
              return response
                .json()
                .catch(function () {
                  return null;
                })
                .then(function (payload) {
                  return response.ok && payload && payload.ok;
                });
            })
            .then(function (recorded) {
              if (recorded) {
                if (chip) chip.textContent = vt(vocab, TRAINING_STATUS_KEY.complete);
                if (message) {
                  message.textContent = vt(vocab, 'front_desk:training_mark_done_recorded');
                  message.hidden = false;
                }
                button.remove();
                return;
              }
              button.disabled = false;
              if (message) {
                message.textContent = vt(vocab, 'front_desk:training_mark_done_failed');
                message.hidden = false;
              }
            })
            .catch(function () {
              button.disabled = false;
              if (message) {
                message.textContent = vt(vocab, 'front_desk:training_mark_done_failed');
                message.hidden = false;
              }
            });
        });
      })(buttons[i]);
    }
  }

  window.KyberionHelp = { mount: mount };
})();
