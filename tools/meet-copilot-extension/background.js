/**
 * Kyberion Meet Copilot — service worker (control channel).
 *
 * Connects to the local WebSocket server run by the ChromeExtensionMeetingJoinDriver
 * (libs/core/chrome-extension-meeting-driver.ts). Relays driver commands to the
 * Meet content script and streams content-script events (joined / caption / left /
 * error) back to the driver.
 *
 * Control is DRIVER-initiated (inverted vs the native-messaging browser-bridge):
 * the driver is the WS server; this worker is the client.
 *
 * The worker also buffers the live caption stream so the AI side panel can
 * attach mid-meeting, and relays the panel's on-device AI output to the driver
 * as ai_* events. It never runs the model itself: Prompt/Summarizer are document
 * APIs, and keeping generation out of the worker keeps "observe" separate from
 * "act" — nothing the model produces reaches the meeting without a panel click.
 */

// MV3 keeps this worker as a classic script so the governed PII rule bundle can
// be shared with the side panel. If the bundle is absent, caption forwarding
// fails closed rather than persisting raw speech.
if (typeof importScripts === 'function') importScripts('pii-rules.generated.js');

const DEFAULT_PORT = 8779;
const DEFAULT_HOST = '127.0.0.1';
let ws = null;
let keepaliveTimer = null;
let reconnectTimer = null;
let controlToken = '';
// Observability state surfaced to the popup.
const uiState = {
  wsConnected: false,
  phase: 'idle',
  captions: 0,
  lastError: '',
  lastAiAt: '',
  lastScreenContextAt: '',
};

// Live caption ring buffer. MV3 can evict this worker at any time, so it is
// mirrored into chrome.storage.session (debounced) and restored on startup —
// otherwise reopening the panel after an eviction would show an empty meeting.
const MAX_TRANSCRIPT_LINES = 1200;
const TRANSCRIPT_KEY = 'meetCopilotTranscript';
const AI_EVENTS = { summary: 'ai_summary', insights: 'ai_insights', suggestions: 'ai_suggestions' };
let transcript = [];
let persistTimer = null;

const CONTROL_COMMANDS = new Set([
  'session',
  'join',
  'set_mic',
  'set_camera',
  'chat',
  'raise_hand',
  'admit',
  'screen_context',
  'leave',
]);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeJsonKeys(value) {
  if (Array.isArray(value)) return value.every(hasSafeJsonKeys);
  if (!isPlainRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_JSON_KEYS.has(key) && hasSafeJsonKeys(nested)
  );
}

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function parseControlMessage(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!isPlainRecord(value) || !hasSafeJsonKeys(value) || typeof value.cmd !== 'string')
    return null;
  if (!CONTROL_COMMANDS.has(value.cmd) || !isOptionalString(value.control_token)) return null;

  if (value.cmd === 'session') return value;
  if (value.cmd === 'join') {
    return isOptionalString(value.url) &&
      isOptionalString(value.display_name) &&
      isOptionalBoolean(value.mic) &&
      isOptionalBoolean(value.camera) &&
      isOptionalBoolean(value.captions)
      ? value
      : null;
  }
  if (value.cmd === 'set_mic' || value.cmd === 'set_camera') {
    return typeof value.on === 'boolean' ? value : null;
  }
  if (value.cmd === 'chat') return typeof value.text === 'string' ? value : null;
  if (value.cmd === 'raise_hand') return value;
  if (value.cmd === 'admit')
    return typeof value.name === 'string' || value.name === undefined ? value : null;
  if (value.cmd === 'screen_context') {
    return typeof value.text === 'string' && isOptionalString(value.provider) ? value : null;
  }
  return value;
}

function sessionStore() {
  // chrome.storage.session is unavailable on older Chrome and in tests.
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

function persistTranscriptSoon() {
  const store = sessionStore();
  if (!store || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      store.set({ [TRANSCRIPT_KEY]: transcript });
    } catch {
      /* eviction-time best effort */
    }
  }, 2000);
}

