/* Ask read recovery: bounded GETs, usable startup vocabulary and optional recent projection. */
/* global window, document */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var fetchJson = options.fetchJson;
    var scopedUrl = options.scopedUrl;
    var renderRecent = options.renderRecent;
    var vt = options.vt;
    // Only read-only startup/projection requests use this bounded wait. No mutation retries.
    function fetchReadJson(url) {
      return new Promise(function (resolve, reject) {
        var controller = window.AbortController ? new window.AbortController() : null;
        var timer = window.setTimeout(function () {
          reject(new Error('Read timed out'));
          if (controller) controller.abort();
        }, 20000);
        fetchJson(url, {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }).then(
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
      if (host) host.hidden = state.vocabularyReady;
      var loading = document.getElementById('ask-startup-loading');
      if (loading) loading.hidden = state.startupFailed && !state.startupReadPending;
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

    return {
      renderStartup: renderStartup,
      fetchJson: fetchReadJson,
      hasBootVocabulary: hasBootVocabulary,
      renderRecent: renderRecentRead,
      refreshRecent: refreshRecent,
    };
  }
  window.KyberionAskReadRecovery = { create: create };
})();
