/**
 * Self-contained mirror viewer page (no external assets): MJPEG <img> stream,
 * click-to-tap with device-coordinate scaling, tap ripples, and a status bar
 * polling /status.
 */
export function renderViewerHtml(options: { deviceLabel: string; interactive: boolean }): string {
  const { deviceLabel, interactive } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kyberion Mirror — ${escapeHtml(deviceLabel)}</title>
<style>
  :root { --ink:#232f3e; --muted:#5a6672; --accent:#ec7211; --line:#e3e8ee; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:system-ui,-apple-system,sans-serif; background:#1c2229; color:#e8ecf0;
         display:flex; flex-direction:column; align-items:center; min-height:100vh; padding:16px; }
  header { width:100%; max-width:480px; display:flex; align-items:center; justify-content:space-between;
           gap:12px; padding:8px 4px; }
  header h1 { font-size:14px; font-weight:600; }
  header .meta { font-size:11px; color:#9aa7b4; }
  .controls { display:flex; gap:8px; align-items:center; }
  .dot { width:8px; height:8px; border-radius:50%; background:#2fbf71; display:inline-block; }
  .dot.degraded { background:var(--accent); }
  button { background:#2a323c; color:#e8ecf0; border:1px solid #3d4754; border-radius:6px;
           font-size:12px; padding:4px 10px; cursor:pointer; }
  button.active { border-color:var(--accent); color:var(--accent); }
  .stage { position:relative; max-width:480px; width:100%; }
  img { width:100%; display:block; border-radius:14px; background:#000;
        -webkit-user-drag:none; user-select:none; }
  .ripple { position:absolute; border:2px solid var(--accent); border-radius:50%;
            pointer-events:none; transform:translate(-50%,-50%); animation:rip .45s ease-out forwards; }
  @keyframes rip { from { width:8px; height:8px; opacity:.9 } to { width:36px; height:36px; opacity:0 } }
  .notice { width:100%; max-width:480px; margin-top:10px; font-size:12px; color:#9aa7b4; }
  .notice b { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1><span class="dot" id="dot"></span> ${escapeHtml(deviceLabel)}</h1>
  <div class="controls">
    <span class="meta" id="fps">— fps</span>
    ${interactive ? '<button id="tapToggle" class="active">tap: on</button>' : ''}
  </div>
</header>
<div class="stage">
  <img id="screen" src="/stream.mjpeg" alt="Live screen of ${escapeHtml(deviceLabel)}">
</div>
<p class="notice" id="notice">${
    interactive
      ? 'Click on the screen to inject a tap into the device.'
      : 'Input injection unavailable — viewer is read-only.'
  }</p>
<script>
(function () {
  var img = document.getElementById('screen');
  var stage = document.querySelector('.stage');
  var fpsEl = document.getElementById('fps');
  var dot = document.getElementById('dot');
  var notice = document.getElementById('notice');
  var tapOn = ${interactive ? 'true' : 'false'};
  var toggle = document.getElementById('tapToggle');
  if (toggle) toggle.addEventListener('click', function () {
    tapOn = !tapOn;
    toggle.className = tapOn ? 'active' : '';
    toggle.textContent = 'tap: ' + (tapOn ? 'on' : 'off');
  });
  img.addEventListener('click', function (ev) {
    if (!tapOn || !img.naturalWidth) return;
    var rect = img.getBoundingClientRect();
    var dx = Math.round((ev.clientX - rect.left) * (img.naturalWidth / rect.width));
    var dy = Math.round((ev.clientY - rect.top) * (img.naturalHeight / rect.height));
    var r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = (ev.clientX - rect.left) + 'px';
    r.style.top = (ev.clientY - rect.top) + 'px';
    stage.appendChild(r);
    setTimeout(function () { r.remove(); }, 500);
    fetch('/tap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: dx, y: dy })
    }).then(function (res) {
      if (!res.ok) notice.innerHTML = '<b>tap failed</b> — device rejected the input';
    }).catch(function () {
      notice.innerHTML = '<b>tap failed</b> — mirror unreachable';
    });
  });
  setInterval(function () {
    fetch('/status').then(function (r) { return r.json(); }).then(function (s) {
      fpsEl.textContent = (s.fps || 0).toFixed(1) + ' fps';
      dot.className = 'dot' + (s.state === 'degraded' ? ' degraded' : '');
      if (s.state === 'degraded') notice.textContent = 'degraded — ' + (s.last_error || 'frame capture failing');
    }).catch(function () { dot.className = 'dot degraded'; });
  }, 2000);
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