async function restoreTranscript() {
  const store = sessionStore();
  if (!store) return;
  try {
    const stored = await store.get([TRANSCRIPT_KEY]);
    const lines = stored && stored[TRANSCRIPT_KEY];
    if (Array.isArray(lines) && transcript.length === 0) {
      transcript = lines
        .slice(-MAX_TRANSCRIPT_LINES)
        .map((entry) => ({
          ...entry,
          text: redactText(entry && entry.text),
        }))
        .filter((entry) => entry.text);
      uiState.captions = transcript.length;
    }
  } catch {
    /* start from an empty buffer */
  }
}

function recordCaption(payload) {
  // The event boundary redacts before calling this persistence helper. Avoid
  // applying the rule set twice because generated placeholders may themselves
  // match broad PII patterns.
  const text = String((payload && payload.text) || '').trim();
  if (!text) return null;
  const entry = {
    text,
    at: new Date().toISOString(),
    platform: (payload && payload.platform) || '',
  };
  transcript.push(entry);
  if (transcript.length > MAX_TRANSCRIPT_LINES) {
    transcript.splice(0, transcript.length - MAX_TRANSCRIPT_LINES);
  }
  persistTranscriptSoon();
  return entry;
}

function redactText(value) {
  const scrub = globalThis.__kyberionPiiScrub;
  if (typeof scrub !== 'function') {
    uiState.lastError = 'PII scrubber unavailable; caption withheld';
    return '';
  }
  try {
    return String(scrub(String(value || ''))).trim();
  } catch {
    uiState.lastError = 'PII scrubber failed; caption withheld';
    return '';
  }
}

// Fire-and-forget notification to an open side panel. No receiver is the normal
// case (the panel is usually closed), so the error is swallowed deliberately.
function notifyPanel(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    /* no panel listening */
  }
}

async function getConfig() {
  const cfg = await chrome.storage.local.get([
    'meetCopilotHost',
    'meetCopilotPort',
    'meetCopilotAuthToken',
  ]);
  return {
    host: cfg.meetCopilotHost || DEFAULT_HOST,
    port: cfg.meetCopilotPort || DEFAULT_PORT,
    authToken: cfg.meetCopilotAuthToken || '',
  };
}

const MEETING_URL_PATTERNS = [
  'https://meet.google.com/*',
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://*.zoom.us/*',
];

async function findMeetTab() {
  const tabs = await chrome.tabs.query({ url: MEETING_URL_PATTERNS });
  return tabs[0] || null;
}

async function ensureMeetTab(url) {
  let tab = await findMeetTab();
  if (!tab && url) {
    tab = await chrome.tabs.create({ url, active: true });
    // wait for the tab to finish loading before injecting
    await waitForTabComplete(tab.id, 20000);
  }
  return tab;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.status === 'complete') return resolve();
      } catch {
        /* tab gone */
      }
      if (Date.now() > deadline) return resolve();
      setTimeout(check, 500);
    };
    check();
  });
}

// Programmatic injection handles tabs that existed BEFORE the extension was
// loaded (declarative content scripts only attach on subsequent page loads).
// content.js guards against double-evaluation, so re-injection is safe.
async function ensureInjected(tabId) {
  for (let i = 0; i < 6; i += 1) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return false;
}

function sendEvent(evt) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(controlToken ? { ...evt, control_token: controlToken } : evt));
  }
}

async function relayToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: true });
      }
    });
  });
}

