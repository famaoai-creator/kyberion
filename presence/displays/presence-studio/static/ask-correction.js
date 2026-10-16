/* Recorded feedback is a scoped read and a user-reviewed draft, never execution. */
/* global window, document, URLSearchParams */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var sequence = 0;
    var pending = false;
    var prepared = null;
    var phase = 'idle';
    function label(key) {
      return options.vt(state.vocab, 'front_desk:ask_correction_' + key);
    }
    function render() {
      var host = document.getElementById('ask-correction-status');
      if (host) {
        host.hidden = phase === 'idle';
        host.setAttribute('aria-busy', String(phase === 'loading'));
      }
      var text = document.getElementById('ask-correction-text');
      if (text && phase !== 'idle') text.textContent = label(phase);
      var retry = document.getElementById('ask-correction-retry');
      if (retry) {
        retry.hidden = phase !== 'failed';
        retry.disabled = pending;
        retry.textContent = label('retry');
      }
    }
    function snapshot() {
      return [
        window.location.pathname,
        window.location.search,
        window.location.hash,
        options.scopedUrl('/api/conversation'),
        state.conversationId,
      ].join('\n');
    }
    function usable() {
      return (
        state.historyState === 'ready' &&
        state.storageVerified &&
        !state.sending &&
        !state.shellBlockedMessage
      );
    }
    function invalidate() {
      sequence += 1;
      pending = false;
      prepared = null;
      phase = 'idle';
      render();
    }
    function apply() {
      var params = new URLSearchParams(window.location.search);
      if (params.has('request') || !params.has('correction') || !usable())
        return Promise.resolve(false);
      var identity = snapshot();
      if (pending || prepared === identity) return Promise.resolve(false);
      var entry = params.get('correction');
      var artifact = params.get('artifact');
      if (
        !entry ||
        !artifact ||
        entry.length > 512 ||
        artifact.length > 512 ||
        params.getAll('correction').length !== 1 ||
        params.getAll('artifact').length !== 1
      ) {
        phase = 'failed';
        render();
        return Promise.resolve(false);
      }
      var serial = ++sequence;
      var shell = window.FrontDeskRail && window.FrontDeskRail.ready;
      var boundScope = null;
      function current() {
        return (
          serial === sequence &&
          identity === snapshot() &&
          usable() &&
          (!boundScope || state.conversationId === 'concierge-' + boundScope) &&
          shell === (window.FrontDeskRail && window.FrontDeskRail.ready)
        );
      }
      function accepted() {
        if (!current()) return;
        var clean = new URLSearchParams(window.location.search);
        ['correction', 'artifact', 'ask', 'send', 'mic'].forEach(function (key) {
          clean.delete(key);
        });
        var query = clean.toString();
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + (query ? '?' + query : '') + window.location.hash
        );
      }
      function dismissed() {
        if (!current()) return;
        accepted();
        invalidate();
      }
      pending = true;
      phase = 'loading';
      render();
      return Promise.resolve()
        .then(function () {
          if (!current()) return null;
          return options.fetchJson(
            options.scopedUrl(
              '/api/progress/' +
                encodeURIComponent(artifact) +
                '/correction-context?entry=' +
                encodeURIComponent(entry)
            )
          );
        })
        .then(function (result) {
          if (!current()) return false;
          var body = result && result.body;
          var context = body && body.context;
          if (
            !result.ok ||
            !body ||
            body.ok !== true ||
            typeof body.viewer_scope_id !== 'string' ||
            state.conversationId !== 'concierge-' + body.viewer_scope_id ||
            !context ||
            context.entry_id !== entry ||
            context.artifact_id !== artifact ||
            typeof context.title !== 'string' ||
            typeof context.note !== 'string' ||
            (context.status !== 'rejected' && context.status !== 'changes_requested')
          )
            throw new Error('Recorded feedback unavailable');
          boundScope = body.viewer_scope_id;
          var draft =
            label('draft_intro') +
            '\n\n' +
            label('entry') +
            ': ' +
            context.entry_id +
            '\n' +
            label('artifact') +
            ': ' +
            context.artifact_id +
            '\n' +
            label('title') +
            ': ' +
            context.title +
            '\n\n' +
            label('note') +
            ':\n' +
            context.note;
          if (!options.proposeDraft(draft, current, accepted, dismissed)) return false;
          prepared = identity;
          phase = 'prepared';
          return true;
        })
        .catch(function () {
          if (current()) phase = 'failed';
          return false;
        })
        .finally(function () {
          if (serial !== sequence) return;
          pending = false;
          // A stale response must not leave a misleading loading announcement.
          if (phase === 'loading') phase = 'idle';
          render();
        });
    }
    function mount() {
      var retry = document.getElementById('ask-correction-retry');
      if (retry) retry.addEventListener('click', apply);
      if (window.addEventListener) {
        window.addEventListener('popstate', invalidate);
        window.addEventListener('pagehide', invalidate);
      }
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function (shell) {
          if (shell.phase === 'blocked') invalidate();
        });
    }
    return { apply: apply, mount: mount };
  }
  window.KyberionAskCorrection = { create: create };
})();
