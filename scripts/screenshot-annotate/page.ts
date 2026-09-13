/**
 * page.ts — screenshot-annotate pad: image drop/paste + sketch-style overlay tools.
 * Bilingual via resolveLocale() maps (vocabulary can be added later).
 */
import { resolveLocale } from '@agent/core/locale';
import { escHtml, padShellCss } from '../lib/local-artifact-pad.js';

export interface ScreenshotAnnotatePageConfig {
  token: string;
  exportUrl: string;
  screenshotUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

function messages() {
  const ja = resolveLocale() === 'ja';
  return {
    title: ja ? 'スクリーンショット注釈' : 'Screenshot Annotate',
    subtitle: ja
      ? '画像を貼り付け／ドロップして注釈を描き、PNG + 指示を Kyberion に渡します。'
      : 'Paste or drop an image, annotate it, and hand off PNG + instruction to Kyberion.',
    dropHint: ja
      ? 'ここに貼り付け / ドロップ（または「画像を読み込む」）'
      : 'Paste / Drop screenshot here (or Load image)',
    loadImage: ja ? '画像を読み込む' : 'Load image',
    osCapture: ja ? 'OSキャプチャ試行' : 'Try OS capture',
    pen: ja ? 'ペン' : 'Pen',
    rect: ja ? '矩形' : 'Rect',
    arrow: ja ? '矢印' : 'Arrow',
    text: ja ? 'テキスト' : 'Text',
    eraser: ja ? '消しゴム' : 'Eraser',
    undo: ja ? '元に戻す' : 'Undo',
    clear: ja ? '注釈クリア' : 'Clear marks',
    color: ja ? '色' : 'Color',
    width: ja ? '太さ' : 'Width',
    instruction: ja ? 'Kyberion への指示' : 'Instruction for Kyberion',
    instructionPlaceholder: ja
      ? 'この注釈付き画像をどう処理するか'
      : 'How to process this annotated image',
    voice: ja ? '音声入力' : 'Voice',
    voiceStop: ja ? '停止' : 'Stop',
    handoff: ja ? 'Kyberionへ渡す' : 'Hand off',
    ready: ja ? '準備完了 — 画像を貼り付けてください' : 'Ready — paste or drop an image',
    exporting: ja ? '書き出し中…' : 'Exporting…',
    exported: ja ? '書き出し完了' : 'Exported',
    exportFailed: ja ? '書き出し失敗' : 'Export failed',
    clearConfirm: ja
      ? '注釈を消しますか？（背景画像は残ります）'
      : 'Clear annotations? (keeps background)',
    textPrompt: ja ? 'テキスト' : 'Text',
    outLabel: ja ? '出力先' : 'Output',
    imageLoaded: ja ? '画像を読み込みました' : 'Image loaded',
    imageNeeded: ja ? '先に画像を読み込んでください' : 'Load an image first',
    captureOk: ja ? 'OSキャプチャ完了' : 'OS capture loaded',
    captureFail: ja
      ? 'OSキャプチャ不可 — 貼り付けてください'
      : 'OS capture unavailable — paste instead',
    voiceStarted: ja ? '音声入力開始' : 'Voice started',
    voiceStopped: ja ? '音声入力停止' : 'Voice stopped',
    voiceError: ja ? '音声エラー' : 'Voice error',
    voiceUnavailable: ja ? '音声認識が使えません' : 'Speech recognition unavailable',
    dictationNote: ja
      ? '機微な画面は貼り付け推奨。🎤はクラウド送信の可能性あり。'
      : 'Prefer paste for sensitive screens. Browser speech may leave the device.',
  };
}

export function screenshotAnnotatePageHtml(config: ScreenshotAnnotatePageConfig): string {
  const m = messages();
  const instruction = config.defaultInstruction ?? '';
  const lang = resolveLocale() === 'ja' ? 'ja' : 'en';
  const speechLang = lang === 'ja' ? 'ja-JP' : 'en-US';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(m.title)}</title>
<style>${padShellCss('#8a5a2f')}
  #sa-drop{border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;font-size:13px;color:var(--muted);background:var(--bg)}
  #sa-drop.hot{border-color:var(--accent);color:var(--accent)}
  #sa-stage{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  canvas{background:#111}
  #sa-bar input[type=color]{width:32px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent}
  #sa-bar input[type=range]{width:90px}
</style>
</head>
<body>
<header>
  <h1>${escHtml(m.title)}</h1>
  <p>${escHtml(m.subtitle)}</p>
</header>
<div class="bar" id="sa-bar">
  <label class="btn" for="sa-file">${escHtml(m.loadImage)}</label>
  <input id="sa-file" type="file" accept="image/*"/>
  <button type="button" id="sa-capture">${escHtml(m.osCapture)}</button>
  <button type="button" data-tool="pen" class="on">${escHtml(m.pen)}</button>
  <button type="button" data-tool="rect">${escHtml(m.rect)}</button>
  <button type="button" data-tool="arrow">${escHtml(m.arrow)}</button>
  <button type="button" data-tool="text">${escHtml(m.text)}</button>
  <button type="button" data-tool="eraser">${escHtml(m.eraser)}</button>
  <button type="button" id="sa-undo">${escHtml(m.undo)}</button>
  <button type="button" id="sa-clear">${escHtml(m.clear)}</button>
  <label>${escHtml(m.color)} <input id="sa-color" type="color" value="#ff5533"/></label>
  <label>${escHtml(m.width)} <input id="sa-width" type="range" min="1" max="24" value="4"/></label>
  <button type="button" id="sa-mic">🎤 ${escHtml(m.voice)}</button>
  <button type="button" class="primary" id="sa-handoff">${escHtml(m.handoff)}</button>
  <span class="status" id="sa-status">${escHtml(m.ready)}</span>
</div>
<main>
  <div id="sa-drop">${escHtml(m.dropHint)}</div>
  <div id="sa-stage"><canvas id="sa-canvas" width="1280" height="720"></canvas></div>
  <section class="panel">
    <label class="field" for="sa-instruction">${escHtml(m.instruction)}</label>
    <textarea id="sa-instruction" placeholder="${escHtml(m.instructionPlaceholder)}">${escHtml(instruction)}</textarea>
    <p class="note">${escHtml(m.dictationNote)}</p>
    <div class="note">${escHtml(m.outLabel)}: ${escHtml(config.outLabel)}</div>
  </section>
</main>
<script>
(function(){
  var CFG={url:${JSON.stringify(config.exportUrl)},shot:${JSON.stringify(config.screenshotUrl)},token:${JSON.stringify(config.token)}};
  var M=${JSON.stringify(m)};
  var canvas=document.getElementById('sa-canvas');
  var ctx=canvas.getContext('2d');
  var bg=null, hasImage=false;
  var tool='pen', drawing=false, startX=0, startY=0, snapshot=null;
  var history=[], colorEl=document.getElementById('sa-color'), widthEl=document.getElementById('sa-width');
  var statusEl=document.getElementById('sa-status'), instructionEl=document.getElementById('sa-instruction');
  var drop=document.getElementById('sa-drop'), mic=document.getElementById('sa-mic');
  function setStatus(t){ statusEl.textContent=t; }
  function redrawBg(){
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation='source-over';
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(bg){
      var scale=Math.min(canvas.width/bg.width, canvas.height/bg.height);
      var w=bg.width*scale, h=bg.height*scale;
      var x=(canvas.width-w)/2, y=(canvas.height-h)/2;
      ctx.fillStyle='#111'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(bg,x,y,w,h);
    }
  }
  function pushHistory(){
    try{ history.push(canvas.toDataURL('image/png')); if(history.length>40) history.shift(); }catch(e){}
  }
  function restoreSnapshot(){ if(snapshot) ctx.putImageData(snapshot,0,0); }
  function pointerPos(e){
    var r=canvas.getBoundingClientRect();
    return {x:(e.clientX-r.left)*(canvas.width/r.width), y:(e.clientY-r.top)*(canvas.height/r.height)};
  }
  function strokeStyle(){
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.lineWidth=Number(widthEl.value)||4;
    if(tool==='eraser'){ ctx.strokeStyle='#000'; ctx.fillStyle='#000'; ctx.globalCompositeOperation='destination-out'; }
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
  function loadFile(file){
    if(!file||!String(file.type||'').startsWith('image/')) return;
    var reader=new FileReader();
    reader.onload=function(){
      var img=new Image();
      img.onload=function(){
        bg=img; hasImage=true; history=[]; redrawBg(); setStatus(M.imageLoaded);
      };
      img.src=String(reader.result||'');
    };
    reader.readAsDataURL(file);
  }
  function loadDataUrl(dataUrl){
    var img=new Image();
    img.onload=function(){ bg=img; hasImage=true; history=[]; redrawBg(); setStatus(M.imageLoaded); };
    img.src=dataUrl;
  }
  document.querySelectorAll('#sa-bar [data-tool]').forEach(function(btn){
    btn.addEventListener('click', function(){
      tool=btn.getAttribute('data-tool');
      document.querySelectorAll('#sa-bar [data-tool]').forEach(function(b){ b.classList.toggle('on', b===btn); });
    });
  });
  canvas.addEventListener('pointerdown', function(e){
    if(!hasImage){ setStatus(M.imageNeeded); return; }
    canvas.setPointerCapture(e.pointerId);
    var p=pointerPos(e); startX=p.x; startY=p.y; drawing=true;
    snapshot=ctx.getImageData(0,0,canvas.width,canvas.height);
    pushHistory(); strokeStyle();
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
    else if(tool==='arrow'){ drawArrow(startX,startY,p.x,p.y); }
  });
  function endDraw(){ drawing=false; snapshot=null; }
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  document.getElementById('sa-undo').onclick=function(){
    var prev=history.pop();
    if(!prev) return;
    var img=new Image();
    img.onload=function(){ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0); };
    img.src=prev;
  };
  document.getElementById('sa-clear').onclick=function(){
    if(!window.confirm(M.clearConfirm)) return;
    pushHistory(); redrawBg();
  };
  document.getElementById('sa-file').onchange=function(e){
    var f=e.target.files&&e.target.files[0]; if(f) loadFile(f);
  };
  ;['dragenter','dragover'].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('hot'); });
    canvas.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('hot'); });
  });
  ;['dragleave','drop'].forEach(function(ev){
    drop.addEventListener(ev, function(e){
      e.preventDefault(); drop.classList.remove('hot');
      if(ev==='drop'&&e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    canvas.addEventListener(ev, function(e){
      e.preventDefault(); drop.classList.remove('hot');
      if(ev==='drop'&&e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
  });
  window.addEventListener('paste', function(e){
    var items=e.clipboardData&&e.clipboardData.items; if(!items) return;
    for(var i=0;i<items.length;i++){
      if(items[i].type&&items[i].type.indexOf('image')===0){
        var f=items[i].getAsFile(); if(f){ e.preventDefault(); loadFile(f); return; }
      }
    }
  });
  document.getElementById('sa-capture').onclick=function(){
    fetch(CFG.shot,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-SA-Token':CFG.token},
      body:'{}'
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok||!res.body||!res.body.ok||!res.body.png_base64){
          throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        }
        loadDataUrl('data:image/png;base64,'+res.body.png_base64);
        setStatus(M.captureOk);
      }).catch(function(err){ setStatus(M.captureFail+': '+(err&&err.message?err.message:String(err))); });
  };
  document.getElementById('sa-handoff').onclick=function(){
    if(!hasImage){ setStatus(M.imageNeeded); return; }
    setStatus(M.exporting);
    var dataUrl=canvas.toDataURL('image/png');
    var b64=dataUrl.split(',')[1]||'';
    fetch(CFG.url,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-SA-Token':CFG.token},
      body:JSON.stringify({png_base64:b64,instruction:instructionEl.value||'',width:canvas.width,height:canvas.height})
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok||!res.body||!res.body.ok) throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        setStatus(M.exported+' — '+(res.body.image_path||''));
      }).catch(function(err){ setStatus(M.exportFailed+': '+(err&&err.message?err.message:String(err))); });
  };
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition, rec=null, recing=false;
  function stopRec(){ recing=false; if(rec){ try{rec.stop();}catch(e){} } if(mic){ mic.classList.remove('rec'); mic.textContent='🎤 '+M.voice; } }
  if(mic){
    mic.onclick=function(){
      if(recing){ stopRec(); setStatus(M.voiceStopped); return; }
      if(!SR){ setStatus(M.voiceUnavailable); return; }
      rec=new SR(); rec.lang=${JSON.stringify(speechLang)}; rec.interimResults=true; rec.continuous=true;
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
