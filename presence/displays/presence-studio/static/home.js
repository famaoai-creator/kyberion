/*
 * home.js — FD-02: the presence-studio home page ("ホーム"), rebuilt on the
 * kyberion-base components for UI-06 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23).
 *
 * Plain browser script loaded by `home.html`; `KyberionHome.mount()` runs
 * after the shared shell module (`front-desk-rail.js`), whose
 * `FrontDeskRail.render(container, components)` draws the components with the
 * viewer's locale. All copy comes from the server (`/api/home-vocabulary`,
 * `/api/front-desk/nav`) and the home read model (`/api/home`) — this file
 * never hardcodes a surface port or host, and never invents data the server
 * did not send. The page's fixed chrome (headings, placeholders, chip labels)
 * is already server-rendered in the viewer's language; this script fills in
 * the data parts, which show a labelled skeleton until then.
 *
 * Order on the page: the briefing as the "next action" (top), the ask box,
 * three counts, then the decide list and the progress list.
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-02.
 */
/* global window, document, fetch */
(function () {
  'use strict';

  // `/api/home-vocabulary`'s `texts` object is keyed by the fully-qualified
  // `namespace:key` form (same as `/api/ui-vocabulary` in index.html).
  function vt(vocab, key) {
    return (vocab && vocab[key]) || '';
  }

  function fd(vocab, key) {
    return vt(vocab, 'front_desk:' + key);
  }

  function currentLocale() {
    if (window.KyberionPrefs) return window.KyberionPrefs.locale();
    return document.documentElement.getAttribute('lang') === 'ja' ? 'ja' : 'en';
  }

  function renderTemplate(template, params) {
    return String(template || '').replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(params || {}, key) ? String(params[key]) : match;
    });
  }

  function scopedUrl(path) {
    return window.KyberionPrefs && window.KyberionPrefs.scopedUrl
      ? window.KyberionPrefs.scopedUrl(path)
      : path;
  }

  function fetchJson(url) {
    return fetch(scopedUrl(url)).then(function (response) {
      return response.json();
    });
  }

  function draw(container, components) {
    if (!container || !window.FrontDeskRail) return;
    window.FrontDeskRail.render(container, components);
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_PATHS = {
    mic: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M5 11a7 7 0 0 0 14 0M12 18v3'],
    send: ['M4 12l16-8-6 16-2-6z'],
    mail: ['M3 5h18v14H3z', 'M3 7l9 6 9-6'],
    notes: ['M6 3h9l4 4v14H6z', 'M9 12h7M9 16h7'],
    globe: [
      'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z',
      'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    ],
    list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  };

  function svgIcon(id) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ps-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICON_PATHS[id] || []).forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function setIconOnly(button, iconId, label) {
    if (!button) return;
    if (label) button.setAttribute('aria-label', label);
    button.textContent = '';
    button.appendChild(svgIcon(iconId));
  }

  function setIconAndText(button, iconId, text) {
    if (!button) return;
    var label = document.createElement('span');
    label.textContent = text || button.textContent.trim();
    button.textContent = '';
    button.appendChild(svgIcon(iconId));
    button.appendChild(label);
  }

  function formatHomeDate(dateText, locale) {
    var parsed = new Date(String(dateText || '') + 'T00:00:00');
    if (isNaN(parsed.getTime())) return String(dateText || '');
    try {
      return parsed.toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
      });
    } catch (err) {
      return String(dateText || '');
    }
  }

  var CHIPS = [
    { key: 'email', textKey: 'chip_email', icon: 'mail' },
    { key: 'minutes', textKey: 'chip_minutes', icon: 'notes' },
    { key: 'browser', textKey: 'chip_browser', icon: 'globe' },
    { key: 'webapp', textKey: 'chip_webapp', icon: 'list' },
  ];

  function renderAskShell(vocab) {
    var input = document.getElementById('ask-input');
    if (input) input.setAttribute('placeholder', fd(vocab, 'home_ask_placeholder'));
    setIconOnly(document.getElementById('ask-mic'), 'mic', fd(vocab, 'home_ask_voice'));
    setIconOnly(document.getElementById('ask-send'), 'send', fd(vocab, 'home_ask_send'));
    CHIPS.forEach(function (def) {
      var button = document.querySelector('.home-chip[data-chip="' + def.key + '"]');
      setIconAndText(button, def.icon, fd(vocab, def.textKey));
    });
  }

  // FD-03: the ask box hands off to the dedicated "頼む" page — `send` submits
  // and sends immediately (`&send=1`), `mic` opens the page with the mic
  // focused (`&mic=1`, picked up by `static/ask.js`), and chips only prefill
  // the input there (no auto-send).
  function goToAsk(params) {
    var query = Object.keys(params || {})
      .filter(function (key) {
        return params[key];
      })
      .map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      })
      .join('&');
    window.location.href = scopedUrl(query ? '/ask?' + query : '/ask');
  }

  function wireAskBox(vocab) {
    var form = document.getElementById('ask-form');
    var input = document.getElementById('ask-input');
    var micButton = document.getElementById('ask-mic');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = ((input && input.value) || '').trim();
        goToAsk(text ? { ask: text, send: '1' } : {});
      });
    }
    if (micButton) {
      micButton.addEventListener('click', function () {
        goToAsk({ mic: '1' });
      });
    }
    CHIPS.forEach(function (def) {
      var button = document.querySelector('.home-chip[data-chip="' + def.key + '"]');
      if (!button) return;
      button.addEventListener('click', function () {
        var template = fd(vocab, def.textKey);
        goToAsk(template ? { ask: template } : {});
      });
    });
  }

  var view = { vocab: {}, home: null, mode: 'quiet', generation: 0, scope: '', wired: false };

  function text(key) {
    return fd(view.vocab, 'work_home_' + key);
  }
  function element(tag, value, className) {
    var node = document.createElement(tag);
    if (value) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function safeHref(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/' || value.slice(0, 2) === '//')
      return null;
    try {
      var url = new URL(value, window.location.href);
      if (
        url.origin !== window.location.origin ||
        !/^\/(ask|progress|work|api\/artifacts|api\/conversation\/artifacts)(\/|$)/.test(
          url.pathname
        )
      )
        return null;
      if (
        url.searchParams.has('send') ||
        url.searchParams.has('mic') ||
        url.searchParams.has('ask')
      )
        return null;
      return url.pathname + url.search + url.hash;
    } catch (err) {
      return null;
    }
  }
  function linkFor(link) {
    var href = safeHref(link.href);
    if (!href) return null;
    var node = element('a', text('link_' + link.kind), 'kb-btn kb-btn--secondary');
    node.setAttribute('href', href);
    return node;
  }
  function field(host, label, value) {
    if (!value) return;
    host.appendChild(element('dt', label));
    host.appendChild(element('dd', value));
  }
  function date(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return text('time_unknown');
    return new Date(value).toLocaleString(currentLocale() === 'ja' ? 'ja-JP' : 'en-US');
  }
  function row(item, compact) {
    var card = element('article', '', 'kb-section home-work-item');
    card.setAttribute('data-work-id', item.id);
    card.appendChild(element('h3', item.title, 'kb-section__title'));
    var label = item.status_key || item.status;
    card.appendChild(element('span', vt(view.vocab, label), 'kb-badge'));
    card.appendChild(element('p', vt(view.vocab, item.next_step_key)));
    (item.unknowns || []).forEach(function (unknown) {
      card.appendChild(element('p', text('unknown_' + unknown)));
    });
    if (item.artifact)
      card.appendChild(element('p', text('version_' + item.artifact.currentness), 'kb-badge'));
    if (!compact) {
      var details = element('details', '', 'home-work-details');
      details.open = view.mode === 'detailed';
      details.appendChild(element('summary', text('resume_context')));
      var facts = element('dl');
      field(facts, text('source'), text('source_' + item.source));
      field(facts, text('last_recorded'), date(item.last_recorded_at));
      field(
        facts,
        text('last_verified'),
        item.last_verified_at ? date(item.last_verified_at) : text('not_verified')
      );
      (item.unknowns || []).forEach(function (unknown) {
        field(facts, text('unknown'), text('unknown_' + unknown));
      });
      if (item.artifact) {
        if (item.artifact.revision !== undefined)
          field(facts, text('revision'), String(item.artifact.revision));
        field(facts, text('version_state'), text('version_' + item.artifact.currentness));
        if (item.artifact.change_reason === 'format_change')
          field(facts, text('change_reason'), text('format_change') + ' ' + item.artifact.format);
      }
      details.appendChild(facts);
      var group = (view.home.updates || []).find(function (entry) {
        return entry.item_id === item.id;
      });
      if (group) {
        var updates = element('ol');
        group.entries.forEach(function (entry) {
          if (entry.text) updates.appendChild(element('li', entry.text));
        });
        if (updates.children.length) details.appendChild(updates);
      }
      card.appendChild(details);
    }
    var links = element('div', '', 'home-work-links');
    var seenLinks = new Set();
    (item.links || []).forEach(function (link) {
      if (seenLinks.has(link.href)) return;
      seenLinks.add(link.href);
      var node = linkFor(link);
      if (node) links.appendChild(node);
    });
    card.appendChild(links);
    return card;
  }
  function fill(id, items, compact, emptyKey) {
    var host = document.getElementById(id);
    if (!host) return;
    host.textContent = '';
    if (!items.length) host.appendChild(element('p', text(emptyKey)));
    items.forEach(function (item) {
      host.appendChild(row(item, compact));
    });
  }
  function preferenceKey() {
    return view.home && view.home.scope_id
      ? 'kyberion.work-home.detail.' + view.home.scope_id
      : null;
  }
  function renderWork() {
    var home = view.home;
    if (!home) return;
    var error = document.getElementById('home-error');
    if (error) error.hidden = true;
    var partial = home.coverage !== 'supported_sources_ready';
    var counts = home.counts;
    var sources = document.getElementById('home-sources');
    if (sources) {
      sources.textContent = '';
      sources.appendChild(element('p', text('coverage_note')));
      home.sources.forEach(function (source) {
        if (source.state !== 'available')
          sources.appendChild(
            element('p', text('source_' + source.id) + ': ' + text('source_state_' + source.state))
          );
      });
    }
    draw(document.getElementById('home-next'), [
      {
        id: 'work-home-next',
        type: 'ui:next-action',
        props: {
          eyebrow: date(home.observed_at),
          title: text(partial ? 'partial' : counts.attention ? 'attention_title' : 'overview'),
          reason: text('resume_readonly'),
          state: partial ? 'blocked' : 'ready',
        },
      },
    ]);
    draw(document.getElementById('home-metrics'), [
      {
        id: 'work-counts',
        type: 'ui:grid',
        props: { columns: 3, gap: 'md' },
        children: ['work-all', 'work-attention', 'work-verified'],
      },
      {
        id: 'work-all',
        type: 'ui:metric',
        props: { label: text('all_title'), value: String(counts.all) },
      },
      {
        id: 'work-attention',
        type: 'ui:metric',
        props: { label: text('attention_title'), value: String(counts.attention) },
      },
      {
        id: 'work-verified',
        type: 'ui:metric',
        props: { label: text('verified_title'), value: String(counts.verified) },
      },
    ]);
    fill('decide-body', home.attention, true, partial ? 'attention_unknown' : 'attention_empty');
    fill('progress-body', home.items, false, partial ? 'work_unknown' : 'work_empty');
    var count = document.getElementById('decide-count');
    if (count) {
      count.textContent = String(counts.attention);
      count.hidden = false;
    }
    var mode = document.getElementById('home-detail-mode');
    if (mode) mode.value = view.mode;
    var summary = document.getElementById('progress-summary');
    if (summary) summary.textContent = text('grouped_updates');
  }
  function showFailure() {
    view.home = null;
    var error = document.getElementById('home-error');
    if (error) error.hidden = false;
    var count = document.getElementById('decide-count');
    if (count) {
      count.hidden = true;
      count.textContent = '';
    }
    var summary = document.getElementById('progress-summary');
    if (summary) summary.textContent = '';
    ['home-next', 'home-metrics', 'home-sources', 'decide-body', 'progress-body'].forEach(
      function (id) {
        var host = document.getElementById(id);
        if (host) host.textContent = '';
      }
    );
    var host = document.getElementById('home-next');
    if (host && !error) host.appendChild(element('p', text('load_failed'), 'kb-callout'));
  }
  function refresh() {
    var generation = ++view.generation;
    var scope = scopedUrl('/api/home');
    if (view.scope && view.scope !== scope) showFailure();
    view.scope = scope;
    var button = document.getElementById('home-refresh');
    if (button) button.disabled = true;
    return fetch(scope, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('read unavailable');
        return response.json();
      })
      .then(function (body) {
        if (generation !== view.generation) return;
        if (scope !== scopedUrl('/api/home')) {
          showFailure();
          return refresh();
        }
        var home = body && body.work_home;
        if (
          !body.ok ||
          !home ||
          home.version !== 1 ||
          !Array.isArray(home.items) ||
          !Array.isArray(home.attention) ||
          !Array.isArray(home.sources) ||
          !home.counts
        )
          throw new Error('read unavailable');
        var previousScope = view.home && view.home.scope_id;
        view.home = home;
        if (previousScope !== home.scope_id) view.mode = 'quiet';
        try {
          if (preferenceKey() && window.localStorage.getItem(preferenceKey()) === 'detailed')
            view.mode = 'detailed';
        } catch (err) {
          /* Display preference is optional. */
        }
        renderWork();
      })
      .catch(function () {
        if (generation === view.generation) showFailure();
      })
      .finally(function () {
        if (generation === view.generation && button) button.disabled = false;
      });
  }
  function mount() {
    if (!view.retryWired) {
      view.retryWired = true;
      var retry = document.getElementById('home-refresh');
      if (retry)
        retry.addEventListener('click', function () {
          return Object.keys(view.vocab).length ? refresh() : mount();
        });
    }
    return Promise.resolve(window.FrontDeskRail && window.FrontDeskRail.ready)
      .then(function () {
        return fetchJson('/api/home-vocabulary?locale=' + encodeURIComponent(currentLocale()));
      })
      .then(function (response) {
        if (!response || !response.ok) throw new Error('copy unavailable');
        view.vocab = response.texts || {};
        renderAskShell(view.vocab);
        if (!view.wired) {
          view.wired = true;
          wireAskBox(view.vocab);
          var mode = document.getElementById('home-detail-mode');
          if (mode)
            mode.addEventListener('change', function () {
              view.mode = mode.value === 'detailed' ? 'detailed' : 'quiet';
              try {
                if (preferenceKey()) window.localStorage.setItem(preferenceKey(), view.mode);
              } catch (err) {
                /* Keep this tab usable. */
              }
              renderWork();
            });
          if (window.addEventListener) {
            window.addEventListener('popstate', refresh);
            window.addEventListener('pageshow', function () {
              if (view.home) refresh();
            });
          }
        }
        return refresh();
      })
      .catch(showFailure);
  }
  window.KyberionHome = { mount: mount, refresh: refresh };
})();
