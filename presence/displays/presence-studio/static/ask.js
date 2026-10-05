/*
 * ask.js — FD-03: the presence-studio "頼む" (ask) page.
 *
 * Plain browser script (no modules, no external resources) loaded by
 * `ask.html` with a plain <script> tag, mirroring `home.js` / `progress.js`.
 * All copy comes from the server (`/api/ask-vocabulary`, `/api/front-desk/nav`)
 * and the conversation/progress read models (`/api/conversation`,
 * `/api/progress`) — this file never hardcodes a surface port or host, and
 * never invents data the server did not send.
 *
 * Conversation history is server-owned and shared with Concierge. Older
 * per-tab history is retained locally as a read-only archive, never replayed.
 * Hearing sessions keep their independent legacy IDs.
 *
 * Voice: the mic button and the header hands-free toggle both use the
 * browser's `SpeechRecognition` (ported, in a much smaller form, from
 * `static/index.html`'s `setupMic()` — no push-to-talk, no engine/device
 * selects, which stay on `/work`). Barge-in is a best-effort
 * `POST /api/voice/stop-speaking` call before every hands-free recognition
 * cycle (this page has no live speech-state poll, unlike `/work`, so it
 * cannot gate the call on "is the companion currently speaking" — calling it
 * when nothing is playing is a harmless no-op). TTS of the companion's reply
 * only happens while hands-free is on, via `speechSynthesis` — this surface
 * has no dedicated "speak this text" HTTP endpoint (`/api/voice/ingest`'s own
 * `auto_reply`/`reflect_to_surface` server-side speech is a property of the
 * voice-hub bridge itself, not something this page controls per-request).
 *
 * PA-09: once `ask.html` attaches the talking avatar (`attachAvatar`, from
 * `static/partner-avatar.js`), hands-free replies are spoken through it
 * instead — voice-hub audio via `POST /api/voice/synthesize` played in the
 * browser with analyser lip-sync, falling back to `speechSynthesis` with a
 * synthetic mouth — and the avatar mirrors listening / thinking. Send, mic and
 * hands-free clicks unlock its audio (autoplay policy).
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-03 and docs/USER_EXPERIENCE_CONTRACT.md.
 */
