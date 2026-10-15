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

  // Only critical GET reads use this deadline. Verdict POSTs retain their
  // existing unknown-outcome protection and are never timed out or retried here.
  function fetchReadJson(url) {
    return new Promise(function (resolve, reject) {
      var controller = window.AbortController ? new window.AbortController() : null;
      var timer = window.setTimeout(function () {
        reject(new Error('Progress read unavailable'));
        if (controller) controller.abort();
      }, 20000);
      Promise.resolve()
        .then(function () {
          return fetch(scopedUrl(url), {
            cache: 'no-store',
            signal: controller ? controller.signal : undefined,
          });
        })
        .then(function (response) {
          if (!response.ok) {
            // Denial headers are authoritative even if the body never finishes.
            // Error bodies are not displayed; release the remaining transfer.
            if (controller) controller.abort();
            return { ok: false, status: response.status, body: null };
          }
          return response.json().then(function (body) {
            return { ok: true, status: response.status, body: body };
          });
        })
        .then(
          function (result) {
            window.clearTimeout(timer);
            resolve(result);
          },
          function (error) {
            window.clearTimeout(timer);
            reject(error);
            if (controller) controller.abort();
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

  var TASK_STATE = {
    collecting_requirements: { status: 'pending', next: 'refresh' },
    awaiting_input: { status: 'pending', next: 'input' },
    awaiting_confirmation: { status: 'pending', next: 'confirmation' },
    planning: { status: 'pending', next: 'refresh' },
    executing: { status: 'active', next: 'refresh' },
    verifying: { status: 'pending', next: 'refresh' },
    paused: { status: 'idle', next: 'inspect' },
    blocked: { status: 'pending', next: 'inspect' },
    completed: { status: 'idle', next: 'result' },
    failed: { status: 'failed', next: 'inspect' },
    released: { status: 'idle', next: 'inspect' },
    unknown: { status: 'idle', next: 'inspect' },
  };
  function taskState(value) {
    return Object.prototype.hasOwnProperty.call(TASK_STATE, value) ? value : 'unknown';
  }
  function taskPillHtml(value) {
    var key = taskState(value);
    return pillHtml({ status: TASK_STATE[key].status, labelKey: 'progress_task_state_' + key });
  }
  function recordedUpdateHtml(update) {
    if (!update || !update.text) return '';
    return (
      '<p class="progress-row-now">' +
      escapeHtml(vt(state.vocab, 'progress_task_latest_update')) +
      ': ' +
      escapeHtml(update.text) +
      '</p>'
    );
  }
  function statusPillHtml(filter, item) {
    if (filter === 'active' || (item && item.kind === 'task_session'))
      return taskPillHtml(item && item.task_state);
    var def = (item && OUTCOME_STATUS[item.status]) || ROW_STATUS[filter];
    return pillHtml(def);
  }
  function pillHtml(def) {
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
    readPending: true,
    hasLoaded: false,
    detailPending: false,
    navigationPending: false,
    noticeKey: null,
    payload: { counts: {}, active: [], delivered: [], done: [], mirror_href: '' },
    filter: 'active',
    selectedId: null,
    selectedTitle: '',
    detailSequence: 0,
    loadSequence: 0,
    verdictGeneration: 1,
    rowGeneration: 0,
    verdictStorageKey: null,
    verdictStorageVerified: false,
    pendingVerdicts: Object.create(null),
    uncertainVerdicts: Object.create(null),
    correctionDrafts: Object.create(null),
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
    if (!state.vocabularyReady) return;
    var vocab = state.vocab;
    var counts = state.payload.counts || {};
    var buttons = {
      active: document.getElementById('filter-active'),
      delivered: document.getElementById('filter-delivered'),
      done: document.getElementById('filter-done'),
    };
    if (buttons.active) {
      buttons.active.textContent = state.loaded
        ? renderTemplate(vt(vocab, 'progress_filter_active'), { count: counts.active || 0 })
        : vt(vocab, 'progress_open_work');
    }
    if (buttons.delivered) {
      buttons.delivered.textContent = state.loaded
        ? renderTemplate(vt(vocab, 'progress_filter_delivered'), { count: counts.delivered || 0 })
        : vt(vocab, 'progress_delivered_title');
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
      svgIcon('chevron', 'progress-row-chevron') +
      '</div><div class="progress-row-now">' +
      statusPillHtml('active', item) +
      '</div>' +
      recordedUpdateHtml(item.latest_update) +
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
    var generation = state.rowGeneration;
    var scope = state.verdictStorageKey;
    function current() {
      return (
        state.loaded &&
        item.can_verdict &&
        item.entry_id &&
        generation === state.rowGeneration &&
        scope === state.verdictStorageKey &&
        !state.pendingVerdicts[item.entry_id] &&
        !state.uncertainVerdicts[item.entry_id]
      );
    }
    var selected = item.id === state.selectedId;
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'progress-row' + (selected ? ' progress-row-selected' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    var actionsHtml = '';
    if (item.downloadable) {
      actionsHtml +=
        '<a class="kb-btn kb-btn--secondary progress-row-action" data-action="open" download href="' +
        escapeHtml(scopedUrl('/api/artifacts/' + encodeURIComponent(item.id))) +
        '">' +
        escapeHtml(vt(vocab, 'action_open')) +
        '</a>';
    }
    if (item.can_verdict && item.entry_id) {
      actionsHtml +=
        '<p>' +
        escapeHtml(vt(vocab, 'progress_delivery_verdict_scope')) +
        '</p>' +
        (!window.KyberionProgressCorrection
          ? '<p role="status">' + escapeHtml(vt(vocab, 'progress_correction_unavailable')) + '</p>'
          : '') +
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
      button.setAttribute('data-entry-id', item.entry_id || '');
      button.disabled =
        !state.verdictStorageKey ||
        !state.verdictStorageVerified ||
        Boolean(state.pendingVerdicts[item.entry_id] || state.uncertainVerdicts[item.entry_id]) ||
        (button.getAttribute('data-action') === 'receive' &&
          Boolean(state.correctionDrafts[item.entry_id])) ||
        (button.getAttribute('data-action') === 'revise' && !window.KyberionProgressCorrection);
      if (!window.KyberionProgressCorrection && button.getAttribute('data-action') === 'revise')
        button.setAttribute('title', vt(vocab, 'progress_correction_unavailable'));
    });
    var receiveButton = row.querySelector('[data-action="receive"]');
    if (receiveButton && item.entry_id) {
      receiveButton.addEventListener('click', function (event) {
        event.stopPropagation();
        if (current() && !state.correctionDrafts[item.entry_id])
          submitVerdict(item, 'accepted', undefined, row);
      });
    }
    var reviseButton = row.querySelector('[data-action="revise"]');
    if (reviseButton && item.entry_id) {
      reviseButton.addEventListener('click', function (event) {
        event.stopPropagation();
        renderCorrectionForm(row, item, vocab, current, true);
      });
    }

    renderCorrectionForm(row, item, vocab, current);
    li.appendChild(row);
    return li;
  }

  function renderCorrectionForm(row, item, vocab, current, open) {
    if (!window.KyberionProgressCorrection) return;
    window.KyberionProgressCorrection[open ? 'open' : 'render']({
      state: state,
      row: row,
      item: item,
      vocab: vocab,
      current: current,
      vt: vt,
      submitVerdict: submitVerdict,
      renderList: renderList,
    });
  }

  function correctionRecorded(item) {
    return (
      item.kind === 'artifact' &&
      item.entry_id &&
      ['rejected', 'changes_requested'].indexOf(item.status) >= 0
    );
  }

  function correctionHref(item) {
    return scopedUrl(
      '/ask?correction=' +
        encodeURIComponent(item.entry_id) +
        '&artifact=' +
        encodeURIComponent(item.id)
    );
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
        ? '<div class="progress-row-actions"><a class="kb-btn kb-btn--secondary progress-row-action" download href="' +
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
      (item.kind === 'task_session' ? '' : statusPillHtml('done', item)) +
      svgIcon('chevron', 'progress-row-chevron') +
      '</div>' +
      (item.kind === 'task_session'
        ? '<div class="progress-row-now">' + statusPillHtml('done', item) + '</div>'
        : '') +
      actionsHtml +
      (correctionRecorded(item)
        ? '<p role="status">' +
          escapeHtml(vt(state.vocab, 'progress_correction_recorded')) +
          '</p><a class="kb-btn kb-btn--secondary progress-row-action" href="' +
          escapeHtml(correctionHref(item)) +
          '">' +
          escapeHtml(vt(state.vocab, 'progress_correction_prepare')) +
          '</a>'
        : needsRecovery(item)
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
    state.rowGeneration += 1;
    Object.keys(state.correctionDrafts).forEach(function (entryId) {
      var draft = state.correctionDrafts[entryId];
      var siblings = (state.payload.delivered || []).filter(function (item) {
        return item.entry_id === entryId && item.can_verdict;
      });
      if (
        !siblings.some(function (item) {
          return item.id === draft.editorId;
        }) &&
        siblings.length
      )
        draft.editorId = siblings[0].id;
    });
    renderLeave();
    var vocab = state.vocab;
    var listEl = document.getElementById('progress-list');
    var emptyEl = document.getElementById('progress-empty');
    var headerEl = document.getElementById('delivered-header');
    if (!listEl || !emptyEl) return;

    listEl.setAttribute(
      'aria-busy',
      state.readPending && !state.shellBlockedMessage ? 'true' : 'false'
    );
    var notice = document.getElementById('progress-notice');
    var refresh = notice && notice.querySelector('button');
    if (refresh) refresh.disabled = state.readPending;
    var readStatus = document.getElementById('progress-read-status');
    if (readStatus) {
      var readKey = state.hasLoaded ? 'progress_refreshing' : 'progress_loading';
      readStatus.textContent =
        state.shellBlockedMessage ||
        (state.readPending
          ? vt(vocab, readKey) || readStatus.getAttribute('data-' + readKey) || ''
          : '');
    }
    if (headerEl) {
      if (state.loaded && state.filter === 'delivered') {
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
    if (!state.loaded) {
      emptyEl.textContent = '';
      emptyEl.classList.add('hidden');
      return;
    }
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

  function renderDetailReadState(kind) {
    state.detailPending = kind === 'loading';
    var detailEl = document.getElementById('progress-detail');
    if (detailEl) detailEl.setAttribute('aria-busy', state.detailPending ? 'true' : 'false');
    var status = document.getElementById('progress-detail-status');
    if (status) {
      status.textContent = kind
        ? renderTemplate(vt(state.vocab, 'progress_detail_' + kind), { title: state.selectedTitle })
        : '';
    }
    var retry = document.getElementById('progress-detail-retry');
    if (retry) {
      retry.hidden = kind !== 'failed' && !(kind === 'loading' && !retry.hidden);
      retry.disabled = kind !== 'failed';
      retry.textContent = vt(state.vocab, 'progress_detail_retry') || retry.textContent;
    }
  }

  function renderDetailHint() {
    var vocab = state.vocab;
    var detailEl = document.getElementById('progress-detail');
    if (!detailEl) return;
    renderDetailReadState(null);
    detailEl.innerHTML = state.loaded
      ? '<p class="progress-select-hint">' + escapeHtml(vt(vocab, 'progress_select_hint')) + '</p>'
      : '';
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
    // The selected list may predate this detail. Never borrow its task state.
    var isTask =
      detail.kind === 'task_session' ||
      (!detail.kind && found && (found.filter === 'active' || found.item.kind === 'task_session'));
    var blocks =
      found && found.filter !== 'active' && found.item.kind !== 'task_session'
        ? statusPillHtml(found.filter, found.item)
        : '';
    if (isTask) {
      var currentTaskState = taskState(detail.task_state);
      blocks +=
        '<div class="progress-detail-block"><p class="progress-detail-label">' +
        escapeHtml(vt(vocab, 'progress_task_recorded_state')) +
        '</p>' +
        taskPillHtml(currentTaskState) +
        '<p class="progress-detail-text">' +
        escapeHtml(vt(vocab, 'progress_task_next_' + TASK_STATE[currentTaskState].next)) +
        '</p></div>';
    }
    blocks +=
      '<div class="progress-detail-block">' +
      '<p class="progress-detail-label">' +
      escapeHtml(vt(vocab, 'progress_detail_requested')) +
      '</p>' +
      '<p class="progress-detail-text">' +
      escapeHtml(detail.requested) +
      '</p>' +
      '</div>';
    if (!isTask || detail.latest_update) {
      blocks +=
        '<div class="progress-detail-block">' +
        '<p class="progress-detail-label">' +
        escapeHtml(vt(vocab, isTask ? 'progress_task_latest_update' : 'progress_detail_now')) +
        '</p>' +
        '<p class="progress-detail-text">' +
        escapeHtml(isTask ? detail.latest_update.text : detail.now) +
        '</p>' +
        '</div>';
    }
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
      escapeHtml(
        found && correctionRecorded(found.item)
          ? correctionHref(found.item)
          : askHref(state.selectedTitle)
      ) +
      '">' +
      escapeHtml(
        vt(
          vocab,
          found && correctionRecorded(found.item)
            ? 'progress_correction_prepare'
            : found && needsRecovery(found.item)
              ? 'progress_recovery'
              : 'progress_action_note'
        )
      ) +
      '</a>' +
      '<a class="kb-btn kb-btn--secondary progress-detail-action" href="' +
      escapeHtml(scopedUrl(state.payload.mirror_href || '/progress')) +
      '">' +
      escapeHtml(vt(vocab, 'progress_open_mirror')) +
      '</a>' +
      '</div>';

    renderDetailReadState('ready');
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
      state.correctionDrafts = Object.create(null);
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
    var submittedDraft = state.correctionDrafts[item.entry_id];
    var textarea = row.querySelector('.progress-revise-note');
    if (textarea) textarea.disabled = true;
    renderList();
    postVerdict(item.entry_id, status, note)
      .then(function (result) {
        if (writeScopeKey !== state.verdictStorageKey) return;
        delete state.pendingVerdicts[item.entry_id];
        if (!result.ok || !result.body || !result.body.ok) throw new Error('verdict-unconfirmed');
        if (
          status === 'rejected' &&
          submittedDraft &&
          state.correctionDrafts[item.entry_id] === submittedDraft &&
          submittedDraft.text.trim() === (note || '')
        )
          delete state.correctionDrafts[item.entry_id];
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
        renderLeave();
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
  function clearPresentation(pending) {
    state.loaded = false;
    state.readPending = Boolean(pending);
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
    if (!state.loaded || !selectedId) {
      renderDetailHint();
      return Promise.resolve();
    }
    var detailEl = document.getElementById('progress-detail');
    if (detailEl) detailEl.innerHTML = '';
    renderDetailReadState('loading');
    return fetchReadJson('/api/progress/' + encodeURIComponent(selectedId))
      .then(function (result) {
        if (sequence !== state.detailSequence || selectedId !== state.selectedId) return;
        if (!result.ok || !result.body || !result.body.ok) {
          if (result.status === 401 || result.status === 403 || result.status === 404) {
            state.loadSequence += 1;
            clearPresentation();
            showNotice('progress_item_unavailable');
          } else renderDetailReadState('failed');
          return;
        }
        if (state.noticeKey === 'progress_load_failed') showNotice(null);
        renderDetail(result.body.item);
      })
      .catch(function () {
        if (sequence === state.detailSequence && selectedId === state.selectedId)
          renderDetailReadState('failed');
      });
  }

  function readFilter() {
    var filter = new URLSearchParams(window.location.search).get('filter');
    return FILTERS.indexOf(filter) >= 0 ? filter : null;
  }

  function applyHashOrDefault() {
    if (!state.loaded) return;
    var filter = readFilter();
    state.filter = filter || 'active';
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
    if (!found && !hasHash && !request && !filter) {
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
        if (!state.loaded || state.navigationPending) return;
        // An explicit tab choice starts an untargeted list view. Back retains
        // the previous item/request URL; reload must not reselect that old work.
        var url = new URL(window.location.href);
        url.searchParams.set('filter', name);
        url.searchParams.delete('request');
        url.hash = '';
        var destination = url.pathname + url.search;
        if (
          destination !==
          window.location.pathname + window.location.search + window.location.hash
        )
          window.history.pushState(window.history.state, '', destination);
        state.filter = name;
        state.selectedId = null;
        state.selectedTitle = '';
        if (isSelectionNotice()) showNotice(null);
        renderFilters();
        renderList();
        // Also fences any detail response started before the tab changed.
        loadDetail();
      });
    });
  }

  function reload() {
    if (state.navigationPending) return Promise.resolve();
    var sequence = ++state.loadSequence;
    clearPresentation(true);
    // A read can reconcile only decisions already uncertain when that read began.
    // An in-flight older snapshot must never unlock a later uncertain write.
    var reconciliationGeneration = state.verdictGeneration;
    return fetchReadJson('/api/progress')
      .then(function (result) {
        if (sequence !== state.loadSequence) return;
        if (!result.ok || !result.body || !result.body.ok) throw new Error('progress-unavailable');
        state.payload = result.body;
        state.loaded = true;
        state.hasLoaded = true;
        state.readPending = false;
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
    clearPresentation(true);
    if (state.noticeKey === 'progress_load_failed' || isSelectionNotice()) showNotice(null);
    var ready = window.FrontDeskRail && window.FrontDeskRail.ready;
    return Promise.resolve(ready)
      .then(function () {
        if (window.FrontDeskRail && ready !== window.FrontDeskRail.ready) return;
        if (state.navigationPending) return;
        if (state.vocabularyReady) return reload();
        return fetchReadJson(
          '/api/progress-vocabulary?locale=' + encodeURIComponent(normalizeLocale())
        ).then(function (result) {
          if (window.FrontDeskRail && ready !== window.FrontDeskRail.ready) return;
          if (!result.ok || !result.body || !result.body.ok)
            throw new Error('vocabulary-unavailable');
          state.vocab = result.body.texts || {};
          state.vocabularyReady = true;
          return reload();
        });
      })
      .catch(function () {
        if (window.FrontDeskRail && ready !== window.FrontDeskRail.ready) return;
        clearPresentation();
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

  // Only app-controlled departures are deterministic. Native browser reload/close
  // can discard memory without a prompt, so never promise protection there.
  var leaveIntent = null;
  var leaveGeneration = 0;
  var leaveRequestSequence = 0;
  var leavePresentation = '';
  function leavePhase() {
    if (Object.keys(state.pendingVerdicts).length) return 'pending';
    if (Object.keys(state.uncertainVerdicts).length) return 'uncertain';
    return Object.keys(state.correctionDrafts).some(function (id) {
      return Boolean(state.correctionDrafts[id].text.trim());
    })
      ? 'draft'
      : '';
  }
  function leaveIsCurrent(intent) {
    return (
      leaveIntent === intent &&
      !state.navigationPending &&
      intent.scope === state.verdictStorageKey &&
      (!intent.isCurrent || intent.isCurrent())
    );
  }
  function drawLeave(host, components, options) {
    try {
      return Promise.resolve(window.FrontDeskRail.render(host, components, options));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  function closeLeave(intent, cancelled) {
    if (leaveIntent !== intent) return;
    leaveIntent = null;
    leavePresentation = '';
    var generation = ++leaveGeneration;
    var host = document.getElementById('progress-leave-dialog');
    if (host && window.FrontDeskRail && window.FrontDeskRail.render) {
      drawLeave(
        host,
        [
          {
            id: 'progress-leave',
            type: 'ui:dialog',
            props: { open: false },
          },
        ],
        {
          isCurrent: function () {
            return generation === leaveGeneration;
          },
        }
      )
        .then(function () {
          if (cancelled && generation === leaveGeneration && intent.cancel) intent.cancel();
        })
        .catch(function () {
          if (generation !== leaveGeneration) return;
          host.textContent = '';
          showNotice('progress_leave_unavailable');
          if (cancelled && intent.cancel) intent.cancel();
        });
    } else if (cancelled && intent.cancel) intent.cancel();
  }
  function renderLeave() {
    var intent = leaveIntent;
    if (!intent) return;
    var phase = leavePhase();
    if (!leaveIsCurrent(intent) || !phase) {
      closeLeave(intent, true);
      return;
    }
    if (leavePresentation === phase) return;
    leavePresentation = phase;
    var generation = ++leaveGeneration;
    var host = document.getElementById('progress-leave-dialog');
    if (!host || !window.FrontDeskRail || !window.FrontDeskRail.render) {
      showNotice('progress_leave_unavailable');
      closeLeave(intent, true);
      return;
    }
    var current = function () {
      return generation === leaveGeneration && leaveIsCurrent(intent);
    };
    drawLeave(
      host,
      [
        {
          id: 'progress-leave',
          type: 'ui:dialog',
          props: {
            open: true,
            title: vt(state.vocab, 'progress_leave_title'),
            message: vt(state.vocab, 'progress_leave_' + phase),
            action: { id: 'progress.leave.choose' },
            cancel_action: { id: 'progress.leave.cancel' },
            choices: [
              {
                id: 'stay',
                label: vt(
                  state.vocab,
                  phase === 'draft' ? 'progress_leave_stay' : 'progress_leave_stay_page'
                ),
                variant: 'primary',
              },
              {
                id: 'leave',
                label: vt(
                  state.vocab,
                  phase === 'draft' ? 'progress_leave_discard' : 'progress_leave_anyway'
                ),
                variant: 'danger',
              },
            ],
          },
        },
      ],
      {
        isCurrent: current,
        onAction: function (action) {
          if (!leaveIsCurrent(intent)) {
            closeLeave(intent, true);
            return;
          }
          if (!current()) return;
          var choice = action && action.payload && action.payload.choice;
          if (action.id === 'progress.leave.cancel' || choice === 'stay') {
            closeLeave(intent, true);
            return;
          }
          if (action.id !== 'progress.leave.choose' || choice !== 'leave') return;
          // A verdict can settle while the dialog is open. Re-present the actual
          // state rather than accepting a stale warning or retrying any write.
          if (leavePhase() !== phase) {
            leavePresentation = '';
            renderLeave();
            return;
          }
          if (!leaveIsCurrent(intent)) return;
          state.correctionDrafts = Object.create(null);
          closeLeave(intent, false);
          // Persisted unknown-outcome identifiers are deliberately untouched.
          intent.proceed();
        },
      }
    ).catch(function () {
      if (!current()) return;
      leavePresentation = '';
      showNotice('progress_leave_unavailable');
      closeLeave(intent, true);
    });
  }
  function mountLeaveGuard() {
    window.FrontDeskPageLeave = {
      begin: function () {
        var sequence = ++leaveRequestSequence;
        if (leaveIntent) closeLeave(leaveIntent, true);
        return function () {
          return sequence === leaveRequestSequence;
        };
      },
      requestLeave: function (proceed, isCurrent, cancel) {
        if (!isCurrent) isCurrent = window.FrontDeskPageLeave.begin();
        if (!isCurrent()) return;
        if (leaveIntent) closeLeave(leaveIntent, true);
        if (!leavePhase()) {
          proceed();
          return;
        }
        leaveIntent = {
          proceed: proceed,
          isCurrent: isCurrent,
          cancel: cancel,
          scope: state.verdictStorageKey,
        };
        renderLeave();
      },
    };
    document.addEventListener(
      'click',
      function (event) {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        var link = event.target && event.target.closest && event.target.closest('a[href]');
        if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download'))
          return;
        var href = link.getAttribute('href');
        var target;
        try {
          target = new URL(href, window.location.href);
        } catch (err) {
          return;
        }
        if (['http:', 'https:'].indexOf(target.protocol) < 0) return;
        var current = new URL(window.location.href);
        if (
          target.origin === current.origin &&
          target.pathname === current.pathname &&
          target.search === current.search &&
          href.indexOf('#') >= 0
        )
          return;
        var pageIntent = window.FrontDeskPageLeave.begin();
        if (!leavePhase()) return;
        event.preventDefault();
        event.stopPropagation();
        window.FrontDeskPageLeave.requestLeave(
          function () {
            window.location.assign(target.href);
          },
          pageIntent,
          function () {
            if (link.focus) link.focus();
          }
        );
      },
      true
    );
  }

  function mount() {
    mountLeaveGuard();
    var locale = normalizeLocale();
    if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
      window.FrontDeskRail.subscribe(function (shell) {
        if (state.vocabularyReady) return;
        state.shellBlockedMessage = shell.phase === 'blocked' ? shell.message : '';
        renderList();
      });
    wireFilters();
    var detailRetry = document.getElementById('progress-detail-retry');
    if (detailRetry)
      detailRetry.addEventListener('click', function () {
        if (!state.detailPending && state.loaded && state.selectedId) loadDetail();
      });
    var notice = document.getElementById('progress-notice');
    var refresh = notice && notice.querySelector('button');
    if (refresh)
      refresh.addEventListener('click', function () {
        if (!state.readPending) refreshProgress();
      });
    var initialScope = null;
    function navigateSelection() {
      if (initialScope === null || state.navigationPending) return;
      if (navigationScope() !== initialScope) {
        // Tenant preferences are initialized once by the shared rail. A scope
        // traversal needs a fresh page rather than using its old cached scope.
        state.navigationPending = true;
        state.loadSequence += 1;
        clearPresentation(true);
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
    var ready = window.FrontDeskRail && window.FrontDeskRail.ready;
    return Promise.resolve(ready)
      .then(function () {
        if (window.FrontDeskRail && ready !== window.FrontDeskRail.ready) return;
        initialScope = navigationScope();
        loadWorkInventoryPanel(locale);
        return refreshProgress();
      })
      .catch(function () {
        if (window.FrontDeskRail && ready !== window.FrontDeskRail.ready) return;
        clearPresentation();
        showNotice('progress_load_failed');
      });
  }

  window.KyberionProgress = { mount: mount };
})();
