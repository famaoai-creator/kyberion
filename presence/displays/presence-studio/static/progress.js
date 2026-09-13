/*
 * progress.js — FD-05: the presence-studio progress page ("進み具合").
 *
 * Plain browser script (no modules, no external resources) loaded by
 * `progress.html` with a plain <script> tag, mirroring `home.js`.
 * All copy comes from the server (`/api/progress-vocabulary`,
 * `/api/front-desk/nav`) and the progress read model (`/api/progress`,
 * `/api/progress/:id`) — this file never hardcodes a surface port or host,
 * and never invents data the server did not send.
 *
 * INTERIM (FD-03): "ひとこと伝える" (progress_action_note) hands off to
 * `/work?ask=...#conversation-panel` (the pre-FD-03 workbench) because there
 * is no endpoint on this surface that accepts a note/message for an existing
 * task session yet. Replace this once FD-03 or a task-session note endpoint
 * ships. "止める" (stop) is intentionally never rendered — this surface has
 * no task-session cancel endpoint (see FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * FD-05 task notes).
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-05.
 */
/* global window, document, navigator, fetch */
(function () {
  'use strict';

  // `/api/progress-vocabulary`'s `texts` object is keyed by the fully
  // qualified `namespace:key` form (same as `/api/home-vocabulary`).
  function vt(vocab, key) {
    return (vocab && vocab['front_desk:' + key]) || '';
  }

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
      return Object.prototype.hasOwnProperty.call(params || {}, key) ? String(params[key]) : match;
    });
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  }

  var ICON_PATHS = {
    chevron: '<path d="M9 6l6 6-6 6"/>',
    box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  };

  function svgIcon(id, extraClass) {
    var body = ICON_PATHS[id] || '';
    var cls = 'progress-icon' + (extraClass ? ' ' + extraClass : '');
    return (
      '<svg class="' +
      cls +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  var FILTERS = ['active', 'delivered', 'done'];

  var state = {
    vocab: {},
    payload: { counts: {}, active: [], delivered: [], done: [], mirror_href: '' },
    filter: 'active',
    selectedId: null,
    selectedTitle: '',
  };

  function itemsForFilter(filter) {
    return state.payload[filter] || [];
  }

  function findSection(id) {
    if (!id) return null;
    for (var i = 0; i < FILTERS.length; i += 1) {
      var items = itemsForFilter(FILTERS[i]);
      for (var j = 0; j < items.length; j += 1) {
        if (items[j].id === id) return { filter: FILTERS[i], item: items[j] };
      }
    }
    return null;
  }

  function readHashId() {
    var raw = String(window.location.hash || '').replace(/^#/, '');
    return raw ? decodeURIComponent(raw) : null;
  }

  function writeHashId(id) {
    if (id) {
      window.history.replaceState(null, '', '#' + encodeURIComponent(id));
    } else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  function renderFilters() {
    var vocab = state.vocab;
    var counts = state.payload.counts || {};
    var buttons = {
      active: document.getElementById('filter-active'),
      delivered: document.getElementById('filter-delivered'),
      done: document.getElementById('filter-done'),
    };
    if (buttons.active) {
      buttons.active.textContent = renderTemplate(vt(vocab, 'progress_filter_active'), {
        count: counts.active || 0,
      });
    }
    if (buttons.delivered) {
      buttons.delivered.textContent = renderTemplate(vt(vocab, 'progress_filter_delivered'), {
        count: counts.delivered || 0,
      });
    }
    if (buttons.done) {
      buttons.done.textContent = vt(vocab, 'progress_filter_done');
    }
    FILTERS.forEach(function (name) {
      var button = buttons[name];
      if (!button) return;
      var selected = state.filter === name;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function selectItem(id, title) {
    state.selectedId = id;
    state.selectedTitle = title || '';
    writeHashId(id);
    renderList();
    loadDetail();
  }

  function renderActiveRow(item) {
    var selected = item.id === state.selectedId;
    var bar =
      typeof item.percent === 'number'
        ? '<div class="progress-row-progress"><div class="progress-row-progress-fill" style="width:' +
          Math.max(0, Math.min(100, item.percent)) +
          '%"></div></div>'
        : '';
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'progress-row' + (selected ? ' progress-row-selected' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.innerHTML =
      '<div class="progress-row-main">' +
      '<span class="progress-row-title">' +
      escapeHtml(item.title) +
      '</span>' +
      svgIcon('chevron', 'progress-row-chevron') +
      '</div>' +
      '<p class="progress-row-now">' +
      escapeHtml(item.now) +
      '</p>' +
      bar;
    row.addEventListener('click', function () {
      selectItem(item.id, item.title);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectItem(item.id, item.title);
      }
    });
    li.appendChild(row);
    return li;
  }

  function postVerdict(entryId, status, note) {
    return fetchJson('/api/outcomes/' + encodeURIComponent(entryId) + '/verdict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { status: status, note: note } : { status: status }),
    });
  }

  function renderDeliveredRow(item, vocab) {
    var selected = item.id === state.selectedId;
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'progress-row' + (selected ? ' progress-row-selected' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    var actionsHtml = '';
    if (item.downloadable) {
      actionsHtml +=
        '<a class="progress-row-action" data-action="open" href="/api/artifacts/' +
        encodeURIComponent(item.id) +
        '">' +
        escapeHtml(vt(vocab, 'action_open')) +
        '</a>';
    }
    if (item.can_verdict) {
      actionsHtml +=
        '<button type="button" class="progress-row-action" data-action="receive">' +
        escapeHtml(vt(vocab, 'action_receive')) +
        '</button>' +
        '<button type="button" class="progress-row-action" data-action="revise">' +
        escapeHtml(vt(vocab, 'action_revise')) +
        '</button>';
    }

    row.innerHTML =
      '<div class="progress-row-main">' +
      svgIcon('box') +
      '<span class="progress-row-title">' +
      escapeHtml(item.title) +
      '</span>' +
      svgIcon('chevron', 'progress-row-chevron') +
      '</div>' +
      (actionsHtml ? '<div class="progress-row-actions">' + actionsHtml + '</div>' : '');

    row.addEventListener('click', function (event) {
      if (event.target.closest('[data-action]') || event.target.closest('.progress-revise-form')) {
        return;
      }
      selectItem(item.id, item.title);
    });
    row.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('[data-action]')) {
        event.preventDefault();
        selectItem(item.id, item.title);
      }
    });

    var openLink = row.querySelector('[data-action="open"]');
    if (openLink) {
      openLink.addEventListener('click', function (event) {
        event.stopPropagation();
      });
    }
    var receiveButton = row.querySelector('[data-action="receive"]');
    if (receiveButton && item.entry_id) {
      receiveButton.addEventListener('click', function (event) {
        event.stopPropagation();
        receiveButton.disabled = true;
        postVerdict(item.entry_id, 'accepted').then(function () {
          reload();
        });
      });
    }
    var reviseButton = row.querySelector('[data-action="revise"]');
    if (reviseButton && item.entry_id) {
      reviseButton.addEventListener('click', function (event) {
        event.stopPropagation();
        if (row.querySelector('.progress-revise-form')) return;
        var form = document.createElement('div');
        form.className = 'progress-revise-form';
        var textarea = document.createElement('textarea');
        textarea.className = 'progress-revise-note';
        var submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'progress-row-action';
        submit.textContent = escapeHtml(vt(vocab, 'action_revise'));
        submit.addEventListener('click', function (innerEvent) {
          innerEvent.stopPropagation();
          submit.disabled = true;
          var note = textarea.value.trim() || undefined;
          postVerdict(item.entry_id, 'rejected', note).then(function () {
            reload();
          });
        });
        form.appendChild(textarea);
        form.appendChild(submit);
        row.appendChild(form);
      });
    }

    li.appendChild(row);
    return li;
  }

  function renderDoneRow(item) {
    var selected = item.id === state.selectedId;
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'progress-row' + (selected ? ' progress-row-selected' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    var actionsHtml =
      item.kind === 'artifact' && item.downloadable
        ? '<div class="progress-row-actions"><a class="progress-row-action" href="/api/artifacts/' +
          encodeURIComponent(item.id) +
          '">' +
          escapeHtml(vt(state.vocab, 'action_open')) +
          '</a></div>'
        : '';
    row.innerHTML =
      '<div class="progress-row-main">' +
      svgIcon('box') +
      '<span class="progress-row-title">' +
      escapeHtml(item.title) +
      '</span>' +
      svgIcon('chevron', 'progress-row-chevron') +
      '</div>' +
      actionsHtml;
    row.addEventListener('click', function (event) {
      if (event.target.closest('[href]')) return;
      selectItem(item.id, item.title);
    });
    li.appendChild(row);
    return li;
  }

  function renderList() {
    var vocab = state.vocab;
    var listEl = document.getElementById('progress-list');
    var emptyEl = document.getElementById('progress-empty');
    var headerEl = document.getElementById('delivered-header');
    if (!listEl || !emptyEl) return;

    if (headerEl) {
      if (state.filter === 'delivered') {
        headerEl.classList.remove('hidden');
        var titleEl = document.getElementById('delivered-title');
        var waitingEl = document.getElementById('delivered-waiting');
        if (titleEl) titleEl.textContent = vt(vocab, 'progress_delivered_title');
        if (waitingEl) {
          waitingEl.textContent = renderTemplate(vt(vocab, 'progress_delivered_waiting'), {
            count: state.payload.counts.delivered || 0,
          });
        }
      } else {
        headerEl.classList.add('hidden');
      }
    }

    var items = itemsForFilter(state.filter);
    listEl.innerHTML = '';
    if (!items.length) {
      var emptyKey =
        state.filter === 'active'
          ? 'progress_empty_active'
          : state.filter === 'delivered'
            ? 'progress_empty_delivered'
            : '';
      if (emptyKey) {
        emptyEl.textContent = vt(vocab, emptyKey);
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
      }
      return;
    }
    emptyEl.classList.add('hidden');
    items.forEach(function (item) {
      var node =
        state.filter === 'active'
          ? renderActiveRow(item)
          : state.filter === 'delivered'
            ? renderDeliveredRow(item, vocab)
            : renderDoneRow(item);
      listEl.appendChild(node);
    });
  }

  function renderDetailHint() {
    var vocab = state.vocab;
    var detailEl = document.getElementById('progress-detail');
    if (!detailEl) return;
    detailEl.innerHTML =
      '<p class="progress-select-hint">' + escapeHtml(vt(vocab, 'progress_select_hint')) + '</p>';
  }

  function askHref(title) {
    var text = title ? title + ' について' : '';
    return '/work?ask=' + encodeURIComponent(text) + '#conversation-panel';
  }

  function renderDetail(detail) {
    var vocab = state.vocab;
    var detailEl = document.getElementById('progress-detail');
    if (!detailEl) return;

    var blocks = '';
    blocks +=
      '<div class="progress-detail-block">' +
      '<p class="progress-detail-label">' +
      escapeHtml(vt(vocab, 'progress_detail_requested')) +
      '</p>' +
      '<p class="progress-detail-text">' +
      escapeHtml(detail.requested) +
      '</p>' +
      '</div>';
    blocks +=
      '<div class="progress-detail-block">' +
      '<p class="progress-detail-label">' +
      escapeHtml(vt(vocab, 'progress_detail_now')) +
      '</p>' +
      '<p class="progress-detail-text">' +
      escapeHtml(detail.now) +
      '</p>' +
      '</div>';
    if (Array.isArray(detail.next) && detail.next.length) {
      blocks +=
        '<div class="progress-detail-block">' +
        '<p class="progress-detail-label">' +
        escapeHtml(vt(vocab, 'progress_detail_next')) +
        '</p>' +
        '<ul class="progress-detail-next">' +
        detail.next
          .map(function (step) {
            return '<li>' + escapeHtml(step) + '</li>';
          })
          .join('') +
        '</ul>' +
        '</div>';
    }
    if (Array.isArray(detail.log) && detail.log.length) {
      blocks +=
        '<div class="progress-detail-block">' +
        '<p class="progress-detail-label">' +
        escapeHtml(vt(vocab, 'progress_detail_log')) +
        '</p>' +
        '<ul class="progress-log">' +
        detail.log
          .map(function (entry) {
            return (
              '<li><div class="progress-log-entry">' +
              (entry.when
                ? '<span class="progress-log-when">' + escapeHtml(entry.when) + '</span>'
                : '') +
              escapeHtml(entry.text) +
              '</div></li>'
            );
          })
          .join('') +
        '</ul>' +
        '</div>';
    }

    blocks +=
      '<div class="progress-detail-actions">' +
      '<a class="progress-detail-action" href="' +
      escapeHtml(askHref(state.selectedTitle)) +
      '">' +
      escapeHtml(vt(vocab, 'progress_action_note')) +
      '</a>' +
      '<a class="progress-detail-action" href="' +
      escapeHtml(state.payload.mirror_href || '') +
      '">' +
      escapeHtml(vt(vocab, 'progress_open_mirror')) +
      '</a>' +
      '</div>';

    detailEl.innerHTML = blocks;
  }

  function loadDetail() {
    if (!state.selectedId) {
      renderDetailHint();
      return;
    }
    fetchJson('/api/progress/' + encodeURIComponent(state.selectedId))
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.ok) {
          state.selectedId = null;
          writeHashId(null);
          renderDetailHint();
          return;
        }
        renderDetail(result.body.item);
      })
      .catch(function () {
        renderDetailHint();
      });
  }

  function applyHashOrDefault() {
    var hashId = readHashId();
    if (hashId) {
      var found = findSection(hashId);
      if (found) {
        state.filter = found.filter;
        state.selectedId = found.item.id;
        state.selectedTitle = found.item.title;
        return;
      }
    }
    var defaultActive = (state.payload.active || []).find(function (item) {
      return item.selected_default;
    });
    if (defaultActive) {
      state.filter = 'active';
      state.selectedId = defaultActive.id;
      state.selectedTitle = defaultActive.title;
      writeHashId(defaultActive.id);
    }
  }

  function wireFilters() {
    FILTERS.forEach(function (name) {
      var button = document.getElementById('filter-' + name);
      if (!button) return;
      button.addEventListener('click', function () {
        state.filter = name;
        renderFilters();
        renderList();
      });
    });
  }

  function reload() {
    return fetchJson('/api/progress').then(function (result) {
      if (result.ok && result.body && result.body.ok) {
        state.payload = result.body;
        if (state.selectedId && !findSection(state.selectedId)) {
          state.selectedId = null;
          writeHashId(null);
        }
        renderFilters();
        renderList();
        loadDetail();
      }
    });
  }

  function mount() {
    var locale = normalizeLocale();
    wireFilters();
    Promise.all([
      fetchJson('/api/progress-vocabulary?locale=' + encodeURIComponent(locale)),
      fetchJson('/api/progress'),
    ])
      .then(function (pair) {
        var vocabResult = pair[0];
        var progressResult = pair[1];
        if (!vocabResult.ok || !vocabResult.body || !vocabResult.body.ok) return;
        if (!progressResult.ok || !progressResult.body || !progressResult.body.ok) return;
        state.vocab = vocabResult.body.texts || {};
        state.payload = progressResult.body;
        applyHashOrDefault();
        renderFilters();
        renderList();
        loadDetail();
      })
      .catch(function () {
        // The progress page is additive chrome around the rail — a fetch
        // failure must never throw and break the rest of the page.
      });
  }

  window.KyberionProgress = { mount: mount };
})();
