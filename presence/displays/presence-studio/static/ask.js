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
 * Voice uses browser SpeechRecognition; dedicated engine controls remain on /work.
 * Hands-free cycles send a best-effort stop-speaking request before recognition.
 * Replies speak only with hands-free enabled. The attached partner avatar prefers
 * voice-hub synthesis with analyser lip-sync, then speechSynthesis as a fallback.
 * Send, mic and hands-free gestures unlock avatar audio for autoplay policies.
 * Voice-hub bridge auto-reply remains independent from this browser's controls.
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-03 and docs/USER_EXPERIENCE_CONTRACT.md.
 */
/* global window, document, navigator, fetch, sessionStorage, URLSearchParams */
(function () {
  'use strict';

  // A missing helper is a delivery failure: retain SSR copy and offer a full-page GET retry.
  if (!window.KyberionAskReadRecovery) {
    var host = document.getElementById('ask-startup-status');
    if (host) host.hidden = false;
    var loading = document.getElementById('ask-startup-loading');
    if (loading) loading.hidden = true;
    var error = document.getElementById('ask-startup-error');
    if (error) error.hidden = false;
    var retry = document.getElementById('ask-startup-retry');
    if (retry) {
      retry.hidden = false;
      retry.disabled = false;
      retry.addEventListener('click', function () {
        window.location.reload();
      });
    }
    return;
  }

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

  // FD-01: the rail stores the chosen tenant; every same-origin API call carries
  // it as `?tenant=` so the server narrows to the tenant being viewed.
  function withTenant(url) {
    try {
      var slug = window.localStorage.getItem('front-desk.tenant');
      if (!slug || url.indexOf('/api/') !== 0 || url.indexOf('tenant=') !== -1) return url;
      return url + (url.indexOf('?') === -1 ? '?' : '&') + 'tenant=' + encodeURIComponent(slug);
    } catch (err) {
      return url;
    }
  }

  function fetchJson(url, options) {
    return fetch(withTenant(url), options).then(function (response) {
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
    vocabularyReady: false,
    startupReadPending: false,
    startupFailed: false,
    recentPhase: 'loading',
    recentFailedOnce: false,
    recentSequence: 0,
    recentItems: [],
    locale: 'en',
    sessionId: readSessionId(),
    turns: [],
    conversationId: null,
    historyState: 'loading',
    storageVerified: false,
    draftEdited: false,
    draftRestored: false,
    draftSaveFailed: false,
    draftRevision: 0,
    homeDraftPreserved: false,
    proposedDraft: null,
    // Server history owns this aggregate; local send uncertainty lives in errorKey/pendingRequest.
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
    // Server-issued canvas URL (versioned so the iframe reloads when a new canvas exists).
    hearingCanvasUrl: null,
    // Phase-structured sheet: the current phase (server-resolved title + counts).
    hearingPhase: null,
    // HT-02: bounded retry while the record's canvas is still `pending`.
    hearingCanvasPollTries: 0,
    // HT-03 (2nd half): local hand-off UI state — `null` before the operator
    // clicks the button; `{ pending: true }` mid-request; then either
    // `{ refId, href }` (server request id + same-tab decide link) or
    // `{ failed: true }`.
    hearingHandoff: null,
    hearingCompletion: null,
    // WI-08: same shape as `hearingHandoff` above, for the `work_inventory`
    // scenario's "save to the work inventory" confirm action —
    // `{ entryId, href }` on success.
    hearingInventory: null,
    // PA-09: the talking avatar handle (null until ask.html attaches it).
    avatar: null,
  };

  var activeSend = null;
  var activeStartup = null;
  function retireStartup() {
    activeStartup = null;
    state.startupReadPending = false;
  }
  function retireSend() {
    var previous = activeSend;
    activeSend = null;
    state.sending = false;
    if (previous && previous.cancel) previous.cancel();
  }

  var readRecovery = window.KyberionAskReadRecovery.create({
    state: state,
    fetch: fetch,
    render: render,
    renderConversationStatus: renderConversationStatus,
    draftKey: draftKey,
    randomId: randomId,
    saveDraft: saveDraft,
    onHistoryReady: applyUrlPrefill,
    onConversationRestored: function () {
      if (!hearingRecovery) return;
      hearingRecovery.load().then(function (accepted) {
        // A hearing opens with the companion's first question, so the person
        // knows what to answer instead of facing an empty box.
        if (accepted && state.turns.length === 0 && state.hearingPrompt) {
          pushTurn({ role: 'companion', text: state.hearingPrompt });
          render();
        }
      });
    },
    retireSend: retireSend,
    retireStartup: retireStartup,
    restoreConversation: restoreConversation,
    loadStartup: loadStartup,
    proposeDraft: proposeDraft,
    cancelDraftChoice: cancelDraftChoice,
    scopedUrl: scopedUrl,
    renderRecent: renderRecent,
    escapeHtml: escapeHtml,
    vt: vt,
  });
  var fetchReadJson = readRecovery.fetchJson;
  var fetchConversationJson = readRecovery.fetchConversationJson;
  function restoreConversation(restoreDraft) {
    if (state.historyReadPending || state.sending) return Promise.resolve(false);
    if (nextActions) nextActions.retire();
    return readRecovery.restoreConversation(restoreDraft);
  }
  var hasBootVocabulary = readRecovery.hasBootVocabulary;
  var refreshRecent = readRecovery.refreshRecent;
  var renderStartup = readRecovery.renderStartup;

  var correction =
    window.KyberionAskCorrection &&
    window.KyberionAskCorrection.create({
      state: state,
      fetchJson: fetchReadJson,
      scopedUrl: scopedUrl,
      proposeDraft: proposeDraft,
      vt: vt,
    });

  var hearingRecovery =
    window.KyberionAskHearingRecovery &&
    window.KyberionAskHearingRecovery.create({
      state: state,
      fetch: fetch,
      fetchReadJson: fetchReadJson,
      scopedUrl: scopedUrl,
      vt: vt,
      render: render,
      renderHearing: function () {
        if (state.vocabularyReady) renderHearing();
      },
      randomId: randomId,
    });
  var hearingCompletion =
    window.KyberionAskHearingCompletion &&
    window.KyberionAskHearingCompletion.create({
      state: state,
      vt: vt,
      scopedUrl: scopedUrl,
      formatTemplate: formatTemplate,
      isWorkInventoryScenario: isWorkInventoryScenario,
      hearingBlocked: hearingBlocked,
      hearingRecovery: hearingRecovery,
      fetchReadJson: fetchReadJson,
      fetchJson: fetchJson,
      renderHearing: renderHearing,
      render: render,
      randomId: randomId,
    });
  function hearingBlocked() {
    return (
      state.hearingMode &&
      (!hearingRecovery ||
        !hearingCompletion ||
        hearingRecovery.blocked() ||
        hearingCompletion.blocked())
    );
  }

  var nextActions =
    window.KyberionAskNextActions &&
    window.KyberionAskNextActions.create({
      state: state,
      vt: vt,
      scopedUrl: scopedUrl,
      escapeHtml: escapeHtml,
      proposeDraft: proposeDraft,
      cancelDraftChoice: cancelDraftChoice,
      renderTurns: renderTurns,
    });

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
      { key: 'process', textKey: 'front_desk:chip_process', icon: 'list' },
    ];
    chipDefs.forEach(function (def) {
      var button = document.querySelector('.ask-chip[data-chip="' + def.key + '"]');
      if (!button) return;
      button.disabled = state.historyState !== 'ready' || !state.storageVerified;
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
    button.textContent =
      vt(
        state.vocab,
        state.handsFree ? 'front_desk:ask_handsfree_on' : 'front_desk:ask_handsfree_off'
      ) ||
      button.getAttribute(state.handsFree ? 'data-label-on' : 'data-label-off') ||
      button.textContent;
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
    if (!state.vocabularyReady) return;
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
    if (match && target && !state.navigationResumed) {
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
    var actionsHtml = nextActions ? nextActions.render(turn) : '';
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
      readRecovery.renderNavigation(turn) +
      '</li>'
    );
  }

  function scrollConversationToBottom() {
    var scroller = document.getElementById('conversation-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
    if (nextActions) nextActions.wire();
    if (selectedRequest() && state.focusedRequest !== selectedRequest()) focusSelectedRequest();
    else scrollConversationToBottom();
  }

  function render() {
    // Until vocabulary is verified, retain the page's localized server-rendered labels.
    if (!state.vocabularyReady) return;
    renderInputShell();
    renderHandsFreeToggle();
    renderAboutCard();
    renderTurns();
    renderHearing();
    syncAvatar();
    renderConversationStatus();
    renderDraftChoice();
    if (hearingRecovery) hearingRecovery.render();
    if (hearingCompletion) hearingCompletion.renderDecision();
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
    if (generation === 'projected') return 'front_desk:hearing_canvas_projected';
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

  // The server marks a decision-ledger hearing on the record (`is_ledger`); the
  // client never re-derives that from the scenario id grammar.
  function isLedgerHearing() {
    return Boolean(state.hearingRecord && state.hearingRecord.is_ledger);
  }

  function renderHearingHandoff(record, ready) {
    if (hearingCompletion) hearingCompletion.render(record, ready);
  }

  function renderHearing() {
    var card = document.getElementById('hearing-card');
    if (!card) return;
    card.classList.toggle('hidden', !state.hearingMode);
    if (!state.hearingMode) return;
    var exit = document.getElementById('hearing-sync-continue');
    if (exit) exit.setAttribute('href', scopedUrl('/ask'));
    var record = state.hearingRecord;
    var titleEl = document.getElementById('hearing-title');
    if (titleEl) titleEl.textContent = vt(state.vocab, 'front_desk:hearing_title');
    var canvas = document.getElementById('hearing-canvas');
    if (canvas)
      canvas.setAttribute('title', vt(state.vocab, 'front_desk:hearing_canvas_frame_title'));
    var decide = document.getElementById('hearing-decide');
    if (decide) {
      decide.textContent = vt(state.vocab, 'front_desk:hearing_decide');
      decide.disabled = state.sending || hearingBlocked();
    }
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
        var overall = formatTemplate(vt(state.vocab, 'front_desk:hearing_coverage'), {
          done: done,
          total: total,
        });
        var phase = state.hearingPhase;
        coverage.textContent = phase
          ? formatTemplate(vt(state.vocab, 'front_desk:hearing_phase_progress'), {
              phase: phase.title,
              done: phase.complete,
              total: phase.total,
              index: phase.index,
              count: phase.count,
            }) +
            ' / ' +
            overall
          : overall;
        // A decision-ledger hearing may record part of its agenda; a greenfield
        // hearing still needs every requirement answered before "decide".
        var canDecide = isLedgerHearing() ? done > 0 : done === total;
        if (decide) decide.classList.toggle('hidden', !canDecide || Boolean(record.decided_at));
      }
    }
    var canvasUrl = state.hearingCanvasUrl;
    if (canvas && record && canvasUrl && canvas.getAttribute('src') !== canvasUrl) {
      canvas.setAttribute('src', canvasUrl);
    }
    renderHearingCanvasStatus(record);
    renderHearingHandoff(record, ready);
  }

  function decideHearing() {
    if (hearingCompletion) hearingCompletion.decide();
  }
  function handoffHearing() {
    if (hearingCompletion) hearingCompletion.handoff();
  }
  function saveWorkInventory() {
    if (hearingCompletion) hearingCompletion.inventory();
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
      state.avatar.speak(text, {
        lang: state.locale === 'ja' ? 'ja-JP' : 'en-US',
      });
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
      state.draftSaveFailed = window.sessionStorage.getItem(key) !== input.value;
    } catch (err) {
      state.draftSaveFailed = true;
    }
    renderDraftChoice();
    renderConversationStatus();
  }

  function renderDraftChoice() {
    var host = document.getElementById('draft-choice');
    if (host) host.hidden = !state.proposedDraft;
    var lengthWarning = document.getElementById('draft-length-warning');
    var input = document.getElementById('ask-input');
    if (lengthWarning) {
      lengthWarning.hidden = !(
        (input && input.value.length > 4000) ||
        (state.proposedDraft && state.proposedDraft.text.length > 4000)
      );
      lengthWarning.textContent = vt(state.vocab, 'front_desk:ask_draft_too_long');
    }
    var warning = document.getElementById('draft-storage-warning');
    if (warning) {
      warning.hidden = !state.draftSaveFailed;
      warning.textContent = vt(state.vocab, 'front_desk:ask_draft_not_saved');
    }
  }

  function cancelDraftChoice(focus, accepted) {
    var proposal = state.proposedDraft;
    state.proposedDraft = null;
    if (proposal && !accepted && proposal.onDismissed) proposal.onDismissed();
    renderDraftChoice();
    var input = document.getElementById('ask-input');
    if (focus && input) {
      input.focus();
      if (proposal && input.setSelectionRange && proposal.start !== null)
        input.setSelectionRange(proposal.start, proposal.end, proposal.direction);
    }
  }

  function editDraft(text, accepted) {
    var input = document.getElementById('ask-input');
    if (!input) return;
    state.draftEdited = true;
    state.draftRevision += 1;
    state.homeDraftPreserved = false;
    cancelDraftChoice(false, accepted);
    input.value = text;
    saveDraft();
  }

  function proposeDraft(text, isCurrent, onAccepted, onDismissed) {
    var input = document.getElementById('ask-input');
    if (!input || !text || state.historyState !== 'ready' || !state.storageVerified) return false;
    if (isCurrent && !isCurrent()) return false;
    cancelDraftChoice(false);
    if (isCurrent && !isCurrent()) return false;
    if (input.value.trim() && input.value !== text) {
      state.proposedDraft = {
        text: text,
        isCurrent: isCurrent,
        onAccepted: onAccepted,
        onDismissed: onDismissed,
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
      };
      var preview = document.getElementById('draft-choice-preview');
      if (preview) preview.textContent = text;
      renderDraftChoice();
      var keep = document.getElementById('draft-keep');
      if (keep) keep.focus();
    } else {
      editDraft(text);
      if (onAccepted) onAccepted();
      input.focus();
    }
    return true;
  }

  function wireDraft() {
    var input = document.getElementById('ask-input');
    if (input)
      input.addEventListener('input', function () {
        state.draftEdited = true;
        state.draftRevision += 1;
        state.homeDraftPreserved = false;
        cancelDraftChoice(false);
        saveDraft();
      });
    var keep = document.getElementById('draft-keep');
    if (keep)
      keep.addEventListener('click', function () {
        cancelDraftChoice(true);
      });
    var replace = document.getElementById('draft-replace');
    if (replace)
      replace.addEventListener('click', function () {
        if (!state.proposedDraft) return;
        if (state.proposedDraft.isCurrent && !state.proposedDraft.isCurrent()) {
          cancelDraftChoice(true);
          return;
        }
        var accepted = state.proposedDraft.onAccepted;
        editDraft(state.proposedDraft.text, true);
        if (accepted) accepted();
        if (input) input.focus();
      });
    function cancelOnEscape(event) {
      if (event.key === 'Escape' && state.proposedDraft) {
        event.preventDefault();
        cancelDraftChoice(true);
      }
    }
    var choice = document.getElementById('draft-choice');
    if (choice) choice.addEventListener('keydown', cancelOnEscape);
    if (input)
      input.addEventListener('keydown', function (event) {
        cancelOnEscape(event);
        if (
          event.key !== 'Enter' ||
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.isComposing ||
          event.keyCode === 229 ||
          event.repeat ||
          event.defaultPrevented
        )
          return;
        event.preventDefault();
        var form = document.getElementById('ask-form');
        if (form && form.requestSubmit) form.requestSubmit();
      });
  }

  function renderConversationStatus() {
    readRecovery.renderDraftRecovery();
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
    var input = document.getElementById('ask-input');
    if (send)
      send.disabled =
        state.sending ||
        hearingBlocked() ||
        state.historyState !== 'ready' ||
        !state.storageVerified ||
        Boolean(input && input.value.length > 4000);
    host.setAttribute('aria-busy', String(Boolean(state.historyReadPending)));
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
    var retry = document.getElementById('conversation-reload');
    retry.disabled = Boolean(state.historyReadPending || state.sending);
    retry.addEventListener('click', function () {
      restoreConversation(false);
    });
  }

  function sendText(text) {
    var trimmed = String(text || '').trim();
    if (
      !trimmed ||
      String(text || '').length > 4000 ||
      state.sending ||
      hearingBlocked() ||
      state.historyState !== 'ready' ||
      !state.conversationId ||
      !state.storageVerified
    )
      return;
    var request = readRecovery.prepareRequest(trimmed);
    if (!request) return;
    var composer = document.getElementById('ask-input');
    var ownsComposer = Boolean(composer && composer.value.trim() === trimmed);
    var draftRevision = state.draftRevision;
    var sentScope = readRecovery.scopeSnapshot();
    var sentEpoch = state.draftScopeEpoch;
    var sentShell = window.FrontDeskRail && window.FrontDeskRail.ready;
    var attempt = {};
    activeSend = attempt;
    function currentSend() {
      return (
        activeSend === attempt &&
        sentScope === readRecovery.scopeSnapshot() &&
        sentShell === (window.FrontDeskRail && window.FrontDeskRail.ready) &&
        state.draftShellReady !== false
      );
    }
    state.pendingRequest = request;
    state.sending = true;
    var actionAttempt = nextActions ? nextActions.begin() : null;
    state.errorKey = null;
    saveDraft();
    render();

    // A hearing is a question → answer sequence: the answer lands on the
    // requirement the companion asked about, and the companion's next turn is
    // the next open requirement (or "everything is filled in"). The generic
    // conversation path is not consulted here — its intent routing is for
    // requests, not for answers to the companion's own questions.
    if (state.hearingMode) {
      if (!hearingRecovery) {
        state.sending = false;
        render();
        return;
      }
      hearingRecovery
        .submit(trimmed, null)
        .then(function (accepted) {
          if (!accepted) throw new Error('hearing answer failed');
          pushTurn({ role: 'companion', text: state.hearingPrompt || '' });
          speakReply(state.hearingPrompt || '');
        })
        .catch(function () {
          pushTurn({ role: 'companion', text: vt(state.vocab, 'front_desk:ask_send_failed') });
        })
        .finally(function () {
          state.sending = false;
          render();
        });
      return;
    }

    var tenant =
      window.KyberionPrefs && window.KyberionPrefs.tenant ? window.KyberionPrefs.tenant() : null;
    var selectedScope = new URL(window.location.href).searchParams;
    fetchConversationJson(
      {
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
      },
      attempt
    )
      .then(function (result) {
        if (!currentSend()) return;
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
        readRecovery.bindNavigation(request.id, body.navigation, sentScope, sentEpoch);
        state.turns = state.turns.filter(function (turn) {
          return turn.id !== request.id + '-secretary';
        });
        var replyTurn = {
          id: request.id + '-secretary',
          role: 'companion',
          text: body.reply,
          shape: body.shape,
          intent_resolution: body.replayed ? undefined : body.intent_resolution,
          intent_label: body.intent_label,
          intent_label_source: body.intent_label_source,
        };
        pushTurn(replyTurn);
        if (nextActions) nextActions.bind(body, request, replyTurn, actionAttempt);
        readRecovery.completeRequest(request, sentScope);
        var input = document.getElementById('ask-input');
        if (
          ownsComposer &&
          draftRevision === state.draftRevision &&
          sentScope === readRecovery.scopeSnapshot() &&
          input &&
          input.value.trim() === trimmed
        )
          input.value = '';
        saveDraft();
        if (body.historySaved === false) state.errorKey = 'concierge:dock.history.unsaved';
        speakReply(body.reply);
        refreshRecent();
        if (!body.replayed && hearingRecovery)
          hearingRecovery.submit(trimmed, body.intent_resolution);
      })
      .catch(function () {
        if (!currentSend()) return;
        state.errorKey = 'concierge:dock.history.pending';
      })
      .finally(function () {
        if (activeSend !== attempt) return;
        activeSend = null;
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
      if (input) {
        cancelDraftChoice(false);
        input.value = (finalTranscript + ' ' + interim).trim();
      }
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
      cancelDraftChoice(false);
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
        // Hearing sheets are not text templates: they open the phase-structured
        // hearing for that sheet (hearing-scenarios catalog).
        var hearingScenario = { webapp: 'web_app_build', process: 'process_improvement' }[key];
        if (hearingScenario) {
          window.location.assign(
            '/ask?mode=hearing&scenario=' + encodeURIComponent(hearingScenario)
          );
          return;
        }
        var textKey = {
          email: 'chip_email',
          minutes: 'chip_minutes',
          browser: 'chip_browser',
        }[key];
        var template = textKey ? vt(state.vocab, 'front_desk:' + textKey) : '';
        proposeDraft(template);
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
      if (params.has('correction')) {
        if (correction) correction.apply();
        else {
          var status = document.getElementById('ask-correction-status');
          var retry = document.getElementById('ask-correction-retry');
          if (status) status.hidden = false;
          if (retry) retry.hidden = false;
        }
        return;
      }
      var ask = params.get('ask');
      var mic = params.get('mic') === '1';
      if (ask) {
        if (params.get('send') === '1') {
          if (state.pendingRequest && state.pendingRequest.text !== ask.trim()) {
            // Keep the new hand-off reviewable, but never replay it on reload.
            params.delete('send');
            window.history.replaceState(
              window.history.state,
              '',
              window.location.pathname + '?' + params.toString() + window.location.hash
            );
            state.errorKey = 'front_desk:ask_pending_send_blocked';
            proposeDraft(ask);
            renderConversationStatus();
            return;
          }
          var input = document.getElementById('ask-input');
          if (input && input.value.trim() && input.value.trim() !== ask.trim()) {
            state.homeDraftPreserved = true;
          } else editDraft(ask);
          sendText(ask);
          if (!state.sending) {
            // Readiness or storage failed: keep the text, never an auto-send instruction.
            params.delete('send');
            window.history.replaceState(
              window.history.state,
              '',
              window.location.pathname + '?' + params.toString() + window.location.hash
            );
            proposeDraft(ask);
            return;
          }
        } else if (!proposeDraft(ask)) {
          // Keep this hand-off in the URL until draft ownership can be checked.
          return;
        }
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
      var mountParams = new URLSearchParams(window.location.search);
      state.hearingMode = mountParams.get('mode') === 'hearing';
      // `?scenario=` names either a catalog sheet (WI-08: `work_inventory`,
      // `process_improvement`, …; `web_app_build` when absent) or, SD-02, a
      // `decisions-<case>-<actor>` ledger hearing whose items the server
      // resolves from the tenant ledger.
      var scenarioParam = mountParams.get('scenario') || '';
      // The ledger id is also the persisted `record.scenario`, which accepted
      // hearing responses are validated against.
      if (/^decisions-/.test(scenarioParam)) state.hearingScenarioRef = scenarioParam;
      if (scenarioParam) state.hearingScenarioId = scenarioParam;
    } catch (err) {
      state.hearingMode = false;
      state.hearingScenarioRef = '';
    }
    if (hearingRecovery) hearingRecovery.mount();
    if (hearingCompletion) hearingCompletion.mount();
    if (correction) correction.mount();
    else {
      var correctionRetry = document.getElementById('ask-correction-retry');
      if (correctionRetry)
        correctionRetry.addEventListener('click', function () {
          window.location.reload();
        });
    }
    wireDraft();
    wireForm();
    wireMic();
    wireHandsFree();
    wireChips();
    wireHearingDecision();

    var retryRecent = document.getElementById('recent-retry');
    if (retryRecent)
      retryRecent.addEventListener('click', function () {
        if (state.recentPhase === 'failed') refreshRecent();
      });
    var retryStartup = document.getElementById('ask-startup-retry');
    if (retryStartup) retryStartup.addEventListener('click', loadStartup);
    readRecovery.observeShell();
    if (nextActions) nextActions.mount();
    renderStartup();
    loadStartup();
  }

  function loadStartup() {
    if (state.vocabularyReady || state.startupReadPending) return;
    var attempt = {};
    activeStartup = attempt;
    state.startupReadPending = true;
    renderStartup();
    var ready = window.FrontDeskRail && window.FrontDeskRail.ready;
    function currentShell() {
      return (
        activeStartup === attempt && (!window.FrontDeskRail || ready === window.FrontDeskRail.ready)
      );
    }
    return Promise.resolve(ready)
      .then(function () {
        if (!currentShell()) throw new Error('Superseded shell');
        return fetchReadJson('/api/ask-vocabulary?locale=' + encodeURIComponent(state.locale));
      })
      .then(function (vocabResult) {
        if (!currentShell()) throw new Error('Superseded shell');
        var texts = vocabResult.body && vocabResult.body.texts;
        if (
          !vocabResult.ok ||
          !vocabResult.body ||
          !vocabResult.body.ok ||
          !hasBootVocabulary(texts)
        )
          throw new Error('Vocabulary unavailable');
        state.vocab = texts;
        state.vocabularyReady = true;
        state.startupReadPending = false;
        renderStartup();
        render();
        // Optional recent activity must never delay or block the conversation.
        refreshRecent();
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
        restoreConversation(true);
      })
      .catch(function () {
        if (!currentShell()) return;
        state.startupReadPending = false;
        state.startupFailed = true;
        renderStartup();
      });
  }

  window.KyberionAsk = { mount: mount, attachAvatar: attachAvatar };
})();
