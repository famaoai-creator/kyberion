const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(extra || {}) }, (resp) => resolve(resp || {}));
  });
}

async function refresh() {
  const s = await send('popup:get-status');
  $('ws').textContent = s.wsConnected ? 'connected' : 'disconnected';
  $('wsDot').className = 'dot ' + (s.wsConnected ? 'ok' : 'no');
  $('phase').textContent = s.phase || 'idle';
  $('captions').textContent = String(s.captions || 0);
  $('err').textContent = s.lastError ? 'last error: ' + s.lastError : '';
}

async function init() {
  const cfg = await new Promise((r) => chrome.storage.local.get(['meetCopilotPort'], r));
  $('port').value = cfg.meetCopilotPort || 8779;
  await refresh();
  setInterval(refresh, 1500);
}

$('save').addEventListener('click', async () => {
  await send('popup:set-port', { port: Number($('port').value) });
  await refresh();
});
$('diagnose').addEventListener('click', async () => {
  const r = await send('popup:diagnose');
  $('err').textContent = r.ok
    ? 'diagnostics sent to driver'
    : 'diagnose failed: ' + (r.error || '');
});
$('leave').addEventListener('click', async () => {
  await send('popup:leave');
  await refresh();
});

init();
