/**
 * drop-page.ts — self-contained doc-drop HTML (no external resources).
 *
 * Drag/drop + file input + optional camera → attachment list → handoff.
 */
import { resolveLocale } from '@agent/core/locale';
import { escHtml, padShellCss } from '../lib/local-artifact-pad.js';

export interface DocDropPageConfig {
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

function messages(lang: 'ja' | 'en') {
  if (lang === 'ja') {
    return {
      title: 'Doc Drop（ローカルのみ）',
      subtitle:
        'PDF・画像・テキストなどをドロップして Kyberion へ Hand off。自動で knowledge には書き込みません。',
      dropZone: 'ここにファイルをドロップ（または選択）',
      accept: 'pdf / 画像 / txt / md / docx',
      attach: 'ファイル選択',
      camera: 'カメラ',
      handoff: 'Hand off',
      clear: 'クリア',
      instruction: 'Kyberionへの指示',
      instructionPlaceholder: '例: この資料をパースして要点を抽出…',
      attachments: '添付',
      noAttachments: '添付なし',
      ready: '準備完了',
      exporting: '書き出し中…',
      exported: '書き出し完了',
      exportFailed: '書き出し失敗',
      attachAdded: '追加',
      clearConfirm: '添付と指示を消しますか？',
      cameraError: 'カメラを開けません',
      outLabel: '出力先',
      snap: '撮影',
    };
  }
  return {
    title: 'Doc Drop (local only)',
    subtitle:
      'Drop PDFs, images, or text files and hand off to Kyberion. No automatic knowledge commit.',
    dropZone: 'Drop files here (or choose)',
    accept: 'pdf / images / txt / md / docx',
    attach: 'Choose files',
    camera: 'Camera',
    handoff: 'Hand off',
    clear: 'Clear',
    instruction: 'Instruction for Kyberion',
    instructionPlaceholder: 'e.g. Parse this pack and extract key points…',
    attachments: 'Attachments',
    noAttachments: 'No attachments',
    ready: 'Ready',
    exporting: 'Exporting…',
    exported: 'Exported',
    exportFailed: 'Export failed',
    attachAdded: 'Added',
    clearConfirm: 'Clear attachments and instruction?',
    cameraError: 'Camera unavailable',
    outLabel: 'Output',
    snap: 'Capture',
  };
}

export function docDropPageHtml(config: DocDropPageConfig): string {
  const lang = resolveLocale() === 'ja' ? 'ja' : 'en';
  const m = messages(lang);
  const instruction = config.defaultInstruction ?? '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(m.title)}</title>
<style>
${padShellCss('#6b4f2e')}
#ddrop-zone{border:2px dashed var(--line);border-radius:12px;padding:28px 16px;text-align:center;background:var(--bg);cursor:pointer}
#ddrop-zone.drag{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 12%, var(--bg))}
#ddrop-cam-wrap{display:none;gap:8px}
#ddrop-cam-wrap.on{display:grid}
#ddrop-cam{width:100%;max-height:220px;background:#000;border-radius:8px}
</style>
</head>
<body>
<header>
  <h1>${escHtml(m.title)}</h1>
  <p>${escHtml(m.subtitle)}</p>
</header>
<div class="bar">
  <label class="btn" for="ddrop-file">${escHtml(m.attach)}</label>
  <input id="ddrop-file" type="file" multiple accept=".pdf,image/*,.txt,.md,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>
  <button type="button" id="ddrop-camera">${escHtml(m.camera)}</button>
  <button type="button" class="primary" id="ddrop-handoff">${escHtml(m.handoff)}</button>
  <button type="button" id="ddrop-clear">${escHtml(m.clear)}</button>
  <span class="status" id="ddrop-status">${escHtml(m.ready)}</span>
</div>
<main>
  <section class="panel">
    <div id="ddrop-zone">
      <div>${escHtml(m.dropZone)}</div>
      <div class="note">${escHtml(m.accept)}</div>
    </div>
    <label class="field" for="ddrop-instruction">${escHtml(m.instruction)}</label>
    <textarea id="ddrop-instruction" placeholder="${escHtml(m.instructionPlaceholder)}">${escHtml(instruction)}</textarea>
    <div class="note">${escHtml(m.outLabel)}: ${escHtml(config.outLabel)}</div>
  </section>
  <section class="panel">
    <div class="field">${escHtml(m.attachments)}</div>
    <ul class="list" id="ddrop-list"><li class="note" id="ddrop-empty">${escHtml(m.noAttachments)}</li></ul>
    <div id="ddrop-cam-wrap">
      <video id="ddrop-cam" autoplay playsinline muted></video>
      <div class="row">
        <button type="button" id="ddrop-snap">${escHtml(m.snap)}</button>
        <button type="button" id="ddrop-cam-close">×</button>
      </div>
    </div>
  </section>
</main>
<script>
(function(){
  var CFG={ exportUrl:${JSON.stringify(config.exportUrl)}, token:${JSON.stringify(config.token)} };
  var M=${JSON.stringify(m)};
  var DRAFT_KEY='doc-drop.draft.v1';
  var instructionEl=document.getElementById('ddrop-instruction');
  var statusEl=document.getElementById('ddrop-status');
  var listEl=document.getElementById('ddrop-list');
  var zone=document.getElementById('ddrop-zone');
  var attachments=[];
  var camStream=null;
  function setStatus(t){ statusEl.textContent=t; }
  function headers(){
    return {
      'Content-Type':'application/json',
      'X-DDROP-Token':CFG.token,
      'X-DOC-Token':CFG.token
    };
  }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        instruction:instructionEl.value||'',
        attachments:attachments.map(function(a){ return {name:a.name,mime:a.mime,data_base64:a.data_base64}; })
      }));
    }catch(e){}
  }
  function render(){
    listEl.innerHTML='';
    if(!attachments.length){
      var empty=document.createElement('li'); empty.className='note'; empty.textContent=M.noAttachments; listEl.appendChild(empty); return;
    }
    attachments.forEach(function(att, idx){
      var li=document.createElement('li');
      var span=document.createElement('span');
      span.textContent=att.name+' ('+Math.round((att.data_base64.length*0.75)/1024)+' KB)';
      li.appendChild(span);
      var rm=document.createElement('button'); rm.type='button'; rm.textContent='×';
      rm.onclick=function(){ attachments.splice(idx,1); render(); saveDraft(); };
      li.appendChild(rm); listEl.appendChild(li);
    });
  }
  function addAttachment(name, mime, dataBase64){
    if(!dataBase64) return;
    if(dataBase64.length > 16*1024*1024){ setStatus(M.exportFailed+': too large'); return; }
    attachments.push({name:name||('attach-'+Date.now()), mime:mime||'application/octet-stream', data_base64:dataBase64});
    render(); saveDraft(); setStatus(M.attachAdded+': '+(name||''));
  }
  function fileToAttachment(file){
    var reader=new FileReader();
    reader.onload=function(){
      var result=String(reader.result||'');
      var comma=result.indexOf(',');
      var meta=comma>=0?result.slice(0,comma):'';
      var b64=comma>=0?result.slice(comma+1):result;
      var mimeMatch=/data:([^;]+)/.exec(meta);
      addAttachment(file.name, (mimeMatch&&mimeMatch[1])||file.type||'application/octet-stream', b64);
    };
    reader.readAsDataURL(file);
  }
  function takeFiles(fileList){
    if(!fileList) return;
    for(var i=0;i<fileList.length;i++) fileToAttachment(fileList[i]);
  }
  instructionEl.addEventListener('input', saveDraft);
  document.getElementById('ddrop-file').onchange=function(e){
    takeFiles(e.target.files); e.target.value='';
  };
  zone.onclick=function(){ document.getElementById('ddrop-file').click(); };
  zone.ondragover=function(e){ e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave=function(){ zone.classList.remove('drag'); };
  zone.ondrop=function(e){
    e.preventDefault(); zone.classList.remove('drag');
    takeFiles(e.dataTransfer && e.dataTransfer.files);
  };
  document.getElementById('ddrop-clear').onclick=function(){
    if(!confirm(M.clearConfirm)) return;
    attachments=[]; instructionEl.value='';
    try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
    render(); setStatus(M.ready);
  };
  document.getElementById('ddrop-handoff').onclick=function(){
    if(!attachments.length){ setStatus(M.exportFailed+': empty'); return; }
    setStatus(M.exporting);
    fetch(CFG.exportUrl,{
      method:'POST',
      headers:headers(),
      body:JSON.stringify({
        instruction:instructionEl.value||'',
        attachments:attachments
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(!res.ok||!res.j.ok){ setStatus(M.exportFailed+(res.j&&res.j.error?(': '+res.j.error):'')); return; }
        saveDraft();
        setStatus(M.exported+(res.j.handoff_path?(': '+res.j.handoff_path):''));
      }).catch(function(e){ setStatus(M.exportFailed+': '+e); });
  };
  document.getElementById('ddrop-camera').onclick=function(){
    var wrap=document.getElementById('ddrop-cam-wrap');
    if(camStream){ wrap.classList.add('on'); return; }
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      setStatus(M.cameraError); return;
    }
    navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(function(stream){
      camStream=stream;
      document.getElementById('ddrop-cam').srcObject=stream;
      wrap.classList.add('on');
    }).catch(function(){ setStatus(M.cameraError); });
  };
  document.getElementById('ddrop-cam-close').onclick=function(){
    var wrap=document.getElementById('ddrop-cam-wrap');
    wrap.classList.remove('on');
    if(camStream){ camStream.getTracks().forEach(function(t){ t.stop(); }); camStream=null; }
  };
  document.getElementById('ddrop-snap').onclick=function(){
    var video=document.getElementById('ddrop-cam');
    var canvas=document.createElement('canvas');
    canvas.width=video.videoWidth||1280; canvas.height=video.videoHeight||720;
    var ctx=canvas.getContext('2d'); if(!ctx) return;
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    var dataUrl=canvas.toDataURL('image/jpeg',0.92);
    var b64=dataUrl.split(',')[1]||'';
    addAttachment('camera-'+Date.now()+'.jpg','image/jpeg',b64);
  };
  try{
    var raw=localStorage.getItem(DRAFT_KEY);
    if(raw){
      var d=JSON.parse(raw);
      if(d.instruction!=null) instructionEl.value=String(d.instruction);
      if(Array.isArray(d.attachments)) attachments=d.attachments.filter(function(a){ return a&&a.data_base64; });
      render();
    }
  }catch(e){}
})();
</script>
</body>
</html>`;
}
