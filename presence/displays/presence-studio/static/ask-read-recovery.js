/* Ask read recovery: bounded GETs, current history, vocabulary and recent projection. */
/* global window, document */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var fetch = options.fetch;
    var historySequence = 0;
    var scopedUrl = options.scopedUrl;
    var renderRecent = options.renderRecent;
    var vt = options.vt;
    var startupLoading = document.getElementById('ask-startup-loading');
    var startupLoadingText = startupLoading ? startupLoading.textContent : '';
    // GET-only deadline includes response parsing. POST semantics stay in ask.js.
    function fetchReadJson(url) {
      return new Promise(function (resolve, reject) {
        var controller = window.AbortController ? new window.AbortController() : null;
        var timer = window.setTimeout(function () {
          reject(new Error('Read timed out'));
          if (controller) controller.abort();
        }, 20000);
        Promise.resolve()
          .then(function () {
            return fetch(url, {
              cache: 'no-store',
              signal: controller ? controller.signal : undefined,
            });
          })
          .then(function (response) {
            if (!response.ok) {
              // Denial headers remain authoritative even if the body stalls or is HTML.
              if (controller) controller.abort();
              return { ok: false, status: response.status, body: null };
            }
            return response.json().then(function (body) {
              return { ok: response.ok, status: response.status, body: body };
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
            }
          );
      });
    }

    function restoreConversation(restoreDraft) {
      if (state.historyReadPending || state.sending) return Promise.resolve(false);
      var sequence = ++historySequence;
      state.historyReadPending = true;
      state.historyState = 'loading';
      state.errorKey = null;
      options.renderConversationStatus();
      return fetchReadJson(scopedUrl('/api/conversation'))
        .then(function (result) {
          if (sequence !== historySequence) return false;
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
              return (
                m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'secretary')
              );
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
            var savedDraft = window.sessionStorage.getItem(options.draftKey());
            var savedRaw = window.sessionStorage.getItem(options.draftKey() + '.request');
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
            if ((restoreDraft || !state.draftRestored) && input && !state.draftEdited)
              input.value = savedDraft || input.value;
            state.draftRestored = true;
            // Early edits, including deliberate clearing, outrank delayed restoration.
            // Retry after an initial history failure also reaches this verified boundary.
            if (state.draftEdited) options.saveDraft();
          } catch (err) {
            state.storageVerified = false;
            state.errorKey = 'front_desk:conversation_storage_required';
          }
          state.historyReadPending = false;
          options.render();
          if (state.storageVerified) options.onHistoryReady();
          return state.storageVerified;
        })
        .catch(function () {
          if (sequence !== historySequence) return false;
          state.historyReadPending = false;
          state.historyState = 'failed';
          options.render();
          return false;
        });
    }

    // These labels make the initial composer and its recovery actions usable.
    // An empty or partial successful response is not a usable vocabulary bundle.
    var REQUIRED_BOOT_LABELS = [
      'front_desk:home_ask_placeholder',
      'front_desk:home_ask_send',
      'front_desk:home_ask_voice',
      'front_desk:ask_placeholder_followup',
      'front_desk:ask_about_title',
      'front_desk:ask_empty',
      'front_desk:ask_handsfree_on',
      'front_desk:ask_handsfree_off',
      'front_desk:ask_recent',
      'front_desk:ask_recent_loading',
      'front_desk:ask_recent_failed',
      'front_desk:ask_recent_retry',
      'front_desk:chip_email',
      'front_desk:chip_minutes',
      'front_desk:chip_browser',
      'front_desk:chip_webapp',
      'front_desk:nav_progress',
      'front_desk:nav_settings',
      'concierge:dock.history.loading',
      'concierge:dock.history.failed',
      'concierge:dock.history.retry',
    ];
    function hasBootVocabulary(texts) {
      return (
        texts &&
        typeof texts === 'object' &&
        !Array.isArray(texts) &&
        REQUIRED_BOOT_LABELS.every(function (key) {
          return typeof texts[key] === 'string' && texts[key].trim().length > 0;
        })
      );
    }

    function renderRecentRead() {
      if (!state.vocabularyReady) return;
      var loading = state.recentPhase === 'loading';
      var failed = state.recentPhase === 'failed';
      var ready = state.recentPhase === 'ready';
      var card = document.getElementById('recent-card');
      if (card) card.classList.toggle('hidden', ready && state.recentItems.length === 0);
      var list = document.getElementById('recent-list');
      if (list) {
        list.hidden = !ready;
        if (!ready) list.innerHTML = '';
        list.setAttribute('aria-busy', String(loading));
      }
      var status = document.getElementById('recent-status');
      if (status) status.hidden = ready;
      var pending = document.getElementById('recent-loading');
      if (pending) {
        pending.hidden = !loading;
        pending.textContent = vt(state.vocab, 'front_desk:ask_recent_loading');
      }
      var error = document.getElementById('recent-error');
      if (error) {
        error.hidden = !failed;
        error.textContent = vt(state.vocab, 'front_desk:ask_recent_failed');
      }
      var retry = document.getElementById('recent-retry');
      if (retry) {
        retry.hidden = ready || !state.recentFailedOnce;
        retry.disabled = loading;
        retry.textContent = vt(state.vocab, 'front_desk:ask_recent_retry');
      }
      if (ready) renderRecent(state.recentItems);
    }

    function refreshRecent() {
      var sequence = ++state.recentSequence;
      state.recentPhase = 'loading';
      state.recentItems = [];
      renderRecentRead();
      return fetchReadJson(scopedUrl('/api/progress'))
        .then(function (result) {
          if (sequence !== state.recentSequence) return;
          if (!result.ok || !result.body || !result.body.ok || !Array.isArray(result.body.active))
            throw new Error('Recent requests unavailable');
          state.recentPhase = 'ready';
          state.recentItems = result.body.active;
          renderRecentRead();
        })
        .catch(function () {
          if (sequence !== state.recentSequence) return;
          state.recentPhase = 'failed';
          state.recentItems = [];
          state.recentFailedOnce = true;
          renderRecentRead();
        });
    }

    function renderStartup() {
      var host = document.getElementById('ask-startup-status');
      if (host) {
        host.hidden = state.vocabularyReady;
        host.setAttribute(
          'aria-busy',
          state.startupReadPending && !state.shellBlockedMessage ? 'true' : 'false'
        );
      }
      var loading = document.getElementById('ask-startup-loading');
      if (loading) {
        loading.hidden = state.startupFailed && !state.startupReadPending;
        loading.textContent = state.shellBlockedMessage || startupLoadingText;
      }
      var error = document.getElementById('ask-startup-error');
      if (error) error.hidden = !state.startupFailed || state.startupReadPending;
      var retry = document.getElementById('ask-startup-retry');
      if (retry) {
        retry.hidden = !state.startupFailed;
        retry.disabled = state.startupReadPending;
      }
      var send = document.getElementById('ask-send');
      if (send && !state.vocabularyReady) send.disabled = true;
    }

    function observeShell() {
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function (shell) {
          state.shellBlockedMessage = shell.phase === 'blocked' ? shell.message : '';
          renderStartup();
          var recent = document.getElementById('recent-card');
          if (recent && !state.vocabularyReady) recent.hidden = Boolean(state.shellBlockedMessage);
        });
    }

    return {
      restoreConversation: restoreConversation,
      observeShell: observeShell,
      renderStartup: renderStartup,
      fetchJson: fetchReadJson,
      hasBootVocabulary: hasBootVocabulary,
      renderRecent: renderRecentRead,
      refreshRecent: refreshRecent,
    };
  }
  window.KyberionAskReadRecovery = { create: create };
})();
