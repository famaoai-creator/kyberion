/* Ask conversation recovery: bounded GETs, safe drafts, retry identity and read projections. */
/* global window, document */
(function () {
  'use strict';
  function create(options) {
    var state = options.state;
    var fetch = options.fetch;
    var historySequence = 0;
    state.draftScopeEpoch = 0;
    state.draftShellReady = true;
    state.draftRecoveryScope = null;
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

    // This deadline ends the browser wait, not server execution. Never auto-resend a POST.
    function fetchConversationJson(options, attempt) {
      return new Promise(function (resolve, reject) {
        var controller = window.AbortController ? new window.AbortController() : null;
        var settled = false;
        function finish(error, result) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (error) reject(error);
          else resolve(result);
        }
        var timer = window.setTimeout(function () {
          finish(new Error('Conversation result unconfirmed'));
          if (controller) controller.abort();
        }, 60000);
        attempt.cancel = function () {
          finish(new Error('Conversation wait retired'));
          if (controller) controller.abort();
        };
        if (controller) options.signal = controller.signal;
        Promise.resolve()
          .then(function () {
            return fetch('/api/conversation', options).then(function (response) {
              return response.json().then(function (body) {
                return { ok: response.ok, status: response.status, body: body };
              });
            });
          })
          .then(
            function (result) {
              finish(null, result);
            },
            function (error) {
              finish(error);
            }
          );
      });
    }

    function bindNavigation(requestId, navigation, scope, epoch) {
      state.turns.forEach(function (turn) {
        if (turn.role === 'user' && turn.id === requestId + '-user') {
          turn.navigation = navigation;
          turn.navigationScope = scope;
          turn.navigationEpoch = epoch;
        }
      });
    }

    function renderNavigation(turn) {
      if (
        !state.draftShellReady ||
        turn.navigationScope !== draftScopeSnapshot() ||
        turn.navigationEpoch !== state.draftScopeEpoch ||
        turn.role !== 'user' ||
        typeof turn.id !== 'string' ||
        !/^[a-f0-9-]{36}-user$/.test(turn.id) ||
        !Array.isArray(turn.navigation) ||
        turn.navigation.length > 64
      )
        return '';
      var seen = {};
      return turn.navigation
        .map(function (link, index) {
          if (!link || Object.keys(link).length !== 2 || typeof link.id !== 'string') return '';
          var href;
          var label;
          if (
            link.kind === 'request' &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(link.id)
          ) {
            var original = state.turns.find(function (item) {
              return item.role === 'user' && item.id === link.id + '-user';
            });
            if (!original || original.id === turn.id) return '';
            href = '/ask?request=' + encodeURIComponent(link.id);
            label = vt(state.vocab, 'front_desk:ask_original_request');
            if (turn.navigation.length > 1) label += ': ' + original.text.slice(0, 80);
          } else if (
            link.kind === 'progress' &&
            /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(link.id)
          ) {
            href = '/progress#' + encodeURIComponent(link.id);
            label = vt(state.vocab, 'front_desk:nav_progress');
            if (turn.navigation.length > 1) label += ' ' + (index + 1);
          } else return '';
          if (!label || seen[href]) return '';
          seen[href] = true;
          return (
            '<a href="' +
            options.escapeHtml(scopedUrl(href)) +
            '">' +
            options.escapeHtml(label) +
            '</a>'
          );
        })
        .join(' ');
    }

    function draftScopeSnapshot(includeConversation) {
      var params = new URLSearchParams(window.location.search);
      ['ask', 'send', 'mic'].forEach(function (key) {
        params.delete(key);
      });
      return JSON.stringify([
        window.location.pathname,
        params.toString(),
        window.location.hash,
        scopedUrl('/api/conversation'),
        includeConversation === false ? null : state.conversationId,
        state.locale,
        window.KyberionPrefs && window.KyberionPrefs.tenant ? window.KyberionPrefs.tenant() : null,
        state.draftScopeEpoch,
      ]);
    }

    function pendingReviewCurrent(request, scope, shell) {
      if (
        !request ||
        state.sending ||
        state.historyReadPending ||
        state.historyState !== 'ready' ||
        !state.storageVerified ||
        !state.draftShellReady ||
        state.shellBlockedMessage ||
        scope !== state.draftRecoveryScope ||
        scope !== draftScopeSnapshot() ||
        shell !== (window.FrontDeskRail && window.FrontDeskRail.ready)
      )
        return false;
      try {
        var saved = readPendingRequest();
        return Boolean(
          saved &&
          saved.id === request.id &&
          saved.text === request.text &&
          saved.createdAt === request.createdAt
        );
      } catch (err) {
        return false;
      }
    }

    function renderPendingReview() {
      var host = document.getElementById('pending-request-recovery');
      var button = document.getElementById('pending-request-review');
      var description = document.getElementById('pending-request-description');
      var request = state.pendingRequest;
      var scope = state.draftRecoveryScope;
      var shell = window.FrontDeskRail && window.FrontDeskRail.ready;
      var current = function () {
        return pendingReviewCurrent(request, scope, shell);
      };
      if (host) host.hidden = !current();
      if (description)
        description.textContent = vt(state.vocab, 'front_desk:ask_pending_review_description');
      if (button) {
        button.disabled = !current();
        button.textContent = vt(state.vocab, 'front_desk:ask_pending_review');
      }
      var preserved = document.getElementById('home-draft-preserved');
      if (preserved) {
        preserved.hidden = !state.homeDraftPreserved;
        preserved.textContent = vt(state.vocab, 'front_desk:ask_home_draft_preserved');
      }
    }

    function readPendingRequest() {
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
      return saved;
    }

    function completeRequest(request, sentScope) {
      try {
        var retained = readPendingRequest();
        if (
          retained &&
          retained.id === request.id &&
          retained.text === request.text &&
          retained.createdAt === request.createdAt &&
          sentScope === draftScopeSnapshot()
        ) {
          window.sessionStorage.removeItem(options.draftKey() + '.request');
          state.pendingRequest = null;
        } else state.pendingRequest = retained;
      } catch (err) {}
    }

    function prepareRequest(trimmed) {
      try {
        state.pendingRequest = readPendingRequest();
      } catch (err) {
        state.storageVerified = false;
        state.errorKey = 'front_desk:conversation_storage_required';
        options.render();
        return null;
      }
      if (state.pendingRequest && state.pendingRequest.text !== trimmed) {
        state.errorKey = 'front_desk:ask_pending_send_blocked';
        options.render();
        return null;
      }
      var waiting = state.turns.find(function (turn) {
        return (
          turn.role === 'user' &&
          turn.text === trimmed &&
          typeof turn.id === 'string' &&
          !state.turns.some(function (reply) {
            return reply.id === turn.id.replace(/-user$/, '-secretary');
          })
        );
      });
      var request = state.pendingRequest
        ? state.pendingRequest
        : waiting
          ? {
              id: waiting.id.replace(/-user$/, ''),
              text: trimmed,
              createdAt: waiting.createdAt || Date.now(),
            }
          : { id: options.randomId(), text: trimmed, createdAt: Date.now() };
      try {
        var serialized = JSON.stringify(request);
        window.sessionStorage.setItem(options.draftKey() + '.request', serialized);
        if (window.sessionStorage.getItem(options.draftKey() + '.request') !== serialized)
          throw new Error('request not retained');
      } catch (err) {
        state.storageVerified = false;
        state.errorKey = 'front_desk:conversation_storage_required';
        options.render();
        return null;
      }
      return request;
    }

    function restoreConversation(restoreDraft) {
      if (state.historyReadPending || state.sending) return Promise.resolve(false);
      var sequence = ++historySequence;
      var readStart = {
        scope: draftScopeSnapshot(false),
        shell: window.FrontDeskRail && window.FrontDeskRail.ready,
      };
      state.historyReadPending = true;
      state.historyState = 'loading';
      state.errorKey = null;
      options.renderConversationStatus();
      return fetchReadJson(scopedUrl('/api/conversation'))
        .then(function (result) {
          if (sequence !== historySequence) return false;
          if (
            !state.draftShellReady ||
            readStart.scope !== draftScopeSnapshot(false) ||
            readStart.shell !== (window.FrontDeskRail && window.FrontDeskRail.ready)
          ) {
            state.historyReadPending = false;
            state.historyState = 'failed';
            options.render();
            return false;
          }
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
                navigation: m.navigation,
                navigationScope: draftScopeSnapshot(),
                navigationEpoch: state.draftScopeEpoch,
              };
            });
          var input = document.getElementById('ask-input');
          try {
            var savedDraft = window.sessionStorage.getItem(options.draftKey());
            state.pendingRequest = readPendingRequest();
            var pending = state.pendingRequest;
            // A matching completed pair in this server-scoped history is confirmation,
            // not permission to replay. Unknown or truncated history retains the identity.
            if (
              pending &&
              state.turns.some(function (turn) {
                return (
                  turn.id === pending.id + '-user' &&
                  turn.role === 'user' &&
                  turn.text === pending.text
                );
              }) &&
              state.turns.some(function (turn) {
                return turn.id === pending.id + '-secretary' && turn.role === 'companion';
              })
            ) {
              window.sessionStorage.removeItem(options.draftKey() + '.request');
              if (window.sessionStorage.getItem(options.draftKey() + '.request') !== null)
                throw new Error('confirmed request not cleared');
              state.pendingRequest = null;
            }
            state.storageVerified = true;
            if (state.navigationResumed && state.pendingRequest)
              state.errorKey = 'concierge:dock.history.pending';
            if (
              !state.navigationResumed &&
              (restoreDraft || !state.draftRestored) &&
              input &&
              !state.draftEdited
            )
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
          if (state.storageVerified) state.draftRecoveryScope = draftScopeSnapshot();
          options.render();
          if (state.storageVerified && options.onConversationRestored)
            options.onConversationRestored();
          if (state.storageVerified && !state.navigationResumed) options.onHistoryReady();
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
      var review = document.getElementById('pending-request-review');
      if (review)
        review.addEventListener('click', function () {
          var request = state.pendingRequest;
          var scope = state.draftRecoveryScope;
          var shell = window.FrontDeskRail && window.FrontDeskRail.ready;
          var current = function () {
            return pendingReviewCurrent(request, scope, shell);
          };
          if (current()) options.proposeDraft(request.text, current);
        });
      function retireDraftRecovery() {
        state.draftScopeEpoch += 1;
        if (
          state.proposedDraft &&
          state.proposedDraft.isCurrent &&
          !state.proposedDraft.isCurrent()
        )
          options.cancelDraftChoice(false);
        options.render();
      }
      if (window.addEventListener) {
        var hidden = false;
        var resumeSequence = 0;
        var resumeTimer = null;
        window.addEventListener('popstate', retireDraftRecovery);
        window.addEventListener('pagehide', function () {
          hidden = true;
          resumeSequence += 1;
          if (resumeTimer !== null) window.clearTimeout(resumeTimer);
          resumeTimer = null;
          retireDraftRecovery();
        });
        window.addEventListener('pageshow', function (event) {
          if (!event || !event.persisted || !hidden) return;
          hidden = false;
          var sequence = ++resumeSequence;
          // Retire callbacks synchronously; even a resolved old GET must not prefill/send.
          historySequence += 1;
          state.historyReadPending = false;
          state.historyState = 'loading';
          state.errorKey = null;
          state.navigationResumed = true;
          options.retireSend();
          options.retireStartup();
          options.render();
          // History traversal dispatches popstate and restores form state after pageshow.
          resumeTimer = window.setTimeout(function () {
            resumeTimer = null;
            var shell = window.FrontDeskRail && window.FrontDeskRail.ready;
            var scope = draftScopeSnapshot(false);
            Promise.resolve(shell)
              .then(function () {
                if (sequence !== resumeSequence) return;
                if (
                  !state.draftShellReady ||
                  scope !== draftScopeSnapshot(false) ||
                  shell !== (window.FrontDeskRail && window.FrontDeskRail.ready)
                ) {
                  state.historyState = 'failed';
                  options.render();
                  return;
                }
                if (state.vocabularyReady) options.restoreConversation(false);
                else options.loadStartup();
              })
              .catch(function () {
                if (sequence !== resumeSequence) return;
                state.historyState = 'failed';
                options.render();
              });
          }, 0);
        });
      }
      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function (shell) {
          state.draftShellReady = shell.phase === 'ready';
          if (!state.draftShellReady) retireDraftRecovery();
        });

      if (window.FrontDeskRail && window.FrontDeskRail.subscribe)
        window.FrontDeskRail.subscribe(function (shell) {
          state.shellBlockedMessage = shell.phase === 'blocked' ? shell.message : '';
          renderStartup();
          var recent = document.getElementById('recent-card');
          if (recent && !state.vocabularyReady) recent.hidden = Boolean(state.shellBlockedMessage);
        });
    }

    return {
      scopeSnapshot: draftScopeSnapshot,
      renderNavigation: renderNavigation,
      bindNavigation: bindNavigation,
      renderDraftRecovery: renderPendingReview,
      prepareRequest: prepareRequest,
      completeRequest: completeRequest,
      restoreConversation: restoreConversation,
      observeShell: observeShell,
      renderStartup: renderStartup,
      fetchJson: fetchReadJson,
      fetchConversationJson: fetchConversationJson,
      hasBootVocabulary: hasBootVocabulary,
      renderRecent: renderRecentRead,
      refreshRecent: refreshRecent,
    };
  }
  window.KyberionAskReadRecovery = { create: create };
})();