async function handleCommand(msg) {
  try {
    if (msg.cmd === 'session') {
      if (typeof msg.control_token !== 'string' || msg.control_token.length < 32) return;
      controlToken = msg.control_token;
      return;
    }
    if (msg.cmd === 'join') {
      if (typeof msg.control_token !== 'string' || msg.control_token.length < 32) return;
      controlToken = msg.control_token;
      const tab = await ensureMeetTab(msg.url);
      if (!tab) {
        sendEvent({ event: 'error', message: 'no Meet tab and no url provided' });
        return;
      }
      await ensureInjected(tab.id);
      const resp = await relayToContent(tab.id, {
        type: 'meet:join',
        display_name: msg.display_name,
        mic: msg.mic,
        camera: msg.camera,
        captions: msg.captions,
      });
      // The content script acks immediately and reports 'joined'/'error'
      // asynchronously via a meet:event. Only surface a hard relay failure here.
      if (!resp || !resp.ok) {
        sendEvent({ event: 'error', message: (resp && resp.error) || 'join relay failed' });
      }
      return;
    }
    if (!controlToken || msg.control_token !== controlToken) return;
    const tab = await findMeetTab();
    if (!tab) {
      sendEvent({ event: 'error', message: `no Meet tab for cmd '${msg.cmd}'` });
      return;
    }
    await ensureInjected(tab.id);
    if (msg.cmd === 'set_mic') await relayToContent(tab.id, { type: 'meet:set_mic', on: msg.on });
    else if (msg.cmd === 'set_camera')
      await relayToContent(tab.id, { type: 'meet:set_camera', on: msg.on });
    else if (msg.cmd === 'chat')
      await relayToContent(tab.id, { type: 'meet:chat', text: msg.text });
    else if (msg.cmd === 'raise_hand') {
      const resp = await relayToContent(tab.id, { type: 'meet:raise_hand' });
      sendEvent({
        event: 'raised_hand',
        ok: Boolean(resp && resp.ok),
        already: Boolean(resp && resp.already),
      });
    } else if (msg.cmd === 'admit') {
      const resp = await relayToContent(tab.id, { type: 'meet:admit', name: msg.name });
      sendEvent({
        event: 'admitted',
        ok: Boolean(resp && resp.ok),
        admitted: typeof resp?.admitted === 'number' ? resp.admitted : 0,
        ...(typeof msg.name === 'string' && msg.name ? { name: msg.name } : {}),
      });
    }
    // The driver returns OCR text that has already passed the governed PII
    // scrubber; the panel only ever sees this, never the frame it came from.
    else if (msg.cmd === 'screen_context') {
      uiState.lastScreenContextAt = new Date().toISOString();
      notifyPanel({
        type: 'panel:screen-context',
        text: String(msg.text || ''),
        provider: msg.provider || '',
        at: uiState.lastScreenContextAt,
      });
      return;
    } else if (msg.cmd === 'leave') {
      await relayToContent(tab.id, { type: 'meet:leave' });
      sendEvent({ event: 'left' });
    }
  } catch (err) {
    sendEvent({ event: 'error', message: String(err && err.message ? err.message : err) });
  }
}

