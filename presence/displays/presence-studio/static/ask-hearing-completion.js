/* Completed hearing status and safe server-derived navigation. */
/* global window, document, URL */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var hearingRecovery = options.hearingRecovery;
    var fetchJson = options.fetchJson;
    var renderHearing = options.renderHearing;
    var vt = options.vt;
    var scopedUrl = options.scopedUrl;
    var formatTemplate = options.formatTemplate;
    var isWorkInventoryScenario = options.isWorkInventoryScenario;
    var hearingBlocked = options.hearingBlocked;
    // HT-03 (2nd half) / WI-08: the confirm button + its own local
    // request/result state, independent from the hearing record itself (the
    // next GET independently verifies the saved target — this keeps
    // the button responsive without waiting on that round trip). The same
    // `#hearing-handoff` button/status/link elements carry both confirm
    // actions — which one is live depends on `isWorkInventoryScenario`: the
    // governed hand-off (`hearingHandoff`/`front_desk:hearing_handoff_*`) for
    // every other scenario, the "save to the work inventory" confirm
    // (`hearingInventory`/`front_desk:hearing_inventory_*`) for `work_inventory`.
    // Destinations are server-derived and may use configured cross-surface HTTP origins.
    // Never turn a malformed/executable URL into a completion action.
    function hearingCompletionHref(value) {
      if (
        typeof value !== 'string' ||
        !value ||
        /[\\\x00-\x20\x7f]/.test(value) ||
        value.slice(0, 2) === '//'
      )
        return null;
      try {
        var url = new URL(value, window.location.href);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
          return null;
        if (
          ['send', 'mic', 'ask'].some(function (key) {
            return url.searchParams.has(key);
          })
        )
          return null;
        return scopedUrl(value);
      } catch (err) {
        return null;
      }
    }

    function restoredHearingCompletion(kind) {
      var value = state.hearingCompletion;
      if (value == null) return null;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.kind !== kind ||
        value.status !== 'ready' ||
        typeof value.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.id)
      )
        return { unavailable: true };
      var href = hearingCompletionHref(value.next && value.next.href);
      if (!href) return { unavailable: true };
      return kind === 'inventory'
        ? { entryId: value.id, href: href }
        : { refId: value.id, href: href };
    }

    function renderHearingHandoff(record, ready) {
      var button = document.getElementById('hearing-handoff');
      var statusEl = document.getElementById('hearing-handoff-status');
      var linkEl = document.getElementById('hearing-handoff-link');
      if (!button || !statusEl || !linkEl) return;
      button.disabled = state.sending || hearingBlocked();
      statusEl.classList.add('hidden');
      linkEl.classList.add('hidden');
      linkEl.setAttribute('href', '');

      if (isWorkInventoryScenario(record)) {
        button.textContent = vt(state.vocab, 'front_desk:hearing_inventory_button');
        var inventory = restoredHearingCompletion('inventory') || state.hearingInventory;
        var alreadySaved =
          Boolean(inventory && inventory.entryId) ||
          Boolean(record && record.work_inventory_entry_id);
        button.classList.toggle(
          'hidden',
          !ready || alreadySaved || Boolean(state.hearingCompletion)
        );
        if (inventory && inventory.unavailable) {
          statusEl.textContent = vt(state.vocab, 'front_desk:hearing_completion_unavailable');
          statusEl.classList.remove('hidden');
          return;
        }
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
          var inventoryHref = hearingCompletionHref(inventory.href);
          if (inventoryHref) {
            linkEl.textContent = vt(state.vocab, 'front_desk:hearing_inventory_open');
            linkEl.setAttribute('href', inventoryHref);
            linkEl.classList.remove('hidden');
          }
        }
        return;
      }

      button.textContent = vt(state.vocab, 'front_desk:hearing_handoff_button');
      var handoff = restoredHearingCompletion('mission') || state.hearingHandoff;
      var alreadyHandedOff =
        Boolean(handoff && handoff.refId) || Boolean(record && record.mission_id);
      button.classList.toggle(
        'hidden',
        !ready || alreadyHandedOff || Boolean(state.hearingCompletion)
      );
      if (handoff && handoff.unavailable) {
        statusEl.textContent = vt(state.vocab, 'front_desk:hearing_completion_unavailable');
        statusEl.classList.remove('hidden');
        return;
      }
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
          formatTemplate(vt(state.vocab, 'front_desk:hearing_mission_label'), {
            id: handoff.refId,
          });
        statusEl.classList.remove('hidden');
        var handoffHref = hearingCompletionHref(handoff.href);
        if (handoffHref) {
          linkEl.textContent = vt(state.vocab, 'front_desk:hearing_open_decide');
          linkEl.setAttribute('href', handoffHref);
          linkEl.classList.remove('hidden');
        }
      }
    }

    function hearingActionContext() {
      return {
        snapshot: JSON.stringify([
          window.location.href,
          scopedUrl('/api/conversation'),
          state.sessionId,
          state.conversationId,
          state.hearingScenarioId,
          state.locale,
          state.draftScopeEpoch,
        ]),
        shell: window.FrontDeskRail && window.FrontDeskRail.ready,
      };
    }
    function settleRetiredHearingFailure(action, kind, result) {
      var value = state[kind];
      // A settled rejection can release its own guard without publishing an old payload.
      // GET absence alone never proves that an outstanding mutation failed.
      if (
        value &&
        value.action === action &&
        result &&
        !result.ok &&
        [400, 401, 403].indexOf(result.status) !== -1
      )
        state[kind] = null;
    }
    function hearingActionCurrent(action) {
      var current = hearingActionContext();
      return (
        state.draftShellReady &&
        !state.shellBlockedMessage &&
        action.snapshot === current.snapshot &&
        action.shell === current.shell
      );
    }

    // This marker is a local no-resend guard, not a server receipt. GET can
    // restore a destination but cannot correlate this particular decide POST.
    var decisions = Object.create(null);
    var decisionGeneration = 0;
    var decisionHidden = false;
    var decisionMounted = false;
    function decisionKey() {
      return 'kyberion.ask.hearing.decision.' + state.sessionId;
    }
    function decisionState() {
      var key = decisionKey();
      if (!decisions[key]) decisions[key] = { marker: null, failed: false, active: null };
      return decisions[key];
    }
    function decisionBlocked() {
      if (!state.hearingMode) return false;
      var local = decisionState();
      try {
        if (
          !state.sessionId ||
          window.sessionStorage.getItem('kyberion.ask.session_id') !== state.sessionId
        )
          throw new Error('Decision session was not retained');
        var raw = window.sessionStorage.getItem(decisionKey());
        if (raw === null && local.marker !== null) throw new Error('Decision correlation was lost');
        // Even corrupt/foreign markers block. Nothing in storage authorizes a resend.
        if (raw !== null) local.marker = raw;
      } catch (err) {
        local.failed = true;
      }
      return local.marker !== null || local.failed;
    }
    function decisionCurrent(action) {
      return (
        !decisionHidden && action.generation === decisionGeneration && hearingActionCurrent(action)
      );
    }
    function renderDecision() {
      var locked = decisionBlocked();
      var local = decisionState();
      var busy = Boolean(
        locked &&
        local.active &&
        local.marker === local.active.marker &&
        local.active.waiting &&
        decisionCurrent(local.active)
      );
      var phase = local.failed
        ? 'storage'
        : busy
          ? 'pending'
          : locked
            ? 'unknown'
            : local.rejected
              ? 'rejected'
              : null;
      var host = document.getElementById('hearing-decision-status');
      if (host) {
        host.hidden = !state.hearingMode || !phase;
        host.setAttribute('aria-busy', String(busy));
      }
      var text = document.getElementById('hearing-decision-text');
      var label = phase && vt(state.vocab, 'front_desk:hearing_decision_' + phase);
      if (text && label) text.textContent = label;
      var exit = document.getElementById('hearing-decision-continue');
      if (exit) {
        exit.hidden = !locked;
        exit.setAttribute('href', scopedUrl('/ask'));
        var exitLabel = vt(state.vocab, 'front_desk:hearing_decision_continue');
        if (exitLabel) exit.textContent = exitLabel;
      }
    }
    function publishDecision() {
      renderHearing();
      options.render();
    }
    function clearOwnDecision(action) {
      var local = decisions[action.key];
      try {
        if (
          !local ||
          local.failed ||
          local.marker !== action.marker ||
          window.sessionStorage.getItem(action.key) !== action.marker
        )
          return false;
        window.sessionStorage.removeItem(action.key);
        if (window.sessionStorage.getItem(action.key) !== null)
          throw new Error('Decision correlation was not cleared');
        local.marker = null;
        return true;
      } catch (err) {
        if (local) local.failed = true;
        return false;
      }
    }
    function validDecision(result, action) {
      var body = result && result.body;
      var record = body && body.record;
      return Boolean(
        result &&
        result.ok &&
        body &&
        body.ok === true &&
        record &&
        record.session_id === action.sessionId &&
        record.scenario === action.scenarioId &&
        typeof record.decided_at === 'string' &&
        record.decided_at.length > 0 &&
        Number.isFinite(Date.parse(record.decided_at)) &&
        record.decided_by &&
        record.decided_by.kind === 'human' &&
        typeof record.decided_by.id === 'string' &&
        record.decided_by.id.trim().length > 0 &&
        ['owner', 'approver'].indexOf(record.decided_by.role) !== -1 &&
        (record.decided_by.display_name == null ||
          typeof record.decided_by.display_name === 'string') &&
        typeof record.updated_at === 'string' &&
        Number.isFinite(Date.parse(record.updated_at)) &&
        Array.isArray(record.canvas_versions) &&
        record.canvas_versions.every(function (version) {
          return typeof version === 'string';
        }) &&
        Array.isArray(record.requirements) &&
        record.requirements.length > 0 &&
        record.requirements.every(function (item) {
          return (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.id === 'string' &&
            item.id.length > 0 &&
            typeof item.label_key === 'string' &&
            item.label_key.length > 0 &&
            typeof item.confidence === 'number' &&
            Number.isFinite(item.confidence) &&
            (item.source_turn == null || typeof item.source_turn === 'string') &&
            typeof item.answer === 'string' &&
            item.answer.trim().length > 0
          );
        })
      );
    }
    function mountDecision() {
      if (decisionMounted) return;
      decisionMounted = true;
      function retire() {
        decisionGeneration += 1;
        Object.keys(decisions).forEach(function (key) {
          var active = decisions[key].active;
          if (active) {
            active.waiting = false;
            window.clearTimeout(active.timer);
          }
        });
        publishDecision();
      }
      if (window.addEventListener) {
        window.addEventListener('pagehide', function () {
          decisionHidden = true;
          retire();
        });
        window.addEventListener('pageshow', function (event) {
          if (event && event.persisted) {
            decisionHidden = false;
            retire();
          }
        });
        window.addEventListener('popstate', retire);
        window.addEventListener('storage', function () {
          publishDecision();
        });
      }
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(retire);
    }
    function decideHearing() {
      if (
        !state.hearingMode ||
        !state.hearingRecord ||
        state.sending ||
        hearingBlocked() ||
        state.hearingCompletion ||
        state.hearingRecord.decided_at ||
        decisionHidden ||
        !state.draftShellReady ||
        state.shellBlockedMessage ||
        state.historyState !== 'ready' ||
        !state.conversationId
      )
        return;
      var local = decisionState();
      var action = hearingActionContext();
      action.generation = decisionGeneration;
      action.sessionId = state.sessionId;
      action.scenarioId = state.hearingScenarioId;
      action.key = decisionKey();
      try {
        action.marker = JSON.stringify({
          requestId: options.randomId(),
          conversationId: state.conversationId,
          scope: scopedUrl('/api/conversation'),
          scenarioId: state.hearingScenarioId,
        });
        local.marker = action.marker;
        window.sessionStorage.setItem(action.key, action.marker);
        if (window.sessionStorage.getItem(action.key) !== action.marker)
          throw new Error('Decision correlation was not retained');
      } catch (err) {
        local.failed = true;
        publishDecision();
        return;
      }
      if (hearingRecovery) hearingRecovery.beginCompletion();
      local.rejected = false;
      local.active = action;
      action.waiting = true;
      action.timer = window.setTimeout(function () {
        action.waiting = false;
        if (decisionCurrent(action)) {
          if (hearingRecovery) hearingRecovery.endCompletion();
          publishDecision();
        }
      }, 60000);
      publishDecision();
      // Dispatch synchronously only after durable ownership and the UI guard exist.
      var request;
      try {
        if (!decisionCurrent(action) || window.sessionStorage.getItem(action.key) !== action.marker)
          throw new Error('Decision context changed');
        request = fetchJson(
          '/api/hearing/' +
            encodeURIComponent(action.sessionId) +
            '/decide?locale=' +
            encodeURIComponent(state.locale),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        );
      } catch (err) {
        request = Promise.reject(err);
      }
      Promise.resolve(request)
        .then(function (result) {
          var success = validDecision(result, action);
          var rejected = result && !result.ok && [400, 401, 403].indexOf(result.status) !== -1;
          // A retired success cannot refresh the current record safely: retain its
          // guard rather than unlock a stale GET. A pre-write rejection may
          // release its own marker without publishing an old payload.
          if (((success && decisionCurrent(action)) || rejected) && clearOwnDecision(action)) {
            if (decisionCurrent(action)) {
              local.rejected = Boolean(rejected);
              if (success) state.hearingRecord = result.body.record;
            }
          }
        })
        .catch(function () {
          // Network, parse and server failures are ambiguous. Retain the marker.
        })
        .finally(function () {
          action.waiting = false;
          window.clearTimeout(action.timer);
          if (local.active === action) local.active = null;
          if (decisionCurrent(action)) {
            if (hearingRecovery) hearingRecovery.endCompletion();
            publishDecision();
          }
        });
    }

    // HT-03 (2nd half): "confirm and hand off as a request" — carries the
    // decided hearing record into the governed request/approval flow behind
    // `POST /api/hearing/:session/handoff`. Idempotent server-side: a second
    // click after success returns the same ids instead of registering twice.
    function handoffHearing() {
      if (
        !state.hearingMode ||
        !state.hearingRecord ||
        state.sending ||
        hearingBlocked() ||
        state.hearingCompletion
      )
        return;
      if (state.hearingHandoff && state.hearingHandoff.pending) return;
      if (hearingRecovery) hearingRecovery.beginCompletion();
      var action = hearingActionContext();
      state.hearingHandoff = { pending: true, action: action };
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
          if (!hearingActionCurrent(action)) {
            settleRetiredHearingFailure(action, 'hearingHandoff', result);
            return;
          }
          if (result.ok && result.body && result.body.ok) {
            state.hearingHandoff = {
              refId: result.body.mission_id,
              href: result.body.next_action && result.body.next_action.href,
            };
          } else {
            state.hearingHandoff = { failed: true };
          }
          if (hearingRecovery) hearingRecovery.endCompletion();
          renderHearing();
        })
        .catch(function () {
          if (!hearingActionCurrent(action)) return;
          state.hearingHandoff = { failed: true };
          if (hearingRecovery) hearingRecovery.endCompletion();
          renderHearing();
        });
    }

    // WI-08: "save to the work inventory" — the `work_inventory` scenario's
    // equivalent of `handoffHearing()` above, confirming a decided record into
    // a work-inventory entry via `POST /api/hearing/:session/inventory`.
    // Idempotent server-side: a second click after success returns the same
    // `entry_id` instead of writing a second entry.
    function saveWorkInventory() {
      if (
        !state.hearingMode ||
        !state.hearingRecord ||
        state.sending ||
        hearingBlocked() ||
        state.hearingCompletion
      )
        return;
      if (state.hearingInventory && state.hearingInventory.pending) return;
      if (hearingRecovery) hearingRecovery.beginCompletion();
      var action = hearingActionContext();
      state.hearingInventory = { pending: true, action: action };
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
          if (!hearingActionCurrent(action)) {
            settleRetiredHearingFailure(action, 'hearingInventory', result);
            return;
          }
          if (result.ok && result.body && result.body.ok) {
            state.hearingInventory = {
              entryId: result.body.entry_id,
              href: result.body.next && result.body.next.href,
            };
          } else {
            state.hearingInventory = { failed: true };
          }
          if (hearingRecovery) hearingRecovery.endCompletion();
          renderHearing();
        })
        .catch(function () {
          if (!hearingActionCurrent(action)) return;
          state.hearingInventory = { failed: true };
          if (hearingRecovery) hearingRecovery.endCompletion();
          renderHearing();
        });
    }

    return {
      render: renderHearingHandoff,
      renderDecision: renderDecision,
      blocked: decisionBlocked,
      mount: mountDecision,
      decide: decideHearing,
      handoff: handoffHearing,
      inventory: saveWorkInventory,
    };
  }
  window.KyberionAskHearingCompletion = { create: create };
})();
