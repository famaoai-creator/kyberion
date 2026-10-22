/*
 * a2ui-host.js — the front-desk host's A2UI renderer (A2UI COMPONENT HOST PLAN §2.3).
 *
 * Renders `A2UIMessage`s into a container with a FIXED component library.
 * Robustness rules:
 *   - DOM API only (`textContent`, `createElement`); HTML strings from the
 *     wire are never parsed into the document.
 *   - Unknown component types render a neutral "cannot be shown yet" note and
 *     never throw; a malformed component is skipped the same way.
 *   - `button` components carry an `action` descriptor (a headless operation:
 *     method + path + body); the host owns execution through `onAction`.
 *   - All chrome text comes from the vocabulary the host passes in.
 *
 * Plain browser script, no external resources — same contract as the other
 * front-desk pages (ask.js, home.js).
 */
/* global window, document */
(function () {
  'use strict';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asText(value, fallback) {
    if (value === undefined || value === null) return fallback || '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  // ------------------------------------------------------------------ library
  var library = {
    text: function (props) {
      return el('p', 'a2ui-text', asText(props.text || props.content));
    },
    button: function (props, ctx) {
      var button = el(
        'button',
        'a2ui-button' + (props.variant === 'primary' ? ' a2ui-button-primary' : ''),
        asText(props.label)
      );
      button.type = 'button';
      if (props.action && typeof props.action === 'object' && ctx.onAction) {
        button.addEventListener('click', function () {
          button.disabled = true;
          Promise.resolve(ctx.onAction(props.action)).finally(function () {
            button.disabled = false;
          });
        });
      } else {
        button.disabled = true;
      }
      return button;
    },
    card: function (props) {
      var card = el('article', 'a2ui-card');
      if (props.title) card.appendChild(el('h3', 'a2ui-card-title', asText(props.title)));
      if (props.description) card.appendChild(el('p', 'a2ui-card-body', asText(props.description)));
      return card;
    },
    container: function (props, ctx) {
      var box = el('div', 'a2ui-container');
      asArray(props.items).forEach(function (child) {
        box.appendChild(renderComponent(child, ctx));
      });
      return box;
    },
    'display:hero': function (props) {
      var hero = el('header', 'a2ui-hero');
      hero.appendChild(el('h2', 'a2ui-hero-title', asText(props.title)));
      if (props.subtitle) hero.appendChild(el('p', 'a2ui-hero-subtitle', asText(props.subtitle)));
      return hero;
    },
    'display:section': function (props, ctx) {
      var section = el('section', 'a2ui-section');
      if (props.title) section.appendChild(el('h3', 'a2ui-section-title', asText(props.title)));
      if (props.description)
        section.appendChild(el('p', 'a2ui-section-desc', asText(props.description)));
      asArray(props.items).forEach(function (child) {
        section.appendChild(renderComponent(child, ctx));
      });
      return section;
    },
    'display:card': function (props) {
      return library.card(props);
    },
    'display:list': function (props) {
      var wrap = el('div', 'a2ui-list');
      if (props.title) wrap.appendChild(el('h4', 'a2ui-minor-title', asText(props.title)));
      var list = el('ul', 'a2ui-list-items');
      asArray(props.items).forEach(function (item) {
        var li = el('li', 'a2ui-list-item');
        li.appendChild(el('span', 'a2ui-list-label', asText(item && item.label)));
        if (item && item.detail)
          li.appendChild(el('span', 'a2ui-list-detail', asText(item.detail)));
        list.appendChild(li);
      });
      wrap.appendChild(list);
      return wrap;
    },
    'display:kv': function (props) {
      var wrap = el('div', 'a2ui-kv');
      if (props.title) wrap.appendChild(el('h4', 'a2ui-minor-title', asText(props.title)));
      var dl = el('dl', 'a2ui-kv-entries');
      asArray(props.entries).forEach(function (entry) {
        var row = el(
          'div',
          'a2ui-kv-row' + (entry && entry.highlight ? ' a2ui-kv-row-highlight' : '')
        );
        row.appendChild(el('dt', 'a2ui-kv-key', asText(entry && entry.key)));
        row.appendChild(el('dd', 'a2ui-kv-value', asText(entry && entry.value)));
        dl.appendChild(row);
      });
      wrap.appendChild(dl);
      return wrap;
    },
    'display:progress': function (props) {
      var wrap = el('div', 'a2ui-progress');
      if (props.title) wrap.appendChild(el('h4', 'a2ui-minor-title', asText(props.title)));
      var steps = el('ol', 'a2ui-progress-steps');
      asArray(props.steps).forEach(function (step) {
        var status =
          step && ['done', 'active', 'pending'].indexOf(step.status) !== -1
            ? step.status
            : 'pending';
        steps.appendChild(
          el('li', 'a2ui-progress-step a2ui-progress-' + status, asText(step && step.label))
        );
      });
      wrap.appendChild(steps);
      return wrap;
    },
    'display:alert': function (props) {
      var severity =
        ['info', 'warning', 'error', 'success'].indexOf(props.severity) !== -1
          ? props.severity
          : 'info';
      var box = el('div', 'a2ui-alert a2ui-alert-' + severity);
      box.setAttribute('role', severity === 'error' ? 'alert' : 'status');
      if (props.title) box.appendChild(el('strong', 'a2ui-alert-title', asText(props.title)));
      if (props.message) box.appendChild(el('p', 'a2ui-alert-message', asText(props.message)));
      return box;
    },
    'display:badges': function (props) {
      var wrap = el('div', 'a2ui-badges');
      asArray(props.items || props.badges).forEach(function (badge) {
        wrap.appendChild(
          el('span', 'a2ui-badge', asText(typeof badge === 'string' ? badge : badge && badge.label))
        );
      });
      return wrap;
    },
    'display:status': function (props) {
      var wrap = el('div', 'a2ui-status');
      wrap.appendChild(
        el('span', 'a2ui-status-dot a2ui-status-' + asText(props.tone || props.status || 'neutral'))
      );
      wrap.appendChild(el('span', 'a2ui-status-label', asText(props.label || props.title)));
      return wrap;
    },
  };

  function renderComponent(component, ctx) {
    if (!component || typeof component !== 'object' || typeof component.type !== 'string') {
      return el('div', 'a2ui-unsupported', ctx.text.unsupported);
    }
    var renderer = library[component.type];
    var props = component.props && typeof component.props === 'object' ? component.props : {};
    if (!renderer) {
      var note = el('div', 'a2ui-unsupported', ctx.text.unsupported);
      note.setAttribute('data-a2ui-type', component.type);
      return note;
    }
    try {
      var node = renderer(props, ctx);
      if (component.id) node.setAttribute('data-a2ui-id', String(component.id));
      return node;
    } catch (err) {
      return el('div', 'a2ui-unsupported', ctx.text.unsupported);
    }
  }

  /**
   * Apply a message list to `container`. `createSurface` resets the surface,
   * `updateComponents` replaces its components, `updateDataModel` is exposed
   * through the returned state, `deleteSurface` clears it.
   */
  function render(container, messages, options) {
    var ctx = {
      onAction: options && options.onAction,
      text: { unsupported: (options && options.text && options.text.unsupported) || '' },
    };
    var state = { surfaceId: null, title: null, data: {} };
    var components = null;
    (Array.isArray(messages) ? messages : []).forEach(function (message) {
      if (!message || typeof message !== 'object') return;
      if (message.createSurface) {
        state.surfaceId = message.createSurface.surfaceId || null;
        state.title = message.createSurface.title || null;
        components = [];
      }
      if (message.updateComponents) {
        components = asArray(message.updateComponents.components);
      }
      if (message.updateDataModel && message.updateDataModel.data) {
        Object.keys(message.updateDataModel.data).forEach(function (key) {
          state.data[key] = message.updateDataModel.data[key];
        });
      }
      if (message.deleteSurface) {
        components = [];
      }
    });
    while (container.firstChild) container.removeChild(container.firstChild);
    (components || []).forEach(function (component) {
      container.appendChild(renderComponent(component, ctx));
    });
    return state;
  }

  // ------------------------------------------------------------- surface store
  // A small store that applies A2UI messages incrementally, per surfaceId, and
  // keeps a bounded history — what a generic A2UI viewer needs beyond the
  // one-shot `render` above. `apply` never throws on a malformed message; it
  // records it in the history as `invalid` and moves on.
  var MAX_HISTORY = 200;

  function createStore() {
    return { surfaces: {}, order: [], history: [] };
  }

  function ensureSurface(store, surfaceId) {
    if (!store.surfaces[surfaceId]) {
      store.surfaces[surfaceId] = {
        id: surfaceId,
        title: null,
        components: [],
        data: {},
        updatedAt: null,
      };
      store.order.push(surfaceId);
    }
    return store.surfaces[surfaceId];
  }

  function describeMessage(message) {
    if (!message || typeof message !== 'object')
      return { kind: 'invalid', surfaceId: null, detail: '' };
    if (message.createSurface) {
      return {
        kind: 'createSurface',
        surfaceId: message.createSurface.surfaceId || null,
        detail: message.createSurface.title || message.createSurface.catalogId || '',
      };
    }
    if (message.updateComponents) {
      return {
        kind: 'updateComponents',
        surfaceId: message.updateComponents.surfaceId || null,
        detail: String(asArray(message.updateComponents.components).length),
      };
    }
    if (message.updateDataModel) {
      return {
        kind: 'updateDataModel',
        surfaceId: message.updateDataModel.surfaceId || null,
        detail: Object.keys(message.updateDataModel.data || {}).join(', '),
      };
    }
    if (message.deleteSurface) {
      return {
        kind: 'deleteSurface',
        surfaceId: message.deleteSurface.surfaceId || null,
        detail: '',
      };
    }
    return { kind: 'invalid', surfaceId: null, detail: '' };
  }

  function apply(store, message, source) {
    var info = describeMessage(message);
    var entry = {
      at: new Date().toISOString(),
      kind: info.kind,
      surfaceId: info.surfaceId,
      detail: info.detail,
      source: source || '',
    };
    store.history.push(entry);
    if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
    if (info.kind === 'invalid' || !info.surfaceId) return entry;
    if (info.kind === 'deleteSurface') {
      delete store.surfaces[info.surfaceId];
      store.order = store.order.filter(function (id) {
        return id !== info.surfaceId;
      });
      return entry;
    }
    var surface = ensureSurface(store, info.surfaceId);
    surface.updatedAt = entry.at;
    if (info.kind === 'createSurface') {
      surface.title = message.createSurface.title || surface.title;
      surface.components = [];
    } else if (info.kind === 'updateComponents') {
      surface.components = asArray(message.updateComponents.components);
    } else if (info.kind === 'updateDataModel') {
      var data = message.updateDataModel.data || {};
      Object.keys(data).forEach(function (key) {
        surface.data[key] = data[key];
      });
    }
    return entry;
  }

  function applyAll(store, messages, source) {
    return (Array.isArray(messages) ? messages : []).map(function (message) {
      return apply(store, message, source);
    });
  }

  function renderSurface(container, store, surfaceId, options) {
    var ctx = {
      onAction: options && options.onAction,
      text: { unsupported: (options && options.text && options.text.unsupported) || '' },
    };
    while (container.firstChild) container.removeChild(container.firstChild);
    var surface = store.surfaces[surfaceId];
    if (!surface) return null;
    surface.components.forEach(function (component) {
      container.appendChild(renderComponent(component, ctx));
    });
    return surface;
  }

  /** Buttons with an action descriptor, flattened from a surface's component tree. */
  function collectActions(components) {
    var out = [];
    (function walk(list) {
      asArray(list).forEach(function (component) {
        if (!component || typeof component !== 'object') return;
        var props = component.props || {};
        if (component.type === 'button' && props.action && typeof props.action === 'object') {
          out.push({ id: component.id, label: asText(props.label), action: props.action });
        }
        walk(props.items);
      });
    })(components);
    return out;
  }

  window.A2UIHost = {
    render: render,
    supportedTypes: Object.keys(library),
    createStore: createStore,
    apply: apply,
    applyAll: applyAll,
    renderSurface: renderSurface,
    collectActions: collectActions,
  };
})();
