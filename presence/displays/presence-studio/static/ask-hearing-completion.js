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
    // Only bounded server conflict codes become user-facing copy, never raw errors.
    function conflictCode(result) {
      var code =
        result &&
        !result.ok &&
        result.status === 409 &&
        result.body &&
        result.body.hearing_conflict;
      return ['stale_snapshot', 'completion_locked', 'handoff_unresolved'].indexOf(code) !== -1
        ? code
        : null;
    }
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

    function completionConflictBlocked(value) {
      return Boolean(
        value &&
        value.conflict &&
        value.action &&
        hearingActionCurrent(value.action) &&
        ['completion_locked', 'handoff_unresolved'].indexOf(value.conflict) !== -1
      );
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
        if (completionConflictBlocked(state.hearingInventory)) button.disabled = true;
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
          statusEl.textContent = vt(
            state.vocab,
            inventory.conflict
              ? 'front_desk:hearing_conflict_' + inventory.conflict
              : 'front_desk:hearing_inventory_failed'
          );
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
      if (completionConflictBlocked(state.hearingHandoff)) button.disabled = true;
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
        statusEl.textContent = vt(
          state.vocab,
          handoff.conflict
            ? 'front_desk:hearing_conflict_' + handoff.conflict
            : 'front_desk:hearing_handoff_failed'
        );
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

    // A marker is only a no-resend guard. Version 2 carries the exact operation
    // needed for authenticated receipt lookup; legacy markers never become proof.
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
    function operationValid(value) {
      return Boolean(
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 4 &&
        value.version === 1 &&
        typeof value.operation_id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value.operation_id) &&
        typeof value.scenario_id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value.scenario_id) &&
        Number.isSafeInteger(value.requirements_revision) &&
        value.requirements_revision >= 0
      );
    }
    function exactMarker(raw) {
      try {
        var value = JSON.parse(raw);
        return value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).length === 4 &&
          value.version === 2 &&
          operationValid(value.operation) &&
          ['conversationId', 'scope'].every(function (key) {
            return (
              typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096
            );
          })
          ? value
          : null;
      } catch (err) {
        return null;
      }
    }
    function markerMatches(value) {
      return Boolean(
        value &&
        value.conversationId === state.conversationId &&
        value.scope === scopedUrl('/api/conversation') &&
        value.operation.scenario_id === state.hearingScenarioId
      );
    }
    function recoveryUsable() {
      return (
        state.hearingMode &&
        !decisionHidden &&
        state.draftShellReady &&
        !state.shellBlockedMessage &&
        state.historyState === 'ready' &&
        state.conversationId
      );
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
      var saved = exactMarker(local.marker);
      var checking = Boolean(
        local.recovery && local.recovery.waiting && decisionCurrent(local.recovery)
      );
      busy = busy || checking;
      var phase = local.failed
        ? 'storage'
        : checking
          ? 'checking'
          : busy
            ? 'pending'
            : locked
              ? !saved
                ? 'legacy'
                : !markerMatches(saved)
                  ? 'scope'
                  : local.superseded && decisionCurrent(local.superseded)
                    ? 'superseded'
                    : 'unknown'
              : local.rejected
                ? 'rejected'
                : local.recovered &&
                    decisionCurrent(local.recovered) &&
                    currentDecision(
                      { ok: true, body: { ok: true, record: state.hearingRecord } },
                      local.recovered.proof,
                      local.recovered
                    )
                  ? 'recovered'
                  : null;
      var host = document.getElementById('hearing-decision-status');
      if (host) {
        host.hidden = !state.hearingMode || !phase;
        host.setAttribute('aria-busy', String(busy));
      }
      var text = document.getElementById('hearing-decision-text');
      var label = phase && vt(state.vocab, 'front_desk:hearing_decision_' + phase);
      if (phase === 'unknown' && local.conflict && decisionCurrent(local.conflict.action))
        label += ' ' + vt(state.vocab, 'front_desk:hearing_conflict_' + local.conflict.code);
      if (text && label) text.textContent = label;
      var check = document.getElementById('hearing-decision-check');
      if (check) {
        check.hidden = !locked || local.failed || !saved || !markerMatches(saved);
        check.disabled = busy || !recoveryUsable();
        var checkLabel = vt(state.vocab, 'front_desk:hearing_decision_check');
        if (checkLabel) check.textContent = checkLabel;
      }
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
    function exactProof(result, action) {
      var proof =
        result &&
        result.ok &&
        result.body &&
        result.body.ok === true &&
        result.body.decision_receipt;
      var receipt = proof && proof.receipt;
      var identity = receipt && receipt.identity;
      var expected = action.operation;
      var operation = receipt && receipt.operation;
      // The endpoint authenticates principal + scope + member + source against the
      // stored receipt. Never infer an actor or authorization from client scope text.
      if (
        !proof ||
        ['current', 'superseded'].indexOf(proof.status) === -1 ||
        !receipt ||
        !operationValid(operation) ||
        !expected ||
        ['version', 'operation_id', 'scenario_id', 'requirements_revision'].some(function (key) {
          return operation[key] !== expected[key];
        }) ||
        receipt.session_id !== action.sessionId ||
        typeof receipt.namespace !== 'string' ||
        !receipt.namespace ||
        !Number.isSafeInteger(receipt.record_revision) ||
        receipt.record_revision < 1 ||
        typeof receipt.decided_at !== 'string' ||
        !Number.isFinite(Date.parse(receipt.decided_at)) ||
        !identity ||
        ['principal_id', 'scope_key', 'member_id'].some(function (key) {
          return typeof identity[key] !== 'string' || !identity[key].trim();
        }) ||
        ['loopback', 'token'].indexOf(identity.source) === -1
      )
        return null;
      return proof;
    }
    function currentDecision(result, proof, action) {
      if (!proof || proof.status !== 'current' || !validDecision(result, action)) return false;
      var record = result.body.record;
      var receipt = proof.receipt;
      return (
        Number.isSafeInteger(record.requirements_revision) &&
        record.requirements_revision === action.operation.requirements_revision &&
        Number.isSafeInteger(record.record_revision) &&
        record.record_revision >= receipt.record_revision &&
        record.decided_at === receipt.decided_at &&
        record.decided_by.id === 'user:' + receipt.identity.member_id
      );
    }
    function recoveryCurrent(action) {
      var local = decisions[action.key];
      return (
        decisionCurrent(action) &&
        recoveryUsable() &&
        local &&
        !local.failed &&
        local.recovery === action &&
        local.marker === action.marker &&
        action.waiting &&
        window.sessionStorage.getItem(action.key) === action.marker &&
        markerMatches(exactMarker(action.marker))
      );
    }
    function checkDecision() {
      decisionBlocked();
      var local = decisionState();
      var saved = exactMarker(local.marker);
      if (
        !recoveryUsable() ||
        local.failed ||
        !markerMatches(saved) ||
        (local.active && local.active.waiting && decisionCurrent(local.active)) ||
        (local.recovery && local.recovery.waiting && decisionCurrent(local.recovery))
      )
        return;
      // A newer read owns settlement now. A delayed POST response may contain
      // proof that was current before the read observed a superseding decision.
      if (local.active) {
        local.active.recoveryRetired = true;
        local.active.waiting = false;
        window.clearTimeout(local.active.timer);
        local.active = null;
      }
      decisionGeneration += 1;
      var action = hearingActionContext();
      action.generation = decisionGeneration;
      action.sessionId = state.sessionId;
      action.scenarioId = state.hearingScenarioId;
      action.key = decisionKey();
      action.marker = local.marker;
      action.operation = saved.operation;
      action.waiting = true;
      local.recovery = action;
      local.superseded = null;
      if (hearingRecovery) hearingRecovery.beginCompletion();
      publishDecision();
      var recordResult;
      // Read current requirements first, then verify that this exact operation is
      // still current. A generic record or destination is never proof by itself.
      Promise.resolve()
        .then(function () {
          if (!recoveryCurrent(action)) throw new Error('Decision context changed');
          return options.fetchReadJson(
            scopedUrl(
              '/api/hearing/' +
                encodeURIComponent(action.sessionId) +
                '?locale=' +
                encodeURIComponent(state.locale) +
                '&scenario_id=' +
                encodeURIComponent(action.scenarioId)
            )
          );
        })
        .then(function (result) {
          if (!recoveryCurrent(action)) throw new Error('Decision context changed');
          recordResult = result;
          if (!result || !result.ok || !result.body || result.body.ok !== true) return null;
          return options.fetchReadJson(
            scopedUrl(
              '/api/hearing/' +
                encodeURIComponent(action.sessionId) +
                '/decision-receipts/' +
                encodeURIComponent(action.operation.operation_id) +
                '?version=1&scenario_id=' +
                encodeURIComponent(action.operation.scenario_id) +
                '&requirements_revision=' +
                action.operation.requirements_revision
            )
          );
        })
        .then(function (result) {
          if (!recoveryCurrent(action)) return;
          var proof = exactProof(result, action);
          if (proof && proof.status === 'superseded') local.superseded = action;
          if (currentDecision(recordResult, proof, action) && clearOwnDecision(action)) {
            state.hearingRecord = recordResult.body.record;
            state.hearingCompletion =
              recordResult.body.completion == null ? null : recordResult.body.completion;
            state.hearingHandoff = null;
            state.hearingInventory = null;
            action.proof = proof;
            local.recovered = action;
            local.conflict = null;
          }
        })
        .catch(function () {
          // Missing, denied, timed-out, corrupt or foreign proof remains unknown.
        })
        .finally(function () {
          action.waiting = false;
          if (local.recovery !== action) return;
          local.recovery = null;
          if (decisionCurrent(action)) {
            if (hearingRecovery) hearingRecovery.endCompletion();
            publishDecision();
          }
        });
    }
    function mountDecision() {
      if (decisionMounted) return;
      decisionMounted = true;
      var check = document.getElementById('hearing-decision-check');
      if (check) check.addEventListener('click', checkDecision);
      function retire() {
        decisionGeneration += 1;
        Object.keys(decisions).forEach(function (key) {
          var recovery = decisions[key].recovery;
          if (recovery) recovery.waiting = false;
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
        action.operation = {
          version: 1,
          operation_id: options.randomId(),
          scenario_id: state.hearingScenarioId,
          requirements_revision:
            state.hearingRecord.requirements_revision == null
              ? 0
              : state.hearingRecord.requirements_revision,
        };
        if (!operationValid(action.operation)) throw new Error('Invalid hearing revision');
        action.marker = JSON.stringify({
          version: 2,
          operation: action.operation,
          conversationId: state.conversationId,
          scope: scopedUrl('/api/conversation'),
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
      local.conflict = null;
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
          scopedUrl(
            '/api/hearing/' +
              encodeURIComponent(action.sessionId) +
              '/decide?locale=' +
              encodeURIComponent(state.locale)
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action.operation),
          }
        );
      } catch (err) {
        request = Promise.reject(err);
      }
      Promise.resolve(request)
        .then(function (result) {
          if (action.recoveryRetired) return;
          var code = conflictCode(result);
          if (code && decisionCurrent(action) && local.marker === action.marker)
            local.conflict = { code: code, action: action };
          var proof = exactProof(result, action);
          var success = currentDecision(result, proof, action);
          if (proof && proof.status === 'superseded' && decisionCurrent(action))
            local.superseded = action;
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
      if (completionConflictBlocked(state.hearingHandoff)) return;
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
            state.hearingHandoff = { failed: true, conflict: conflictCode(result), action: action };
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
      if (completionConflictBlocked(state.hearingInventory)) return;
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
            state.hearingInventory = {
              failed: true,
              conflict: conflictCode(result),
              action: action,
            };
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
