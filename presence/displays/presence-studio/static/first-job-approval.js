/* Dedicated diagnostic approval. No credential creation or loopback identity inference.
 * Every decision is an explicit click bound to the latest server display digest.
 * Reload and refresh only read; cookie verification and effect authorization stay server-side.
 */
/* global window, document, fetch, URLSearchParams */
(function () {
  'use strict';
  var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  var HASH = /^[a-f0-9]{64}$/;
  var SESSION = /^concierge-[a-f0-9]{64}$/;
  var state = {
    context: null,
    generation: 0,
    loading: false,
    readController: null,
    sending: false,
    eligible: false,
    authStatus: null,
    readiness: null,
    items: [],
    held: [],
    error: null,
    message: null,
    mounted: false,
  };
  function el(id) {
    return document.getElementById('first-job-approval-' + id);
  }
  function text(key) {
    return (state.context && state.context.vocab['front_desk:first_job_' + key]) || '';
  }
  function tellParent() {
    if (state.context && state.context.onChange) {
      var update = {
        ready: state.eligible && !state.loading && !state.sending,
        busy: state.sending,
      };
      if (state.held.length) update.heldRequests = state.held;
      state.context.onChange(update);
    }
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
  function validItem(item) {
    var snapshot = state.context && state.context.snapshot;
    return (
      item &&
      UUID.test(item.approval_request_id) &&
      UUID.test(item.request_id) &&
      Number.isSafeInteger(item.revision) &&
      item.revision > 0 &&
      item.revision <= 64 &&
      HASH.test(item.display_digest) &&
      HASH.test(item.payload_hash) &&
      /^first-job:[a-f0-9]{64}$/.test(item.effect_binding) &&
      typeof item.tenant === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.tenant) &&
      snapshot &&
      snapshot.scope &&
      snapshot.scope.tier === 'public' &&
      item.tenant === snapshot.scope.tenant &&
      (item.receipt_format === 'pretty' || item.receipt_format === 'compact') &&
      typeof item.expires_at === 'string' &&
      Number.isFinite(Date.parse(item.expires_at)) &&
      typeof item.execution_deadline_at === 'string' &&
      Number.isFinite(Date.parse(item.execution_deadline_at)) &&
      Date.parse(item.execution_deadline_at) <= Date.parse(item.expires_at) &&
      Date.parse(item.execution_deadline_at) > Date.now()
    );
  }
  function validHeld(item) {
    return (
      item &&
      UUID.test(item.request_id) &&
      item.status === 'approval_verification_failed' &&
      item.recovery === 'operator_recovery'
    );
  }
  function authKey() {
    if (state.loading) return 'approval_loading';
    if (state.sending) return 'approval_sending';
    if (state.authStatus === 'authentication_configuration_required')
      return 'approval_configuration';
    if (state.authStatus === 'authentication_required') return 'approval_auth_needed';
    if (state.authStatus === 'access_denied') return 'approval_forbidden';
    if (state.readiness === 'scope_changed' || state.readiness === 'diagnostic_unavailable')
      return 'approval_diagnostic_unavailable';
    return state.eligible ? 'approval_ready' : 'approval_unknown';
  }
  function render() {
    el('readiness').textContent = text(authKey());
    el('signin').hidden =
      ['authentication_required', 'authentication_configuration_required'].indexOf(
        state.authStatus
      ) === -1;
    el('refresh').disabled = state.sending || state.loading || !state.context;
    el('error').hidden = !state.error;
    el('error').textContent = state.error ? text(state.error) : '';
    el('status').textContent = text(
      state.sending
        ? 'approval_sending'
        : state.message ||
            (state.held.length
              ? 'approval_held'
              : state.eligible && !state.items.length
                ? 'approval_empty'
                : authKey())
    );
    var container = el('items');
    container.replaceChildren();
    state.items.forEach(function (item) {
      if (!validItem(item)) return;
      var card = append(container, 'article', undefined, 'home-work-item');
      append(card, 'h3', text('approval_title'), 'kb-section__title');
      append(card, 'p', text('approval_effect'));
      append(card, 'p', text('approval_validity'));
      field(card, 'approval_id', item.approval_request_id);
      field(card, 'request', item.request_id);
      field(card, 'revision', item.revision);
      field(card, 'scope', item.tenant);
      field(
        card,
        'format',
        text(item.receipt_format === 'compact' ? 'format_compact' : 'format_readable')
      );
      field(card, 'approval_destination', text('approval_destination_local'));
      field(
        card,
        'approval_execution_deadline',
        new Date(item.execution_deadline_at).toLocaleString(state.context.locale)
      );
      field(card, 'approval_effect_digest', item.display_digest);
      field(card, 'approval_payload_digest', item.payload_hash);
      field(card, 'approval_binding_digest', item.effect_binding);
      var buttons = append(card, 'div', undefined, 'home-work-toolbar');
      var generation = state.generation;
      ['approved', 'rejected'].forEach(function (decision) {
        var button = append(
          buttons,
          'button',
          text(decision === 'approved' ? 'approval_accept' : 'approval_reject'),
          decision === 'approved' ? 'kb-btn kb-btn--primary' : 'kb-btn kb-btn--secondary'
        );
        button.type = 'button';
        button.disabled = !state.eligible || state.loading || state.sending;
        button.addEventListener('click', function () {
          if (generation !== state.generation || !state.eligible || state.loading || state.sending)
            return;
          if (!validItem(item)) {
            state.eligible = false;
            state.error = 'approval_changed';
            render();
            return;
          }
          decide(item, decision);
        });
      });
    });
    state.held.forEach(function (item) {
      var card = append(container, 'article', undefined, 'home-work-item');
      append(card, 'h3', text('approval_held'), 'kb-section__title');
      field(card, 'request', item.request_id);
      append(card, 'p', text('approval_held_detail'));
    });
    tellParent();
  }
  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    });
  }
  function readApproval(url, controller, parentSignal) {
    var timer;
    var cancel;
    return new Promise(function (resolve, reject) {
      cancel = function () {
        reject(new Error('approval_read_cancelled'));
        if (controller && !controller.signal.aborted) controller.abort();
      };
      if (controller) controller.signal.addEventListener('abort', cancel, { once: true });
      if (parentSignal) parentSignal.addEventListener('abort', cancel, { once: true });
      timer = window.setTimeout(cancel, 15000);
      if (parentSignal && parentSignal.aborted) {
        cancel();
        return;
      }
      fetchJson(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      }).then(resolve, reject);
    }).finally(function () {
      window.clearTimeout(timer);
      if (controller) controller.signal.removeEventListener('abort', cancel);
      if (parentSignal) parentSignal.removeEventListener('abort', cancel);
    });
  }
  function contextValid(context) {
    return (
      context &&
      context.snapshot &&
      SESSION.test(context.snapshot.sessionId) &&
      context.snapshot.readiness &&
      context.snapshot.readiness.ready === true &&
      context.snapshot.readiness.status === 'diagnostic_mapping_ready'
    );
  }
  function check(context) {
    if (state.sending) return Promise.resolve();
    if (state.readController) state.readController.abort();
    state.readController = null;
    state.context = context;
    if (!state.mounted) {
      el('refresh').addEventListener('click', function () {
        if (!state.loading && !state.sending) check(state.context);
      });
      state.mounted = true;
    }
    var generation = ++state.generation;
    state.eligible = false;
    state.items = [];
    state.held = [];
    state.error = null;
    state.message = null;
    state.authStatus = null;
    state.readiness = null;
    if (!contextValid(context)) {
      state.loading = false;
      state.readiness = 'diagnostic_unavailable';
      render();
      return Promise.resolve();
    }
    state.loading = true;
    render();
    var query = new URLSearchParams();
    query.set('session_id', context.snapshot.sessionId);
    if (context.locale) query.set('locale', context.locale);
    var controller = window.AbortController ? new window.AbortController() : null;
    state.readController = controller;
    return readApproval('/api/first-job/approvals?' + query.toString(), controller, context.signal)
      .then(function (result) {
        if (generation !== state.generation) return;
        var body = result.body;
        if (
          !result.ok ||
          !body ||
          body.ok !== true ||
          !body.auth ||
          !body.readiness ||
          !Array.isArray(body.approvals)
        )
          throw new Error('approval_unavailable');
        state.authStatus = body.auth.status;
        state.readiness = body.readiness.status;
        state.eligible =
          body.auth.status === 'ready' &&
          body.readiness.ready === true &&
          body.readiness.status === 'ready';
        if (state.eligible) {
          var held = body.held_requests === undefined ? [] : body.held_requests;
          if (
            !body.approvals.every(validItem) ||
            !Array.isArray(held) ||
            !held.every(validHeld) ||
            held.some(function (item) {
              return body.approvals.some(function (approval) {
                return approval.request_id === item.request_id;
              });
            })
          ) {
            state.eligible = false;
            state.error = 'approval_changed';
          } else {
            state.items = body.approvals;
            state.held = held;
          }
        }
      })
      .catch(function () {
        if (generation !== state.generation) return;
        state.eligible = false;
        state.items = [];
        state.error = 'approval_failed';
      })
      .finally(function () {
        if (generation !== state.generation) return;
        state.readController = null;
        state.loading = false;
        render();
      });
  }
  function invalidate() {
    if (state.sending) return;
    if (state.readController) state.readController.abort();
    state.readController = null;
    state.generation += 1;
    state.eligible = false;
    state.loading = false;
    state.authStatus = null;
    state.items = [];
    state.held = [];
    state.readiness = 'diagnostic_unavailable';
    if (state.context) render();
  }
  function decide(item, decision) {
    state.sending = true;
    state.eligible = false;
    state.generation += 1;
    state.error = null;
    render();
    var context = state.context;
    var body = {
      decision: decision,
      display_digest: item.display_digest,
      session_id: context.snapshot.sessionId,
    };
    return fetchJson(
      '/api/first-job/approvals/' + encodeURIComponent(item.approval_request_id) + '/decision',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
      .then(function (result) {
        if (
          !result.ok ||
          !result.body ||
          result.body.ok !== true ||
          result.body.approval_request_id !== item.approval_request_id ||
          result.body.status !== decision
        ) {
          state.error =
            result.body && result.body.retry_safe === true
              ? 'approval_changed'
              : 'approval_uncertain';
          return;
        }
        state.items = [];
        state.message = 'approval_recorded';
      })
      .catch(function () {
        state.error = 'approval_uncertain';
      })
      .finally(function () {
        state.sending = false;
        render();
        if (!state.error && context.onDecision) context.onDecision();
      });
  }
  window.KyberionFirstJobApproval = { check: check, invalidate: invalidate };
})();
