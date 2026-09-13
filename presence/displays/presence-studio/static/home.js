/*
 * home.js — FD-02: the presence-studio home page ("ホーム").
 *
 * Plain browser script (no modules, no external resources) loaded by
 * `home.html` with a plain <script> tag, mirroring `front-desk-rail.js`.
 * All copy comes from the server (`/api/home-vocabulary`, `/api/front-desk/nav`)
 * and the home read model (`/api/home`) — this file never hardcodes a
 * surface port or host, and never invents data the server did not send.
 *
 * INTERIM (FD-03): the dedicated "頼む" page does not exist yet, so the ask
 * box's send/mic/chip actions hand off to `/work` (the pre-FD-02 workbench)
 * with a `?ask=` query and a `#panel` hash the future page can pick up.
 * Replace `goToWork()` and its call sites once FD-03 ships.
 *
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
 * §2.1 / FD-02.
 */
/* global window, document, navigator, fetch */
(function () {
  'use strict';

  // `/api/home-vocabulary`'s `texts` object is keyed by the fully-qualified
  // `namespace:key` form (same as `/api/ui-vocabulary` in index.html) — this
  // helper is the one place that knows the `front_desk:` prefix.
  function vt(vocab, key) {
    return (vocab && vocab['front_desk:' + key]) || '';
  }

  // Every injected string goes through this before it reaches innerHTML —
  // including attribute values, so quotes and ampersands are escaped too.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeLocale() {
    var raw = String((navigator && navigator.language) || 'en').toLowerCase();
    return raw.indexOf('ja') === 0 ? 'ja' : 'en';
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

  var ICON_PATHS = {
    chevron: '<path d="M9 6l6 6-6 6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    send: '<path d="M4 12l16-8-6 16-2-6z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  };

  function svgIcon(id, extraClass) {
    var body = ICON_PATHS[id] || '';
    var cls = 'home-icon' + (extraClass ? ' ' + extraClass : '');
    return (
      '<svg class="' +
      cls +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  function formatHomeDate(dateText, locale) {
    var parsed = new Date(String(dateText || '') + 'T00:00:00');
    if (isNaN(parsed.getTime())) return String(dateText || '');
    var localeTag = locale === 'ja' ? 'ja-JP' : 'en-US';
    try {
      return parsed.toLocaleDateString(localeTag, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
      });
    } catch (err) {
      return String(dateText || '');
    }
  }

  function renderAskShell(vocab) {
    var input = document.getElementById('ask-input');
    if (input) input.setAttribute('placeholder', vt(vocab, 'home_ask_placeholder'));

    var micButton = document.getElementById('ask-mic');
    if (micButton) {
      micButton.setAttribute('aria-label', vt(vocab, 'home_ask_voice'));
      micButton.innerHTML = svgIcon('mic');
    }

    var sendButton = document.getElementById('ask-send');
    if (sendButton) {
      sendButton.setAttribute('aria-label', vt(vocab, 'home_ask_send'));
      sendButton.innerHTML = svgIcon('send');
    }

    var chipDefs = [
      { key: 'email', textKey: 'chip_email', icon: 'mail' },
      { key: 'minutes', textKey: 'chip_minutes', icon: 'notes' },
      { key: 'browser', textKey: 'chip_browser', icon: 'globe' },
      { key: 'webapp', textKey: 'chip_webapp', icon: 'list' },
    ];
    chipDefs.forEach(function (def) {
      var button = document.querySelector('.home-chip[data-chip="' + def.key + '"]');
      if (!button) return;
      button.innerHTML =
        svgIcon(def.icon) + '<span>' + escapeHtml(vt(vocab, def.textKey)) + '</span>';
    });
  }

  function goToWork(hash, askText) {
    var url = '/work';
    if (askText) url += '?ask=' + encodeURIComponent(askText);
    url += '#' + hash;
    window.location.href = url;
  }

  var CHIP_TARGETS = {
    email: { hash: 'email-panel' },
    minutes: { hash: 'meeting-notepad-redirect-panel' },
    browser: { hash: 'browser-panel' },
    // Interim ask-prefill text distinct from the chip's own label, matching
    // the FD-02 wireframe copy for this hand-off.
    webapp: { hash: 'conversation-panel', ask: 'Webアプリの要望をまとめたい' },
  };

  function wireAskBox() {
    var form = document.getElementById('ask-form');
    var input = document.getElementById('ask-input');
    var micButton = document.getElementById('ask-mic');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = ((input && input.value) || '').trim();
        goToWork('conversation-panel', text || undefined);
      });
    }
    if (micButton) {
      micButton.addEventListener('click', function () {
        goToWork('voice-panel');
      });
    }
    document.querySelectorAll('.home-chip').forEach(function (button) {
      button.addEventListener('click', function () {
        var target = CHIP_TARGETS[button.getAttribute('data-chip')];
        if (!target) return;
        goToWork(target.hash, target.ask);
      });
    });
  }

  function decideHref(nav) {
    var items = (nav && nav.items) || [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === 'decide') return items[i].href;
    }
    return '/';
  }

  var DECIDE_TAG_KEY = {
    approval: 'tag_approval',
    exception: 'tag_exception',
    stalled: 'tag_stalled',
    memory: 'tag_memory',
  };

  function renderDecideCard(nav, vocab, home) {
    var titleEl = document.getElementById('decide-title');
    if (titleEl) titleEl.textContent = vt(vocab, 'home_decide_title');

    var href = decideHref(nav);
    var moreLink = document.getElementById('decide-more');
    if (moreLink) {
      moreLink.textContent = vt(vocab, 'home_decide_more');
      moreLink.setAttribute('href', href);
    }

    var counts = home.counts || {};
    var countEl = document.getElementById('decide-count');
    if (countEl) {
      countEl.textContent = renderTemplate(vt(vocab, 'count_items') || '{count}', {
        count: counts.decide || 0,
      });
    }

    var items = (home.decide || []).slice(0, 3);
    var listEl = document.getElementById('decide-list');
    var emptyEl = document.getElementById('decide-empty');
    if (!items.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.textContent = vt(vocab, 'home_decide_empty');
        emptyEl.classList.remove('hidden');
      }
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (!listEl) return;
    listEl.innerHTML = items
      .map(function (item) {
        var tagKey = DECIDE_TAG_KEY[item.kind] || 'tag_approval';
        var tagLabel = vt(vocab, tagKey) || item.kind;
        var tenantChip = item.tenant_slug
          ? '<span class="home-tenant-chip">' + escapeHtml(item.tenant_slug) + '</span>'
          : '';
        return (
          '<li><a class="home-row" href="' +
          escapeHtml(href) +
          '">' +
          '<span class="home-row-main">' +
          '<span class="home-tag home-tag-' +
          escapeHtml(item.kind) +
          '">' +
          escapeHtml(tagLabel) +
          '</span>' +
          '<span class="home-row-title">' +
          escapeHtml(item.title) +
          '</span>' +
          tenantChip +
          svgIcon('chevron', 'home-row-chevron') +
          '</span>' +
          '</a></li>'
        );
      })
      .join('');
  }

  var PROGRESS_TAG_KEY = { in_progress: 'tag_in_progress', delivered: 'tag_delivered' };

  // FD-05: the dedicated "進み具合" page — each row deep-links to its own
  // item (kept in the URL hash there so a reload restores the selection).
  function progressHref(item) {
    return '/progress#' + encodeURIComponent(item.id);
  }

  function renderProgressCard(vocab, home) {
    var titleEl = document.getElementById('progress-title');
    if (titleEl) titleEl.textContent = vt(vocab, 'home_progress_title');

    var counts = home.counts || {};
    var summaryEl = document.getElementById('progress-summary');
    if (summaryEl) {
      summaryEl.textContent = renderTemplate(vt(vocab, 'home_progress_summary'), {
        active: counts.progress || 0,
        delivered: counts.delivered || 0,
      });
    }

    var moreLink = document.getElementById('progress-more');
    if (moreLink) moreLink.textContent = vt(vocab, 'home_progress_more');

    var items = (home.progress || []).slice(0, 4);
    var listEl = document.getElementById('progress-list');
    var emptyEl = document.getElementById('progress-empty');
    if (!items.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.textContent = vt(vocab, 'home_progress_empty');
        emptyEl.classList.remove('hidden');
      }
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (!listEl) return;
    listEl.innerHTML = items
      .map(function (item) {
        var href = progressHref(item);
        var tagKey = PROGRESS_TAG_KEY[item.kind] || 'tag_in_progress';
        var tagLabel = vt(vocab, tagKey) || item.kind;
        var bar =
          typeof item.percent === 'number'
            ? '<div class="home-row-progress"><div class="home-row-progress-fill" style="width:' +
              Math.max(0, Math.min(100, item.percent)) +
              '%"></div></div>'
            : '';
        var receiveLink =
          item.kind === 'delivered'
            ? '<a class="home-row-receive" href="' +
              escapeHtml(href) +
              '">' +
              escapeHtml(vt(vocab, 'action_receive')) +
              '</a>'
            : '';
        return (
          '<li><a class="home-row" href="' +
          escapeHtml(href) +
          '">' +
          '<span class="home-row-main">' +
          '<span class="home-tag home-tag-' +
          escapeHtml(item.kind) +
          '">' +
          escapeHtml(tagLabel) +
          '</span>' +
          '<span class="home-row-title">' +
          escapeHtml(item.title) +
          '</span>' +
          svgIcon('chevron', 'home-row-chevron') +
          '</span>' +
          bar +
          '</a>' +
          receiveLink +
          '</li>'
        );
      })
      .join('');
  }

  function renderBriefing(vocab, home, locale) {
    var dateEl = document.getElementById('briefing-date');
    if (dateEl) dateEl.textContent = formatHomeDate(home.date, locale);

    var counts = home.counts || { decide: 0, progress: 0, delivered: 0 };
    var sentenceEl = document.getElementById('briefing-sentence');
    if (sentenceEl) {
      sentenceEl.textContent =
        (counts.decide || 0) === 0 && (counts.progress || 0) === 0 && (counts.delivered || 0) === 0
          ? vt(vocab, 'home_briefing_clear')
          : renderTemplate(vt(vocab, 'home_briefing'), counts);
    }

    var recommendEl = document.getElementById('briefing-recommend');
    var topDecide = (home.decide || [])[0];
    if (recommendEl) {
      if (topDecide) {
        recommendEl.textContent = renderTemplate(vt(vocab, 'home_recommend'), {
          title: topDecide.title,
        });
        recommendEl.classList.remove('hidden');
      } else {
        recommendEl.classList.add('hidden');
      }
    }
  }

  function render(nav, vocab, home, locale) {
    renderBriefing(vocab, home, locale);
    renderDecideCard(nav, vocab, home);
    renderProgressCard(vocab, home);
  }

  function mount() {
    var locale = normalizeLocale();
    Promise.all([
      fetchJson('/api/front-desk/nav?locale=' + encodeURIComponent(locale)),
      fetchJson('/api/home-vocabulary?locale=' + encodeURIComponent(locale)),
    ])
      .then(function (pair) {
        var nav = pair[0];
        var vocabResponse = pair[1];
        if (!vocabResponse || !vocabResponse.ok) return undefined;
        var vocab = vocabResponse.texts || {};
        renderAskShell(vocab);
        wireAskBox();
        return fetchJson('/api/home').then(function (home) {
          if (home && home.ok && nav && nav.ok) {
            render(nav, vocab, home, locale);
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
