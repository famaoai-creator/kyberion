/**
 * page.ts — self-contained memory-capture pad HTML (no external resources).
 *
 * Bilingual UI strings via resolveLocale() maps (vocabulary keys can be added later).
 */
import { resolveLocale } from '@agent/core/locale';
import { escHtml, padShellCss } from '../lib/local-artifact-pad.js';

export interface MemoryCapturePageConfig {
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

function messages() {
  const ja = resolveLocale() === 'ja';
  return {
    title: ja ? 'メモリキャプチャ' : 'Memory Capture',
    subtitle: ja
      ? '思いつき・メモを書き留めて Kyberion に渡します（MVP では mission 自動起動なし）。'
      : 'Brain-dump notes and hand them to Kyberion (no auto mission start in MVP).',
    notes: ja ? 'メモ' : 'Notes',
    notesPlaceholder: ja ? '自由に書き出す…' : 'Dump thoughts here…',
    tags: ja ? 'タグ（カンマ区切り）' : 'Tags (comma-separated)',
    tagsPlaceholder: ja ? 'idea, follow-up' : 'idea, follow-up',
    target: ja ? '宛先' : 'Target',
    targetMemory: ja ? 'メモリ' : 'memory',
    targetNow: ja ? 'いま' : 'now',
    targetTodo: ja ? 'TODO' : 'todo',
    instruction: ja ? 'Kyberion への指示' : 'Instruction for Kyberion',
    instructionPlaceholder: ja
      ? 'このメモをどう処理するか（任意）'
      : 'How to process these notes (optional)',
    voice: ja ? '音声入力' : 'Voice',
    voiceStop: ja ? '停止' : 'Stop',
    handoff: ja ? 'Kyberionへ渡す' : 'Hand off',
    restore: ja ? '下書き復元' : 'Restore draft',
    clear: ja ? '下書き消去' : 'Clear draft',
    ready: ja ? '準備完了' : 'Ready',
    exporting: ja ? '書き出し中…' : 'Exporting…',
    exported: ja ? '書き出し完了' : 'Exported',
    exportFailed: ja ? '書き出し失敗' : 'Export failed',
    clearConfirm: ja ? '下書きを消しますか？' : 'Clear the local draft?',
    outLabel: ja ? '出力先' : 'Output',
    voiceStarted: ja ? '音声入力開始' : 'Voice started',
    voiceStopped: ja ? '音声入力停止' : 'Voice stopped',
    voiceError: ja ? '音声エラー' : 'Voice error',
    voiceUnavailable: ja
      ? 'このブラウザでは音声認識が使えません'
      : 'Speech recognition unavailable',
    dictationNote: ja
      ? '機微な内容は OS ディクテーションを推奨（🎤はクラウド送信の可能性あり）。'
      : 'Prefer OS dictation for sensitive content (browser speech may leave the device).',
    draftSaved: ja ? '下書きを保存しました' : 'Draft saved',
    draftRestored: ja ? '下書きを復元しました' : 'Draft restored',
    draftCleared: ja ? '下書きを消去しました' : 'Draft cleared',
  };
}

export function memoryCapturePageHtml(config: MemoryCapturePageConfig): string {
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
<style>${padShellCss('#3d6b8a')}
  main{grid-template-columns:1.2fr .8fr}
  @media (max-width:900px){main{grid-template-columns:1fr}}
  #mc-notes{min-height:220px}
</style>
</head>
<body>
<header>
  <h1>${escHtml(m.title)}</h1>
  <p>${escHtml(m.subtitle)}</p>
</header>
<div class="bar">
  <button type="button" id="mc-mic">🎤 ${escHtml(m.voice)}</button>
  <button type="button" class="primary" id="mc-handoff">${escHtml(m.handoff)}</button>
  <button type="button" id="mc-restore">${escHtml(m.restore)}</button>
  <button type="button" id="mc-clear">${escHtml(m.clear)}</button>
  <span class="status" id="mc-status">${escHtml(m.ready)}</span>
</div>
<main>
  <section class="panel">
    <label class="field" for="mc-notes">${escHtml(m.notes)}</label>
    <textarea id="mc-notes" placeholder="${escHtml(m.notesPlaceholder)}"></textarea>
    <label class="field" for="mc-tags">${escHtml(m.tags)}</label>
    <input id="mc-tags" type="text" placeholder="${escHtml(m.tagsPlaceholder)}"/>
    <label class="field" for="mc-target">${escHtml(m.target)}</label>
    <select id="mc-target">
      <option value="memory">${escHtml(m.targetMemory)}</option>
      <option value="now">${escHtml(m.targetNow)}</option>
      <option value="todo">${escHtml(m.targetTodo)}</option>
    </select>
  </section>
  <section class="panel">
    <label class="field" for="mc-instruction">${escHtml(m.instruction)}</label>
    <textarea id="mc-instruction" placeholder="${escHtml(m.instructionPlaceholder)}">${escHtml(instruction)}</textarea>
    <p class="note">${escHtml(m.dictationNote)}</p>
    <div class="note" id="mc-out">${escHtml(m.outLabel)}: ${escHtml(config.outLabel)}</div>
  </section>
</main>
<script>
(function(){
  var CFG={url:${JSON.stringify(config.exportUrl)},token:${JSON.stringify(config.token)}};
  var M=${JSON.stringify(m)};
  var DRAFT_KEY='memory-capture.draft.v1';
  var notesEl=document.getElementById('mc-notes');
  var tagsEl=document.getElementById('mc-tags');
  var targetEl=document.getElementById('mc-target');
  var instructionEl=document.getElementById('mc-instruction');
  var statusEl=document.getElementById('mc-status');
  var mic=document.getElementById('mc-mic');
  function setStatus(t){ statusEl.textContent=t; }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        notes:notesEl.value||'',
        tags:tagsEl.value||'',
        target:targetEl.value||'memory',
        instruction:instructionEl.value||''
      }));
    }catch(e){}
  }
  function loadDraft(){
    try{
      var raw=localStorage.getItem(DRAFT_KEY);
      if(!raw) return false;
      var d=JSON.parse(raw);
      notesEl.value=d.notes||'';
      tagsEl.value=d.tags||'';
      if(d.target) targetEl.value=d.target;
      if(typeof d.instruction==='string') instructionEl.value=d.instruction;
      return true;
    }catch(e){ return false; }
  }
  ['input','change'].forEach(function(ev){
    notesEl.addEventListener(ev, saveDraft);
    tagsEl.addEventListener(ev, saveDraft);
    targetEl.addEventListener(ev, saveDraft);
    instructionEl.addEventListener(ev, saveDraft);
  });
  loadDraft();
  document.getElementById('mc-restore').onclick=function(){
    if(loadDraft()) setStatus(M.draftRestored); else setStatus(M.ready);
  };
  document.getElementById('mc-clear').onclick=function(){
    if(!window.confirm(M.clearConfirm)) return;
    try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
    notesEl.value=''; tagsEl.value=''; targetEl.value='memory';
    setStatus(M.draftCleared);
  };
  document.getElementById('mc-handoff').onclick=function(){
    setStatus(M.exporting);
    var tags=(tagsEl.value||'').split(/[,\\n]+/).map(function(s){return s.trim();}).filter(Boolean);
    fetch(CFG.url,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-MC-Token':CFG.token},
      body:JSON.stringify({
        notes:notesEl.value||'',
        tags:tags,
        target:targetEl.value||'memory',
        instruction:instructionEl.value||''
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok||!res.body||!res.body.ok) throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        setStatus(M.exported+' — '+(res.body.session_dir||''));
        saveDraft();
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
        if(text){ notesEl.value=(notesEl.value?notesEl.value+' ':'')+text; saveDraft(); }
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
