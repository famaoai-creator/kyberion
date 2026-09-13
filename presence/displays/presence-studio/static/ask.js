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
 * The turn list persists in `sessionStorage` (last 20 turns, one random
 * `session_id` per tab) so a reload keeps the conversation — this is
 * intentionally per-tab, not a server-side conversation log.
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
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-03 and docs/USER_EXPERIENCE_CONTRACT.md.
 */
/* global window, document, navigator, fetch, sessionStorage, URLSearchParams */
(function () {
  'use strict';

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  var TURNS_STORAGE_KEY = 'kyberion.ask.turns';
  var SESSION_STORAGE_KEY = 'kyberion.ask.session_id';
  var MAX_TURNS = 20;

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

  function normalizeLocale() {
    var raw = String((navigator && navigator.language) || 'en').toLowerCase();
    return raw.indexOf('ja') === 0 ? 'ja' : 'en';
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
    return 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
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

  function saveTurns(turns) {
    try {
      window.sessionStorage.setItem(TURNS_STORAGE_KEY, JSON.stringify(turns.slice(-MAX_TURNS)));
    } catch (err) {
      // Best effort only — the conversation still works for this page view.
    }
  }

  var state = {
    vocab: {},
    locale: 'en',
    sessionId: readSessionId(),
    turns: loadTurns(),
    sending: false,
    listening: false,
    handsFree: false,
    hearingMode: false,
    hearingRecord: null,
  };

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
    listEl.innerHTML = (items || [])
      .slice(0, 3)
      .map(function (item) {
        return (
          '<li><a class="ask-recent-row" href="/progress#' +
          encodeURIComponent(item.id) +
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

  function turnHtml(turn) {
    var roleClass = turn.role === 'user' ? 'ask-turn-user' : 'ask-turn-companion';
    var shapeLabel = vt(state.vocab, turnShapeLabelKey(turn.shape)) || humanizeSlug(turn.shape);
    var shapeHtml =
      turn.role === 'companion' && turn.shape && turn.shape !== 'reply'
        ? '<span class="ask-turn-shape">' + escapeHtml(shapeLabel) + '</span>'
        : '';
    var actionsHtml = '';
    if (turn.role === 'companion' && Array.isArray(turn.next_actions) && turn.next_actions.length) {
      actionsHtml =
        '<div class="ask-turn-next-actions">' +
        turn.next_actions
          .map(function (action) {
            var label = quickReplyLabel(action);
            return (
              '<button type="button" class="ask-quick-reply" data-quick-reply="' +
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
      '"><div class="ask-bubble">' +
      escapeHtml(turn.text) +
      '</div>' +
      shapeHtml +
      actionsHtml +
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
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = state.turns.map(turnHtml).join('');
    wireQuickReplies();
    scrollConversationToBottom();
  }

  function render() {
    renderInputShell();
    renderHandsFreeToggle();
    renderAboutCard();
    renderTurns();
    renderHearing();
  }

  function renderHearing() {
    var card = document.getElementById('hearing-card');
    if (!card) return;
    card.classList.toggle('hidden', !state.hearingMode);
    if (!state.hearingMode) return;
    var record = state.hearingRecord;
    var coverage = document.getElementById('hearing-coverage');
    var canvas = document.getElementById('hearing-canvas');
    var decide = document.getElementById('hearing-decide');
    if (coverage) {
      var complete = record
        ? record.requirements.filter(function (item) {
            return Boolean(item.answer);
          }).length
        : 0;
      var total = record ? record.requirements.length : 0;
      coverage.textContent = complete + '/' + total + ' 項目が埋まっています';
      if (decide) decide.classList.toggle('hidden', complete !== total || Boolean(record && record.decided_at));
    }
    if (canvas && record && record.canvas_url && canvas.getAttribute('src') !== record.canvas_url) {
      canvas.setAttribute('src', record.canvas_url);
    }
  }

  function loadHearing() {
    if (!state.hearingMode) return;
    fetchJson('/api/hearing/' + encodeURIComponent(state.sessionId))
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          state.hearingRecord = result.body.record;
          renderHearing();
        }
      })
      .catch(function () {
        /* hearing is additive to the conversation */
      });
  }

  function decideHearing() {
    if (!state.hearingMode || !state.hearingRecord) return;
    fetchJson('/api/hearing/' + encodeURIComponent(state.sessionId) + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(function (result) {
      if (result.ok && result.body && result.body.ok) {
        state.hearingRecord = result.body.record;
        renderHearing();
      }
    }).catch(function () { /* the record remains available for retry */ });
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
    saveTurns(state.turns);
  }

  function speakReply(text) {
    if (!state.handsFree) return;
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
    fetchJson('/api/progress')
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

  function sendText(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed || state.sending) return;

    pushTurn({ role: 'user', text: trimmed });
    state.sending = true;
    render();

    var input = document.getElementById('ask-input');
    if (input) input.value = '';

    fetchJson('/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, locale: state.locale, session_id: state.sessionId }),
    })
      .then(function (result) {
        var body = result.body || {};
        if (!result.ok || !body.ok || typeof body.reply !== 'string') {
          throw new Error('conversation request failed');
        }
        pushTurn({
          role: 'companion',
          text: body.reply,
          shape: body.shape,
          next_actions: body.next_actions,
          intent_resolution: body.intent_resolution,
          intent_label: body.intent_label,
          intent_label_source: body.intent_label_source,
        });
        return updateHearing(trimmed, body.intent_resolution).catch(function () {
          // The conversation remains usable when the hearing record is unavailable.
        });
      })
      .then(function () {
        speakReply(state.turns[state.turns.length - 1]?.text || '');
        refreshRecent();
      })
      .catch(function () {
        pushTurn({ role: 'companion', text: vt(state.vocab, 'front_desk:ask_send_failed') });
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
      state.handsFree = !state.handsFree;
      renderHandsFreeToggle();
      if (state.handsFree) {
        stopSpeakingBestEffort('hands_free_enable').then(function () {
          if (state.handsFree) startRecognitionCycle(false);
        });
      } else {
        stopRecognitionCycle();
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
      var input = document.getElementById('ask-input');
      sendText(input ? input.value : '');
    });
  }

  function wireHearingDecision() {
    var button = document.getElementById('hearing-decide');
    if (button) button.addEventListener('click', decideHearing);
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
      var ask = params.get('ask');
      var mic = params.get('mic') === '1';
      if (ask) {
        var input = document.getElementById('ask-input');
        if (input) input.value = ask;
        if (params.get('send') === '1') sendText(ask);
      }
      if (mic && SpeechRecognitionCtor) startRecognitionCycle(false);
      if (ask || mic) window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      // Best effort only.
    }
  }

  function mount() {
    state.locale = normalizeLocale();
    try {
      state.hearingMode = new URLSearchParams(window.location.search).get('mode') === 'hearing';
    } catch (err) {
      state.hearingMode = false;
    }
    wireForm();
    wireMic();
    wireHandsFree();
    wireChips();
    wireHearingDecision();

    Promise.all([
      fetchJson('/api/ask-vocabulary?locale=' + encodeURIComponent(state.locale)),
      fetchJson('/api/progress'),
    ])
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
        applyUrlPrefill();
      })
      .catch(function () {
        // The ask page is additive chrome around the rail — a fetch failure
        // must never throw and break the rest of the page.
        render();
      });
  }

  window.KyberionAsk = { mount: mount };
})();
