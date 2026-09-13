/**
 * notepad-page.ts — self-contained meeting notepad HTML (no external resources).
 *
 * Notes + voice dictation + continuous MediaRecorder capture + camera/file
 * attachments + create-minutes + Kyberion handoff.
 */
import { resolveLocale } from '@agent/core/locale';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export interface MeetingNotepadPageConfig {
  token: string;
  exportUrl: string;
  minutesUrl: string;
  transcribeUrl: string;
  defaultInstruction?: string;
  defaultTitle?: string;
  outLabel: string;
}

function st(key: VocabularyKey, params?: Record<string, string | number>): string {
  return catalogT(key, params);
}

function messages() {
  return {
    title: st('meeting_notepad:title'),
    subtitle: st('meeting_notepad:subtitle'),
    meetingTitle: st('meeting_notepad:meeting_title'),
    meetingTitlePlaceholder: st('meeting_notepad:meeting_title_placeholder'),
    notes: st('meeting_notepad:notes'),
    notesPlaceholder: st('meeting_notepad:notes_placeholder'),
    transcript: st('meeting_notepad:transcript'),
    transcriptPlaceholder: st('meeting_notepad:transcript_placeholder'),
    instruction: st('meeting_notepad:instruction'),
    instructionPlaceholder: st('meeting_notepad:instruction_placeholder'),
    dictationNote: st('meeting_notepad:dictation_note'),
    voice: st('meeting_notepad:voice'),
    voiceStop: st('meeting_notepad:voice_stop'),
    record: st('meeting_notepad:record'),
    recordStop: st('meeting_notepad:record_stop'),
    camera: st('meeting_notepad:camera'),
    attach: st('meeting_notepad:attach'),
    createMinutes: st('meeting_notepad:create_minutes'),
    handoff: st('meeting_notepad:handoff'),
    clear: st('meeting_notepad:clear'),
    restore: st('meeting_notepad:restore'),
    ready: st('meeting_notepad:ready'),
    exporting: st('meeting_notepad:exporting'),
    exported: st('meeting_notepad:exported'),
    exportFailed: st('meeting_notepad:export_failed'),
    minutesRunning: st('meeting_notepad:minutes_running'),
    minutesDone: st('meeting_notepad:minutes_done'),
    minutesFailed: st('meeting_notepad:minutes_failed'),
    recording: st('meeting_notepad:recording'),
    recordingStopped: st('meeting_notepad:recording_stopped'),
    recordingError: st('meeting_notepad:recording_error'),
    cameraError: st('meeting_notepad:camera_error'),
    attachAdded: st('meeting_notepad:attach_added'),
    clearConfirm: st('meeting_notepad:clear_confirm'),
    outLabel: st('meeting_notepad:out_label'),
    attachments: st('meeting_notepad:attachments'),
    noAttachments: st('meeting_notepad:no_attachments'),
    voiceStarted: st('meeting_notepad:voice_started'),
    voiceStopped: st('meeting_notepad:voice_stopped'),
    voiceError: st('meeting_notepad:voice_error'),
    voiceUnavailable: st('meeting_notepad:voice_unavailable'),
    preview: st('meeting_notepad:preview'),
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

export function meetingNotepadPageHtml(config: MeetingNotepadPageConfig): string {
  const m = messages();
  const instruction = config.defaultInstruction ?? '';
  const title = config.defaultTitle ?? '';
  const lang = resolveLocale() === 'ja' ? 'ja' : 'en';
  const speechLang = lang === 'ja' ? 'ja-JP' : 'en-US';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(m.title)}</title>
<style>
  :root{--bg:#eef2f6;--panel:#fff;--ink:#1a2230;--line:#d5dbe5;--accent:#1f6b5a;--muted:#5c6778;--danger:#a33}
  @media (prefers-color-scheme:dark){:root{--bg:#10151d;--panel:#18202c;--ink:#e8eef6;--line:#2a3545;--accent:#4fb39a;--muted:#9aa6b8;--danger:#e07272}}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;background:var(--bg);color:var(--ink)}
  header{padding:16px 18px 8px}
  header h1{margin:0;font-size:20px;font-weight:650}
  header p{margin:6px 0 0;font-size:13px;color:var(--muted);line-height:1.45;max-width:56rem}
  #mn-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
  #mn-bar button,#mn-bar label.btn{background:#e8eef4;border:1px solid var(--line);color:inherit;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;font-family:inherit}
  @media (prefers-color-scheme:dark){#mn-bar button,#mn-bar label.btn{background:#222c3b}}
  #mn-bar button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  #mn-bar button.rec{background:var(--danger);color:#fff;border-color:var(--danger)}
  #mn-status{font-size:11px;opacity:.8;margin-left:4px}
  main{display:grid;grid-template-columns:1.2fr .8fr;gap:14px;padding:14px 18px 28px}
  @media (max-width:900px){main{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;gap:8px;align-content:start}
  label.field{font-size:12px;color:var(--muted)}
  input[type=text],textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;background:var(--bg);color:inherit}
  textarea{min-height:160px;resize:vertical}
  #mn-transcript{min-height:120px}
  #mn-preview{min-height:140px;white-space:pre-wrap;font-size:13px;line-height:1.45;border:1px dashed var(--line);border-radius:8px;padding:10px;background:var(--bg);max-height:280px;overflow:auto}
  .note{font-size:11px;color:var(--muted);line-height:1.45}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  #mn-attach-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  #mn-attach-list li{display:flex;gap:8px;align-items:center;font-size:12px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--bg)}
  #mn-attach-list img{width:40px;height:40px;object-fit:cover;border-radius:6px;background:#0001}
  #mn-attach-list button{border:0;background:transparent;color:var(--danger);cursor:pointer;font:inherit}
  #mn-cam-wrap{display:none;gap:8px}
  #mn-cam-wrap.on{display:grid}
  #mn-cam{width:100%;max-height:220px;background:#000;border-radius:8px}
  #mn-out{font-size:11px;color:var(--muted)}
  input[type=file]{display:none}
</style>
</head>
<body>
<header>
  <h1>${esc(m.title)}</h1>
  <p>${esc(m.subtitle)}</p>
</header>
<div id="mn-bar">
  <button type="button" id="mn-mic">🎤 ${esc(m.voice)}</button>
  <button type="button" id="mn-record">🎙 ${esc(m.record)}</button>
  <button type="button" id="mn-camera">${esc(m.camera)}</button>
  <label class="btn" for="mn-file">${esc(m.attach)}</label>
  <input id="mn-file" type="file" multiple accept="image/*,.pdf,.txt,.md,.doc,.docx,.png,.jpg,.jpeg,.webp"/>
  <button type="button" class="primary" id="mn-minutes">${esc(m.createMinutes)}</button>
  <button type="button" class="primary" id="mn-handoff">${esc(m.handoff)}</button>
  <button type="button" id="mn-restore">${esc(m.restore)}</button>
  <button type="button" id="mn-clear">${esc(m.clear)}</button>
  <span id="mn-status">${esc(m.ready)}</span>
</div>
<main>
  <section class="panel">
    <label class="field" for="mn-title">${esc(m.meetingTitle)}</label>
    <input id="mn-title" type="text" placeholder="${esc(m.meetingTitlePlaceholder)}" value="${esc(title)}"/>
    <label class="field" for="mn-notes">${esc(m.notes)}</label>
    <textarea id="mn-notes" placeholder="${esc(m.notesPlaceholder)}"></textarea>
    <div class="row">
      <span class="note">${esc(m.dictationNote)}</span>
    </div>
    <label class="field" for="mn-transcript">${esc(m.transcript)}</label>
    <textarea id="mn-transcript" placeholder="${esc(m.transcriptPlaceholder)}"></textarea>
    <label class="field" for="mn-instruction">${esc(m.instruction)}</label>
    <textarea id="mn-instruction" placeholder="${esc(m.instructionPlaceholder)}">${esc(instruction)}</textarea>
    <div id="mn-out">${esc(m.outLabel)}: ${esc(config.outLabel)}</div>
  </section>
  <section class="panel">
    <div class="field">${esc(m.attachments)}</div>
    <ul id="mn-attach-list"><li class="note" id="mn-attach-empty">${esc(m.noAttachments)}</li></ul>
    <div id="mn-cam-wrap">
      <video id="mn-cam" autoplay playsinline muted></video>
      <div class="row">
        <button type="button" id="mn-snap">${esc(m.camera)}</button>
        <button type="button" id="mn-cam-close">×</button>
      </div>
    </div>
    <div class="field">${esc(m.preview)}</div>
    <div id="mn-preview"></div>
  </section>
</main>
<script>
(function(){
  var CFG={
    exportUrl:${JSON.stringify(config.exportUrl)},
    minutesUrl:${JSON.stringify(config.minutesUrl)},
    transcribeUrl:${JSON.stringify(config.transcribeUrl)},
    token:${JSON.stringify(config.token)}
  };
  var M=${JSON.stringify(m)};
  var DRAFT_KEY='meeting-notepad.draft.v1';
  var notesEl=document.getElementById('mn-notes');
  var transcriptEl=document.getElementById('mn-transcript');
  var instructionEl=document.getElementById('mn-instruction');
  var titleEl=document.getElementById('mn-title');
  var statusEl=document.getElementById('mn-status');
  var previewEl=document.getElementById('mn-preview');
  var attachList=document.getElementById('mn-attach-list');
  var attachEmpty=document.getElementById('mn-attach-empty');
  var mic=document.getElementById('mn-mic');
  var recordBtn=document.getElementById('mn-record');
  var attachments=[];
  var mediaRecorder=null, mediaChunks=[], mediaStream=null, recording=false;
  var camStream=null;
  function setStatus(t){ statusEl.textContent=t; }
  function headers(){ return {'Content-Type':'application/json','X-MN-Token':CFG.token}; }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        title:titleEl.value||'',
        notes:notesEl.value||'',
        transcript:transcriptEl.value||'',
        instruction:instructionEl.value||'',
        attachments:attachments.map(function(a){ return {name:a.name,mime:a.mime,data_base64:a.data_base64}; })
      }));
    }catch(e){}
  }
  function renderAttachments(){
    attachList.innerHTML='';
    if(!attachments.length){
      var li=document.createElement('li'); li.className='note'; li.id='mn-attach-empty'; li.textContent=M.noAttachments; attachList.appendChild(li); return;
    }
    attachments.forEach(function(att, idx){
      var li=document.createElement('li');
      if(att.mime && att.mime.indexOf('image/')===0){
        var img=document.createElement('img'); img.src='data:'+att.mime+';base64,'+att.data_base64; li.appendChild(img);
      }
      var span=document.createElement('span'); span.textContent=att.name+' ('+Math.round((att.data_base64.length*0.75)/1024)+' KB)'; li.appendChild(span);
      var rm=document.createElement('button'); rm.type='button'; rm.textContent='×'; rm.onclick=function(){ attachments.splice(idx,1); renderAttachments(); saveDraft(); };
      li.appendChild(rm); attachList.appendChild(li);
    });
  }
  function addAttachment(name, mime, dataBase64){
    if(!dataBase64) return;
    if(dataBase64.length > 8*1024*1024){ setStatus(M.exportFailed+': too large'); return; }
    attachments.push({name:name||('attach-'+Date.now()), mime:mime||'application/octet-stream', data_base64:dataBase64});
    renderAttachments(); saveDraft(); setStatus(M.attachAdded+': '+(name||''));
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
  notesEl.addEventListener('input', saveDraft);
  transcriptEl.addEventListener('input', saveDraft);
  instructionEl.addEventListener('input', saveDraft);
  titleEl.addEventListener('input', saveDraft);
  document.getElementById('mn-file').onchange=function(e){
    var files=e.target.files||[];
    for(var i=0;i<files.length;i++) fileToAttachment(files[i]);
    e.target.value='';
  };
  document.getElementById('mn-restore').onclick=function(){
    try{
      var raw=localStorage.getItem(DRAFT_KEY); if(!raw) return;
      var draft=JSON.parse(raw);
      titleEl.value=draft.title||'';
      notesEl.value=draft.notes||'';
      transcriptEl.value=draft.transcript||'';
      instructionEl.value=draft.instruction||'';
      attachments=Array.isArray(draft.attachments)?draft.attachments:[];
      renderAttachments();
      setStatus(M.ready);
    }catch(e){ setStatus(M.exportFailed+': draft'); }
  };
  document.getElementById('mn-clear').onclick=function(){
    if(!window.confirm(M.clearConfirm)) return;
    titleEl.value=''; notesEl.value=''; transcriptEl.value=''; instructionEl.value=''; attachments=[]; previewEl.textContent='';
    renderAttachments(); localStorage.removeItem(DRAFT_KEY); setStatus(M.ready);
  };
  function sourceText(){
    var parts=[];
    if(notesEl.value.trim()) parts.push('## Notes\\n'+notesEl.value.trim());
    if(transcriptEl.value.trim()) parts.push('## Transcript\\n'+transcriptEl.value.trim());
    return parts.join('\\n\\n');
  }
  function payloadBase(){
    return {
      title:titleEl.value||'',
      notes:notesEl.value||'',
      transcript:transcriptEl.value||'',
      instruction:instructionEl.value||'',
      language:${JSON.stringify(lang)},
      attachments:attachments.map(function(a){ return {name:a.name,mime:a.mime,data_base64:a.data_base64}; })
    };
  }
  document.getElementById('mn-handoff').onclick=function(){
    setStatus(M.exporting);
    fetch(CFG.exportUrl,{method:'POST',headers:headers(),body:JSON.stringify(payloadBase())})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok) throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        setStatus(M.exported+' — '+(res.body.handoff_path||''));
        if(res.body.minutes_preview) previewEl.textContent=res.body.minutes_preview;
      }).catch(function(err){ setStatus(M.exportFailed+': '+(err&&err.message?err.message:String(err))); });
  };
  document.getElementById('mn-minutes').onclick=function(){
    setStatus(M.minutesRunning);
    fetch(CFG.minutesUrl,{method:'POST',headers:headers(),body:JSON.stringify(payloadBase())})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok) throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        previewEl.textContent=res.body.minutes_markdown||'';
        setStatus(M.minutesDone+' — '+(res.body.minutes_path||''));
      }).catch(function(err){ setStatus(M.minutesFailed+': '+(err&&err.message?err.message:String(err))); });
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
        if(text){ notesEl.value=(notesEl.value?notesEl.value+' ':'')+text; saveDraft(); }
      };
      rec.onerror=function(e){ setStatus(M.voiceError+': '+(e.error||'')); stopRec(); };
      try{ rec.start(); recing=true; mic.classList.add('rec'); mic.textContent='⏹ '+M.voiceStop; setStatus(M.voiceStarted); }
      catch(e){ setStatus(M.voiceError+': '+(e.message||e)); stopRec(); }
    };
  }
  function appendTranscript(text){
    if(!text) return;
    transcriptEl.value=(transcriptEl.value?transcriptEl.value+'\\n':'')+text.trim();
    saveDraft();
  }
  function stopRecording(upload){
    recording=false;
    recordBtn.classList.remove('rec');
    recordBtn.textContent='🎙 '+M.record;
    if(mediaRecorder && mediaRecorder.state!=='inactive'){
      try{ mediaRecorder.stop(); }catch(e){}
    } else if(upload===false){
      setStatus(M.recordingStopped);
    }
    if(mediaStream){ mediaStream.getTracks().forEach(function(t){ t.stop(); }); mediaStream=null; }
  }
  recordBtn.onclick=function(){
    if(recording){ stopRecording(true); return; }
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ setStatus(M.recordingError+': unsupported'); return; }
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      mediaStream=stream; mediaChunks=[];
      var mime='';
      if(window.MediaRecorder){
        if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime='audio/webm;codecs=opus';
        else if(MediaRecorder.isTypeSupported('audio/webm')) mime='audio/webm';
        else if(MediaRecorder.isTypeSupported('audio/mp4')) mime='audio/mp4';
      }
      mediaRecorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
      mediaRecorder.ondataavailable=function(ev){ if(ev.data && ev.data.size>0) mediaChunks.push(ev.data); };
      mediaRecorder.onstop=function(){
        var blob=new Blob(mediaChunks,{type:mediaRecorder.mimeType||'audio/webm'});
        var reader=new FileReader();
        reader.onload=function(){
          var result=String(reader.result||'');
          var b64=result.split(',')[1]||'';
          setStatus(M.minutesRunning);
          fetch(CFG.transcribeUrl,{
            method:'POST',headers:headers(),
            body:JSON.stringify({audio_base64:b64,mime:blob.type||'audio/webm',language:${JSON.stringify(lang)}})
          }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,body:j}; }); })
            .then(function(res){
              if(!res.ok) throw new Error((res.body&&res.body.error)||'transcribe failed');
              appendTranscript(res.body.text||'');
              setStatus(M.recordingStopped+(res.body.text?' + STT':''));
            }).catch(function(err){ setStatus(M.recordingError+': '+(err&&err.message?err.message:String(err))); });
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start(5000);
      recording=true; recordBtn.classList.add('rec'); recordBtn.textContent='⏹ '+M.recordStop; setStatus(M.recording);
    }).catch(function(err){ setStatus(M.recordingError+': '+(err&&err.message?err.message:String(err))); });
  };
  var camWrap=document.getElementById('mn-cam-wrap');
  var camVideo=document.getElementById('mn-cam');
  document.getElementById('mn-camera').onclick=function(){
    if(camWrap.classList.contains('on')) return;
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ setStatus(M.cameraError+': unsupported'); return; }
    navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false}).then(function(stream){
      camStream=stream; camVideo.srcObject=stream; camWrap.classList.add('on');
    }).catch(function(){
      return navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(function(stream){
        camStream=stream; camVideo.srcObject=stream; camWrap.classList.add('on');
      });
    }).catch(function(err){ setStatus(M.cameraError+': '+(err&&err.message?err.message:String(err))); });
  };
  document.getElementById('mn-cam-close').onclick=function(){
    camWrap.classList.remove('on');
    if(camStream){ camStream.getTracks().forEach(function(t){ t.stop(); }); camStream=null; }
    camVideo.srcObject=null;
  };
  document.getElementById('mn-snap').onclick=function(){
    try{
      var canvas=document.createElement('canvas');
      canvas.width=camVideo.videoWidth||1280; canvas.height=camVideo.videoHeight||720;
      var ctx=canvas.getContext('2d'); ctx.drawImage(camVideo,0,0,canvas.width,canvas.height);
      var dataUrl=canvas.toDataURL('image/jpeg',0.92);
      var b64=dataUrl.split(',')[1]||'';
      addAttachment('camera-'+Date.now()+'.jpg','image/jpeg',b64);
    }catch(err){ setStatus(M.cameraError+': '+(err&&err.message?err.message:String(err))); }
  };
  try{
    var existing=localStorage.getItem(DRAFT_KEY);
    if(existing){
      var d=JSON.parse(existing);
      if(d && (d.notes||d.transcript||d.instruction||(d.attachments&&d.attachments.length))){
        titleEl.value=d.title||titleEl.value;
        notesEl.value=d.notes||'';
        transcriptEl.value=d.transcript||'';
        instructionEl.value=d.instruction||instructionEl.value;
        attachments=Array.isArray(d.attachments)?d.attachments:[];
        renderAttachments();
      }
    }
  }catch(e){}
})();
</script>
</body>
</html>`;
}
