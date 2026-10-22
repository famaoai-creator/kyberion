/*
 * flow.js — the front-desk component host page (`/flow/:component`).
 *
 * Assembles the page from the component registry: the shared five-verb rail,
 * a component menu (GET /api/components), and the selected component's A2UI
 * projection (its registry `a2ui_path`) rendered by `a2ui-host.js`. Actions
 * declared by the component (headless operations: method + path + body) are
 * executed here, then the projection is fetched again. When the component
 * declares an `input` operation, the input bar posts the typed text to it.
 *
 * Plain browser script, no external resources; all copy from the server.
 * See docs/developer/improvement-plans-2026-09/A2UI_COMPONENT_HOST_PLAN_2026-09-15.ja.md.
 */
/* global window, document, fetch, sessionStorage */
(function () {
  'use strict';

  var SESSION_KEY = 'kyberion.flow.session';

  var state = {
    vocab: {},
    locale: 'en',
    componentId: '',
    components: [],
    component: null,
    sessionId: '',
    projection: null,
    busy: false,
  };

  function vt(key) {
    return state.vocab[key] || '';
  }

  function normalizeLocale() {
    var raw = String((window.navigator && window.navigator.language) || 'en').toLowerCase();
    return raw.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  function withTenant(url) {
    try {
      var slug = window.localStorage.getItem('front-desk.tenant');
      if (!slug || url.indexOf('/api/') !== 0 || url.indexOf('tenant=') !== -1) return url;
      return url + (url.indexOf('?') === -1 ? '?' : '&') + 'tenant=' + encodeURIComponent(slug);
    } catch (err) {
      return url;
    }
  }

  function fetchJson(url, options) {
    return fetch(withTenant(url), options).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // Request/session ids gate replay, so the fallback must stay unguessable.
    var bytes = new Uint32Array(2);
    window.crypto.getRandomValues(bytes);
    return 'flow-' + Date.now().toString(36) + '-' + bytes[0].toString(36) + bytes[1].toString(36);
  }

  function sessionFor(componentId) {
    var key = SESSION_KEY + '.' + componentId;
    try {
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var next = randomId();
      sessionStorage.setItem(key, next);
      return next;
    } catch (err) {
      return randomId();
    }
  }

  function resetSession(componentId) {
    try {
      sessionStorage.removeItem(SESSION_KEY + '.' + componentId);
    } catch (err) {
      // Best effort only.
    }
  }

  function componentIdFromPath() {
    var match = /^\/flow\/([a-z][a-z0-9-]{0,60})/.exec(window.location.pathname);
    return match ? match[1] : '';
  }

  function setStatus(text, isError) {
    var status = document.getElementById('flow-status');
    if (!status) return;
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
    status.classList.toggle('flow-status-error', Boolean(isError));
  }

  // ------------------------------------------------------------------ menu
  function renderMenu(payload) {
    var title = document.getElementById('flow-menu-title');
    if (title) title.textContent = vt('front_desk:flow_components_title');
    var list = document.getElementById('flow-menu');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var groups = payload.groups || [];
    groups.forEach(function (group) {
      var items = state.components.filter(function (item) {
        return item.group === group.id;
      });
      if (!items.length) return;
      var head = document.createElement('li');
      head.className = 'flow-menu-group';
      head.textContent = group.label;
      list.appendChild(head);
      items.forEach(function (item) {
        var li = document.createElement('li');
        li.className =
          'flow-menu-item' + (item.id === state.componentId ? ' flow-menu-item-current' : '');
        var link = document.createElement(item.href ? 'a' : 'span');
        link.className = 'flow-menu-link';
        if (item.href) link.setAttribute('href', item.href);
        var name = document.createElement('span');
        name.className = 'flow-menu-name';
        name.textContent = item.title;
        var sub = document.createElement('span');
        sub.className = 'flow-menu-sub';
        sub.textContent = item.summary;
        var badge = document.createElement('span');
        badge.className = 'flow-menu-status flow-menu-status-' + item.status;
        badge.textContent = vt('front_desk:flow_status_' + item.status);
        link.appendChild(name);
        link.appendChild(sub);
        link.appendChild(badge);
        li.appendChild(link);
        list.appendChild(li);
      });
    });
  }

  // ------------------------------------------------------------------ stage
  function renderStageHeader() {
    var title = document.getElementById('flow-stage-title');
    var summary = document.getElementById('flow-stage-summary');
    var reset = document.getElementById('flow-new-session');
    if (title)
      title.textContent = state.component ? state.component.title : vt('front_desk:flow_title');
    if (summary) summary.textContent = state.component ? state.component.summary : '';
    if (reset) {
      reset.textContent = vt('front_desk:flow_new_session');
      reset.classList.toggle('hidden', !(state.component && state.component.kind === 'flow'));
    }
  }

  function renderProjection() {
    var surface = document.getElementById('flow-surface');
    if (!surface) return;
    var projection = state.projection;
    if (!projection) {
      while (surface.firstChild) surface.removeChild(surface.firstChild);
      var note = document.createElement('p');
      note.className = 'flow-empty';
      note.textContent =
        state.component && state.component.status !== 'a2ui'
          ? vt('front_desk:flow_status_' + (state.component ? state.component.status : 'planned'))
          : vt('front_desk:flow_loading');
      surface.appendChild(note);
      return;
    }
    window.A2UIHost.render(surface, projection.a2ui || [], {
      onAction: runAction,
      text: { unsupported: vt('front_desk:flow_unsupported') },
    });
    var form = document.getElementById('flow-input-form');
    var input = document.getElementById('flow-input');
    var send = document.getElementById('flow-send');
    if (form) form.classList.toggle('hidden', !projection.input);
    if (input && projection.input) {
      input.setAttribute(
        'placeholder',
        (state.component && state.component.input && state.component.input.placeholder) ||
          vt('front_desk:flow_input_placeholder')
      );
    }
    if (send) send.textContent = vt('front_desk:flow_send');
  }

  // ------------------------------------------------------------------ data
  function loadProjection() {
    if (!state.component || !state.component.a2ui_path) {
      state.projection = null;
      renderProjection();
      return Promise.resolve();
    }
    var url =
      state.component.a2ui_path +
      '?session=' +
      encodeURIComponent(state.sessionId) +
      '&locale=' +
      encodeURIComponent(state.locale);
    return fetchJson(url)
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.ok) throw new Error('projection failed');
        state.projection = result.body.data || null;
        setStatus('');
        renderProjection();
      })
      .catch(function () {
        setStatus(vt('front_desk:flow_action_failed'), true);
      });
  }

  function runAction(action, extraBody) {
    if (!action || typeof action !== 'object' || state.busy) return Promise.resolve();
    state.busy = true;
    setStatus(vt('front_desk:flow_loading'));
    var method = action.method === 'GET' ? 'GET' : 'POST';
    var body = Object.assign({}, action.body || {}, extraBody || {});
    var url = String(action.path || '');
    if (url.indexOf('locale=') === -1) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'locale=' + encodeURIComponent(state.locale);
    }
    var options = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (method === 'POST') options.body = JSON.stringify(body);
    return fetchJson(url, options)
      .then(function (result) {
        if (!result.ok || !result.body || result.body.ok === false)
          throw new Error('action failed');
        setStatus('');
        if (action.refresh !== false) return loadProjection();
        return undefined;
      })
      .catch(function () {
        setStatus(vt('front_desk:flow_action_failed'), true);
      })
      .finally(function () {
        state.busy = false;
      });
  }

  function wireInput() {
    var form = document.getElementById('flow-input-form');
    var input = document.getElementById('flow-input');
    if (!form || !input) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = String(input.value || '').trim();
      var op = state.projection && state.projection.input;
      if (!text || !op) return;
      input.value = '';
      var body = {};
      body[op.body_field || 'text'] = text;
      body.request_id = randomId();
      runAction(op, body);
    });
    var reset = document.getElementById('flow-new-session');
    if (reset) {
      reset.addEventListener('click', function () {
        resetSession(state.componentId);
        state.sessionId = sessionFor(state.componentId);
        loadProjection();
      });
    }
  }

  function mount() {
    state.locale = normalizeLocale();
    state.componentId = componentIdFromPath();
    if (window.FrontDeskRail && typeof window.FrontDeskRail.mount === 'function') {
      window.FrontDeskRail.mount(document.getElementById('front-desk-rail'), { current: 'ask' });
    }
    wireInput();
    Promise.all([
      fetchJson('/api/flow-vocabulary?locale=' + encodeURIComponent(state.locale)),
      fetchJson('/api/components?locale=' + encodeURIComponent(state.locale)),
    ])
      .then(function (results) {
        var vocab = results[0];
        var components = results[1];
        if (vocab.ok && vocab.body && vocab.body.ok) state.vocab = vocab.body.texts || {};
        if (components.ok && components.body && components.body.ok) {
          state.components = components.body.components || [];
          state.component =
            state.components.filter(function (item) {
              return item.id === state.componentId;
            })[0] || null;
          renderMenu(components.body);
        }
        state.sessionId = sessionFor(state.componentId || 'flow');
        renderStageHeader();
        return loadProjection();
      })
      .catch(function () {
        setStatus(vt('front_desk:flow_action_failed'), true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
