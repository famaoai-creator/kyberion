/* Bounded local diagnostic guide. GET/reload never sends or approves work.
 * Server scope is authoritative; neither tenant nor free text is submitted.
 * Receipt identities are display data, never approval authority.
 */
/* global window, document, fetch, URLSearchParams */
(function () {
  'use strict';
  var STORAGE_KEY = 'kyberion.first-job.v1';
  var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  var HASH = /^[a-f0-9]{64}$/;
  var SESSION = /^concierge-[a-f0-9]{64}$/;
  var state = {
    vocab: {},
    vocabReady: false,
    snapshot: null,
    sessionId: null,
    pending: null,
    storageReady: false,
    loaded: false,
    sending: false,
    approvalReady: false,
    approvalBusy: false,
    heldRequests: [],
    refreshing: false,
    mounted: false,
    errorKey: null,
    refreshSequence: 0,
  };
  function el(id) {
    return document.getElementById('first-job-' + id);
  }
  function text(key) {
    return state.vocab['front_desk:first_job_' + key] || '';
  }
  function locale() {
    return window.KyberionPrefs
      ? window.KyberionPrefs.locale()
      : document.documentElement.getAttribute('lang');
  }
  function validArtifact(value) {
    return (
      value &&
      UUID.test(value.requestId) &&
      HASH.test(value.sha256) &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      value.revision <= 64 &&
      (value.format === 'compact' || value.format === 'readable')
    );
  }
  function parsePending(value) {
    if (value == null) return null;
    if (!value || !value.body) throw new Error('invalid_pending');
    var body = value.body;
    if (
      !UUID.test(body.request_id) ||
      !SESSION.test(body.session_id) ||
      (body.action !== 'start' && body.action !== 'revise') ||
      (body.action === 'revise' && !validArtifact(body.artifactRevision))
    )
      throw new Error('invalid_pending');
    var clean = { action: body.action, request_id: body.request_id, session_id: body.session_id };
    if (typeof body.locale === 'string') clean.locale = body.locale;
    if (body.action === 'revise')
      clean.artifactRevision = {
        requestId: body.artifactRevision.requestId,
        revision: body.artifactRevision.revision,
        sha256: body.artifactRevision.sha256,
        format: body.artifactRevision.format,
      };
    return { body: clean, retrySafe: value.retrySafe === true, checked: false };
  }
  function save() {
    if (!state.storageReady) {
      state.errorKey = 'storage_required';
      return false;
    }
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sessionId: state.sessionId, pending: state.pending })
      );
      return true;
    } catch (err) {
      state.storageReady = false;
      state.errorKey = 'storage_required';
      return false;
    }
  }
  function restore() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      var stored = raw ? JSON.parse(raw) : {};
      if (!stored || typeof stored !== 'object' || Array.isArray(stored))
        throw new Error('invalid_storage');
      state.sessionId = SESSION.test(stored.sessionId) ? stored.sessionId : null;
      state.pending = parsePending(stored.pending);
      state.storageReady = !!(window.crypto && typeof window.crypto.randomUUID === 'function');
      if (!save()) return;
      if (state.pending) state.errorKey = state.pending.retrySafe ? 'retry_safe' : 'uncertain';
      if (!state.storageReady) state.errorKey = 'storage_required';
    } catch (err) {
      // Never discard an unreadable pending request and create a replacement.
      state.storageReady = false;
      state.errorKey = 'storage_required';
    }
  }
  function tasks() {
    return state.snapshot && Array.isArray(state.snapshot.tasks) ? state.snapshot.tasks : [];
  }
  function messages() {
    return state.snapshot && Array.isArray(state.snapshot.messages) ? state.snapshot.messages : [];
  }
  function ready() {
    var readiness = state.snapshot && state.snapshot.readiness;
    return (
      state.vocabReady &&
      state.loaded &&
      readiness &&
      readiness.ready === true &&
      readiness.status === 'diagnostic_mapping_ready'
    );
  }
  function uncertainWork() {
    return tasks().some(function (task) {
      return (
        task.turnState === 'uncertain' ||
        task.executionStatus === 'uncertain' ||
        (task.artifact && task.artifact.currentness === 'requested_unknown')
      );
    });
  }
  function busy() {
    return !!(
      state.sending ||
      state.approvalBusy ||
      state.refreshing ||
      uncertainWork() ||
      state.pending ||
      (state.snapshot && state.snapshot.pending > 0) ||
      tasks().some(function (task) {
        return (
          ['awaiting_approval', 'queued', 'running'].indexOf(task.executionStatus) !== -1 ||
          task.turnState === 'pending' ||
          (task.artifact && task.artifact.currentness === 'requested_pending')
        );
      })
    );
  }
  function isHeld(task) {
    return !!(
      task.artifact &&
      state.heldRequests.some(function (held) {
        return held.request_id === task.artifact.requestId;
      })
    );
  }
  function otherUnfinishedWork() {
    return tasks().some(function (task) {
      return (
        !isHeld(task) &&
        (task.turnState === 'pending' ||
          task.turnState === 'uncertain' ||
          ['awaiting_approval', 'queued', 'running', 'uncertain'].indexOf(task.executionStatus) !==
            -1 ||
          !task.artifact ||
          task.artifact.verification !== 'verified')
      );
    });
  }
  function canAct() {
    return (
      ready() &&
      state.approvalReady &&
      !state.heldRequests.length &&
      state.storageReady &&
      !!state.sessionId &&
      !busy()
    );
  }
  function append(parent, tag, value, className) {
    var node = document.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }
  function field(parent, label, value) {
    var row = append(parent, 'p');
    append(row, 'strong', text(label) + ': ');
    append(row, 'span', value);
  }
  function revisionTarget(artifact) {
    if (
      !validArtifact(artifact) ||
      artifact.verification !== 'verified' ||
      artifact.currentness !== 'latest_verified'
    )
      return null;
    var match = messages().find(function (message) {
      var receipt = message.artifact;
      return (
        message.role === 'secretary' &&
        validArtifact(receipt) &&
        receipt.canRevise === true &&
        receipt.requestId === artifact.requestId &&
        receipt.revision === artifact.revision &&
        receipt.sha256 === artifact.sha256 &&
        receipt.format === artifact.format
      );
    });
    return match ? match.artifact : null;
  }
  function renderHistory() {
    var history = el('history');
    history.replaceChildren();
    var rows = tasks().filter(function (task) {
      return (
        task.artifact &&
        UUID.test(task.artifact.requestId) &&
        Number.isSafeInteger(task.artifact.revision)
      );
    });
    if (!rows.length) {
      append(history, 'p', text('empty'));
      return;
    }
    rows.forEach(function (task) {
      var artifact = task.artifact;
      var card = append(history, 'article', undefined, 'home-work-item');
      append(card, 'h3', text('revision') + ' ' + artifact.revision, 'kb-section__title');
      var verified = artifact.verification === 'verified' && HASH.test(artifact.sha256);
      var current = verified
        ? artifact.currentness === 'latest_verified'
          ? 'latest'
          : 'older'
        : 'requested';
      append(card, 'p', text(current), 'kb-badge');
      var status =
        [
          'awaiting_approval',
          'queued',
          'running',
          'blocked',
          'cancel_requested',
          'uncertain',
        ].indexOf(task.executionStatus) !== -1
          ? task.executionStatus
          : 'unknown';
      if (verified && task.executionStatus === 'work_completed') status = 'work_completed';
      field(card, 'status', isHeld(task) ? text('approval_held') : text('status_' + status));
      field(card, 'request', artifact.requestId);
      if (artifact.format === 'compact' || artifact.format === 'readable')
        field(card, 'format', text('format_' + artifact.format));
      if (verified) field(card, 'digest', artifact.sha256);
      if (
        verified &&
        typeof artifact.verifiedAt === 'number' &&
        Number.isFinite(artifact.verifiedAt)
      ) {
        var date = new Date(artifact.verifiedAt);
        if (!Number.isNaN(date.getTime())) field(card, 'checked_at', date.toLocaleString(locale()));
      }
      var target = revisionTarget(artifact);
      if (target) {
        var format = target.format === 'readable' ? 'compact' : 'readable';
        var button = append(card, 'button', text('revise_' + format), 'kb-btn kb-btn--secondary');
        button.type = 'button';
        button.disabled = !canAct();
        button.addEventListener('click', function () {
          if (!canAct() || !revisionTarget(artifact)) return;
          submitNew('revise', {
            requestId: target.requestId,
            revision: target.revision,
            sha256: target.sha256,
            format: format,
          });
        });
      }
    });
  }
  function render() {
    var readiness = state.snapshot && state.snapshot.readiness;
    var readinessKey = !state.loaded
      ? 'loading'
      : readiness && readiness.status === 'diagnostic_mapping_ready' && readiness.ready === true
        ? 'ready'
        : [
              'mapping_missing',
              'mapping_mismatch',
              'mapping_ambiguous',
              'mapping_unavailable',
              'mapping_changed',
            ].indexOf(readiness && readiness.status) !== -1
          ? readiness.status
          : 'mapping_unavailable';
    if (!state.loaded && !state.refreshing) readinessKey = 'mapping_unavailable';
    el('readiness').textContent = text(readinessKey);
    el('setup').hidden = !state.loaded || ready();
    var tenant = state.snapshot && state.snapshot.scope && state.snapshot.scope.tenant;
    var validTenant = typeof tenant === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant);
    el('scope').hidden = !validTenant;
    el('scope').textContent = validTenant ? text('scope') + ': ' + tenant : '';
    el('advance').hidden =
      (state.heldRequests.length > 0 && !otherUnfinishedWork()) ||
      !ready() ||
      !validTenant ||
      !tasks().some(function (task) {
        return !task.artifact || task.artifact.verification !== 'verified';
      });
    if (validTenant)
      el('tick').textContent = 'pnpm onboarding first-job --tenant ' + tenant + ' --tick';
    el('start').disabled = !canAct() || tasks().length > 0 || messages().length > 0;
    el('refresh').disabled = state.sending || state.approvalBusy || state.refreshing;
    el('retry').hidden = !state.pending || !state.pending.retrySafe;
    el('retry').disabled =
      !state.pending ||
      !state.pending.retrySafe ||
      !state.pending.checked ||
      !ready() ||
      !state.approvalReady ||
      !state.storageReady ||
      state.sending ||
      state.refreshing;
    el('approval').hidden = !tasks().some(function (task) {
      return task.executionStatus === 'awaiting_approval';
    });
    var verified = tasks().some(function (task) {
      return (
        task.artifact &&
        task.artifact.verification === 'verified' &&
        HASH.test(task.artifact.sha256)
      );
    });
    var statusKey = state.sending
      ? 'wait'
      : !state.loaded
        ? state.refreshing
          ? 'loading'
          : state.errorKey || 'load_failed'
        : state.pending
          ? 'uncertain'
          : state.heldRequests.length && !otherUnfinishedWork()
            ? 'approval_held'
            : uncertainWork()
              ? 'uncertain'
              : busy()
                ? 'pending'
                : verified
                  ? 'verified'
                  : tasks().length
                    ? 'recorded'
                    : 'empty';
    el('status').textContent = text(statusKey);
    el('error').hidden = !state.errorKey;
    el('error').textContent = state.errorKey ? text(state.errorKey) : '';
    el('history').setAttribute('aria-busy', String(state.refreshing));
    renderHistory();
  }
  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    });
  }
  function applySnapshot(body) {
    if (!body || !body.readiness || !Array.isArray(body.tasks) || !Array.isArray(body.messages))
      throw new Error('invalid_snapshot');
    state.snapshot = body;
    state.loaded = true;
    if (SESSION.test(body.sessionId)) state.sessionId = body.sessionId;
    if (state.pending) {
      var requestId = state.pending.body.request_id;
      if (
        tasks().some(function (task) {
          return task.artifact && task.artifact.requestId === requestId;
        })
      )
        state.pending = null;
      else state.pending.checked = true;
    }
    save();
  }
  function checkApproval() {
    state.approvalReady = false;
    if (!window.KyberionFirstJobApproval) return Promise.resolve();
    return window.KyberionFirstJobApproval.check({
      snapshot: state.snapshot,
      vocab: state.vocab,
      locale: locale(),
      onChange: function (status) {
        state.approvalReady = status.ready === true;
        state.approvalBusy = status.busy === true;
        state.heldRequests = Array.isArray(status.heldRequests)
          ? status.heldRequests.filter(function (held) {
              return (
                held &&
                UUID.test(held.request_id) &&
                held.status === 'approval_verification_failed' &&
                held.recovery === 'operator_recovery'
              );
            })
          : [];
        render();
      },
      onDecision: refresh,
    });
  }
  function invalidateApproval() {
    state.approvalReady = false;
    state.heldRequests = [];
    if (window.KyberionFirstJobApproval) window.KyberionFirstJobApproval.invalidate();
  }
  function refresh() {
    if (state.sending || state.approvalBusy || state.refreshing) return Promise.resolve();
    var sequence = ++state.refreshSequence;
    state.refreshing = true;
    invalidateApproval();
    render();
    var query = new URLSearchParams();
    if (locale()) query.set('locale', locale());
    if (state.sessionId) query.set('session_id', state.sessionId);
    return fetchJson('/api/first-job?' + query.toString(), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (result) {
        if (sequence !== state.refreshSequence) return;
        if (!result.ok || !result.body.ok) throw new Error('status_unavailable');
        applySnapshot(result.body);
        state.errorKey = !state.storageReady
          ? 'storage_required'
          : state.pending
            ? state.pending.retrySafe
              ? 'retry_safe'
              : 'uncertain'
            : null;
        return checkApproval();
      })
      .catch(function () {
        state.loaded = false;
        invalidateApproval();
        state.errorKey = state.pending ? 'uncertain' : 'load_failed';
      })
      .finally(function () {
        state.refreshing = false;
        render();
      });
  }
  function sendPending() {
    if (state.sending || !state.pending || !state.storageReady) return;
    state.sending = true;
    state.pending.retrySafe = false;
    state.pending.checked = false;
    state.errorKey = null;
    // Persist the exact request before any network effect; reload never replays it.
    if (!save()) {
      state.sending = false;
      render();
      return;
    }
    render();
    return fetchJson('/api/first-job', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.pending.body),
    })
      .then(function (result) {
        if (!result.ok || !result.body.ok) {
          state.pending.retrySafe = result.body.retry_safe === true;
          state.pending.checked = false;
          state.loaded = false;
          state.errorKey = state.pending.retrySafe ? 'retry_safe' : 'uncertain';
          save();
          return;
        }
        applySnapshot(result.body);
        state.errorKey = !state.storageReady
          ? 'storage_required'
          : state.pending
            ? 'uncertain'
            : null;
        save();
        return checkApproval();
      })
      .catch(function () {
        state.errorKey = 'uncertain';
        state.loaded = false;
        save();
      })
      .finally(function () {
        state.sending = false;
        render();
      });
  }
  function submitNew(action, artifact) {
    if (!canAct()) return;
    var body = {
      action: action,
      request_id: window.crypto.randomUUID(),
      session_id: state.sessionId,
      locale: locale(),
    };
    if (artifact) body.artifactRevision = artifact;
    state.pending = { body: body, retrySafe: false, checked: false };
    return sendPending();
  }
  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    restore();
    el('start').addEventListener('click', function () {
      if (!tasks().length && !messages().length) submitNew('start');
    });
    el('refresh').addEventListener('click', load);
    el('retry').addEventListener('click', function () {
      if (
        state.pending &&
        state.pending.retrySafe &&
        state.pending.checked &&
        ready() &&
        state.approvalReady &&
        !state.sending &&
        !state.approvalBusy &&
        !state.refreshing
      )
        sendPending();
    });
    var railReady = (window.FrontDeskRail && window.FrontDeskRail.ready) || Promise.resolve();
    return Promise.resolve(railReady).then(load);
  }
  function load() {
    if (state.sending || state.refreshing) return Promise.resolve();
    if (state.vocabReady) return refresh();
    return fetchJson('/api/ui-vocabulary?locale=' + encodeURIComponent(locale()), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (result) {
        if (
          !result.ok ||
          !result.body.texts ||
          typeof result.body.texts['front_desk:first_job_ready'] !== 'string'
        )
          throw new Error('vocabulary_unavailable');
        state.vocab = result.body.texts;
        state.vocabReady = true;
        return refresh();
      })
      .catch(function () {
        // Keep server-rendered labels; a failed vocabulary read must not unlock mutation.
        state.loaded = false;
        el('start').disabled = true;
        el('error').hidden = false;
        el('readiness').textContent = el('error').textContent;
        el('status').textContent = el('error').textContent;
      });
  }
  window.KyberionFirstJob = { mount: mount };
})();
