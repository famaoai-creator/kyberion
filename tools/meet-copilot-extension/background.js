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
 */

const DEFAULT_PORT = 8779;
const DEFAULT_HOST = '127.0.0.1';
let ws = null;
let keepaliveTimer = null;
let reconnectTimer = null;
// Observability state surfaced to the popup.
const uiState = { wsConnected: false, phase: 'idle', captions: 0, lastError: '' };

async function getConfig() {
  const cfg = await chrome.storage.local.get(['meetCopilotHost', 'meetCopilotPort']);
  return {
    host: cfg.meetCopilotHost || DEFAULT_HOST,
    port: cfg.meetCopilotPort || DEFAULT_PORT,
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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(evt));
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
    if (msg.cmd === 'join') {
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
    else if (msg.cmd === 'leave') {
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
  const { host, port } = await getConfig();
  try {
    ws = new WebSocket(`ws://${host}:${port}`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    uiState.wsConnected = true;
    uiState.lastError = '';
    sendEvent({ event: 'ready', ext: 'meet-copilot', version: '0.1.0' });
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendEvent({ event: 'ping', t: Date.now() }), 20000);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg && msg.cmd) handleCommand(msg);
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
    const p = message.payload || {};
    if (p.event === 'caption') uiState.captions += 1;
    else if (p.event === 'status') uiState.phase = p.phase || uiState.phase;
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
connect();
