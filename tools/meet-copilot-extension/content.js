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
      chatOpen: { aria: [/全員とチャット/i, /chat with everyone/i, /^チャット$/i] },
      chatInputSel: ['textarea[aria-label*="メッセージ"]', 'textarea[aria-label*="message" i]'],
      chatSend: { aria: [/メッセージを送信/i, /send a message/i, /send message/i] },
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
      chatOpen: { aria: [/^チャット$/i, /^chat$/i], sel: ['[data-tid="chat-button"]'] },
      chatInputSel: [
        '[data-tid="ckeditor"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
      ],
      chatSend: {
        aria: [/送信/i, /\bsend\b/i],
        sel: ['[data-tid="newMessageCommandBar-send"]', 'button[name="send"]'],
      },
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
      chatOpen: { aria: [/^チャット$/i, /^chat$/i, /チャットを開く/i, /open chat/i] },
      chatInputSel: [
        'textarea.chat-rtf-box__editor',
        'div.chat-rtf-box__editor[contenteditable="true"]',
        'textarea[aria-label*="チャット"]',
        'div[contenteditable="true"]',
      ],
      chatSend: { aria: [/送信/i, /\bsend\b/i] },
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
    // Frame-source inventory for tuning the shared-screen picker per platform:
    // which surface the platform actually paints into, and how many decoys the
    // largest-area heuristic has to beat.
    const videos = frameSourceCandidates()
      .slice(0, 20)
      .map((c) => ({
        kind: c.kind,
        intrinsic: `${c.width}x${c.height}`,
        rendered_area: Math.round(c.area),
        has_stream: c.kind === 'video' ? Boolean(c.el.srcObject) : undefined,
      }));
    return {
      platform: PLATFORM,
      url: location.href,
      at: new Date().toISOString(),
      controls,
      regions,
      caption_candidates,
      videos,
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

  // Chat posting for operator-approved utterances. The AI never reaches this
  // path on its own: the side panel requires an explicit click per message.
  function setFieldText(el, text) {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return true;
    }
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    el.focus();
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      );
    }
  }

  async function sendChat(text) {
    const message = String(text || '').trim();
    if (!message) return { ok: false, error: 'empty chat text' };

    let input = findBySel(S.chatInputSel);
    if (!input) {
      const opener = find(S.chatOpen);
      if (!opener) return { ok: false, error: `chat panel not found on ${PLATFORM}` };
      opener.click();
      const deadline = Date.now() + 5000;
      while (!input && Date.now() < deadline) {
        await sleep(250);
        input = findBySel(S.chatInputSel);
      }
    }
    if (!input) return { ok: false, error: `chat input not found on ${PLATFORM}` };
    if (!setFieldText(input, message)) {
      return { ok: false, error: `could not set chat text on ${PLATFORM}` };
    }
    await sleep(150);
    const sendBtn = find(S.chatSend);
    if (sendBtn && isVisible(sendBtn)) sendBtn.click();
    else pressEnter(input);
    return { ok: true, detail: { platform: PLATFORM, sent_via: sendBtn ? 'button' : 'enter' } };
  }

  // Shared-screen capture. The platform renders the shared screen into a
  // <video> fed by a WebRTC MediaStream, so a canvas readback gets the frame
  // without tabCapture/getDisplayMedia — no extra permission, no capture
  // indicator, and nothing is recorded that the operator is not already seeing.
  const MIN_FRAME_SOURCE_WIDTH = 200;
  const MIN_FRAME_SOURCE_HEIGHT = 150;

  /**
   * Candidate surfaces the shared screen could be painted on, largest first.
   *
   * Meet and Teams render remote streams into <video>. Zoom's web client
   * decodes in WebAssembly and paints into <canvas>, so there is often no
   * <video> to read at all — but a canvas the page painted itself is not
   * tainted, so the same readback works on it.
   */
  function frameSourceCandidates() {
    const candidates = [];
    const consider = (el, kind, intrinsicWidth, intrinsicHeight) => {
      if (!intrinsicWidth || !intrinsicHeight) return;
      const rect = el.getBoundingClientRect();
      // Participant tiles are small; the shared screen is the largest surface.
      if (rect.width < MIN_FRAME_SOURCE_WIDTH || rect.height < MIN_FRAME_SOURCE_HEIGHT) return;
      candidates.push({
        el,
        kind,
        width: intrinsicWidth,
        height: intrinsicHeight,
        area: rect.width * rect.height,
      });
    };
    for (const video of document.querySelectorAll('video')) {
      consider(video, 'video', video.videoWidth, video.videoHeight);
    }
    for (const canvas of document.querySelectorAll('canvas')) {
      consider(canvas, 'canvas', canvas.width, canvas.height);
    }
    return candidates.sort((a, b) => b.area - a.area);
  }

  function captureSharedScreenFrame({ maxWidth = 1600, quality = 0.7 } = {}) {
    const candidates = frameSourceCandidates();
    const source = candidates[0];
    if (!source) {
      return { ok: false, error: `no shared-screen surface found on ${PLATFORM}` };
    }
    const scale = Math.min(1, maxWidth / source.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    try {
      canvas.getContext('2d').drawImage(source.el, 0, 0, canvas.width, canvas.height);
      // A protected stream taints the canvas and toDataURL throws. Report that
      // instead of returning a blank frame that looks like a working capture.
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      return {
        ok: true,
        data_url: dataUrl,
        width: canvas.width,
        height: canvas.height,
        // The picker cannot tell a shared screen from a large camera tile, so
        // report what it grabbed and let the operator judge.
        source_kind: source.kind,
        source_size: `${source.width}x${source.height}`,
        candidate_count: candidates.length,
        platform: PLATFORM,
      };
    } catch (err) {
      return {
        ok: false,
        error: `frame readback blocked on ${PLATFORM} (${source.kind}): ${
          err && err.message ? err.message : err
        }`,
      };
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

  // Caption regions are a CUMULATIVE, LIVE-REVISED block, not a stream of
  // utterances: every mutation re-renders the whole visible block, and live ASR
  // keeps rewriting its tail as it refines the current sentence. Measured on a
  // real Teams call: 453 mutations carrying 258k chars for ~19k chars of speech.
  //
  // So treat the longest common prefix between two consecutive blocks as the
  // FINALIZED text (a revision can only change the tail) and emit only the part
  // of it we have not emitted yet. The block also scrolls, dropping finalized
  // lines off the top, which shrinks that prefix — re-anchor on the tail of what
  // we already emitted when that happens.
  const MAX_CAPTION_OVERLAP = 2000;

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i += 1;
    return i;
  }

  function createCaptionExtractor() {
    let block = '';
    let committed = 0;
    let emittedTail = '';
    return (next) => {
      if (!next || next === block) return '';
      const stable = commonPrefixLength(block, next);
      if (stable < committed) {
        // Scrolled: the block now starts partway into text we already emitted.
        // Re-anchor on the longest head of the new block that our emitted tail
        // ends with — that head is exactly the part already sent.
        let anchor = 0;
        const max = Math.min(emittedTail.length, next.length, MAX_CAPTION_OVERLAP);
        for (let i = max; i > 0; i -= 1) {
          if (emittedTail.endsWith(next.slice(0, i))) {
            anchor = i;
            break;
          }
        }
        block = next;
        committed = anchor;
        return '';
      }
      block = next;
      if (stable <= committed) return '';
      // Keep the raw slice (separators included) in the tail: the re-anchor
      // above matches against the block's own text, which is not trimmed.
      const raw = next.slice(committed, stable);
      committed = stable;
      emittedTail = (emittedTail + raw).slice(-MAX_CAPTION_OVERLAP);
      return raw.trim();
    };
  }

  // ASR commits a couple of characters at a time, so finalized fragments are
  // buffered into utterance-sized events instead of being pushed one by one.
  const CAPTION_FLUSH_CHARS = 120;
  const CAPTION_IDLE_MS = 2000;
  const SENTENCE_END = /[。．！？!?]$/;
  let captionBuffer = '';
  let captionFlushTimer = null;

  function flushCaptionBuffer() {
    if (captionFlushTimer) {
      clearTimeout(captionFlushTimer);
      captionFlushTimer = null;
    }
    const text = captionBuffer.trim();
    captionBuffer = '';
    if (!text) return;
    const key = text.slice(-200);
    if (seenCaptions.has(key)) return;
    seenCaptions.add(key);
    if (seenCaptions.size > 500) seenCaptions.clear();
    pushEvent({ event: 'caption', text, platform: PLATFORM });
  }

  function appendCaptionFragment(fragment) {
    captionBuffer += fragment;
    if (SENTENCE_END.test(captionBuffer) || captionBuffer.length >= CAPTION_FLUSH_CHARS) {
      flushCaptionBuffer();
      return;
    }
    if (captionFlushTimer) clearTimeout(captionFlushTimer);
    captionFlushTimer = setTimeout(flushCaptionBuffer, CAPTION_IDLE_MS);
  }

  function startCaptions() {
    const on = find(S.captionsOn);
    if (on) on.click();
    if (captionObserver) return;
    const extractCaption = createCaptionExtractor();
    captionObserver = new MutationObserver(() => {
      let best = '';
      for (const region of captionRegions()) {
        const cleaned = cleanCaptionText(region.textContent || '');
        if (cleaned.length > best.length) best = cleaned;
      }
      const fragment = extractCaption(best);
      if (fragment) appendCaptionFragment(fragment);
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
    // Don't lose the last, still-buffered sentence on the way out.
    flushCaptionBuffer();
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
        } else if (message.type === 'meet:chat') {
          sendResponse(await sendChat(message.text));
        } else if (message.type === 'meet:capture_frame') {
          sendResponse(captureSharedScreenFrame(message.options || {}));
        } else sendResponse({ ok: false, error: `unknown message ${message.type}` });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  });
})();
