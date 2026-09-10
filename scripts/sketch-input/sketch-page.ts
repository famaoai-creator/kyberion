/**
 * sketch-page.ts — self-contained sketch board HTML (no external resources).
 *
 * Tools: pen / rectangle / ellipse / line / arrow / text (keyboard + OS dictation + Web Speech) /
 * eraser / undo / clear. Export posts PNG(+optional instruction) to the local server.
 */
import { resolveLocale } from '@agent/core/locale';

export interface SketchPageConfig {
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

function messages() {
  const ja = resolveLocale() === 'ja';
  return {
    title: ja ? 'Sketch Input（ローカルのみ）' : 'Sketch Input (local only)',
    subtitle: ja
      ? '図とテキストを描いて PNG を書き出し、Kyberion へ渡します'
      : 'Draw diagrams and text, export PNG, and hand off to Kyberion',
    pen: ja ? 'ペン' : 'Pen',
    rect: ja ? '矩形' : 'Rect',
    ellipse: ja ? '楕円' : 'Ellipse',
    line: ja ? '直線' : 'Line',
    arrow: ja ? '矢印' : 'Arrow',
    text: ja ? 'テキスト' : 'Text',
    eraser: ja ? '消しゴム' : 'Eraser',
    undo: ja ? '元に戻す' : 'Undo',
    clear: ja ? '消去' : 'Clear',
    color: ja ? '色' : 'Color',
    width: ja ? '太さ' : 'Width',
    instruction: ja ? 'Kyberionへの指示' : 'Instruction for Kyberion',
    instructionPlaceholder: ja
      ? '例: この図を要件として整理して（キーボード / OSディクテーション / 🎤）'
      : 'e.g. Turn this diagram into requirements (keyboard / OS dictation / 🎤)',
    dictationNote: ja
      ? '指示欄はOSディクテーション（端末内）推奨。ブラウザ🎤は機種によりクラウド送信の場合があります。'
      : 'Prefer OS dictation (on-device) for the instruction. Browser 🎤 may send audio to a cloud provider.',
    voice: ja ? '音声' : 'Voice',
    voiceStop: ja ? '停止' : 'Stop',
    download: ja ? 'PNGダウンロード' : 'Download PNG',
    handoff: ja ? 'Kyberionへ渡す' : 'Hand off to Kyberion',
    ready: ja ? '描画してエクスポートできます' : 'Ready to draw and export',
    exporting: ja ? '書き出し中…' : 'Exporting…',
    exported: ja ? '書き出し完了' : 'Exported',
    exportFailed: ja ? '書き出し失敗' : 'Export failed',
    clearConfirm: ja ? 'キャンバスを消去しますか？' : 'Clear the canvas?',
    textPrompt: ja ? 'テキストを入力' : 'Enter text',
    outLabel: ja ? '出力先' : 'Output',
    voiceStarted: ja ? '音声入力中…' : 'Listening…',
    voiceStopped: ja ? '音声入力を停止' : 'Voice stopped',
    voiceError: ja ? '音声エラー' : 'Voice error',
    voiceUnavailable: ja
      ? 'このブラウザでは音声認識を使えません（OSディクテーションは可）'
      : 'Speech recognition unavailable (OS dictation still works)',
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sketchPageHtml(config: SketchPageConfig): string {
  const m = messages();
  const instruction = config.defaultInstruction ?? '';
  // Browser JS is embedded as a string template; keep it ES5-friendly.
  return `<!DOCTYPE html>
<html lang="${resolveLocale() === 'ja' ? 'ja' : 'en'}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(m.title)}</title>
<style>
  :root{--bg:#f4f6f9;--panel:#fff;--ink:#1a1f29;--line:#d7dbe4;--accent:#2f5c9e;--muted:#5b6575}
  @media (prefers-color-scheme:dark){:root{--bg:#0f141c;--panel:#161d2b;--ink:#e7ecf3;--line:#26303f;--accent:#6ea0e6;--muted:#9aa6b8}}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;background:var(--bg);color:var(--ink)}
  header{padding:14px 18px 8px}
  header h1{margin:0;font-size:18px;font-weight:650}
  header p{margin:4px 0 0;font-size:12px;color:var(--muted)}
  #sk-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
  #sk-bar button,#sk-bar label{background:#eef1f6;border:1px solid var(--line);color:inherit;border-radius:7px;padding:5px 9px;font-size:12px;cursor:pointer;font-family:inherit}
  @media (prefers-color-scheme:dark){#sk-bar button,#sk-bar label{background:#1c2636}}
  #sk-bar button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  #sk-bar button.rec{background:#b33;color:#fff;border-color:#b33}
  #sk-bar input[type=color]{width:32px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent}
  #sk-bar input[type=range]{width:90px}
  #sk-status{font-size:11px;opacity:.75;margin-left:4px}
  main{display:grid;grid-template-columns:1fr;gap:12px;padding:14px 18px 24px}
  #sk-stage{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  canvas{display:block;width:100%;height:min(70vh,720px);touch-action:none;cursor:crosshair;background:#fff}
  @media (prefers-color-scheme:dark){canvas{background:#111827}}
  #sk-side{display:grid;gap:8px}
  #sk-side label{font-size:12px;color:var(--muted)}
  #sk-instruction{width:100%;min-height:72px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;background:var(--panel);color:inherit}
  .note{font-size:11px;color:var(--muted);line-height:1.45}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  #sk-out{font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<header>
  <h1>${esc(m.title)}</h1>
  <p>${esc(m.subtitle)}</p>
</header>
<div id="sk-bar">
  <button type="button" data-tool="pen" class="on">${esc(m.pen)}</button>
  <button type="button" data-tool="rect">${esc(m.rect)}</button>
  <button type="button" data-tool="ellipse">${esc(m.ellipse)}</button>
  <button type="button" data-tool="line">${esc(m.line)}</button>
  <button type="button" data-tool="arrow">${esc(m.arrow)}</button>
  <button type="button" data-tool="text">${esc(m.text)}</button>
  <button type="button" data-tool="eraser">${esc(m.eraser)}</button>
  <button type="button" id="sk-undo">${esc(m.undo)}</button>
  <button type="button" id="sk-clear">${esc(m.clear)}</button>
  <label>${esc(m.color)} <input id="sk-color" type="color" value="#1a1f29"/></label>
  <label>${esc(m.width)} <input id="sk-width" type="range" min="1" max="24" value="3"/></label>
  <button type="button" id="sk-download">${esc(m.download)}</button>
  <button type="button" id="sk-handoff">${esc(m.handoff)}</button>
  <span id="sk-status">${esc(m.ready)}</span>
</div>
<main>
  <div id="sk-stage"><canvas id="sk-canvas" width="1280" height="720"></canvas></div>
  <div id="sk-side">
    <label for="sk-instruction">${esc(m.instruction)}</label>
    <textarea id="sk-instruction" placeholder="${esc(m.instructionPlaceholder)}">${esc(instruction)}</textarea>
    <div class="row">
      <button type="button" id="sk-mic">🎤 ${esc(m.voice)}</button>
      <span class="note">${esc(m.dictationNote)}</span>
    </div>
    <div id="sk-out">${esc(m.outLabel)}: ${esc(config.outLabel)}</div>
  </div>
</main>
<script>
(function(){
  var CFG={url:${JSON.stringify(config.exportUrl)},token:${JSON.stringify(config.token)}};
  var M=${JSON.stringify(m)};
  var canvas=document.getElementById('sk-canvas');
  var ctx=canvas.getContext('2d');
  var tool='pen', drawing=false, startX=0, startY=0, snapshot=null;
  var history=[], colorEl=document.getElementById('sk-color'), widthEl=document.getElementById('sk-width');
  var statusEl=document.getElementById('sk-status'), instructionEl=document.getElementById('sk-instruction');
  var mic=document.getElementById('sk-mic');
  function setStatus(t){ statusEl.textContent=t; }
  function pushHistory(){
    try{ history.push(canvas.toDataURL('image/png')); if(history.length>40) history.shift(); }catch(e){}
  }
  function restoreSnapshot(){ if(snapshot) ctx.putImageData(snapshot,0,0); }
  function pointerPos(e){
    var r=canvas.getBoundingClientRect();
    var x=(e.clientX-r.left)*(canvas.width/r.width);
    var y=(e.clientY-r.top)*(canvas.height/r.height);
    return {x:x,y:y};
  }
  function strokeStyle(){
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.lineWidth=Number(widthEl.value)||3;
    if(tool==='eraser'){ ctx.strokeStyle='#000000'; ctx.fillStyle='#000000'; ctx.globalCompositeOperation='destination-out'; }
    else { ctx.strokeStyle=colorEl.value; ctx.fillStyle=colorEl.value; ctx.globalCompositeOperation='source-over'; }
  }
  function drawArrow(x1,y1,x2,y2){
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    var angle=Math.atan2(y2-y1,x2-x1), len=12+ctx.lineWidth;
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2-len*Math.cos(angle-Math.PI/6), y2-len*Math.sin(angle-Math.PI/6));
    ctx.lineTo(x2-len*Math.cos(angle+Math.PI/6), y2-len*Math.sin(angle+Math.PI/6));
    ctx.closePath(); ctx.fill();
  }
  document.querySelectorAll('#sk-bar [data-tool]').forEach(function(btn){
    btn.addEventListener('click', function(){
      tool=btn.getAttribute('data-tool');
      document.querySelectorAll('#sk-bar [data-tool]').forEach(function(b){ b.classList.toggle('on', b===btn); });
    });
  });
  canvas.addEventListener('pointerdown', function(e){
    canvas.setPointerCapture(e.pointerId);
    var p=pointerPos(e); startX=p.x; startY=p.y; drawing=true;
    snapshot=ctx.getImageData(0,0,canvas.width,canvas.height);
    pushHistory();
    strokeStyle();
    if(tool==='pen'||tool==='eraser'){ ctx.beginPath(); ctx.moveTo(p.x,p.y); }
    if(tool==='text'){
      drawing=false;
      var text=window.prompt(M.textPrompt,'');
      if(text){ ctx.font=(16+Number(widthEl.value)*2)+'px sans-serif'; ctx.fillText(text,p.x,p.y); }
    }
  });
  canvas.addEventListener('pointermove', function(e){
    if(!drawing) return;
    var p=pointerPos(e);
    if(tool==='pen'||tool==='eraser'){ ctx.lineTo(p.x,p.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(p.x,p.y); return; }
    restoreSnapshot(); strokeStyle();
    if(tool==='rect'){ ctx.strokeRect(startX,startY,p.x-startX,p.y-startY); }
    else if(tool==='ellipse'){
      ctx.beginPath();
      ctx.ellipse((startX+p.x)/2,(startY+p.y)/2,Math.abs(p.x-startX)/2,Math.abs(p.y-startY)/2,0,0,Math.PI*2);
      ctx.stroke();
    } else if(tool==='line'){ ctx.beginPath(); ctx.moveTo(startX,startY); ctx.lineTo(p.x,p.y); ctx.stroke(); }
    else if(tool==='arrow'){ drawArrow(startX,startY,p.x,p.y); }
  });
  function endDraw(){ drawing=false; snapshot=null; }
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  document.getElementById('sk-undo').onclick=function(){
    var prev=history.pop();
    if(!prev) return;
    var img=new Image();
    img.onload=function(){ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0); };
    img.src=prev;
  };
  document.getElementById('sk-clear').onclick=function(){
    if(!window.confirm(M.clearConfirm)) return;
    pushHistory();
    ctx.clearRect(0,0,canvas.width,canvas.height);
  };
  function pngDataUrl(){ return canvas.toDataURL('image/png'); }
  document.getElementById('sk-download').onclick=function(){
    var a=document.createElement('a'); a.href=pngDataUrl(); a.download='sketch-input.png'; a.click();
  };
  document.getElementById('sk-handoff').onclick=function(){
    setStatus(M.exporting);
    var dataUrl=pngDataUrl();
    var b64=dataUrl.split(',')[1]||'';
    fetch(CFG.url,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-SK-Token':CFG.token},
      body:JSON.stringify({png_base64:b64,instruction:instructionEl.value||'',width:canvas.width,height:canvas.height})
    }).then(function(r){ return r.text().then(function(t){ return {ok:r.ok,status:r.status,text:t}; }); })
      .then(function(res){
        if(!res.ok) throw new Error(res.text||('HTTP '+res.status));
        setStatus(M.exported+' — '+res.text);
      }).catch(function(err){ setStatus(M.exportFailed+': '+(err&&err.message?err.message:String(err))); });
  };
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition, rec=null, recing=false;
  function stopRec(){ recing=false; if(rec){ try{rec.stop();}catch(e){} } if(mic){ mic.classList.remove('rec'); mic.textContent='🎤 '+M.voice; } }
  if(mic){
    mic.onclick=function(){
      if(recing){ stopRec(); setStatus(M.voiceStopped); return; }
      if(!SR){ setStatus(M.voiceUnavailable); return; }
      rec=new SR(); rec.lang=${JSON.stringify(resolveLocale() === 'ja' ? 'ja-JP' : 'en-US')}; rec.interimResults=true; rec.continuous=true;
      rec.onresult=function(ev){
        var text='';
        for(var i=ev.resultIndex;i<ev.results.length;i++){ if(ev.results[i].isFinal) text+=ev.results[i][0].transcript; }
        if(text){ instructionEl.value=(instructionEl.value?instructionEl.value+' ':'')+text; }
      };
      rec.onerror=function(e){ setStatus(M.voiceError+': '+(e.error||'')); stopRec(); };
      try{ rec.start(); recing=true; mic.classList.add('rec'); mic.textContent='⏹ '+M.voiceStop; setStatus(M.voiceStarted); }
      catch(e){ setStatus(M.voiceError+': '+(e.message||e)); stopRec(); }
    };
  }
})();
</script>
</body>
</html>`;
}
