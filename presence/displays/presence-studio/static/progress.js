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
 * `/ask?ask=...` (the request composer) because there
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
    return (vocab && vocab[key.indexOf(':') >= 0 ? key : 'front_desk:' + key]) || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // UI-06: the viewer's stored language choice (`front-desk-prefs.js`),
  // falling back to the language the page was served in.
  function normalizeLocale() {
    if (window.KyberionPrefs) return window.KyberionPrefs.locale();
    return document.documentElement.getAttribute('lang') === 'ja' ? 'ja' : 'en';
  }

  function renderTemplate(template, params) {
    return String(template || '').replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(params || {}, key) ? String(params[key]) : match;
    });
  }

  function scopedUrl(path) {
    return window.KyberionPrefs && window.KyberionPrefs.scopedUrl
      ? window.KyberionPrefs.scopedUrl(path)
      : path;
  }

  function fetchJson(url, options) {
    return fetch(scopedUrl(url), options).then(function (response) {
      return response.json().then(
        function (body) {
          return { ok: response.ok, status: response.status, body: body };
        },
        function () {
          // Gateways can deny with HTML or no body. Keep status authoritative.
          return { ok: response.ok, status: response.status, body: null };
        }
      );
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

  // UI-06: each row carries a kyberion-base status pill (icon + text, never
  // color alone). The label is this page's own plain wording.
  var ROW_STATUS = {
    active: { status: 'active', labelKey: 'tag_in_progress' },
    delivered: { status: 'pending', labelKey: 'tag_delivered' },
    done: { status: 'idle', labelKey: 'progress_history' },
  };

  var OUTCOME_STATUS = {
    completed: { status: 'completed', labelKey: 'ui:status_completed' },
    failed: { status: 'failed', labelKey: 'ui:status_failed' },
    released: { status: 'idle', labelKey: 'progress_status_released' },
    accepted: { status: 'completed', labelKey: 'concierge:home.status.accepted' },
    rejected: { status: 'failed', labelKey: 'concierge:home.status.rejected' },
    changes_requested: { status: 'pending', labelKey: 'concierge:home.status.changes_requested' },
  };

  function needsRecovery(item) {
    return ['failed', 'released', 'rejected', 'changes_requested'].indexOf(item.status) >= 0;
  }

  function statusPillHtml(filter, item) {
    var def = (item && OUTCOME_STATUS[item.status]) || ROW_STATUS[filter];
    if (!def) return '';
    return (
      '<span class="kb-status-pill" data-status="' +
      def.status +
      '"><span class="kb-status-pill__icon" aria-hidden="true"></span>' +
      '<span class="kb-status-pill__label">' +
      escapeHtml(vt(state.vocab, def.labelKey)) +
      '</span></span>'
    );
  }

  var state = {
    vocab: {},
    vocabularyReady: false,
    loaded: false,
    navigationPending: false,
    noticeKey: null,
    payload: { counts: {}, active: [], delivered: [], done: [], mirror_href: '' },
    filter: 'active',
    selectedId: null,
    selectedTitle: '',
    detailSequence: 0,
    loadSequence: 0,
    verdictGeneration: 1,
    verdictStorageKey: null,
    verdictStorageVerified: false,
    pendingVerdicts: Object.create(null),
    uncertainVerdicts: Object.create(null),
  };

  // WI-11: the "業務の自動化候補" panel's own vocab + read model, fetched and
  // rendered independently of the active/delivered/done columns above — a
  // failure here never blocks the rest of the page (see `loadWorkInventoryPanel`).
  var wi = {
    vocab: {},
    payload: { scope: null, candidates: [], counts: {} },
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
    try {
      return raw ? decodeURIComponent(raw) : null;
    } catch (err) {
      return null;
    }
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
      buttons.done.textContent = vt(vocab, 'progress_history');
    }
    FILTERS.forEach(function (name) {
      var button = buttons[name];
      if (!button) return;
      var selected = state.filter === name;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function selectItem(id, title) {
    if (!state.loaded || !findSection(id)) return;
    state.selectedId = id;
    state.selectedTitle = title || '';
    if (isSelectionNotice()) showNotice(null);
    writeHashId(id);
    renderList();
    loadDetail();
  }

  function renderActiveRow(item) {
    var selected = item.id === state.selectedId;
    var bar =
      item.progress_basis === 'phase_estimate' &&
      typeof item.percent === 'number' &&
      isFinite(item.percent)
        ? '<p class="progress-row-now">' +
          escapeHtml(vt(state.vocab, 'progress_phase_estimate')) +
          '</p><div class="progress-row-progress" aria-label="' +
          escapeHtml(vt(state.vocab, 'progress_phase_estimate')) +
          '"><div class="progress-row-progress-fill" style="width:' +
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
      statusPillHtml('active', item) +
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
      body: JSON.stringify({
        status: status,
        viewer_scope_id: state.payload.viewer_scope_id,
        ...(note ? { note: note } : {}),
      }),
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
        '<a class="kb-btn kb-btn--secondary progress-row-action" data-action="open" href="' +
        escapeHtml(scopedUrl('/api/artifacts/' + encodeURIComponent(item.id))) +
        '">' +
        escapeHtml(vt(vocab, 'action_open')) +
        '</a>';
    }
    if (item.can_verdict && item.entry_id) {
      actionsHtml +=
        '<button type="button" class="kb-btn kb-btn--primary progress-row-action" data-action="receive">' +
        escapeHtml(vt(vocab, 'action_receive')) +
        '</button>' +
        '<button type="button" class="kb-btn kb-btn--secondary progress-row-action" data-action="revise">' +
        escapeHtml(vt(vocab, 'action_revise')) +
        '</button>';
    }

    row.innerHTML =
      '<div class="progress-row-main">' +
      svgIcon('box') +
      '<span class="progress-row-title">' +
      escapeHtml(item.title) +
      '</span>' +
      statusPillHtml('delivered', item) +
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
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        !event.target.closest('[data-action]') &&
        !event.target.closest('.progress-revise-form')
      ) {
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
    row.querySelectorAll('button').forEach(function (button) {
      button.disabled =
        !state.verdictStorageKey ||
        !state.verdictStorageVerified ||
        Boolean(state.pendingVerdicts[item.entry_id] || state.uncertainVerdicts[item.entry_id]);
    });
    var receiveButton = row.querySelector('[data-action="receive"]');
    if (receiveButton && item.entry_id) {
      receiveButton.addEventListener('click', function (event) {
        event.stopPropagation();
        submitVerdict(item, 'accepted', undefined, row);
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
        textarea.className = 'kb-input kb-textarea progress-revise-note';
        var submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'kb-btn kb-btn--primary progress-row-action';
        submit.textContent = vt(vocab, 'action_revise');
        textarea.setAttribute('aria-label', vt(vocab, 'action_revise'));
        submit.addEventListener('click', function (innerEvent) {
          innerEvent.stopPropagation();
          var note = textarea.value.trim() || undefined;
          submitVerdict(item, 'rejected', note, row);
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
        ? '<div class="progress-row-actions"><a class="kb-btn kb-btn--secondary progress-row-action" href="' +
          escapeHtml(scopedUrl('/api/artifacts/' + encodeURIComponent(item.id))) +
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
      statusPillHtml('done', item) +
      svgIcon('chevron', 'progress-row-chevron') +
      '</div>' +
      actionsHtml +
      (needsRecovery(item)
        ? '<a class="kb-btn kb-btn--secondary progress-row-action" href="' +
          escapeHtml(askHref(item.title)) +
          '">' +
          escapeHtml(vt(state.vocab, 'progress_recovery')) +
          '</a>'
        : '');
    row.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('[href]')) {
        event.preventDefault();
        selectItem(item.id, item.title);
      }
    });
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
    // "About <title>" / "<title> について" — word order is the vocabulary's.
    var text = title
      ? renderTemplate(vt(state.vocab, 'progress_ask_about') || '{title}', { title: title })
      : '';
    return scopedUrl('/ask?ask=' + encodeURIComponent(text));
  }

  function renderDetail(detail) {
    var vocab = state.vocab;
    var detailEl = document.getElementById('progress-detail');
    if (!detailEl) return;

    var found = findSection(state.selectedId);
    var blocks = found ? statusPillHtml(found.filter, found.item) : '';
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
      '<a class="kb-btn kb-btn--secondary progress-detail-action" href="' +
      escapeHtml(askHref(state.selectedTitle)) +
      '">' +
      escapeHtml(
        vt(vocab, found && needsRecovery(found.item) ? 'progress_recovery' : 'progress_action_note')
      ) +
      '</a>' +
      '<a class="kb-btn kb-btn--secondary progress-detail-action" href="' +
      escapeHtml(scopedUrl(state.payload.mirror_href || '/progress')) +
      '">' +
      escapeHtml(vt(vocab, 'progress_open_mirror')) +
      '</a>' +
      '</div>';

    detailEl.innerHTML = blocks;
  }

  function showNotice(key) {
    state.noticeKey = key;
    if (key === 'progress_load_failed' && !state.loaded) {
      var list = document.getElementById('progress-list');
      if (list) list.innerHTML = '';
    }
    var notice = document.getElementById('progress-notice');
    if (!notice) return;
    notice.hidden = !key;
    if (!key) return;
    var text = notice.querySelector('[data-notice-text]');
    if (text) text.textContent = vt(state.vocab, key) || notice.getAttribute('data-' + key) || '';
    var button = notice.querySelector('button');
    if (button) button.textContent = vt(state.vocab, 'progress_refresh') || button.textContent;
  }

  function restoreVerdictLocks(viewerScopeId, readGeneration) {
    // The server binds this opaque identifier to the authenticated principal
    // and narrowed viewer scope. Client-selected tenant text is not identity.
    var storageKey =
      typeof viewerScopeId === 'string' && viewerScopeId
        ? 'front-desk.progress.uncertain.' + encodeURIComponent(viewerScopeId)
        : null;
    if (state.verdictStorageKey !== storageKey) {
      state.verdictStorageKey = storageKey;
      state.verdictStorageVerified = false;
      state.pendingVerdicts = Object.create(null);
      state.uncertainVerdicts = Object.create(null);
    }
    if (!storageKey) return false;
    if (state.verdictStorageVerified) return true;
    try {
      var raw = window.sessionStorage.getItem(storageKey);
      var ids = raw === null ? [] : JSON.parse(raw);
      if (
        !Array.isArray(ids) ||
        ids.some(function (id) {
          return typeof id !== 'string' || !id;
        })
      ) {
        throw new Error('invalid-verdict-locks');
      }
      ids.forEach(function (id) {
        // Keep a newer in-memory uncertainty generation when restoring after
        // an I/O failure. A pending older read must not lower that fence.
        state.uncertainVerdicts[id] = state.uncertainVerdicts[id] || readGeneration;
      });
      state.verdictStorageVerified = true;
    } catch (err) {
      // Do not replace or delete storage we could not verify. Only a later
      // successful restore may re-enable decisions for this scope.
      state.verdictStorageVerified = false;
    }
    return true;
  }

  function persistVerdictLocks() {
    if (!state.verdictStorageKey || !state.verdictStorageVerified) return false;
    try {
      var ids = Object.keys(state.uncertainVerdicts).concat(Object.keys(state.pendingVerdicts));
      if (ids.length) window.sessionStorage.setItem(state.verdictStorageKey, JSON.stringify(ids));
      else window.sessionStorage.removeItem(state.verdictStorageKey);
      return true;
    } catch (err) {
      state.verdictStorageVerified = false;
      return false;
    }
  }

  function submitVerdict(item, status, note, row) {
    if (!state.loaded) return;
    if (!state.verdictStorageKey) {
      showNotice('progress_scope_required');
      return;
    }
    if (!state.verdictStorageVerified) {
      showNotice('progress_storage_required');
      return;
    }
    var writeScopeKey = state.verdictStorageKey;
    if (state.pendingVerdicts[item.entry_id] || state.uncertainVerdicts[item.entry_id]) return;
    state.pendingVerdicts[item.entry_id] = ++state.verdictGeneration;
    // Persist only identifiers, before the request can reach the server. A reload
    // during an outstanding request must restore an unknown-outcome lock.
    if (!persistVerdictLocks()) {
      delete state.pendingVerdicts[item.entry_id];
      var list = document.getElementById('progress-list');
      if (list)
        list.querySelectorAll('button').forEach(function (button) {
          button.disabled = true;
        });
      showNotice('progress_storage_required');
      return;
    }
    row.querySelectorAll('button').forEach(function (button) {
      button.disabled = true;
    });
    postVerdict(item.entry_id, status, note)
      .then(function (result) {
        if (writeScopeKey !== state.verdictStorageKey) return;
        delete state.pendingVerdicts[item.entry_id];
        if (!result.ok || !result.body || !result.body.ok) throw new Error('verdict-unconfirmed');
        // The write was confirmed, but actions remain locked until a fresh read.
        state.uncertainVerdicts[item.entry_id] = ++state.verdictGeneration;
        persistVerdictLocks();
        return reload();
      })
      .catch(function () {
        if (writeScopeKey !== state.verdictStorageKey) return;
        delete state.pendingVerdicts[item.entry_id];
        state.uncertainVerdicts[item.entry_id] = ++state.verdictGeneration;
        persistVerdictLocks();
        showNotice(
          state.verdictStorageVerified ? 'progress_action_failed' : 'progress_storage_required'
        );
      });
  }

  function isSelectionNotice() {
    return ['progress_request_pending', 'progress_item_unavailable'].indexOf(state.noticeKey) >= 0;
  }

  // A failed/currently refreshing read cannot leave old scope data or actions
  // available to hash/filter handlers. Keep uncertain verdict storage intact.
  function clearPresentation() {
    state.loaded = false;
    state.payload = { counts: {}, active: [], delivered: [], done: [], mirror_href: '' };
    state.selectedId = null;
    state.selectedTitle = '';
    state.detailSequence += 1;
    renderFilters();
    renderList();
    renderDetailHint();
  }

  function loadDetail() {
    var sequence = ++state.detailSequence;
    var selectedId = state.selectedId;
    renderDetailHint();
    if (!state.loaded || !selectedId) return Promise.resolve();
    return fetchJson('/api/progress/' + encodeURIComponent(selectedId))
      .then(function (result) {
        if (sequence !== state.detailSequence || selectedId !== state.selectedId) return;
        if (!result.ok || !result.body || !result.body.ok) {
          if (result.status === 401 || result.status === 403 || result.status === 404) {
            state.loadSequence += 1;
            clearPresentation();
            showNotice('progress_item_unavailable');
          } else showNotice('progress_load_failed');
          return;
        }
        if (state.noticeKey === 'progress_load_failed') showNotice(null);
        renderDetail(result.body.item);
      })
      .catch(function () {
        if (sequence === state.detailSequence && selectedId === state.selectedId)
          showNotice('progress_load_failed');
      });
  }

  function applyHashOrDefault() {
    if (!state.loaded) return;
    var hashId = readHashId();
    var hasHash = Boolean(String(window.location.hash || '').replace(/^#/, ''));
    var found = findSection(hashId);
    var request = new URLSearchParams(window.location.search).get('request');
    // A decodable explicit item is the target even when unavailable. A malformed
    // fragment may still use the established request-correlation handoff.
    if (!found && !hashId && request) {
      FILTERS.some(function (filter) {
        var match = itemsForFilter(filter).find(function (item) {
          return item.correlation_id === request;
        });
        if (match) found = { filter: filter, item: match };
        return Boolean(match);
      });
    }
    if (!found && !hasHash && !request) {
      var defaultActive = (state.payload.active || []).find(function (item) {
        return item.selected_default;
      });
      if (defaultActive) found = { filter: 'active', item: defaultActive };
    }
    state.selectedId = found ? found.item.id : null;
    state.selectedTitle = found ? found.item.title : '';
    if (found) {
      state.filter = found.filter;
      if (isSelectionNotice()) showNotice(null);
      writeHashId(found.item.id);
    } else if (hasHash || request) {
      showNotice(hashId || !request ? 'progress_item_unavailable' : 'progress_request_pending');
    } else if (isSelectionNotice()) showNotice(null);
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
    if (state.navigationPending) return Promise.resolve();
    var sequence = ++state.loadSequence;
    clearPresentation();
    // A read can reconcile only decisions already uncertain when that read began.
    // An in-flight older snapshot must never unlock a later uncertain write.
    var reconciliationGeneration = state.verdictGeneration;
    return fetchJson('/api/progress')
      .then(function (result) {
        if (sequence !== state.loadSequence) return;
        if (!result.ok || !result.body || !result.body.ok) throw new Error('progress-unavailable');
        state.payload = result.body;
        state.loaded = true;
        var scopeReady = restoreVerdictLocks(
          state.payload.viewer_scope_id,
          reconciliationGeneration
        );
        Object.keys(state.uncertainVerdicts).forEach(function (entryId) {
          var terminalOutcome = (state.payload.done || []).some(function (item) {
            return (
              item.entry_id === entryId &&
              ['accepted', 'rejected', 'changes_requested'].indexOf(item.status) >= 0
            );
          });
          // Even a newer successful read can race a delayed commit. Only the
          // exact inbox entry's recorded verdict resolves the unknown outcome.
          if (state.uncertainVerdicts[entryId] <= reconciliationGeneration && terminalOutcome) {
            delete state.uncertainVerdicts[entryId];
          }
        });
        persistVerdictLocks();
        showNotice(
          !scopeReady
            ? 'progress_scope_required'
            : !state.verdictStorageVerified
              ? 'progress_storage_required'
              : Object.keys(state.uncertainVerdicts).length
                ? 'progress_action_failed'
                : null
        );
        applyHashOrDefault();
        renderFilters();
        renderList();
        return loadDetail();
      })
      .catch(function () {
        if (sequence === state.loadSequence) {
          clearPresentation();
          showNotice('progress_load_failed');
        }
      });
  }

  // WI-11: work-inventory automation-candidate panel.
  var WI_STATUS_KEYS = ['draft', 'confirmed', 'candidate', 'promoted', 'retired'];

  function wiShortDate(iso) {
    return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
  }

  function renderWorkInventoryCounts(vocab, counts) {
    var el = document.getElementById('wi-counts');
    if (!el) return;
    el.innerHTML = '';
    WI_STATUS_KEYS.forEach(function (key) {
      var count = (counts && counts[key]) || 0;
      var chip = document.createElement('span');
      chip.className = 'kb-badge wi-count-chip';
      chip.textContent = vt(vocab, 'progress_work_inventory_status_' + key) + ' ' + count;
      el.appendChild(chip);
    });
  }

  function renderWorkInventoryRow(vocab, item) {
    var li = document.createElement('li');
    li.className = 'wi-row';
    var ratio = typeof item.automatable_ratio === 'number' ? item.automatable_ratio : 0;
    var pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    var hours = typeof item.hours_per_month === 'number' ? item.hours_per_month : 0;
    var hoursText = renderTemplate(vt(vocab, 'progress_work_inventory_hours_label'), {
      hours: String(Math.round(hours * 10) / 10),
    });
    var scoreLabel = vt(vocab, 'progress_work_inventory_score_label');
    var scoreText =
      typeof item.score === 'number' ? String(Math.round(item.score * 10000) / 10000) : '';
    var statusLabel = vt(vocab, 'progress_work_inventory_status_' + item.status);
    var ratioLabel = vt(vocab, 'progress_work_inventory_automatable_label');
    li.innerHTML =
      '<div class="wi-row-main">' +
      '<span class="wi-row-title">' +
      escapeHtml(item.title) +
      '</span>' +
      '<span class="kb-badge wi-row-status">' +
      escapeHtml(statusLabel) +
      '</span>' +
      '</div>' +
      '<div class="wi-row-meta">' +
      '<span>' +
      escapeHtml(scoreLabel) +
      ' ' +
      escapeHtml(scoreText) +
      '</span>' +
      '<span>' +
      escapeHtml(hoursText) +
      '</span>' +
      '</div>' +
      '<div class="wi-row-bar" aria-label="' +
      escapeHtml(ratioLabel) +
      '"><div class="wi-row-bar-fill" style="width:' +
      pct +
      '%"></div></div>';
    return li;
  }

  function renderWorkInventoryConsent(vocab, consent) {
    var el = document.getElementById('wi-consent');
    if (!el) return;
    if (!consent) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    if (!consent.active && !consent.pending_summaries) {
      el.textContent = vt(vocab, 'progress_work_inventory_consent_none');
      return;
    }
    if (consent.expires_soonest) {
      el.textContent = renderTemplate(vt(vocab, 'progress_work_inventory_consent_line'), {
        active: consent.active || 0,
        expires: wiShortDate(consent.expires_soonest),
        pending: consent.pending_summaries || 0,
      });
    } else {
      el.textContent = renderTemplate(vt(vocab, 'progress_work_inventory_consent_line_no_expiry'), {
        active: consent.active || 0,
        pending: consent.pending_summaries || 0,
      });
    }
  }

  function renderWorkInventoryPanel() {
    var vocab = wi.vocab;
    var payload = wi.payload || {};
    var titleEl = document.getElementById('wi-title');
    if (titleEl) titleEl.textContent = vt(vocab, 'progress_work_inventory_title');
    renderWorkInventoryCounts(vocab, payload.counts);

    var candidates = payload.candidates || [];
    var listEl = document.getElementById('wi-list');
    if (listEl) {
      listEl.innerHTML = '';
      candidates.forEach(function (item) {
        listEl.appendChild(renderWorkInventoryRow(vocab, item));
      });
    }
    var emptyEl = document.getElementById('wi-empty');
    if (emptyEl) {
      if (candidates.length === 0) {
        emptyEl.textContent = vt(vocab, 'progress_work_inventory_empty');
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
      }
    }

    renderWorkInventoryConsent(vocab, payload.consent);

    var startEl = document.getElementById('wi-start');
    if (startEl) {
      startEl.textContent = vt(vocab, 'progress_work_inventory_start');
      startEl.href = scopedUrl('/ask?mode=hearing&scenario=work_inventory');
    }

    var hintEl = document.getElementById('wi-hint');
    if (hintEl) hintEl.textContent = vt(vocab, 'progress_work_inventory_operator_hint');
  }

  function loadWorkInventoryPanel(locale) {
    return Promise.all([
      fetchJson('/api/work-inventory-vocabulary?locale=' + encodeURIComponent(locale)),
      fetchJson('/api/front-desk/work-inventory'),
    ])
      .then(function (pair) {
        if (state.navigationPending) return;
        var vocabResult = pair[0];
        var dataResult = pair[1];
        if (!vocabResult.ok || !vocabResult.body || !vocabResult.body.ok) return;
        if (!dataResult.ok || !dataResult.body || !dataResult.body.ok) return;
        wi.vocab = vocabResult.body.texts || {};
        wi.payload = dataResult.body;
        renderWorkInventoryPanel();
      })
      .catch(function () {
        // Additive chrome around the main columns — a fetch failure here
        // must never throw or block the rest of the page.
      });
  }

  function refreshProgress() {
    if (state.navigationPending) return Promise.resolve();
    return Promise.resolve(window.FrontDeskRail && window.FrontDeskRail.ready)
      .then(function () {
        if (state.navigationPending) return;
        if (state.vocabularyReady) return reload();
        return fetchJson(
          '/api/progress-vocabulary?locale=' + encodeURIComponent(normalizeLocale())
        ).then(function (result) {
          if (!result.ok || !result.body || !result.body.ok)
            throw new Error('vocabulary-unavailable');
          state.vocab = result.body.texts || {};
          state.vocabularyReady = true;
          return reload();
        });
      })
      .catch(function () {
        showNotice('progress_load_failed');
      });
  }

  function navigationScope() {
    var query = new URLSearchParams(window.location.search);
    return JSON.stringify(
      ['tenant', 'organizationId', 'projectId'].map(function (key) {
        return query.getAll(key);
      })
    );
  }

  function mount() {
    var locale = normalizeLocale();
    wireFilters();
    var notice = document.getElementById('progress-notice');
    var refresh = notice && notice.querySelector('button');
    if (refresh)
      refresh.addEventListener('click', function () {
        refreshProgress();
      });
    var initialScope = null;
    function navigateSelection() {
      if (initialScope === null || state.navigationPending) return;
      if (navigationScope() !== initialScope) {
        // Tenant preferences are initialized once by the shared rail. A scope
        // traversal needs a fresh page rather than using its old cached scope.
        state.navigationPending = true;
        state.loadSequence += 1;
        clearPresentation();
        wi.payload = { scope: null, candidates: [], counts: {} };
        renderWorkInventoryPanel();
        window.location.reload();
        return;
      }
      applyHashOrDefault();
      renderFilters();
      renderList();
      loadDetail();
    }
    window.addEventListener('hashchange', navigateSelection);
    window.addEventListener('popstate', navigateSelection);
    // The shared rail validates the selected scope before any tenant read.
    return Promise.resolve(window.FrontDeskRail && window.FrontDeskRail.ready)
      .then(function () {
        initialScope = navigationScope();
        loadWorkInventoryPanel(locale);
        return refreshProgress();
      })
      .catch(function () {
        showNotice('progress_load_failed');
      });
  }

  window.KyberionProgress = { mount: mount };
})();
