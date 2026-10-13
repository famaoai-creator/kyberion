/* Current saved replies may prepare bounded editable drafts, never execute them. */
/* global window, document */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var vt = options.vt;
    var scopedUrl = options.scopedUrl;
    var escapeHtml = options.escapeHtml;
    var proposeDraft = options.proposeDraft;
    var cancelDraftChoice = options.cancelDraftChoice;
    var renderTurns = options.renderTurns;
    state.liveActionSource = null;
    state.actionSourceSequence = 0;
    state.actionShellReady = true;

    // A live action only prepares editable text. Its source is the enclosing
    // durable response, never the intent resolver's non-durable request hash.
    function actionRecord(value) {
      return value && typeof value === 'object' && !Array.isArray(value);
    }

    function boundedActionText(value, limit) {
      return typeof value === 'string' && value.length <= limit && value.trim()
        ? value.trim()
        : null;
    }

    function boundedMissingInputs(value) {
      if (!Array.isArray(value) || value.length > 8) return null;
      var fields = value.map(function (entry) {
        return boundedActionText(entry, 96);
      });
      return fields.every(Boolean) ? fields : null;
    }

    function parseDraftAction(body) {
      if (!Array.isArray(body.next_actions) || body.next_actions.length !== 1) return null;
      var action = body.next_actions[0];
      var contract = body.intent_resolution;
      if (!actionRecord(action) || !actionRecord(contract) || !actionRecord(contract.next_action))
        return null;
      var expected =
        contract.authority_level === 'human_clarification_required' &&
        contract.next_action.kind === 'provide_input'
          ? 'draft_input'
          : contract.authority_level === 'approval_required' &&
              contract.next_action.kind === 'request_approval'
            ? 'draft_review'
            : null;
      if (
        !expected ||
        action.id !== expected ||
        Object.keys(action).length !== 4 ||
        !Object.keys(action).every(function (key) {
          return ['id', 'label', 'consequence', 'missing_inputs'].indexOf(key) !== -1;
        })
      )
        return null;
      var label = boundedActionText(action.label, 256);
      var consequence = boundedActionText(action.consequence, 512);
      var missing = boundedMissingInputs(action.missing_inputs);
      var contractMissing = boundedMissingInputs(contract.missing_inputs);
      if (
        !label ||
        !consequence ||
        !missing ||
        !contractMissing ||
        label !== boundedActionText(contract.next_action.label, 256) ||
        consequence !== boundedActionText(contract.next_action.consequence, 512) ||
        JSON.stringify(missing) !== JSON.stringify(contractMissing)
      )
        return null;
      return { id: expected, label: label, consequence: consequence, missing_inputs: missing };
    }

    function actionScopeSnapshot() {
      try {
        return JSON.stringify([
          window.location.pathname,
          window.location.search,
          window.location.hash,
          scopedUrl('/api/conversation'),
          window.KyberionPrefs && window.KyberionPrefs.tenant
            ? window.KyberionPrefs.tenant()
            : null,
          state.conversationId,
          state.locale,
        ]);
      } catch (err) {
        return null;
      }
    }

    function retireNextActions() {
      state.actionSourceSequence += 1;
      state.liveActionSource = null;
      if (state.proposedDraft && state.proposedDraft.isCurrent && !state.proposedDraft.isCurrent())
        cancelDraftChoice(false);
      if (state.vocabularyReady) renderTurns();
    }

    function currentActionSource(source) {
      if (
        !source ||
        source !== state.liveActionSource ||
        source.accepted ||
        state.sending ||
        state.pending ||
        state.pendingRequest ||
        state.historyReadPending ||
        state.historyState !== 'ready' ||
        !state.storageVerified ||
        !state.actionShellReady ||
        state.shellBlockedMessage ||
        source.sessionId !== state.conversationId ||
        source.scope !== actionScopeSnapshot() ||
        source.shell !== (window.FrontDeskRail && window.FrontDeskRail.ready) ||
        state.turns[state.turns.length - 1] !== source.turn
      )
        return false;
      var user = state.turns[state.turns.length - 2];
      return Boolean(
        user &&
        user.role === 'user' &&
        user.id === source.requestId + '-user' &&
        user.text === source.requestText &&
        source.turn.role === 'companion' &&
        source.turn.id === source.requestId + '-secretary'
      );
    }

    function actionCopy(key, limit) {
      return boundedActionText(vt(state.vocab, 'front_desk:ask_action_' + key), limit || 96);
    }

    function actionContent(source) {
      var action = source.action;
      var labels = {};
      var keys = ['reference', 'guidance', 'missing', 'consequence', 'reply'];
      for (var index = 0; index < keys.length; index += 1) {
        labels[keys[index]] = actionCopy(keys[index]);
        if (!labels[keys[index]]) return null;
      }
      var button = actionCopy(action.id === 'draft_input' ? 'input' : 'review');
      var manual = actionCopy('manual', 512);
      var intro = actionCopy('draft_intro', 512);
      var question = action.id === 'draft_review' ? actionCopy('review_prompt', 256) : '';
      if (!button || !manual || !intro || question === null) return null;
      var excerpt =
        source.requestText.length > 1000
          ? source.requestText.slice(0, 999) + '\u2026'
          : source.requestText;
      var context = [
        labels.reference + ':\n' + excerpt,
        labels.guidance + ':\n' + action.label,
        labels.consequence + ':\n' + action.consequence,
      ];
      if (action.missing_inputs.length)
        context.push(labels.missing + ':\n' + action.missing_inputs.join('\n'));
      var draft = intro + '\n\n' + context.join('\n\n') + '\n\n' + labels.reply + ':\n' + question;
      return draft.length <= 4000
        ? { button: button, manual: manual, context: context, draft: draft }
        : null;
    }

    function bindNextActions(body, request, turn, scope, shell, sequence) {
      if (
        sequence !== state.actionSourceSequence ||
        body.historySaved !== true ||
        (body.replayed !== undefined && body.replayed !== false) ||
        typeof body.request_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.request_id) ||
        body.request_id !== request.id ||
        body.session_id !== state.conversationId ||
        !state.pendingRequest ||
        state.pendingRequest.id !== request.id ||
        state.pendingRequest.text !== request.text ||
        !scope ||
        scope !== actionScopeSnapshot() ||
        shell !== (window.FrontDeskRail && window.FrontDeskRail.ready) ||
        !state.actionShellReady
      )
        return;
      var action = parseDraftAction(body);
      if (!action) return;
      var source = {
        action: action,
        turn: turn,
        requestId: body.request_id,
        sessionId: body.session_id,
        requestText: request.text,
        scope: scope,
        shell: shell,
        accepted: false,
      };
      if (actionContent(source)) state.liveActionSource = source;
    }

    function renderAction(turn) {
      var actionsHtml = '';
      var source = state.liveActionSource;
      var content =
        source && source.turn === turn && currentActionSource(source)
          ? actionContent(source)
          : null;
      if (content) {
        actionsHtml =
          '<div class="ask-turn-next-actions">' +
          content.context
            .map(function (line) {
              return '<p>' + escapeHtml(line) + '</p>';
            })
            .join('') +
          '<p>' +
          escapeHtml(content.manual) +
          '</p>' +
          '<button type="button" class="kb-btn kb-btn--secondary ask-quick-reply" data-next-action="' +
          escapeHtml(source.action.id) +
          '" data-action-request="' +
          escapeHtml(source.requestId) +
          '">' +
          escapeHtml(content.button) +
          '</button></div>';
      }
      return actionsHtml;
    }

    function wireNextActions() {
      var source = state.liveActionSource;
      document.querySelectorAll('[data-next-action]').forEach(function (button) {
        button.addEventListener('click', function () {
          function current() {
            return (
              currentActionSource(source) &&
              button.getAttribute('data-next-action') === source.action.id &&
              button.getAttribute('data-action-request') === source.requestId
            );
          }
          if (!current()) return;
          var content = actionContent(source);
          if (!content) return;
          proposeDraft(content.draft, current, function () {
            if (!current()) return;
            source.accepted = true;
            renderTurns();
          });
        });
      });
    }

    function observeNextActionScope() {
      if (window.addEventListener) {
        window.addEventListener('popstate', retireNextActions);
        window.addEventListener('pagehide', retireNextActions);
      }
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function (shell) {
          state.actionShellReady = shell.phase === 'ready';
          if (!state.actionShellReady) retireNextActions();
        });
    }

    return {
      begin: function () {
        retireNextActions();
        return {
          sequence: state.actionSourceSequence,
          scope: actionScopeSnapshot(),
          shell: window.FrontDeskRail && window.FrontDeskRail.ready,
        };
      },
      bind: function (body, request, turn, attempt) {
        if (attempt)
          bindNextActions(body, request, turn, attempt.scope, attempt.shell, attempt.sequence);
      },
      retire: retireNextActions,
      render: renderAction,
      wire: wireNextActions,
      mount: observeNextActionScope,
    };
  }
  window.KyberionAskNextActions = { create: create };
})();
