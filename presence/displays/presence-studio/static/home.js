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

  function fetchJson(url) {
    return fetch(url).then(function (response) {
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
    window.location.href = query ? '/ask?' + query : '/ask';
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

  function navItem(nav, id) {
    var items = (nav && nav.items) || [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  function decideHref(nav) {
    var item = navItem(nav, 'decide');
    return item ? item.href : '/';
  }

  var DECIDE_TAG_KEY = {
    approval: 'tag_approval',
    exception: 'tag_exception',
    stalled: 'tag_stalled',
    memory: 'tag_memory',
  };

  // Tenant names only make sense when the viewer can look at more than one
  // tenant, and they show the tenant's display name, never its slug.
  function tenantNameFor(me, slug) {
    if (!me || !me.ok || !me.can_switch || !slug) return '';
    var name = slug;
    (me.tenants || []).forEach(function (tenant) {
      if (tenant.tenant_slug === slug && tenant.display_name) name = tenant.display_name;
    });
    return name;
  }

  function mutedText(id, text) {
    return { id: id, type: 'ui:text', props: { text: text, variant: 'muted' } };
  }

  // The briefing as the page's single "next action": the day's summary, the
  // recommended first item, and one button to where that work happens.
  function renderNextAction(nav, vocab, home, locale) {
    var counts = home.counts || {};
    var decide = counts.decide || 0;
    var progress = counts.progress || 0;
    var delivered = counts.delivered || 0;
    var clear = decide === 0 && progress === 0 && delivered === 0;
    var top = (home.decide || [])[0];
    var primary = null;
    if (decide > 0) {
      primary = { label: fd(vocab, 'home_decide_more'), href: decideHref(nav) };
    } else if (progress > 0 || delivered > 0) {
      primary = { label: fd(vocab, 'home_progress_more'), href: '/progress' };
    } else {
      var ask = navItem(nav, 'ask');
      if (ask && ask.allowed !== false) {
        primary = { label: vt(vocab, 'presence_studio:home_next_ask'), href: ask.href };
      }
    }
    var props = {
      eyebrow: formatHomeDate(home.date, locale),
      title: clear
        ? fd(vocab, 'home_briefing_clear')
        : renderTemplate(fd(vocab, 'home_briefing'), counts),
      state: clear ? 'empty' : 'ready',
    };
    if (top) props.reason = renderTemplate(fd(vocab, 'home_recommend'), { title: top.title });
    if (primary && primary.label) props.primary = primary;
    draw(document.getElementById('home-next'), [
      { id: 'home-next-action', type: 'ui:next-action', props: props },
    ]);
  }

  function renderMetrics(vocab, home) {
    var counts = home.counts || {};
    draw(document.getElementById('home-metrics'), [
      {
        id: 'home-metrics-grid',
        type: 'ui:grid',
        props: { columns: 3, gap: 'md' },
        children: ['home-metric-decide', 'home-metric-active', 'home-metric-delivered'],
      },
      {
        id: 'home-metric-decide',
        type: 'ui:metric',
        props: {
          label: vt(vocab, 'presence_studio:home_metric_decide'),
          value: String(counts.decide || 0),
          tone: counts.decide ? 'warning' : undefined,
        },
      },
      {
        id: 'home-metric-active',
        type: 'ui:metric',
        props: { label: fd(vocab, 'tag_in_progress'), value: String(counts.progress || 0) },
      },
      {
        id: 'home-metric-delivered',
        type: 'ui:metric',
        props: {
          label: fd(vocab, 'progress_delivered_title'),
          value: String(counts.delivered || 0),
        },
      },
    ]);
  }

  function renderDecideCard(nav, vocab, home, me) {
    var href = decideHref(nav);
    var moreLink = document.getElementById('decide-more');
    if (moreLink) {
      moreLink.textContent = fd(vocab, 'home_decide_more');
      moreLink.setAttribute('href', href);
    }
    var countEl = document.getElementById('decide-count');
    if (countEl) {
      countEl.textContent = renderTemplate(fd(vocab, 'count_items') || '{count}', {
        count: (home.counts && home.counts.decide) || 0,
      });
      countEl.hidden = false;
    }
    var items = (home.decide || []).slice(0, 3);
    var body = document.getElementById('decide-body');
    if (!items.length) {
      draw(body, [mutedText('decide-empty', fd(vocab, 'home_decide_empty'))]);
      return;
    }
    draw(body, [
      {
        id: 'decide-list',
        type: 'ui:list',
        props: {
          items: items.map(function (item) {
            var tag = fd(vocab, DECIDE_TAG_KEY[item.kind] || 'tag_approval') || item.kind;
            var tenant = tenantNameFor(me, item.tenant_slug);
            return {
              title: item.title,
              meta: tenant ? tag + ' · ' + tenant : tag,
              href: href,
              status: 'pending',
            };
          }),
        },
      },
    ]);
  }

  var PROGRESS_TAG_KEY = { in_progress: 'tag_in_progress', delivered: 'tag_delivered' };

  // FD-05: each row deep-links to its own item on the "進み具合" page (kept in
  // the URL hash there so a reload restores the selection).
  function progressHref(item) {
    return '/progress#' + encodeURIComponent(item.id);
  }

  function renderProgressCard(vocab, home) {
    var counts = home.counts || {};
    var summaryEl = document.getElementById('progress-summary');
    if (summaryEl) {
      summaryEl.textContent = renderTemplate(fd(vocab, 'home_progress_summary'), {
        active: counts.progress || 0,
        delivered: counts.delivered || 0,
      });
    }
    var moreLink = document.getElementById('progress-more');
    if (moreLink) moreLink.textContent = fd(vocab, 'home_progress_more');

    var items = (home.progress || []).slice(0, 4);
    var body = document.getElementById('progress-body');
    if (!items.length) {
      draw(body, [mutedText('progress-empty', fd(vocab, 'home_progress_empty'))]);
      return;
    }
    draw(body, [
      {
        id: 'progress-list',
        type: 'ui:list',
        props: {
          items: items.map(function (item) {
            var delivered = item.kind === 'delivered';
            var tag = fd(vocab, PROGRESS_TAG_KEY[item.kind] || 'tag_in_progress') || item.kind;
            var meta = delivered ? fd(vocab, 'action_receive') : tag;
            if (!delivered && typeof item.percent === 'number') {
              meta += ' · ' + Math.max(0, Math.min(100, Math.round(item.percent))) + '%';
            }
            return {
              title: item.title,
              meta: meta,
              href: progressHref(item),
              status: delivered ? 'completed' : 'active',
            };
          }),
        },
      },
    ]);
  }

  function storedTenantQuery() {
    try {
      var slug = window.localStorage.getItem('front-desk.tenant');
      return slug ? '?tenant=' + encodeURIComponent(slug) : '';
    } catch (err) {
      return '';
    }
  }

  function mount() {
    var locale = currentLocale();
    var navPromise =
      window.FrontDeskRail && window.FrontDeskRail.nav
        ? window.FrontDeskRail.nav()
        : fetchJson('/api/front-desk/nav?locale=' + encodeURIComponent(locale));
    Promise.all([
      navPromise,
      fetchJson('/api/home-vocabulary?locale=' + encodeURIComponent(locale)),
    ])
      .then(function (pair) {
        var nav = pair[0];
        var vocabResponse = pair[1];
        if (!vocabResponse || !vocabResponse.ok) return undefined;
        var vocab = vocabResponse.texts || {};
        renderAskShell(vocab);
        wireAskBox(vocab);
        var tenantQuery = storedTenantQuery();
        return Promise.all([
          fetchJson('/api/home' + tenantQuery),
          fetchJson('/api/me' + tenantQuery),
        ]).then(function (pair2) {
          var home = pair2[0];
          var me = pair2[1];
          if (home && home.ok && nav && nav.ok) {
            renderNextAction(nav, vocab, home, locale);
            renderMetrics(vocab, home);
            renderDecideCard(nav, vocab, home, me);
            renderProgressCard(vocab, home);
          }
        });
      })
      .catch(function () {
        // The home page is additive chrome around the rail — a fetch
        // failure must never throw and break the rest of the page.
      });
  }

  window.KyberionHome = { mount: mount };
})();
