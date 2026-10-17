/* Hearing answers are independent effects: retain identity until an exact read confirms them. */
/* global window, document */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var fetch = options.fetch;
    var generation = 0;
    var pending = null;
    var storageFailed = false;
    var activePost = null;
    var activeRead = null;
    var pollTimer = null;
    var hidden = false;
    var mounted = false;

    function key() {
      // The backend hearing record is session-owned, even when the UI scope changes.
      return 'kyberion.ask.hearing.pending.' + state.sessionId;
    }
    function validPending(value) {
      return Boolean(
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 4 &&
        ['requestId', 'conversationId', 'scope', 'scenarioId'].every(function (name) {
          return (
            typeof value[name] === 'string' && value[name].length > 0 && value[name].length <= 4096
          );
        })
      );
    }
    function identity(value) {
      return value
        ? JSON.stringify([value.requestId, value.conversationId, value.scope, value.scenarioId])
        : null;
    }
    function readPending(recheckStorage) {
      if (!state.hearingMode) return;
      try {
        if (
          !state.sessionId ||
          window.sessionStorage.getItem('kyberion.ask.session_id') !== state.sessionId
        )
          throw new Error('Hearing session was not retained');
        var raw = window.sessionStorage.getItem(key());
        var saved = raw === null ? null : JSON.parse(raw);
        if (raw !== null && !validPending(saved)) throw new Error('Invalid hearing correlation');
        // Disappearing storage is not evidence that a server mutation completed.
        if (!saved && pending) throw new Error('Hearing correlation was lost');
        pending = saved;
        if (recheckStorage) storageFailed = false;
      } catch (err) {
        storageFailed = true;
      }
    }
    function blocked() {
      if (!state.hearingMode) return false;
      readPending(false);
      return Boolean(pending || storageFailed);
    }
    function scopeMismatch() {
      // History supplies the server-owned conversation ID; wait for it before comparing.
      return Boolean(
        pending &&
        state.conversationId &&
        (pending.conversationId !== state.conversationId ||
          pending.scope !== options.scopedUrl('/api/conversation') ||
          pending.scenarioId !== state.hearingScenarioId)
      );
    }
    function usable() {
      return Boolean(
        state.hearingMode &&
        !hidden &&
        state.draftShellReady &&
        !state.shellBlockedMessage &&
        state.historyState === 'ready' &&
        state.conversationId
      );
    }
    function snapshot() {
      return JSON.stringify([
        window.location.pathname,
        window.location.search,
        window.location.hash,
        options.scopedUrl('/api/conversation'),
        state.sessionId,
        state.conversationId,
        state.hearingScenarioId,
        state.locale,
        state.draftScopeEpoch,
      ]);
    }
    function current(attempt) {
      return Boolean(
        attempt &&
        attempt.generation === generation &&
        usable() &&
        attempt.snapshot === snapshot() &&
        attempt.shell === (window.FrontDeskRail && window.FrontDeskRail.ready)
      );
    }
    function label(element, name) {
      var value = options.vt(state.vocab, 'front_desk:hearing_sync_' + name);
      // Immediate shell notifications precede vocabulary loading; retain SSR copy.
      if (element && value) element.textContent = value;
    }
    function render() {
      var locked = blocked();
      var busy = Boolean(locked && (current(activePost) || current(activeRead)));
      var phase = storageFailed
        ? 'storage'
        : scopeMismatch()
          ? 'scope'
          : busy
            ? 'pending'
            : 'unconfirmed';
      var host = document.getElementById('hearing-sync-status');
      if (host) {
        host.hidden = !locked;
        host.setAttribute('aria-busy', String(busy));
      }
      var text = document.getElementById('hearing-sync-text');
      if (locked) label(text, phase);
      var retry = document.getElementById('hearing-sync-retry');
      if (retry) {
        retry.hidden = !locked || phase === 'scope' || phase === 'storage';
        retry.disabled = busy || !usable();
        label(retry, 'retry');
      }
      var continuation = document.getElementById('hearing-sync-continue');
      if (continuation) {
        continuation.hidden = !locked;
        label(continuation, 'continue');
        // This GET exits hearing mode. It never clears or replays the pending effect.
        continuation.setAttribute('href', options.scopedUrl('/ask'));
      }
    }
    function publish() {
      render();
      options.renderHearing();
      options.render();
    }
    function clearPoll() {
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    function retire() {
      generation += 1;
      clearPoll();
      if (activePost && activePost.cancel) activePost.cancel();
      if (activeRead && activeRead.cancel) activeRead.cancel();
      activePost = null;
      activeRead = null;
    }
    function startAttempt() {
      retire();
      return {
        generation: generation,
        snapshot: snapshot(),
        shell: window.FrontDeskRail && window.FrontDeskRail.ready,
        pending: identity(pending),
      };
    }
    // The deadline includes headers and JSON parsing; cancellation never claims rollback.
    function bounded(attempt, timeout, operation, controller) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        }
        attempt.cancel = function () {
          finish(new Error('Hearing wait retired'));
          if (controller) controller.abort();
        };
        var timer = window.setTimeout(function () {
          finish(new Error('Hearing result unconfirmed'));
          if (controller) controller.abort();
        }, timeout);
        Promise.resolve()
          .then(function () {
            if (!current(attempt)) throw new Error('Stale hearing request');
            return operation();
          })
          .then(
            function (value) {
              finish(null, value);
            },
            function (error) {
              finish(error);
            }
          );
      });
    }
    function clearConfirmed(attempt) {
      try {
        readPending(false);
        if (storageFailed || !pending || identity(pending) !== attempt.pending) return false;
        // Re-read ownership immediately before removal and verify the removal itself.
        var saved = JSON.parse(window.sessionStorage.getItem(key()));
        if (!validPending(saved) || identity(saved) !== attempt.pending) return false;
        window.sessionStorage.removeItem(key());
        if (window.sessionStorage.getItem(key()) !== null)
          throw new Error('Confirmed hearing correlation was not cleared');
        pending = null;
        storageFailed = false;
        return true;
      } catch (err) {
        storageFailed = true;
        return false;
      }
    }
    function accept(attempt, result) {
      if (!current(attempt)) return false;
      readPending(false);
      if (storageFailed || identity(pending) !== attempt.pending) return false;
      var body = result && result.body;
      var record = body && body.record;
      if (
        !result ||
        !result.ok ||
        !body ||
        body.ok !== true ||
        !record ||
        record.session_id !== state.sessionId ||
        record.scenario !== state.hearingScenarioId ||
        !Array.isArray(record.requirements) ||
        !record.requirements.every(function (item) {
          return (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            (item.answer == null || typeof item.answer === 'string')
          );
        })
      )
        return false;
      if (
        pending &&
        record.requirements.some(function (item) {
          return item.source_turn === pending.requestId;
        })
      ) {
        if (!clearConfirmed(attempt)) return false;
      }
      state.hearingRecord = record;
      return !pending;
    }
    function scheduleCanvas(attempt) {
      if (!current(attempt) || blocked()) return;
      var record = state.hearingRecord;
      if (!record || record.canvas_generation !== 'pending') {
        state.hearingCanvasPollTries = 0;
        return;
      }
      if ((state.hearingCanvasPollTries || 0) >= 10) return;
      state.hearingCanvasPollTries = (state.hearingCanvasPollTries || 0) + 1;
      pollTimer = window.setTimeout(function () {
        pollTimer = null;
        if (current(attempt)) load();
      }, 3000);
    }
    function load() {
      if (!state.hearingMode) return Promise.resolve(false);
      readPending(true);
      if (!usable() || storageFailed || scopeMismatch()) {
        publish();
        return Promise.resolve(false);
      }
      if (current(activePost)) return Promise.resolve(false);
      if (current(activeRead)) return activeRead.promise;
      var attempt = startAttempt();
      activeRead = attempt;
      publish();
      attempt.promise = bounded(attempt, 20000, function () {
        return options.fetchReadJson(
          options.scopedUrl(
            '/api/hearing/' +
              encodeURIComponent(state.sessionId) +
              '?locale=' +
              encodeURIComponent(state.locale) +
              '&scenario_id=' +
              encodeURIComponent(state.hearingScenarioId)
          )
        );
      })
        .then(function (result) {
          return accept(attempt, result);
        })
        .catch(function () {
          return false;
        })
        .finally(function () {
          if (activeRead !== attempt) return;
          activeRead = null;
          if (current(attempt)) scheduleCanvas(attempt);
          publish();
        });
      return attempt.promise;
    }
    function submit(text, intentResolution) {
      try {
        if (!state.hearingMode) return Promise.resolve(false);
        if (blocked() || !usable()) {
          publish();
          return Promise.resolve(false);
        }
        pending = {
          requestId: options.randomId(),
          conversationId: state.conversationId,
          scope: options.scopedUrl('/api/conversation'),
          scenarioId: state.hearingScenarioId,
        };
        if (!validPending(pending)) throw new Error('Invalid hearing correlation');
        var serialized = JSON.stringify(pending);
        window.sessionStorage.setItem(key(), serialized);
        if (window.sessionStorage.getItem(key()) !== serialized)
          throw new Error('Hearing correlation was not retained');
        var attempt = startAttempt();
        activePost = attempt;
        state.hearingCanvasPollTries = 0;
        var controller = window.AbortController ? new window.AbortController() : null;
        var url = options.scopedUrl(
          '/api/hearing/' + encodeURIComponent(state.sessionId) + '/answer'
        );
        var request = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            request_id: pending.requestId,
            intent_resolution: intentResolution,
            locale: state.locale,
            scenario_id: state.hearingScenarioId,
          }),
          signal: controller ? controller.signal : undefined,
        };
        publish();
        return bounded(
          attempt,
          60000,
          function () {
            // Revalidate durable ownership before the only mutation; never replay it.
            readPending(false);
            if (storageFailed || identity(pending) !== attempt.pending)
              throw new Error('Hearing correlation changed');
            return fetch(url, request).then(function (response) {
              return response.json().then(function (body) {
                return { ok: response.ok, status: response.status, body: body };
              });
            });
          },
          controller
        )
          .then(function (result) {
            return accept(attempt, result);
          })
          .catch(function () {
            return false;
          })
          .finally(function () {
            if (activePost !== attempt) return;
            activePost = null;
            if (current(attempt)) scheduleCanvas(attempt);
            publish();
          });
      } catch (err) {
        storageFailed = true;
        retire();
        publish();
        return Promise.resolve(false);
      }
    }
    function mount() {
      if (mounted) return;
      mounted = true;
      var retry = document.getElementById('hearing-sync-retry');
      if (retry) retry.addEventListener('click', load);
      if (window.addEventListener) {
        window.addEventListener('popstate', function () {
          retire();
          publish();
        });
        window.addEventListener('pagehide', function () {
          hidden = true;
          retire();
          publish();
        });
        window.addEventListener('pageshow', function (event) {
          if (!event || !event.persisted) return;
          hidden = false;
          retire();
          publish();
          // Conversation restoration calls load once its history and shell are verified.
        });
      }
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function () {
          retire();
          publish();
        });
      render();
    }
    return { blocked: blocked, submit: submit, load: load, mount: mount, render: render };
  }
  window.KyberionAskHearingRecovery = { create: create };
})();
