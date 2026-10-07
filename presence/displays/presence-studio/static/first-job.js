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
    setup: null,
    sessionId: null,
    pending: null,
    storageReady: false,
    loaded: false,
    sending: false,
    approvalReady: false,
    approvalBusy: false,
    heldRequests: [],
    recoveryRequests: [],
    refreshing: false,
    mounted: false,
    errorKey: null,
    refreshSequence: 0,
    approvalSequence: 0,
    refreshController: null,
    pollTimer: null,
    pollFailures: 0,
    readBlocked: false,
    pageActive: true,
    lastChecked: null,
    networkError: false,
    receiptScope: null,
    receiptEpoch: 0,
    receiptAccessError: null,
    resumeRead: false,
    loadingVocabulary: false,
    receipts: Object.create(null),
    selection: { body: '', left: '', right: '' },
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
  function recoveryFor(task) {
    return state.recoveryRequests.find(function (item) {
      return (
        item.request_id === task.id &&
        (!task.artifact ||
          (item.request_id === task.artifact.requestId && item.revision === task.artifact.revision))
      );
    });
  }
  function isParked(task) {
    var recovery = recoveryFor(task);
    return isHeld(task) || !!(recovery && recovery.status === 'eligible');
  }
  function safelyTerminated(task) {
    var recovery = recoveryFor(task);
    return !!(
      recovery &&
      recovery.status === 'terminated_unstarted' &&
      task.executionStatus === 'terminated_unstarted' &&
      task.turnState === 'settled' &&
      (!task.artifact ||
        (task.artifact.verification !== 'verified' &&
          ['requested_pending', 'requested_unknown'].indexOf(task.artifact.currentness) === -1))
    );
  }
  function canRestart() {
    var ids = tasks().map(function (task) {
      return task.id;
    });
    return (
      canAct() &&
      tasks().length > 0 &&
      tasks().every(safelyTerminated) &&
      state.recoveryRequests.length === tasks().length &&
      messages().every(function (message) {
        return (
          message &&
          typeof message.id === 'string' &&
          ['user', 'secretary'].indexOf(message.role) !== -1 &&
          ids.indexOf(message.id.replace(/-(user|secretary)$/, '')) !== -1 &&
          (!message.artifact ||
            (ids.indexOf(message.artifact.requestId) !== -1 && message.artifact.canRevise !== true))
        );
      })
    );
  }
  function otherUnfinishedWork() {
    return tasks().some(function (task) {
      return (
        !isParked(task) &&
        !safelyTerminated(task) &&
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
      visible() &&
      ready() &&
      state.approvalReady &&
      !state.heldRequests.length &&
      !state.recoveryRequests.some(function (item) {
        return item.status === 'eligible';
      }) &&
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
      observedCurrentness(artifact) !== 'latest_verified'
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

  function observedCurrentness(artifact) {
    var entry = state.receipts[receiptKey(artifact)];
    return artifact.currentness === 'older_verified' ||
      (entry && entry.status === 'ready' && entry.currentness === 'older_verified')
      ? 'older_verified'
      : artifact.currentness;
  }
  function receiptKey(artifact) {
    return artifact.requestId + ':' + artifact.revision + ':' + artifact.sha256;
  }
  function verifiedArtifacts() {
    var found = Object.create(null);
    return tasks()
      .map(function (task) {
        return task.artifact;
      })
      .filter(function (artifact) {
        if (
          !validArtifact(artifact) ||
          artifact.verification !== 'verified' ||
          ['latest_verified', 'older_verified'].indexOf(artifact.currentness) === -1
        )
          return false;
        var key = receiptKey(artifact);
        if (found[key]) return false;
        found[key] = true;
        return true;
      })
      .sort(function (a, b) {
        return a.revision - b.revision;
      });
  }
  function selectedArtifact(key) {
    return verifiedArtifacts().find(function (artifact) {
      return receiptKey(artifact) === key;
    });
  }
  function clearReceipts(resetSelection) {
    state.receiptEpoch++;
    Object.keys(state.receipts).forEach(function (key) {
      if (state.receipts[key].controller) state.receipts[key].controller.abort();
    });
    state.receipts = Object.create(null);
    if (resetSelection) state.selection = { body: '', left: '', right: '' };
  }
  function invalidateReadAccess(reason) {
    state.readBlocked = true;
    state.loaded = false;
    state.snapshot = null;
    state.setup = null;
    state.receiptAccessError = reason;
    clearReceipts(false);
    state.refreshSequence++;
    if (state.refreshController) state.refreshController.abort();
    state.refreshController = null;
    state.refreshing = false;
    state.resumeRead = false;
    state.networkError = true;
    state.errorKey = state.pending ? 'uncertain' : 'load_failed';
    invalidateApproval();
    stopPolling();
    render();
  }
  function syncReceipts() {
    var scope = JSON.stringify([state.sessionId, state.snapshot.scope || null]);
    if (scope !== state.receiptScope) {
      clearReceipts(true);
      state.receiptScope = scope;
    }
    var artifacts = verifiedArtifacts();
    // Defaults apply only to empty selections. A refresh never moves a chosen revision.
    if (!state.selection.body && artifacts.length)
      state.selection.body = receiptKey(
        artifacts.find(function (artifact) {
          return artifact.currentness === 'latest_verified';
        }) || artifacts[artifacts.length - 1]
      );
    if (artifacts.length > 1) {
      if (!state.selection.left) state.selection.left = receiptKey(artifacts[0]);
      if (!state.selection.right)
        state.selection.right = receiptKey(artifacts[artifacts.length - 1]);
    }
    Object.keys(state.receipts).forEach(function (key) {
      if (!selectedArtifact(key)) {
        if (state.receipts[key].controller) state.receipts[key].controller.abort();
        delete state.receipts[key];
      }
    });
    loadSelectedReceipts(false);
  }
  function readReceipt(key) {
    var artifact = selectedArtifact(key);
    if (!artifact || !SESSION.test(state.sessionId) || state.receipts[key]) return;
    var sessionId = state.sessionId;
    var epoch = state.receiptEpoch;
    var entry = {
      status: 'loading',
      body: null,
      controller: window.AbortController ? new window.AbortController() : null,
    };
    state.receipts[key] = entry;
    var query = new URLSearchParams();
    query.set('session_id', sessionId);
    query.set('request_id', artifact.requestId);
    query.set('revision', String(artifact.revision));
    query.set('sha256', artifact.sha256);
    function current() {
      return (
        epoch === state.receiptEpoch &&
        state.sessionId === sessionId &&
        state.receipts[key] === entry &&
        !!selectedArtifact(key)
      );
    }
    fetchJson(
      '/api/first-job/artifact?' + query.toString(),
      {
        credentials: 'same-origin',
        cache: 'no-store',
      },
      entry.controller
    )
      .then(function (result) {
        if (!current()) return;
        var receipt = result.body && result.body.artifact;
        if (!result.ok) {
          if (result.status === 401 || result.status === 403) {
            invalidateReadAccess('forbidden');
            return;
          }
          entry.status =
            result.status === 403 || result.status === 401
              ? 'forbidden'
              : result.status === 404
                ? 'unavailable'
                : 'failed';
          return;
        }
        if (
          !result.body.ok ||
          result.body.sessionId !== sessionId ||
          !validArtifact(receipt) ||
          receiptKey(receipt) !== key ||
          receipt.format !== artifact.format ||
          receipt.verification !== 'verified' ||
          ['latest_verified', 'older_verified'].indexOf(receipt.currentness) === -1 ||
          typeof receipt.verifiedAt !== 'number' ||
          !Number.isFinite(receipt.verifiedAt) ||
          typeof receipt.body !== 'string'
        ) {
          entry.status = 'unavailable';
          return;
        }
        // The server verifies the bytes. Keep the exact string, never parse, prettify or inject HTML.
        entry.body = receipt.body;
        entry.currentness = receipt.currentness;
        entry.verifiedAt = receipt.verifiedAt;
        entry.status = 'ready';
      })
      .catch(function () {
        if (current()) entry.status = 'failed';
      })
      .finally(function () {
        if (current()) render();
      });
  }
  function loadSelectedReceipts(retry) {
    Object.keys(state.selection).forEach(function (slot) {
      var key = state.selection[slot];
      var entry = state.receipts[key];
      if (retry && entry && entry.status !== 'ready' && entry.status !== 'loading')
        delete state.receipts[key];
      readReceipt(key);
    });
  }
  function renderReceiptSelector(slot, artifacts) {
    var select = el(slot + '-select');
    var chosen = state.selection[slot];
    var signature = JSON.stringify([
      chosen,
      artifacts.map(function (artifact) {
        return [receiptKey(artifact), artifact.currentness, artifact.format];
      }),
    ]);
    // Preserve focus and the open native select while unrelated status reads finish.
    if (select.receiptSignature !== signature) {
      select.receiptSignature = signature;
      select.replaceChildren();
      if (!chosen || !selectedArtifact(chosen)) {
        var empty = append(select, 'option', text(chosen ? 'body_unavailable' : 'body_empty'));
        empty.value = chosen;
      }
      artifacts.forEach(function (artifact) {
        var label =
          text('revision') +
          ' ' +
          artifact.revision +
          ' · ' +
          text('format_' + artifact.format) +
          ' · ' +
          artifact.requestId +
          ' · ' +
          artifact.sha256;
        var option = append(select, 'option', label);
        option.value = receiptKey(artifact);
      });
      select.value = chosen;
    }
    select.disabled = artifacts.length === 0;
  }
  function renderReceiptPane(slot) {
    var key = state.selection[slot];
    var artifact = selectedArtifact(key);
    var entry = artifact && state.receipts[key];
    var status = !key
      ? 'empty'
      : !artifact
        ? state.receiptAccessError || 'unavailable'
        : entry
          ? entry.status
          : 'loading';
    var metadata = el(slot + '-metadata');
    metadata.replaceChildren();
    if (artifact) {
      field(metadata, 'revision', artifact.revision);
      field(metadata, 'request', artifact.requestId);
      field(metadata, 'format', text('format_' + artifact.format));
      field(metadata, 'digest', artifact.sha256);
      append(
        metadata,
        'p',
        text(observedCurrentness(artifact) === 'latest_verified' ? 'latest' : 'older')
      );
      var verifiedAt = entry && entry.status === 'ready' ? entry.verifiedAt : artifact.verifiedAt;
      var verifiedDate = new Date(verifiedAt);
      if (
        typeof verifiedAt === 'number' &&
        Number.isFinite(verifiedAt) &&
        !Number.isNaN(verifiedDate.getTime())
      )
        field(metadata, 'checked_at', verifiedDate.toLocaleString(locale()));
    }
    el(slot + '-status').textContent = text('body_' + status);
    el(slot + '-content').textContent = status === 'ready' ? entry.body : '';
    el(slot + '-content').hidden = status !== 'ready';
    el(slot + '-content').setAttribute('aria-busy', String(status === 'loading'));
  }
  function renderReceipts() {
    var artifacts = verifiedArtifacts();
    ['body', 'left', 'right'].forEach(function (slot) {
      renderReceiptSelector(slot, artifacts);
      renderReceiptPane(slot);
    });
    var left = selectedArtifact(state.selection.left) && state.receipts[state.selection.left];
    var right = selectedArtifact(state.selection.right) && state.receipts[state.selection.right];
    var comparison =
      artifacts.length < 2
        ? 'compare_empty'
        : state.selection.left === state.selection.right
          ? 'compare_same_version'
          : left && right && left.status === 'ready' && right.status === 'ready'
            ? left.body === right.body
              ? 'compare_same'
              : 'compare_different'
            : 'compare_wait';
    el('compare-status').textContent = text(comparison);
    el('body-retry').disabled =
      state.readBlocked ||
      !Object.keys(state.selection).some(function (slot) {
        var key = state.selection[slot];
        var entry = selectedArtifact(key) && state.receipts[key];
        return entry && entry.status !== 'ready' && entry.status !== 'loading';
      });
  }
  function visible() {
    return state.pageActive && document.visibilityState !== 'hidden' && document.hidden !== true;
  }
  function progressing() {
    var readiness = state.snapshot && state.snapshot.readiness;
    return (
      state.vocabReady &&
      readiness &&
      readiness.ready === true &&
      readiness.status === 'diagnostic_mapping_ready' &&
      !state.readBlocked &&
      !state.pending &&
      !uncertainWork() &&
      tasks().some(function (task) {
        return !isParked(task) && ['queued', 'running'].indexOf(task.executionStatus) !== -1;
      })
    );
  }
  function stopPolling() {
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  function schedulePolling() {
    if (!visible() || !progressing() || state.sending || state.approvalBusy || state.refreshing) {
      stopPolling();
      return;
    }
    if (state.pollTimer !== null) return;
    state.pollTimer = window.setTimeout(
      function () {
        state.pollTimer = null;
        if (visible() && progressing()) refresh();
      },
      Math.min(5000 * Math.pow(2, state.pollFailures), 60000)
    );
  }
  function suspendReads(force) {
    stopPolling();
    var recheck = force || state.refreshing || state.recoveryRequests.length > 0 || state.setup;
    if (recheck) state.resumeRead = true;
    state.setup = null;
    if (state.refreshing) {
      state.refreshSequence++;
      if (state.refreshController) state.refreshController.abort();
      state.refreshController = null;
      state.refreshing = false;
    }
    // Preserve an in-flight decision callback; clearing guidance does not cancel a mutation.
    if (recheck && !state.approvalBusy) invalidateApproval();
    render();
  }
  function historyArtifact(task) {
    if (task.artifact) return task.artifact;
    var recovery = recoveryFor(task);
    return safelyTerminated(task) ? { requestId: task.id, revision: recovery.revision } : null;
  }
  function renderHistory() {
    var history = el('history');
    history.replaceChildren();
    var rows = tasks().filter(function (task) {
      var artifact = historyArtifact(task);
      return artifact && UUID.test(artifact.requestId) && Number.isSafeInteger(artifact.revision);
    });
    if (!rows.length) {
      append(history, 'p', text('empty'));
      return;
    }
    rows.forEach(function (task) {
      var artifact = historyArtifact(task);
      var card = append(history, 'article', undefined, 'home-work-item');
      append(card, 'h3', text('revision') + ' ' + artifact.revision, 'kb-section__title');
      var verified = artifact.verification === 'verified' && HASH.test(artifact.sha256);
      var current = safelyTerminated(task)
        ? 'recovery_terminated'
        : verified
          ? observedCurrentness(artifact) === 'latest_verified'
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
          'terminated_unstarted',
        ].indexOf(task.executionStatus) !== -1
          ? task.executionStatus
          : 'unknown';
      if (verified && task.executionStatus === 'work_completed') status = 'work_completed';
      field(
        card,
        'status',
        isHeld(task)
          ? text('approval_held')
          : isParked(task)
            ? text('recovery_eligible')
            : text('status_' + status)
      );
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
  function setupRecoveryBlocked() {
    return (
      state.heldRequests.length > 0 ||
      state.recoveryRequests.some(function (item) {
        return item.status === 'eligible';
      })
    );
  }
  function renderSetup() {
    var setup = visible() && !state.refreshing && !state.networkError && state.setup;
    var fields = {
      profile: ['present', 'missing', 'unavailable'],
      oidc: ['configured', 'configuration_required', 'unavailable'],
      browser_user: ['verified', 'sign_in_required', 'binding_required', 'unavailable'],
      approval_scope: [
        'ready',
        'mapping_required',
        'authentication_required',
        'owner_unavailable',
        'owner_mismatch',
        'tenant_membership_required',
        'unavailable',
      ],
      baseline: ['unchecked'],
      reasoning: ['not_required'],
      advancement: ['not_started', 'review_or_tick', 'running', 'receipt_verified', 'unavailable'],
    };
    var actions = [
      'inspect_profile',
      'complete_profile',
      'inspect_mapping',
      'configure_login',
      'sign_in',
      'inspect_member_binding',
      'inspect_approval_scope',
      'inspect_baseline',
      'review_or_tick',
      'wait',
      'inspect_execution',
      'refresh',
    ];
    Object.keys(fields).forEach(function (field) {
      var row = el('setup-' + field);
      if (!row) return;
      var value = setup && setup[field];
      if (value && field === 'advancement' && setupRecoveryBlocked())
        value = { status: 'unavailable', owner: 'operator', next_action: 'inspect_execution' };
      if (field === 'advancement' && (state.sending || state.approvalBusy)) value = null;
      var known = value && fields[field].indexOf(value.status) !== -1;
      var content = text('setup_' + field + '_' + (known ? value.status : 'unknown'));
      if (
        known &&
        ['user', 'operator'].indexOf(value.owner) !== -1 &&
        actions.indexOf(value.next_action) !== -1
      ) {
        content +=
          ' ' +
          text('setup_owner_' + value.owner) +
          ': ' +
          text('setup_action_' + value.next_action);
      }
      if (row.textContent !== content) row.textContent = content;
    });
    var signin = el('setup-signin');
    if (signin)
      signin.hidden = !(
        setup &&
        setup.oidc &&
        setup.oidc.status === 'configured' &&
        setup.browser_user &&
        setup.browser_user.status === 'sign_in_required'
      );
  }
  function render() {
    renderSetup();
    var readiness = state.snapshot && state.snapshot.readiness;
    var mapping = state.setup && state.setup.mapping;
    if (state.setup)
      readiness = mapping
        ? { status: mapping.status, ready: mapping.status === 'diagnostic_mapping_ready' }
        : { status: 'mapping_unavailable', ready: false };
    var readinessKey =
      !state.loaded && !mapping
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
    if (state.refreshing || state.resumeRead || !visible()) readinessKey = 'loading';
    else if (!state.loaded && !mapping) readinessKey = 'mapping_unavailable';
    el('readiness').textContent = text(readinessKey);
    el('setup').hidden = !state.loaded || ready();
    var tenant = state.snapshot && state.snapshot.scope && state.snapshot.scope.tenant;
    var validTenant = typeof tenant === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant);
    el('scope').hidden = !validTenant;
    el('scope').textContent = validTenant ? text('scope') + ': ' + tenant : '';
    el('advance').hidden =
      state.sending ||
      state.approvalBusy ||
      !visible() ||
      state.refreshing ||
      state.resumeRead ||
      (state.setup &&
        (setupRecoveryBlocked() ||
          !state.setup.advancement ||
          state.setup.advancement.status !== 'review_or_tick')) ||
      ((state.heldRequests.length > 0 || state.recoveryRequests.length > 0) &&
        !otherUnfinishedWork()) ||
      !ready() ||
      !validTenant ||
      !tasks().some(function (task) {
        return !task.artifact || task.artifact.verification !== 'verified';
      });
    if (validTenant)
      el('tick').textContent = 'pnpm onboarding first-job --tenant ' + tenant + ' --tick';
    el('start').disabled = !canAct() || tasks().length > 0 || messages().length > 0;
    var terminalHistory =
      tasks().length > 0 &&
      tasks().every(function (task) {
        return task.executionStatus === 'terminated_unstarted';
      });
    el('restart').hidden = !terminalHistory;
    el('restart').disabled = !canRestart();
    el('restart-note').hidden = !terminalHistory;
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
                    ? canRestart()
                      ? 'recovery_terminated'
                      : 'recorded'
                    : 'empty';
    el('status').textContent = text(statusKey);
    el('error').hidden = !state.errorKey;
    el('error').textContent = state.errorKey ? text(state.errorKey) : '';
    el('history').setAttribute('aria-busy', String(state.refreshing));
    renderHistory();
    renderReceipts();
    el('last-checked').textContent =
      text('last_checked') +
      ': ' +
      (state.lastChecked === null
        ? text('not_checked')
        : new Date(state.lastChecked).toLocaleString(locale()));
    el('refresh-error').hidden = !state.networkError;
    el('refresh-error').textContent = state.networkError ? text('refresh_failed') : '';
    el('refresh-mode').textContent = text(
      !visible()
        ? 'refresh_hidden'
        : progressing()
          ? state.networkError
            ? 'refresh_backoff'
            : 'refresh_active'
          : 'refresh_paused'
    );
    schedulePolling();
  }
  function fetchJson(url, options, controller) {
    function request(init) {
      return fetch(url, init).then(function (response) {
        return response.json().then(
          function (body) {
            return { ok: response.ok, status: response.status, body: body };
          },
          function () {
            return { ok: response.ok, status: response.status, body: null };
          }
        );
      });
    }
    // Mutation uncertainty keeps its existing workflow; only GETs have an automatic read timeout.
    if (options && options.method === 'POST') return request(options);
    var readController =
      controller || (window.AbortController ? new window.AbortController() : null);
    var timer;
    var onAbort;
    return new Promise(function (resolve, reject) {
      onAbort = function () {
        reject(new Error('read_aborted'));
      };
      if (readController) readController.signal.addEventListener('abort', onAbort, { once: true });
      timer = window.setTimeout(function () {
        reject(new Error('read_timeout'));
        if (readController) readController.abort();
      }, 15000);
      request(
        Object.assign({}, options, readController ? { signal: readController.signal } : {})
      ).then(resolve, reject);
    }).finally(function () {
      window.clearTimeout(timer);
      if (readController) readController.signal.removeEventListener('abort', onAbort);
    });
  }
  function applySnapshot(body) {
    if (!body || !body.readiness || !Array.isArray(body.tasks) || !Array.isArray(body.messages))
      throw new Error('invalid_snapshot');
    state.snapshot = body;
    // Keep only the status-only setup projection apart from protected request history.
    state.setup = body.setup || null;
    state.loaded = true;
    state.receiptAccessError = null;
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
    syncReceipts();
  }
  function checkApproval() {
    state.approvalReady = false;
    var sequence = ++state.approvalSequence;
    if (!window.KyberionFirstJobApproval) return Promise.resolve();
    var check = window.KyberionFirstJobApproval.check({
      snapshot: state.snapshot,
      signal: state.refreshController ? state.refreshController.signal : undefined,
      vocab: state.vocab,
      locale: locale(),
      onChange: function (status) {
        if (sequence !== state.approvalSequence) return;
        state.approvalReady = status.ready === true;
        if (status.setupInvalidated && state.setup) {
          var setup = state.setup;
          setup.advancement = null;
          if (setup.browser_user && setup.browser_user.status === 'verified')
            setup.browser_user = null;
          if (setup.approval_scope && setup.approval_scope.status === 'ready')
            setup.approval_scope = null;
        }
        if (status.setupScopeInvalidated && state.setup) {
          state.setup.approval_scope = null;
          state.setup.mapping = null;
          state.setup.advancement = null;
        }
        state.approvalBusy = status.busy === true;
        if (status.accessLost === true) {
          // Recovery identities/history still clear completely. The local GET
          // separately established these redacted configuration blockers.
          if (state.setup) {
            if (state.setup.browser_user && state.setup.browser_user.status === 'verified')
              state.setup.browser_user = null;
            if (state.setup.approval_scope && state.setup.approval_scope.status === 'ready')
              state.setup.approval_scope = null;
            state.setup.advancement = null;
          }
          state.approvalReady = false;
          state.snapshot = null;
          state.loaded = false;
          state.readBlocked = true;
          state.heldRequests = [];
          state.receiptAccessError = 'forbidden';
          clearReceipts(true);
          stopPolling();
        }
        state.recoveryRequests =
          status.ready === true && Array.isArray(status.recoveryRequests)
            ? status.recoveryRequests.filter(function (item) {
                return (
                  item &&
                  UUID.test(item.request_id) &&
                  UUID.test(item.approval_request_id) &&
                  HASH.test(item.display_digest) &&
                  item.session_id === state.sessionId &&
                  state.snapshot &&
                  state.snapshot.scope &&
                  state.snapshot.scope.tier === 'public' &&
                  item.tenant === state.snapshot.scope.tenant &&
                  Number.isSafeInteger(item.revision) &&
                  item.revision > 0 &&
                  item.revision <= 64 &&
                  ['eligible', 'terminated_unstarted'].indexOf(item.status) !== -1
                );
              })
            : [];
        if (
          status.ready === true &&
          Array.isArray(status.recoveryRequests) &&
          state.recoveryRequests.length !== status.recoveryRequests.length
        )
          state.approvalReady = false;
        state.heldRequests = Array.isArray(status.heldRequests)
          ? status.heldRequests.filter(function (held) {
              return (
                held &&
                UUID.test(held.request_id) &&
                held.status === 'approval_verification_failed' &&
                held.recovery === 'operator_recovery'
              );
            })
          : status.ready === true
            ? []
            : state.heldRequests;
        render();
        if (
          state.resumeRead &&
          visible() &&
          !state.approvalBusy &&
          !state.sending &&
          !state.refreshing
        )
          refresh();
      },
      onDecision: function () {
        if (!visible()) {
          state.resumeRead = true;
          return;
        }
        refresh();
      },
    });
    var timer;
    return new Promise(function (resolve, reject) {
      timer = window.setTimeout(function () {
        if (sequence === state.approvalSequence) invalidateApproval();
        reject(new Error('approval_read_timeout'));
      }, 15000);
      Promise.resolve(check).then(resolve, reject);
    }).finally(function () {
      window.clearTimeout(timer);
    });
  }
  function invalidateApproval() {
    state.approvalSequence++;
    state.approvalReady = false;
    state.approvalBusy = false;
    state.recoveryRequests = [];
    // A failed read cannot prove that a previously held request has recovered.
    if (window.KyberionFirstJobApproval) window.KyberionFirstJobApproval.invalidate();
  }
  function refresh() {
    if (state.sending || state.approvalBusy || state.refreshing) return Promise.resolve();
    var sequence = ++state.refreshSequence;
    state.resumeRead = false;
    var requestedSession = state.sessionId;
    state.refreshing = true;
    state.readBlocked = false;
    state.refreshController = window.AbortController ? new window.AbortController() : null;
    invalidateApproval();
    render();
    var query = new URLSearchParams();
    if (locale()) query.set('locale', locale());
    if (state.sessionId) query.set('session_id', state.sessionId);
    return fetchJson(
      '/api/first-job?' + query.toString(),
      {
        credentials: 'same-origin',
        cache: 'no-store',
      },
      state.refreshController
    )
      .then(function (result) {
        if (sequence !== state.refreshSequence) return;
        if (!result.ok || !result.body || !result.body.ok) {
          if (result.status >= 400 && result.status < 500) {
            invalidateReadAccess(
              result.status === 401 || result.status === 403 ? 'forbidden' : 'unavailable'
            );
            return;
          }
          throw new Error('status_unavailable');
        }
        if (
          requestedSession &&
          result.body.sessionId !== requestedSession &&
          (result.body.sessionId || !result.body.readiness || result.body.readiness.ready !== false)
        ) {
          invalidateReadAccess('unavailable');
          return;
        }
        applySnapshot(result.body);
        state.lastChecked = Date.now();
        state.networkError = false;
        state.pollFailures = 0;
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
        if (sequence !== state.refreshSequence) return;
        state.loaded = false;
        state.setup = null;
        state.networkError = true;
        state.pollFailures = Math.min(state.pollFailures + 1, 4);
        invalidateApproval();
        state.errorKey = state.pending ? 'uncertain' : 'load_failed';
      })
      .finally(function () {
        if (sequence !== state.refreshSequence) return;
        state.refreshController = null;
        state.refreshing = false;
        render();
      });
  }
  function sendPending() {
    if (state.sending || !state.pending || !state.storageReady) return;
    state.sending = true;
    // An intake outcome is unknown until fresh server readback arrives.
    state.setup = null;
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
        if (!result.ok || !result.body || !result.body.ok) {
          state.pending.retrySafe = !!(result.body && result.body.retry_safe === true);
          state.pending.checked = false;
          state.loaded = false;
          state.errorKey = state.pending.retrySafe ? 'retry_safe' : 'uncertain';
          save();
          if ([401, 403, 409].indexOf(result.status) !== -1) invalidateReadAccess('forbidden');
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
    if (action === 'start' && (tasks().length || messages().length) && !canRestart()) return;
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
    ['body', 'left', 'right'].forEach(function (slot) {
      el(slot + '-select').addEventListener('change', function () {
        var key = el(slot + '-select').value;
        if (!selectedArtifact(key)) return;
        state.selection[slot] = key;
        loadSelectedReceipts(false);
        renderReceipts();
      });
    });
    el('body-retry').addEventListener('click', function () {
      loadSelectedReceipts(true);
      renderReceipts();
    });
    document.addEventListener('visibilitychange', function () {
      if (!visible()) suspendReads();
      else if (state.resumeRead || progressing()) refresh();
      else render();
    });
    window.addEventListener('pagehide', function () {
      state.pageActive = false;
      suspendReads(true);
    });
    window.addEventListener('pageshow', function () {
      state.pageActive = true;
      if (visible() && (state.resumeRead || progressing())) refresh();
    });
    el('start').addEventListener('click', function () {
      if (!tasks().length && !messages().length) submitNew('start');
    });
    el('restart').addEventListener('click', function () {
      if (canRestart()) submitNew('start');
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
    if (state.sending || state.refreshing || state.loadingVocabulary) return Promise.resolve();
    if (state.vocabReady) return refresh();
    state.loadingVocabulary = true;
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
      })
      .finally(function () {
        state.loadingVocabulary = false;
      });
  }
  window.KyberionFirstJob = { mount: mount };
})();
