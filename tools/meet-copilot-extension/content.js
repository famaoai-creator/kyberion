/**
 * Kyberion Meet Copilot — content script (multi-platform meeting DOM control).
 *
 * Runs in the meeting page (Google Meet / Microsoft Teams / Zoom web client),
 * isolated world. Executes commands relayed by the service worker by clicking
 * the platform's controls (join / mic / camera / leave / captions) via localized
 * accessible names and known stable selectors, and scrapes live captions,
 * forwarding them to the driver as transcript events.
 *
 * Platform DOMs are obfuscated and localized (JA + EN matchers below). If a
 * platform changes wording/markup, extend SELECTORS[platform] / caption hints.
 * Use the popup "Diagnose DOM" button to capture the live DOM for tuning.
 */

(function () {
  if (window.__kyberionMeetCopilot) return; // guard against re-injection
  window.__kyberionMeetCopilot = true;

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('meet.google.com')) return 'meet';
    if (h.includes('teams.microsoft.com') || h.includes('teams.live.com')) return 'teams';
    if (h === 'zoom.us' || h.endsWith('.zoom.us')) return 'zoom';
    return 'meet';
  }

  // Per-platform control specs. Each spec: { aria: [RegExp], sel: [cssSelector] }.
  // `find()` tries aria-label/text match first, then CSS selectors.
  const SELECTORS = {
    meet: {
      joinNow: { aria: [/今すぐ参加/i, /参加$/i, /join now/i] },
      askToJoin: { aria: [/参加をリクエスト/i, /ask to join/i, /参加のリクエスト/i] },
      micOff: { aria: [/マイクをオフ/i, /turn off micro?phone/i] }, // shown when mic is ON
      micOn: { aria: [/マイクをオン/i, /turn on micro?phone/i] }, // shown when mic is OFF
      camOff: { aria: [/カメラをオフ/i, /turn off camera/i] },
      camOn: { aria: [/カメラをオン/i, /turn on camera/i] },
      leave: { aria: [/通話から退出/i, /通話を退出/i, /退出/i, /leave call/i] },
      captionsOn: { aria: [/字幕をオン/i, /turn on captions/i, /字幕を表示/i] },
      captionSel: ['[aria-label*="字幕"] [jsname]', 'div[jsname][aria-live="polite"]'],
    },
    teams: {
      joinNow: {
        aria: [/今すぐ参加/i, /join now/i, /参加$/i],
        sel: ['#prejoin-join-button', '[data-tid="prejoin-join-button"]'],
      },
      askToJoin: { aria: [/ロビーで待機/i, /参加をリクエスト/i, /ask to join/i] },
      micOff: { aria: [/ミュート(?!解除)/i, /\bmute\b/i], sel: ['[data-tid="toggle-mute"]'] },
      micOn: { aria: [/ミュート解除/i, /\bunmute\b/i], sel: ['[data-tid="toggle-mute"]'] },
      camOff: { aria: [/カメラをオフ/i, /turn camera off/i], sel: ['[data-tid="toggle-video"]'] },
      camOn: { aria: [/カメラをオン/i, /turn camera on/i], sel: ['[data-tid="toggle-video"]'] },
      leave: {
        aria: [/退出/i, /会議から退出/i, /leave/i, /hang up/i],
        sel: ['[data-tid="hangup-button"]', '[data-tid="call-hangup"]'],
      },
      captionsOn: {
        aria: [/ライブ キャプションをオンに/i, /turn on live captions/i, /字幕をオンに/i],
      },
      captionSel: [
        '[data-tid="closed-caption-v2-window-wrapper"]',
        '[data-tid*="closed-caption"]',
        '[data-tid*="caption"]',
      ],
    },
    zoom: {
      joinNow: {
        aria: [
          /参加$/i,
          /\bjoin\b/i,
          /コンピューターでオーディオに参加/i,
          /join audio by computer/i,
        ],
        sel: ['button.join-audio-by-voip__join-btn', '.zm-btn__outline--blue'],
      },
      askToJoin: { aria: [/参加$/i, /ask to join/i] },
      micOff: { aria: [/ミュート(?!解除)/i, /\bmute\b/i] },
      micOn: { aria: [/ミュート解除/i, /\bunmute\b/i] },
      camOff: { aria: [/ビデオの停止/i, /stop video/i] },
      camOn: { aria: [/ビデオの開始/i, /start video/i] },
      leave: { aria: [/終了/i, /退出/i, /\bleave\b/i, /\bend\b/i], sel: ['.footer__leave-btn'] },
      captionsOn: {
        aria: [/字幕を表示/i, /show captions/i, /closed caption/i, /ライブ文字起こし/i],
      },
      captionSel: ['[class*="live-transcription-subtitle"]', '[class*="caption"]'],
    },
  };

  const PLATFORM = detectPlatform();
  const S = SELECTORS[PLATFORM] || SELECTORS.meet;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clickables() {
    return Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'));
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findByAria(patterns) {
    for (const el of clickables()) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!label) continue;
      if (patterns.some((re) => re.test(label))) return el;
    }
    return null;
  }

  function findBySel(selList) {
    for (const sel of selList || []) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch {
        /* invalid selector on this platform — ignore */
      }
    }
    return null;
  }

  function find(spec) {
    if (!spec) return null;
    return findByAria(spec.aria || []) || findBySel(spec.sel || []);
  }

  async function waitControl(specs, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    const list = Array.isArray(specs) ? specs : [specs];
    while (Date.now() < deadline) {
      for (const spec of list) {
        const el = find(spec);
        if (el) return el;
      }
      await sleep(500);
    }
    return null;
  }

  function pushEvent(payload) {
    chrome.runtime.sendMessage({ type: 'meet:event', payload });
  }

  function emitStatus(phase, detail) {
    pushEvent({ event: 'status', phase, detail: detail || {}, platform: PLATFORM });
  }

  // DOM snapshot for tuning the fragile per-platform selectors against the live product.
  function collectDiagnostics() {
    const controls = clickables()
      .map((el) => ({
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        tid: el.getAttribute('data-tid') || '',
        visible: isVisible(el),
      }))
      .filter((c) => c.label)
      .slice(0, 150);
    const regions = Array.from(document.querySelectorAll('[aria-live]'))
      .slice(0, 25)
      .map((el) => ({
        aria_live: el.getAttribute('aria-live'),
        aria_label: el.getAttribute('aria-label') || '',
        has_buttons: !!el.querySelector('button, [role="button"]'),
        text_sample: (el.textContent || '').trim().slice(0, 200),
      }));
    const vh = window.innerHeight || 800;
    const seenText = new Set();
    const caption_candidates = [];
    for (const el of document.querySelectorAll('div, span, section')) {
      if (caption_candidates.length >= 40) break;
      if (el.querySelector('button, [role="button"]')) continue;
      const t = (el.textContent || '').trim();
      if (t.length < 4 || t.length > 300) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 8 || r.top < vh * 0.45) continue;
      const key = t.slice(0, 60);
      if (seenText.has(key)) continue;
      seenText.add(key);
      caption_candidates.push({
        tag: el.tagName.toLowerCase(),
        jsname: el.getAttribute('jsname') || '',
        tid: el.getAttribute('data-tid') || '',
        aria_live: el.getAttribute('aria-live') || '',
        cls:
          typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join('.') : '',
        text: t.slice(0, 120),
      });
    }
    return {
      platform: PLATFORM,
      url: location.href,
      at: new Date().toISOString(),
      controls,
      regions,
      caption_candidates,
    };
  }

  async function setMic(on) {
    // If a "turn ON / unmute" control is visible the mic is currently OFF, and vice-versa.
    const turnOn = find(S.micOn);
    const turnOff = find(S.micOff);
    if (on && turnOn) turnOn.click();
    else if (!on && turnOff) turnOff.click();
  }

  async function setCamera(on) {
    const turnOn = find(S.camOn);
    const turnOff = find(S.camOff);
    if (on && turnOn) turnOn.click();
    else if (!on && turnOff) turnOff.click();
  }

  function setGuestName(name) {
    if (!name) return;
    const input = document.querySelector('input[aria-label], input[type="text"]');
    if (input && isVisible(input) && !input.value) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  let captionObserver = null;
  const seenCaptions = new Set();

  // Control-bar / material-icon / accessibility-status strings that are NOT speech.
  const CAPTION_UI_DENY = [
    /closed_caption/i,
    /arrow_downward/i,
    /一番下に移動/,
    /字幕を(表示|オン|オフ|非表示)/,
    /\bcaptions?\b/i,
    /\bmic(_off)?\b/i,
    /videocam/i,
    /more_vert/i,
    /present_to_all/i,
    /call_end/i,
    /\bkeep\b/i,
    /devices/i,
    /\bpin\b/i,
    /\bspeaker\b/i,
    /設定/,
    /(マイク|カメラ|自動字幕起こし|字幕).*(オン|オフ)になって/,
    /残り\s*\d+\s*秒/,
    /ホーム画面に戻ります/,
    /通話を確立できませんでした/,
    /ミーティングから退出しました/,
    /会議の準備が整いました/,
    /になっています。?$/,
    /ミュート|unmute|\bmute\b/i,
  ];

  function cleanCaptionText(raw) {
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[a-z][a-z_]{2,}(?=[^a-z_ ]|$)/, '').trim())
      .filter((line) => line && !CAPTION_UI_DENY.some((re) => re.test(line)))
      .join(' ')
      .trim();
  }

  function captionRegions() {
    // Prefer platform-specific caption containers; fall back to the generic
    // "visible, lower-viewport, no-buttons aria-live" heuristic.
    const specific = [];
    for (const sel of S.captionSel || []) {
      try {
        document.querySelectorAll(sel).forEach((el) => specific.push(el));
      } catch {
        /* ignore */
      }
    }
    if (specific.length) return specific.filter(isVisible);
    const vh = window.innerHeight || 800;
    return Array.from(
      document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]')
    ).filter((el) => {
      if (el.querySelector('button, [role="button"]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) return false;
      if (r.top < vh * 0.3) return false;
      return true;
    });
  }

  function startCaptions() {
    const on = find(S.captionsOn);
    if (on) on.click();
    if (captionObserver) return;
    captionObserver = new MutationObserver(() => {
      let best = '';
      for (const region of captionRegions()) {
        const cleaned = cleanCaptionText(region.textContent || '');
        if (cleaned.length > best.length) best = cleaned;
      }
      if (!best) return;
      const key = best.slice(-200);
      if (seenCaptions.has(key)) return;
      seenCaptions.add(key);
      if (seenCaptions.size > 500) seenCaptions.clear();
      pushEvent({ event: 'caption', text: best, platform: PLATFORM });
    });
    captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function inCallNow() {
    if (find(S.leave)) return true;
    const preJoin = find(S.joinNow) || find(S.askToJoin);
    const hasControls = find(S.micOff) || find(S.micOn);
    return !preJoin && !!hasControls;
  }

  async function join({ display_name, mic, camera, captions }) {
    emitStatus('joining');
    if (inCallNow()) {
      await setMic(mic === 'on');
      await setCamera(camera === 'on');
      if (captions) startCaptions();
      emitStatus('in_call', { already: true });
      pushEvent({ event: 'diagnostics', data: collectDiagnostics() });
      return {
        ok: true,
        detail: { already_in_call: true, platform: PLATFORM, url: location.href },
      };
    }
    setGuestName(display_name);
    await setMic(mic === 'on');
    await setCamera(camera === 'on');

    const btn = await waitControl([S.joinNow, S.askToJoin], 30000);
    if (!btn) {
      pushEvent({ event: 'diagnostics', data: collectDiagnostics() });
      return { ok: false, error: `join button not found on ${PLATFORM} (see diagnostics)` };
    }
    btn.click();
    emitStatus('waiting_admit');

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (inCallNow()) break;
      await sleep(700);
    }
    if (!inCallNow()) {
      pushEvent({ event: 'diagnostics', data: collectDiagnostics() });
      return { ok: false, error: `did not reach in-call UI on ${PLATFORM} (see diagnostics)` };
    }

    await setMic(mic === 'on');
    await setCamera(camera === 'on');
    if (captions) startCaptions();
    emitStatus('in_call');
    pushEvent({ event: 'diagnostics', data: collectDiagnostics() });

    return { ok: true, detail: { platform: PLATFORM, url: location.href } };
  }

  async function leave() {
    const btn = find(S.leave);
    if (btn) btn.click();
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'meet:join') {
      sendResponse({ ok: true, ack: true, platform: PLATFORM });
      join(message)
        .then((r) =>
          pushEvent(
            r.ok
              ? { event: 'joined', detail: r.detail || {} }
              : { event: 'error', message: r.error }
          )
        )
        .catch((e) =>
          pushEvent({ event: 'error', message: String(e && e.message ? e.message : e) })
        );
      return false;
    }
    (async () => {
      try {
        if (message.type === 'meet:set_mic') {
          await setMic(Boolean(message.on));
          sendResponse({ ok: true });
        } else if (message.type === 'meet:set_camera') {
          await setCamera(Boolean(message.on));
          sendResponse({ ok: true });
        } else if (message.type === 'meet:leave') {
          await leave();
          pushEvent({ event: 'left' });
          sendResponse({ ok: true });
        } else if (message.type === 'meet:diagnose') {
          const data = collectDiagnostics();
          pushEvent({ event: 'diagnostics', data });
          sendResponse({ ok: true, data });
        } else if (message.type === 'meet:chat')
          sendResponse({ ok: false, error: 'chat not implemented' });
        else sendResponse({ ok: false, error: `unknown message ${message.type}` });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  });
})();