/* global window, document, navigator, fetch, sessionStorage, URLSearchParams */
(function () {
  'use strict';

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  var TURNS_STORAGE_KEY = 'kyberion.ask.turns';
  var SESSION_STORAGE_KEY = 'kyberion.ask.session_id';
  var MAX_TURNS = 100;

  // `/api/ask-vocabulary`'s `texts` object is keyed by the fully-qualified
  // `namespace:key` form (same as `/api/ui-vocabulary` / `/api/home-vocabulary`).
  function vt(vocab, key) {
    return (vocab && vocab[key]) || '';
  }

  // Every injected string goes through this before it reaches innerHTML —
  // including attribute values, so quotes and ampersands are escaped too.
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

  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  }

  var ICON_PATHS = {
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    send: '<path d="M4 12l16-8-6 16-2-6z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  };

  function svgIcon(id, extraClass) {
    var body = ICON_PATHS[id] || '';
    var cls = 'ask-icon' + (extraClass ? ' ' + extraClass : '');
    return (
      '<svg class="' +
      cls +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return (
      'ask-' + Date.now().toString(36) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 6)
    );
  }

  function readSessionId() {
    try {
      var existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) return existing;
      var next = randomId();
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, next);
      return next;
    } catch (err) {
      return randomId();
    }
  }

  function loadTurns() {
    try {
      var raw = window.sessionStorage.getItem(TURNS_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  var state = {
    vocab: {},
    locale: 'en',
    sessionId: readSessionId(),
    turns: [],
    conversationId: null,
    historyState: 'loading',
    storageVerified: false,
    pending: 0,
    errorKey: null,
    setupHref: '/onboarding',
    pendingRequest: null,
    sending: false,
    listening: false,
    handsFree: false,
    hearingMode: false,
    // WI-08: `/ask?mode=hearing&scenario=work_inventory` — defaults to
    // `web_app_build` (today's only scenario before WI-08). Sent to the
    // server as `scenario_id` on every hearing request so a fresh (not yet
    // persisted) session picks the right requirement set and canvas
    // instead of always defaulting to `web_app_build`.
    hearingScenarioId: 'web_app_build',
    hearingRecord: null,
    // HT-02: bounded retry while the record's canvas is still `pending`.
    hearingCanvasPollTries: 0,
    // HT-03 (2nd half): local hand-off UI state — `null` before the operator
    // clicks the button; `{ pending: true }` mid-request; then either
    // `{ refId, href }` (server request id + same-tab decide link) or
    // `{ failed: true }`.
    hearingHandoff: null,
    // WI-08: same shape as `hearingHandoff` above, for the `work_inventory`
    // scenario's "save to the work inventory" confirm action —
    // `{ entryId, href }` on success.
    hearingInventory: null,
    // PA-09: the talking avatar handle (null until ask.html attaches it).
    avatar: null,
  };

  var HEARING_CANVAS_POLL_INTERVAL_MS = 3000;
  var HEARING_CANVAS_POLL_MAX_TRIES = 10;

  var recognition = null;
  var suppressRecognitionRestart = false;

  function latestCompanionTurn() {
    for (var index = state.turns.length - 1; index >= 0; index -= 1) {
      var turn = state.turns[index];
      if (turn.role === 'companion' && turn.intent_resolution) return turn;
    }
    return null;
  }

  function latestIntentResolution() {
    var turn = latestCompanionTurn();
    return turn ? turn.intent_resolution : null;
  }

  // FD-09: last-resort `kebab-case`/`snake_case` -> plain-words fallback for
  // any slug this page must show a human a value for (e.g. `missing_inputs`
  // entries) without a vocabulary-catalog label of their own. Mirrors
  // `humanizeSlug` in `ask-view.ts` (a plain browser script cannot import
  // that Node module — see the module doc above).
  function humanizeSlug(slug) {
    return String(slug || '')
      .replace(/[-_]+/g, ' ')
      .trim();
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderInputShell() {
    var input = document.getElementById('ask-input');
    if (input) {
      input.setAttribute(
        'placeholder',
        state.turns.length
          ? vt(state.vocab, 'front_desk:ask_placeholder_followup')
          : vt(state.vocab, 'front_desk:home_ask_placeholder')
      );
    }

    var micButton = document.getElementById('ask-mic');
    if (micButton) {
      micButton.setAttribute('aria-label', vt(state.vocab, 'front_desk:home_ask_voice'));
      micButton.innerHTML = svgIcon('mic');
      micButton.setAttribute('aria-pressed', state.listening ? 'true' : 'false');
      micButton.classList.toggle('hidden', !SpeechRecognitionCtor);
    }

    var sendButton = document.getElementById('ask-send');
    if (sendButton) {
      sendButton.setAttribute('aria-label', vt(state.vocab, 'front_desk:home_ask_send'));
      sendButton.innerHTML = svgIcon('send');
    }

    var chipDefs = [
      { key: 'email', textKey: 'front_desk:chip_email', icon: 'mail' },
      { key: 'minutes', textKey: 'front_desk:chip_minutes', icon: 'notes' },
      { key: 'browser', textKey: 'front_desk:chip_browser', icon: 'globe' },
      { key: 'webapp', textKey: 'front_desk:chip_webapp', icon: 'list' },
    ];
    chipDefs.forEach(function (def) {
      var button = document.querySelector('.ask-chip[data-chip="' + def.key + '"]');
      if (!button) return;
      button.innerHTML =
        svgIcon(def.icon) + '<span>' + escapeHtml(vt(state.vocab, def.textKey)) + '</span>';
    });
  }

  function renderHandsFreeToggle() {
    var button = document.getElementById('handsfree-toggle');
    if (!button) return;
    if (!SpeechRecognitionCtor) {
      button.classList.add('hidden');
      return;
    }
    button.setAttribute('aria-pressed', state.handsFree ? 'true' : 'false');
    button.textContent = vt(
      state.vocab,
      state.handsFree ? 'front_desk:ask_handsfree_on' : 'front_desk:ask_handsfree_off'
    );
  }

  var AUTHORITY_LABEL_KEY = {
    autonomous: 'tui:tui_cockpit_authority_autonomous',
    approval_required: 'tui:tui_cockpit_authority_approval',
    human_clarification_required: 'tui:tui_cockpit_authority_clarification',
  };
  var OUTCOME_LABEL_KEY = {
    answer: 'tui:tui_cockpit_outcome_answer',
    artifact: 'tui:tui_cockpit_outcome_artifact',
    approval_ready_plan: 'tui:tui_cockpit_outcome_approval_ready_plan',
    service_change: 'tui:tui_cockpit_outcome_service_change',
    status_report: 'tui:tui_cockpit_outcome_status_report',
  };
  // FD-09: vocabulary keys for the execution shape ("Current state" block)
  // and the UX-contract turn shape chip are built from the enum value
  // (`front_desk:shape_<value>` / `front_desk:shape_chip_<value>`), so no
  // internal identifier is written into this human-facing file and a new
  // enum value only needs a catalog entry. Unknown values fall back to the
  // humanized slug at the call sites.
  function shapeLabelKey(value) {
    return value ? 'front_desk:shape_' + String(value) : '';
  }
  function turnShapeLabelKey(value) {
    return value ? 'front_desk:shape_chip_' + String(value) : '';
  }

  function setBlockText(prefix, label, text) {
    var labelEl = document.getElementById(prefix + '-label');
    var textEl = document.getElementById(prefix + '-text');
    if (labelEl) labelEl.textContent = label;
    if (textEl) textEl.textContent = text || '';
  }

  // The "この依頼について" panel — four blocks from the latest intent
  // resolution, plus a live `ask_thinking` / `ask_listening` override on the
  // state block while a request is in flight or the mic is open.
  function renderAboutCard() {
    var titleEl = document.getElementById('about-title');
    if (titleEl) titleEl.textContent = vt(state.vocab, 'front_desk:ask_about_title');

    var companionTurn = latestCompanionTurn();
    var contract = companionTurn ? companionTurn.intent_resolution : null;
    var hasLiveState = state.sending || state.listening;
    var showBlocks = Boolean(contract) || hasLiveState;

    var understoodBlock = document.getElementById('about-understood-block');
    var stateBlock = document.getElementById('about-state-block');
    var decisionBlock = document.getElementById('about-decision-block');
    var deliverableBlock = document.getElementById('about-deliverable-block');
    var emptyEl = document.getElementById('about-empty');

    if (understoodBlock) understoodBlock.classList.toggle('hidden', !contract);
    if (decisionBlock) decisionBlock.classList.toggle('hidden', !contract);
    if (deliverableBlock) deliverableBlock.classList.toggle('hidden', !contract);
    if (stateBlock) stateBlock.classList.toggle('hidden', !showBlocks);

    if (!showBlocks) {
      if (emptyEl) {
        emptyEl.textContent = vt(state.vocab, 'front_desk:ask_empty');
        emptyEl.classList.remove('hidden');
      }
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    var stateText = state.sending
      ? vt(state.vocab, 'front_desk:ask_thinking')
      : state.listening
        ? vt(state.vocab, 'front_desk:ask_listening')
        : contract
          ? vt(state.vocab, shapeLabelKey(contract.resolution_shape)) ||
            humanizeSlug(contract.resolution_shape)
          : '';
    setBlockText('about-state', vt(state.vocab, 'front_desk:ask_state'), stateText);

    if (!contract) return;

    // FD-09: `intent_label` is resolved server-side (`/api/conversation`)
    // from the standard-intent catalog's own description, or a humanized
    // slug as a last resort — never the raw `normalized_intent` id. Falls
    // back to humanizing it here only if an older cached turn predates that
    // field (see `sessionStorage`'s `TURNS_STORAGE_KEY`).
    var understoodText =
      (companionTurn && companionTurn.intent_label) || humanizeSlug(contract.normalized_intent);
    setBlockText('about-understood', vt(state.vocab, 'front_desk:ask_understood'), understoodText);

    var missing =
      Array.isArray(contract.missing_inputs) && contract.missing_inputs.length
        ? contract.missing_inputs.map(humanizeSlug).join('、')
        : '';
    var authorityLabel =
      vt(state.vocab, AUTHORITY_LABEL_KEY[contract.authority_level] || '') ||
      contract.authority_level;
    var decisionText = missing ? missing + ' — ' + authorityLabel : authorityLabel;
    setBlockText('about-decision', vt(state.vocab, 'front_desk:ask_decision_point'), decisionText);

    var outcomeLabel =
      vt(state.vocab, OUTCOME_LABEL_KEY[contract.outcome_kind] || '') || contract.outcome_kind;
    var nextAction = contract.next_action || {};
    var deliverableText = [outcomeLabel, nextAction.label, nextAction.consequence]
      .filter(Boolean)
      .join(' — ');
    setBlockText(
      'about-deliverable',
      vt(state.vocab, 'front_desk:ask_deliverable'),
      deliverableText
    );
  }

  function renderRecent(items) {
    var titleEl = document.getElementById('recent-title');
    if (titleEl) titleEl.textContent = vt(state.vocab, 'front_desk:ask_recent');
    var listEl = document.getElementById('recent-list');
    if (!listEl) return;
    // UI-06: no recent requests -> no empty card.
    var card = document.getElementById('recent-card');
    if (card) card.classList.toggle('hidden', !(items && items.length));
    listEl.innerHTML = (items || [])
      .slice(0, 3)
      .map(function (item) {
        return (
          '<li><a class="ask-recent-row" href="' +
          escapeHtml(scopedUrl('/progress#' + encodeURIComponent(item.id))) +
          '">' +
          escapeHtml(item.title) +
          '</a></li>'
        );
      })
      .join('');
  }

  function quickReplyLabel(action) {
    if (action.id === 'proceed') return vt(state.vocab, 'front_desk:ask_proceed');
    if (action.id === 'more_detail') return vt(state.vocab, 'front_desk:ask_more_detail');
    return action.label;
  }

  function selectedRequest() {
    try {
      return new URLSearchParams(window.location.search).get('request') || '';
    } catch (err) {
      return '';
    }
  }

  function focusSelectedRequest() {
    if (state.historyState !== 'ready') return;
    var request = selectedRequest();
    if (!request) return;
    var match = state.turns.some(function (turn) {
      return turn.id === request + '-user';
    });
    var notice = document.getElementById('conversation-selection');
    if (notice) {
      notice.hidden = false;
      notice.textContent = vt(
        state.vocab,
        match ? 'front_desk:work_home_resume_readonly' : 'front_desk:work_home_request_unavailable'
      );
    }
    state.focusedRequest = request;
    var target = document.getElementById('ask-turn-' + request + '-user');
    if (match && target) {
      if (target.focus) target.focus({ preventScroll: true });
      if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
    }
  }

  function turnHtml(turn) {
    var roleClass = turn.role === 'user' ? 'ask-turn-user' : 'ask-turn-companion';
    var shapeLabel = vt(state.vocab, turnShapeLabelKey(turn.shape)) || humanizeSlug(turn.shape);
    var shapeHtml =
      turn.role === 'companion' && turn.shape && turn.shape !== 'reply'
        ? '<span class="kb-badge ask-turn-shape">' + escapeHtml(shapeLabel) + '</span>'
        : '';
    var actionsHtml = '';
    if (turn.role === 'companion' && Array.isArray(turn.next_actions) && turn.next_actions.length) {
      actionsHtml =
        '<div class="ask-turn-next-actions">' +
        turn.next_actions
          .map(function (action) {
            var label = quickReplyLabel(action);
            return (
              '<button type="button" class="kb-btn kb-btn--secondary ask-quick-reply" data-quick-reply="' +
              escapeHtml(label) +
              '">' +
              escapeHtml(label) +
              '</button>'
            );
          })
          .join('') +
        '</div>';
    }
    return (
      '<li class="ask-turn ' +
      roleClass +
      '" id="ask-turn-' +
      escapeHtml(turn.id || '') +
      '" tabindex="-1"><div class="ask-bubble">' +
      escapeHtml(turn.text) +
      '</div>' +
      shapeHtml +
      actionsHtml +
      (turn.role === 'user' && typeof turn.id === 'string' && /^[a-f0-9-]{36}-user$/.test(turn.id)
        ? '<a href="' +
          escapeHtml(scopedUrl('/progress?request=' + encodeURIComponent(turn.id.slice(0, -5)))) +
          '">' +
          escapeHtml(vt(state.vocab, 'front_desk:nav_progress')) +
          '</a>'
        : '') +
      '</li>'
    );
  }

  function scrollConversationToBottom() {
    var scroller = document.getElementById('conversation-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function wireQuickReplies() {
    document.querySelectorAll('[data-quick-reply]').forEach(function (button) {
      button.addEventListener('click', function () {
        sendText(button.getAttribute('data-quick-reply'));
      });
    });
  }

  function renderTurns() {
    var dateEl = document.getElementById('date-separator');
    if (dateEl) dateEl.textContent = vt(state.vocab, 'front_desk:ask_today');

    var listEl = document.getElementById('turns');
    var emptyEl = document.getElementById('ask-empty');
    if (!listEl || !emptyEl) return;

    if (!state.turns.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = vt(state.vocab, 'front_desk:ask_empty');
      emptyEl.classList.remove('hidden');
      focusSelectedRequest();
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = state.turns.map(turnHtml).join('');
    wireQuickReplies();
    if (selectedRequest() && state.focusedRequest !== selectedRequest()) focusSelectedRequest();
    else scrollConversationToBottom();
  }

  function render() {
    renderInputShell();
    renderHandsFreeToggle();
    renderAboutCard();
    renderTurns();
    renderHearing();
    syncAvatar();
    renderConversationStatus();
  }

  // PA-09: page state -> avatar controller (the avatar overlays `speaking`
  // itself while it plays a reply).
  function syncAvatar() {
    if (!state.avatar) return;
    state.avatar.setState(state.listening ? 'listening' : state.sending ? 'thinking' : null);
  }

  // Called from the user's click / submit so browser audio may start later.
  function unlockAvatarAudio() {
    if (!state.avatar) return;
    try {
      Promise.resolve(state.avatar.unlock()).catch(function () {
        // Best effort only — speech falls back to speechSynthesis.
      });
    } catch (err) {
      // Best effort only.
    }
  }

  function attachAvatar(handle) {
    state.avatar = handle || null;
    syncAvatar();
  }

  // Simple `{name}` interpolation for the vocabulary templates this file
  // renders (mirrors the ICU-subset `{name}` substitution `libs/core/
  // message-format.ts` implements server-side; this page never needs the
  // plural form, so it only replaces bare `{name}` tokens).
  function formatTemplate(template, params) {
    return String(template || '').replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  // HT-02: one-line status under the canvas iframe from the record's
  // `canvas_generation` field (`'pending' | 'generated' | 'template'`,
  // absent on old records treated the same as `'template'`).
  function hearingCanvasStatusKey(record) {
    var generation = record && record.canvas_generation;
    if (generation === 'pending') return 'front_desk:hearing_canvas_updating';
    if (generation === 'generated') return 'front_desk:hearing_canvas_generated';
    return 'front_desk:hearing_canvas_template';
  }

  function renderHearingCanvasStatus(record) {
    var statusEl = document.getElementById('hearing-canvas-status');
    if (!statusEl) return;
    statusEl.textContent = record ? vt(state.vocab, hearingCanvasStatusKey(record)) : '';
  }

  // WI-08: `record.scenario` (once known) is the source of truth; before the
  // first load/answer there is no record yet, so this falls back to the
  // `?scenario=` the page was opened with.
  function isWorkInventoryScenario(record) {
    if (record && record.scenario) return record.scenario === 'work_inventory';
    return state.hearingScenarioId === 'work_inventory';
  }

  // HT-03 (2nd half) / WI-08: the confirm button + its own local
  // request/result state, independent from the hearing record itself (the
  // record only learns the server ids on the next full reload — this keeps
  // the button responsive without waiting on that round trip). The same
  // `#hearing-handoff` button/status/link elements carry both confirm
  // actions — which one is live depends on `isWorkInventoryScenario`: the
  // governed hand-off (`hearingHandoff`/`front_desk:hearing_handoff_*`) for
  // every other scenario, the "save to the work inventory" confirm
  // (`hearingInventory`/`front_desk:hearing_inventory_*`) for `work_inventory`.
  function renderHearingHandoff(record, ready) {
    var button = document.getElementById('hearing-handoff');
    var statusEl = document.getElementById('hearing-handoff-status');
    var linkEl = document.getElementById('hearing-handoff-link');
    if (!button || !statusEl || !linkEl) return;
    statusEl.classList.add('hidden');
    linkEl.classList.add('hidden');

    if (isWorkInventoryScenario(record)) {
      button.textContent = vt(state.vocab, 'front_desk:hearing_inventory_button');
      var inventory = state.hearingInventory;
      var alreadySaved =
        Boolean(inventory && inventory.entryId) ||
        Boolean(record && record.work_inventory_entry_id);
      button.classList.toggle('hidden', !ready || alreadySaved);
      if (!inventory) return;
      if (inventory.pending) {
        statusEl.textContent = vt(state.vocab, 'front_desk:hearing_inventory_pending');
        statusEl.classList.remove('hidden');
        return;
      }
      if (inventory.failed) {
        statusEl.textContent = vt(state.vocab, 'front_desk:hearing_inventory_failed');
        statusEl.classList.remove('hidden');
        return;
      }
      if (inventory.entryId) {
        statusEl.textContent =
          vt(state.vocab, 'front_desk:hearing_inventory_done') +
          ' ' +
          formatTemplate(vt(state.vocab, 'front_desk:hearing_inventory_entry_label'), {
            id: inventory.entryId,
          });
        statusEl.classList.remove('hidden');
        if (inventory.href) {
          linkEl.textContent = vt(state.vocab, 'front_desk:hearing_inventory_open');
          linkEl.setAttribute('href', inventory.href);
          linkEl.classList.remove('hidden');
        }
      }
      return;
    }

    button.textContent = vt(state.vocab, 'front_desk:hearing_handoff_button');
    var handoff = state.hearingHandoff;
    var alreadyHandedOff =
      Boolean(handoff && handoff.refId) || Boolean(record && record.mission_id);
    button.classList.toggle('hidden', !ready || alreadyHandedOff);
    if (!handoff) return;
    if (handoff.pending) {
      statusEl.textContent = vt(state.vocab, 'front_desk:hearing_handoff_pending');
      statusEl.classList.remove('hidden');
      return;
    }
    if (handoff.failed) {
      statusEl.textContent = vt(state.vocab, 'front_desk:hearing_handoff_failed');
      statusEl.classList.remove('hidden');
      return;
    }
    if (handoff.refId) {
      statusEl.textContent =
        vt(state.vocab, 'front_desk:hearing_handoff_done') +
        ' ' +
        formatTemplate(vt(state.vocab, 'front_desk:hearing_mission_label'), { id: handoff.refId });
      statusEl.classList.remove('hidden');
      if (handoff.href) {
        linkEl.textContent = vt(state.vocab, 'front_desk:hearing_open_decide');
        linkEl.setAttribute('href', handoff.href);
        linkEl.classList.remove('hidden');
      }
    }
  }

  function renderHearing() {
    var card = document.getElementById('hearing-card');
    if (!card) return;
    card.classList.toggle('hidden', !state.hearingMode);
    if (!state.hearingMode) return;
    var record = state.hearingRecord;
    var titleEl = document.getElementById('hearing-title');
    if (titleEl) titleEl.textContent = vt(state.vocab, 'front_desk:hearing_title');
    var canvas = document.getElementById('hearing-canvas');
    if (canvas)
      canvas.setAttribute('title', vt(state.vocab, 'front_desk:hearing_canvas_frame_title'));
    var decide = document.getElementById('hearing-decide');
    if (decide) decide.textContent = vt(state.vocab, 'front_desk:hearing_decide');
    var coverage = document.getElementById('hearing-coverage');
    var ready = false;
    if (coverage) {
      if (!record) {
        coverage.textContent = vt(state.vocab, 'front_desk:hearing_pending');
      } else {
        var done = record.requirements.filter(function (item) {
          return Boolean(item.answer);
        }).length;
        var total = record.requirements.length;
        ready = done === total && total > 0 && Boolean(record.decided_at);
        coverage.textContent = formatTemplate(vt(state.vocab, 'front_desk:hearing_coverage'), {
          done: done,
          total: total,
        });
        if (decide) decide.classList.toggle('hidden', done !== total || Boolean(record.decided_at));
      }
    }
    if (canvas && record && record.canvas_url && canvas.getAttribute('src') !== record.canvas_url) {
      canvas.setAttribute('src', record.canvas_url);
    }
    renderHearingCanvasStatus(record);
    renderHearingHandoff(record, ready);
  }

  // HT-02: the record's canvas may still be generating when this page first
  // reads it — reload every ~3s (bounded) until `canvas_generation` leaves
  // `pending`, so the iframe picks up the new `canvas_url` without a manual
  // refresh. `renderHearing` already swaps the iframe `src` whenever
  // `canvas_url` changes.
  function maybeScheduleHearingCanvasPoll() {
    var record = state.hearingRecord;
    if (!record || record.canvas_generation !== 'pending') {
      state.hearingCanvasPollTries = 0;
      return;
    }
    if (state.hearingCanvasPollTries >= HEARING_CANVAS_POLL_MAX_TRIES) return;
    state.hearingCanvasPollTries += 1;
    window.setTimeout(loadHearing, HEARING_CANVAS_POLL_INTERVAL_MS);
  }

  function loadHearing() {
    if (!state.hearingMode) return;
    fetchJson(
      '/api/hearing/' +
        encodeURIComponent(state.sessionId) +
        '?locale=' +
        encodeURIComponent(state.locale) +
        '&scenario_id=' +
        encodeURIComponent(state.hearingScenarioId)
    )
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          state.hearingRecord = result.body.record;
          renderHearing();
          maybeScheduleHearingCanvasPoll();
        }
      })
      .catch(function () {
        /* hearing is additive to the conversation */
      });
  }

  function decideHearing() {
    if (!state.hearingMode || !state.hearingRecord) return;
    fetchJson(
      '/api/hearing/' +
        encodeURIComponent(state.sessionId) +
        '/decide?locale=' +
        encodeURIComponent(state.locale),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          state.hearingRecord = result.body.record;
          renderHearing();
        }
      })
      .catch(function () {
        /* the record remains available for retry */
      });
  }

  // HT-03 (2nd half): "confirm and hand off as a request" — carries the
  // decided hearing record into the governed request/approval flow behind
  // `POST /api/hearing/:session/handoff`. Idempotent server-side: a second
  // click after success returns the same ids instead of registering twice.
  function handoffHearing() {
    if (!state.hearingMode || !state.hearingRecord) return;
    if (state.hearingHandoff && state.hearingHandoff.pending) return;
    state.hearingHandoff = { pending: true };
    renderHearing();
    fetchJson(
      '/api/hearing/' +
        encodeURIComponent(state.sessionId) +
        '/handoff?locale=' +
        encodeURIComponent(state.locale),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          state.hearingHandoff = {
            refId: result.body.mission_id,
            href: result.body.next_action && result.body.next_action.href,
          };
        } else {
          state.hearingHandoff = { failed: true };
        }
        renderHearing();
      })
      .catch(function () {
        state.hearingHandoff = { failed: true };
        renderHearing();
      });
  }

  // WI-08: "save to the work inventory" — the `work_inventory` scenario's
  // equivalent of `handoffHearing()` above, confirming a decided record into
  // a work-inventory entry via `POST /api/hearing/:session/inventory`.
  // Idempotent server-side: a second click after success returns the same
  // `entry_id` instead of writing a second entry.
  function saveWorkInventory() {
    if (!state.hearingMode || !state.hearingRecord) return;
    if (state.hearingInventory && state.hearingInventory.pending) return;
    state.hearingInventory = { pending: true };
    renderHearing();
    fetchJson(
      '/api/hearing/' +
        encodeURIComponent(state.sessionId) +
        '/inventory?locale=' +
        encodeURIComponent(state.locale),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          state.hearingInventory = {
            entryId: result.body.entry_id,
            href: result.body.next && result.body.next.href,
          };
        } else {
          state.hearingInventory = { failed: true };
        }
        renderHearing();
      })
      .catch(function () {
        state.hearingInventory = { failed: true };
        renderHearing();
      });
  }

  function updateHearing(text, intentResolution) {
    if (!state.hearingMode) return Promise.resolve();
    return fetchJson('/api/hearing/' + encodeURIComponent(state.sessionId) + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        request_id: randomId(),
        intent_resolution: intentResolution,
        locale: state.locale,
        scenario_id: state.hearingScenarioId,
      }),
    }).then(function (result) {
      if (result.ok && result.body && result.body.ok) {
        state.hearingRecord = result.body.record;
        renderHearing();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Conversation
  // ---------------------------------------------------------------------

  function pushTurn(turn) {
    state.turns.push(turn);
    if (state.turns.length > MAX_TURNS) state.turns = state.turns.slice(-MAX_TURNS);
  }

  function speakReply(text) {
    if (!state.handsFree) return;
    if (state.avatar) {
      state.avatar.speak(text, { lang: state.locale === 'ja' ? 'ja-JP' : 'en-US' });
      return;
    }
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      var utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = state.locale === 'ja' ? 'ja-JP' : 'en-US';
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      // Best effort only.
    }
  }

  function refreshRecent() {
    fetchJson(scopedUrl('/api/progress'))
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          renderRecent(result.body.active || []);
        }
      })
      .catch(function () {
        // Recent requests are additive chrome — a fetch failure must not
        // interrupt the conversation.
      });
  }

  function scopedUrl(path) {
    return window.KyberionPrefs && window.KyberionPrefs.scopedUrl
      ? window.KyberionPrefs.scopedUrl(path)
      : path;
  }

  function draftKey() {
    return state.conversationId ? 'kyberion.ask.draft.' + state.conversationId : null;
  }
  function saveDraft() {
    var input = document.getElementById('ask-input');
    var key = draftKey();
    if (!key || !input) return;
    try {
      window.sessionStorage.setItem(key, input.value);
    } catch (err) {
      /* Browser-only draft. */
    }
  }

  function renderConversationStatus() {
    var host = document.getElementById('conversation-status');
    if (!host) return;
    var key =
      state.errorKey ||
      (state.historyState === 'loading'
        ? 'concierge:dock.history.loading'
        : state.historyState === 'failed'
          ? 'concierge:dock.history.failed'
          : state.pending
            ? 'concierge:dock.history.pending'
            : null);
    var send = document.getElementById('ask-send');
    if (send)
      send.disabled = state.sending || state.historyState !== 'ready' || !state.storageVerified;
    host.classList.toggle('hidden', !key);
    if (!key) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML =
      '<p>' +
      escapeHtml(vt(state.vocab, key)) +
      '</p>' +
      '<button type="button" class="kb-btn kb-btn--secondary" id="conversation-reload">' +
      escapeHtml(vt(state.vocab, 'concierge:dock.history.retry')) +
      '</button> ' +
      '<a href="' +
      escapeHtml(scopedUrl('/progress')) +
      '">' +
      escapeHtml(vt(state.vocab, 'front_desk:nav_progress')) +
      '</a> ' +
      '<a href="' +
      escapeHtml(scopedUrl(state.setupHref)) +
      '">' +
      escapeHtml(vt(state.vocab, 'front_desk:nav_settings')) +
      '</a>';
    document.getElementById('conversation-reload').addEventListener('click', function () {
      restoreConversation(false);
    });
  }

  function restoreConversation(restoreDraft) {
    state.historyState = 'loading';
    renderConversationStatus();
    return fetchJson(scopedUrl('/api/conversation'), { cache: 'no-store' })
      .then(function (result) {
        var body = result.body || {};
        if (result.status === 401 || result.status === 403) {
          state.errorKey = 'front_desk:conversation_access_required';
          throw new Error('access denied');
        }
        if (
          !result.ok ||
          !body.ok ||
          typeof body.sessionId !== 'string' ||
          !/^concierge-[a-f0-9]{64}$/.test(body.sessionId) ||
          !Array.isArray(body.messages)
        )
          throw new Error('history unavailable');
        state.conversationId = body.sessionId;
        state.historyState = 'ready';
        state.pending = body.pending || 0;
        state.errorKey = null;
        if (body.next_action && typeof body.next_action.href === 'string')
          state.setupHref = body.next_action.href;
        // Only display data is restored. Historical approval actions never reactivate.
        state.turns = body.messages
          .filter(function (m) {
            return m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'secretary');
          })
          .map(function (m) {
            return {
              id: m.id,
              role: m.role === 'user' ? 'user' : 'companion',
              text: m.text,
              createdAt: m.createdAt,
            };
          });
        var input = document.getElementById('ask-input');
        try {
          var savedDraft = window.sessionStorage.getItem(draftKey());
          var savedRaw = window.sessionStorage.getItem(draftKey() + '.request');
          var saved = savedRaw === null ? null : JSON.parse(savedRaw);
          if (
            savedRaw !== null &&
            (!saved ||
              typeof saved !== 'object' ||
              Array.isArray(saved) ||
              typeof saved.id !== 'string' ||
              !/^[a-f0-9-]{36}$/.test(saved.id) ||
              typeof saved.text !== 'string' ||
              typeof saved.createdAt !== 'number' ||
              !isFinite(saved.createdAt))
          )
            throw new Error('invalid saved request');
          if (saved) state.pendingRequest = saved;
          state.storageVerified = true;
          if (restoreDraft && input) input.value = savedDraft || input.value;
        } catch (err) {
          state.storageVerified = false;
          state.errorKey = 'front_desk:conversation_storage_required';
        }
        render();
      })
      .catch(function () {
        state.historyState = 'failed';
        render();
      });
  }

  function sendText(text) {
    var trimmed = String(text || '').trim();
    if (
      !trimmed ||
      state.sending ||
      state.historyState !== 'ready' ||
      !state.conversationId ||
      !state.storageVerified
    )
      return;
    var waiting = state.turns.find(function (turn) {
      return (
        turn.role === 'user' &&
        turn.text === trimmed &&
        typeof turn.id === 'string' &&
        !state.turns.some(function (reply) {
          return reply.id === turn.id.replace(/-user$/, '-secretary');
        })
      );
    });
    var request = waiting
      ? {
          id: waiting.id.replace(/-user$/, ''),
          text: trimmed,
          createdAt: waiting.createdAt || Date.now(),
        }
      : state.pendingRequest && state.pendingRequest.text === trimmed
        ? state.pendingRequest
        : { id: randomId(), text: trimmed, createdAt: Date.now() };
    try {
      var serialized = JSON.stringify(request);
      window.sessionStorage.setItem(draftKey() + '.request', serialized);
      if (window.sessionStorage.getItem(draftKey() + '.request') !== serialized)
        throw new Error('request not retained');
    } catch (err) {
      state.storageVerified = false;
      state.errorKey = 'front_desk:conversation_storage_required';
      render();
      return;
    }
    state.pendingRequest = request;
    state.sending = true;
    state.errorKey = null;
    saveDraft();
    render();
    var tenant =
      window.KyberionPrefs && window.KyberionPrefs.tenant ? window.KyberionPrefs.tenant() : null;
    var selectedScope = new URL(window.location.href).searchParams;
    fetchJson('/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: trimmed,
        locale: state.locale,
        conversation_id: state.conversationId,
        request_id: request.id,
        request_created_at: request.createdAt,
        tenant: tenant || undefined,
        organizationId: selectedScope.get('organizationId') || undefined,
        projectId: selectedScope.get('projectId') || undefined,
      }),
    })
      .then(function (result) {
        var body = result.body || {};
        if (
          !result.ok ||
          !body.ok ||
          body.mode === 'unavailable' ||
          typeof body.reply !== 'string'
        ) {
          var typedErrors = {
            conversation_not_started: 'front_desk:conversation_not_started',
            conversation_scope_selection_required:
              'front_desk:conversation_scope_selection_required',
            conversation_capability_unsupported: 'front_desk:conversation_capability_unsupported',
          };
          state.errorKey =
            typedErrors[body.error] ||
            (result.status === 401 || result.status === 403
              ? 'front_desk:conversation_access_required'
              : body.retry_safe === true
                ? 'concierge:api.history_unavailable'
                : 'concierge:dock.history.pending');
          if (body.retry_safe !== true) state.pending = Math.max(1, state.pending);
          if (body.next_action && typeof body.next_action.href === 'string')
            state.setupHref = body.next_action.href;
          if (result.status === 409 && body.error !== 'conversation_not_started')
            state.historyState = 'failed';
          return;
        }
        if (
          !state.turns.some(function (turn) {
            return turn.id === request.id + '-user';
          })
        )
          pushTurn({
            id: request.id + '-user',
            role: 'user',
            text: trimmed,
            createdAt: request.createdAt,
          });
        state.turns = state.turns.filter(function (turn) {
          return turn.id !== request.id + '-secretary';
        });
        pushTurn({
          id: request.id + '-secretary',
          role: 'companion',
          text: body.reply,
          shape: body.shape,
          next_actions: body.replayed ? undefined : body.next_actions,
          intent_resolution: body.replayed ? undefined : body.intent_resolution,
          intent_label: body.intent_label,
          intent_label_source: body.intent_label_source,
        });
        state.pendingRequest = null;
        try {
          window.sessionStorage.removeItem(draftKey() + '.request');
        } catch (err) {}
        var input = document.getElementById('ask-input');
        if (input && input.value.trim() === trimmed) input.value = '';
        saveDraft();
        if (body.historySaved === false) state.errorKey = 'concierge:dock.history.unsaved';
        speakReply(body.reply);
        refreshRecent();
        if (!body.replayed)
          return updateHearing(trimmed, body.intent_resolution).catch(function () {});
      })
      .catch(function () {
        state.pending = Math.max(1, state.pending);
        state.errorKey = 'concierge:dock.history.pending';
      })
      .finally(function () {
        state.sending = false;
        render();
      });
  }

  // ---------------------------------------------------------------------
  // Voice (mic + hands-free)
  // ---------------------------------------------------------------------

  function stopSpeakingBestEffort(reason) {
    // Server (host) speech only: a reply the avatar is playing in this tab
    // must survive the next hands-free recognition cycle, as the bare
    // speechSynthesis path always did.
    return fetch('/api/voice/stop-speaking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason }),
    }).catch(function () {
      // Best effort only — see module doc on why this call is unconditional.
    });
  }

  function setListening(isListening) {
    state.listening = isListening;
    var micButton = document.getElementById('ask-mic');
    if (micButton) micButton.setAttribute('aria-pressed', isListening ? 'true' : 'false');
    renderAboutCard();
    syncAvatar();
  }

  function startRecognitionCycle(continuous) {
    if (!SpeechRecognitionCtor || recognition) return;
    suppressRecognitionRestart = false;
    var finalTranscript = '';
    var instance = new SpeechRecognitionCtor();
    recognition = instance;
    instance.lang = state.locale === 'ja' ? 'ja-JP' : 'en-US';
    instance.interimResults = true;
    instance.continuous = Boolean(continuous);

    instance.onstart = function () {
      setListening(true);
    };
    instance.onresult = function (event) {
      var finals = '';
      var interim = '';
      for (var index = event.resultIndex; index < event.results.length; index += 1) {
        var part = (event.results[index][0] && event.results[index][0].transcript) || '';
        if (event.results[index].isFinal) finals += part;
        else interim += part;
      }
      finalTranscript = (finalTranscript + ' ' + finals).trim();
      var input = document.getElementById('ask-input');
      if (input) input.value = (finalTranscript + ' ' + interim).trim();
    };
    instance.onerror = function () {
      recognition = null;
      setListening(false);
    };
    instance.onend = function () {
      recognition = null;
      setListening(false);
      var transcript = finalTranscript.trim();
      finalTranscript = '';
      if (transcript) sendText(transcript);
      if (state.handsFree && !suppressRecognitionRestart) {
        window.setTimeout(function () {
          if (!state.handsFree || suppressRecognitionRestart) return;
          stopSpeakingBestEffort('hands_free_barge_in').then(function () {
            if (state.handsFree && !suppressRecognitionRestart) startRecognitionCycle(false);
          });
        }, 400);
      }
    };
    instance.start();
  }

  function stopRecognitionCycle() {
    suppressRecognitionRestart = true;
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        // Best effort only.
      }
    }
    recognition = null;
    setListening(false);
  }

  function wireMic() {
    var micButton = document.getElementById('ask-mic');
    if (!micButton) return;
    micButton.addEventListener('click', function () {
      unlockAvatarAudio();
      if (state.listening) {
        stopRecognitionCycle();
        return;
      }
      startRecognitionCycle(false);
    });
  }

  function wireHandsFree() {
    var button = document.getElementById('handsfree-toggle');
    if (!button) return;
    button.addEventListener('click', function () {
      unlockAvatarAudio();
      state.handsFree = !state.handsFree;
      renderHandsFreeToggle();
      if (state.handsFree) {
        stopSpeakingBestEffort('hands_free_enable').then(function () {
          if (state.handsFree) startRecognitionCycle(false);
        });
      } else {
        stopRecognitionCycle();
        if (state.avatar) state.avatar.stop();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Wiring + boot
  // ---------------------------------------------------------------------

  function wireForm() {
    var form = document.getElementById('ask-form');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      unlockAvatarAudio();
      var input = document.getElementById('ask-input');
      sendText(input ? input.value : '');
    });
  }

  function wireHearingDecision() {
    var button = document.getElementById('hearing-decide');
    if (button) button.addEventListener('click', decideHearing);
    var handoffButton = document.getElementById('hearing-handoff');
    // WI-08: the same button confirms either the governed hand-off or a
    // work-inventory save, depending on the current scenario — see
    // `isWorkInventoryScenario`/`renderHearingHandoff`.
    if (handoffButton) {
      handoffButton.addEventListener('click', function () {
        if (isWorkInventoryScenario(state.hearingRecord)) saveWorkInventory();
        else handoffHearing();
      });
    }
  }

  function wireChips() {
    document.querySelectorAll('.ask-chip').forEach(function (button) {
      button.addEventListener('click', function () {
        var key = button.getAttribute('data-chip');
        var textKey = {
          email: 'chip_email',
          minutes: 'chip_minutes',
          browser: 'chip_browser',
          webapp: 'chip_webapp',
        }[key];
        var template = textKey ? vt(state.vocab, 'front_desk:' + textKey) : '';
        var input = document.getElementById('ask-input');
        if (input) {
          input.value = template;
          input.focus();
        }
      });
    });
  }

  // Picks up the three hand-offs `static/home.js`'s ask box sends here:
  // `?ask=<text>&send=1` (send immediately), `?ask=<text>` alone (prefill
  // only, e.g. a chip template), and `?mic=1` (open the mic, from the home
  // page's own mic button).
  function applyUrlPrefill() {
    try {
      var params = new URLSearchParams(window.location.search);
      // A resume URL is always read-only, even when unrelated prefill parameters are present.
      if (params.has('request')) return;
      var ask = params.get('ask');
      var mic = params.get('mic') === '1';
      if (ask) {
        var input = document.getElementById('ask-input');
        if (input) input.value = ask;
        if (params.get('send') === '1') sendText(ask);
      }
      if (mic && SpeechRecognitionCtor) startRecognitionCycle(false);
      if (ask || mic) {
        params.delete('ask');
        params.delete('mic');
        params.delete('send');
        var query = params.toString();
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + (query ? '?' + query : '') + window.location.hash
        );
      }
    } catch (err) {
      // Best effort only.
    }
  }

  function mount() {
    state.locale = normalizeLocale();
    try {
      var hearingParams = new URLSearchParams(window.location.search);
      state.hearingMode = hearingParams.get('mode') === 'hearing';
      // WI-08: `?scenario=` picks the hearing scenario (`work_inventory`,
      // ...); defaults to `web_app_build` when absent/unrecognized-empty.
      var scenarioParam = hearingParams.get('scenario');
      if (scenarioParam) state.hearingScenarioId = scenarioParam;
    } catch (err) {
      state.hearingMode = false;
    }
    wireForm();
    wireMic();
    wireHandsFree();
    wireChips();
    wireHearingDecision();

    Promise.resolve(window.FrontDeskRail && window.FrontDeskRail.ready)
      .then(function () {
        return Promise.all([
          fetchJson('/api/ask-vocabulary?locale=' + encodeURIComponent(state.locale)),
          fetchJson(scopedUrl('/api/progress')),
        ]);
      })
      .then(function (pair) {
        var vocabResult = pair[0];
        var progressResult = pair[1];
        if (vocabResult.ok && vocabResult.body && vocabResult.body.ok) {
          state.vocab = vocabResult.body.texts || {};
        }
        render();
        loadHearing();
        if (progressResult.ok && progressResult.body && progressResult.body.ok) {
          renderRecent(progressResult.body.active || []);
        }
        var input = document.getElementById('ask-input');
        if (input) input.addEventListener('input', saveDraft);
        var legacy = loadTurns();
        var archive = document.getElementById('conversation-legacy');
        var archiveTurns = document.getElementById('conversation-legacy-turns');
        if (legacy.length && archive && archiveTurns) {
          archive.classList.remove('hidden');
          archiveTurns.innerHTML = legacy
            .map(function (turn) {
              return '<li>' + escapeHtml(turn.text) + '</li>';
            })
            .join('');
        }
        restoreConversation(true).then(applyUrlPrefill);
      })
      .catch(function () {
        // The ask page is additive chrome around the rail — a fetch failure
        // must never throw and break the rest of the page.
        render();
      });
  }

  window.KyberionAsk = { mount: mount, attachAvatar: attachAvatar };
})();