async function connect() {
  // Guard against multiple concurrent sockets (onInstalled + onStartup +
  // top-level all call connect(); the SW may also be restarted by MV3).
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { host, port, authToken } = await getConfig();
  if (typeof authToken !== 'string' || authToken.length < 32) {
    uiState.lastError =
      'Meet extension auth is not configured; set meetCopilotAuthToken in Chrome storage.';
    return;
  }
  try {
    ws = new WebSocket(`ws://${host}:${port}`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    uiState.wsConnected = true;
    uiState.lastError = '';
    ws.send(
      JSON.stringify({
        event: 'hello',
        auth_token: authToken,
        ext: 'meet-copilot',
        version: '0.1.0',
      })
    );
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendEvent({ event: 'ping', t: Date.now() }), 20000);
  };
  ws.onmessage = (e) => {
    const msg = parseControlMessage(e.data);
    if (msg) void handleCommand(msg);
  };
  ws.onclose = () => {
    uiState.wsConnected = false;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

// Content script pushes caption/join/leave/status events up to the driver;
// popup queries/controls come in on the same channel.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'meet:event') {
    let p = message.payload || {};
    if (p.event === 'caption') {
      const text = redactText(p.text);
      if (!text) {
        sendResponse({ ok: false, error: 'caption withheld because PII scrubber is unavailable' });
        return true;
      }
      p = {
        ...p,
        text,
        ...(typeof p.speaker === 'string' ? { speaker: redactText(p.speaker) } : {}),
      };
      uiState.captions += 1;
      const entry = recordCaption(p);
      if (entry) notifyPanel({ type: 'panel:caption', entry });
    } else if (p.event === 'status') uiState.phase = p.phase || uiState.phase;
    else if (p.event === 'joined') uiState.phase = 'in_call';
    else if (p.event === 'left') uiState.phase = 'left';
    else if (p.event === 'error') uiState.lastError = p.message || '';
    sendEvent(p);
    sendResponse({ ok: true });
    return true;
  }
  if (message && message.type === 'popup:get-status') {
    sendResponse({ ...uiState });
    return true;
  }
  if (message && message.type === 'popup:set-port') {
    chrome.storage.local.set({ meetCopilotPort: Number(message.port) || DEFAULT_PORT }, () => {
      try {
        if (ws) ws.close();
      } catch {
        /* noop */
      }
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message && message.type === 'panel:get-state') {
    sendResponse({ ...uiState, transcript: transcript.slice(-MAX_TRANSCRIPT_LINES) });
    return true;
  }
  // AI output produced in the side panel document. The worker validates the
  // envelope and forwards it to the driver, which persists it; it never feeds
  // this back into the meeting.
  if (message && message.type === 'panel:ai-result') {
    const event = AI_EVENTS[message.kind];
    if (!event) {
      sendResponse({ ok: false, error: `unknown ai result kind '${message.kind}'` });
      return true;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: 'control channel is not connected' });
      return true;
    }
    uiState.lastAiAt = new Date().toISOString();
    // Envelope fields win over the payload: the worker decides what event this
    // is, the panel only supplies its content.
    sendEvent({
      ...(message.payload || {}),
      event,
      provider: message.provider || 'unknown',
      at: uiState.lastAiAt,
      transcript_lines: transcript.length,
    });
    sendResponse({ ok: true, event });
    return true;
  }
  // Frame capture is operator-initiated and one-shot: the worker forwards the
  // frame to the driver for local OCR + redaction and keeps no copy itself.
  if (message && message.type === 'panel:capture-frame') {
    (async () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        sendResponse({ ok: false, error: 'control channel is not connected' });
        return;
      }
      const tab = await findMeetTab();
      if (!tab) {
        sendResponse({ ok: false, error: 'no Meet tab' });
        return;
      }
      await ensureInjected(tab.id);
      const shot = await relayToContent(tab.id, {
        type: 'meet:capture_frame',
        options: message.options || {},
      });
      if (!shot || !shot.ok) {
        sendResponse({ ok: false, error: (shot && shot.error) || 'frame capture failed' });
        return;
      }
      sendEvent({
        event: 'frame',
        data_url: shot.data_url,
        width: shot.width,
        height: shot.height,
        at: new Date().toISOString(),
      });
      sendResponse({
        ok: true,
        width: shot.width,
        height: shot.height,
        source_kind: shot.source_kind,
        source_size: shot.source_size,
        candidate_count: shot.candidate_count,
      });
    })();
    return true;
  }
  // A suggested utterance only reaches the meeting through this path, and only
  // after the operator clicked it in the panel.
  if (message && message.type === 'panel:send-chat') {
    (async () => {
      const text = String(message.text || '').trim();
      if (!text) {
        sendResponse({ ok: false, error: 'empty chat text' });
        return;
      }
      const tab = await findMeetTab();
      if (!tab) {
        sendResponse({ ok: false, error: 'no Meet tab' });
        return;
      }
      await ensureInjected(tab.id);
      const resp = await relayToContent(tab.id, { type: 'meet:chat', text });
      sendResponse(resp);
    })();
    return true;
  }
  if (message && (message.type === 'popup:diagnose' || message.type === 'popup:leave')) {
    (async () => {
      const tab = await findMeetTab();
      if (!tab) {
        sendResponse({ ok: false, error: 'no Meet tab' });
        return;
      }
      await ensureInjected(tab.id);
      const resp = await relayToContent(tab.id, {
        type: message.type === 'popup:diagnose' ? 'meet:diagnose' : 'meet:leave',
      });
      sendResponse(resp);
    })();
    return true;
  }
  return true;
});

// Kick the connection on install and on worker startup.
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
restoreTranscript();
connect();
