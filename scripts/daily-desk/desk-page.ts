/**
 * desk-page.ts — self-contained daily desk HTML (no external resources).
 *
 * Three panels (journal / TODO / NOW) + instruction + local draft + handoff.
 */
import { resolveLocale } from '@agent/core/locale';
import { escHtml, padShellCss } from '../lib/local-artifact-pad.js';

export interface DailyDeskPageConfig {
  token: string;
  exportUrl: string;
  loadUrl: string;
  defaultInstruction?: string;
  outLabel: string;
  journal: string;
  todo: string;
  now: string;
  faceNote: string;
  facePaths: {
    journal: string | null;
    todo: string | null;
    now: string | null;
  };
}

function messages(lang: 'ja' | 'en') {
  if (lang === 'ja') {
    return {
      title: 'Daily Desk（ローカルのみ）',
      subtitle:
        '今日の Journal / TODO / NOW を編集し、下書き保存または Kyberion へ Hand off します。作業メモリ面が見つかれば初期表示に使います。',
      journal: 'Journal',
      todo: 'TODO',
      now: 'NOW',
      instruction: 'Kyberionへの指示',
      instructionPlaceholder: '例: 今日のフォーカスを整理して…',
      handoff: 'Hand off',
      saveDraft: '下書き保存',
      loadDisk: 'ディスクから再読込',
      clear: 'クリア',
      ready: '準備完了',
      exporting: '書き出し中…',
      exported: '書き出し完了',
      exportFailed: '書き出し失敗',
      loading: '読込中…',
      loaded: '読込完了',
      loadFailed: '読込失敗',
      clearConfirm: '下書きと入力内容を消しますか？',
      outLabel: '出力先',
      faces: '作業メモリ面',
    };
  }
  return {
    title: 'Daily Desk (local only)',
    subtitle:
      'Edit today’s Journal / TODO / NOW, save a local draft, or hand off to Kyberion. Working-memory faces seed the panels when found.',
    journal: 'Journal',
    todo: 'TODO',
    now: 'NOW',
    instruction: 'Instruction for Kyberion',
    instructionPlaceholder: 'e.g. Organize today’s focus…',
    handoff: 'Hand off',
    saveDraft: 'Save draft',
    loadDisk: 'Reload from disk',
    clear: 'Clear',
    ready: 'Ready',
    exporting: 'Exporting…',
    exported: 'Exported',
    exportFailed: 'Export failed',
    loading: 'Loading…',
    loaded: 'Loaded',
    loadFailed: 'Load failed',
    clearConfirm: 'Clear draft and panel contents?',
    outLabel: 'Output',
    faces: 'Working-memory faces',
  };
}

export function dailyDeskPageHtml(config: DailyDeskPageConfig): string {
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
${padShellCss('#3a5f8a')}
main{grid-template-columns:1fr 1fr 1fr}
@media (max-width:1100px){main{grid-template-columns:1fr}}
textarea.face{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.45}
#dd-instruction{min-height:90px}
.face-meta{font-size:11px;color:var(--muted);word-break:break-all}
</style>
</head>
<body>
<header>
  <h1>${escHtml(m.title)}</h1>
  <p>${escHtml(m.subtitle)}</p>
  <p class="note">${escHtml(config.faceNote)}</p>
</header>
<div class="bar">
  <button type="button" class="primary" id="dd-handoff">${escHtml(m.handoff)}</button>
  <button type="button" id="dd-draft">${escHtml(m.saveDraft)}</button>
  <button type="button" id="dd-load">${escHtml(m.loadDisk)}</button>
  <button type="button" id="dd-clear">${escHtml(m.clear)}</button>
  <span class="status" id="dd-status">${escHtml(m.ready)}</span>
</div>
<main>
  <section class="panel">
    <label class="field" for="dd-journal">${escHtml(m.journal)}</label>
    <div class="face-meta">${escHtml(m.faces)}: ${escHtml(config.facePaths.journal || '—')}</div>
    <textarea class="face" id="dd-journal">${escHtml(config.journal)}</textarea>
  </section>
  <section class="panel">
    <label class="field" for="dd-todo">${escHtml(m.todo)}</label>
    <div class="face-meta">${escHtml(m.faces)}: ${escHtml(config.facePaths.todo || '—')}</div>
    <textarea class="face" id="dd-todo">${escHtml(config.todo)}</textarea>
  </section>
  <section class="panel">
    <label class="field" for="dd-now">${escHtml(m.now)}</label>
    <div class="face-meta">${escHtml(m.faces)}: ${escHtml(config.facePaths.now || '—')}</div>
    <textarea class="face" id="dd-now">${escHtml(config.now)}</textarea>
  </section>
  <section class="panel" style="grid-column:1/-1">
    <label class="field" for="dd-instruction">${escHtml(m.instruction)}</label>
    <textarea id="dd-instruction" placeholder="${escHtml(m.instructionPlaceholder)}">${escHtml(instruction)}</textarea>
    <div class="note">${escHtml(m.outLabel)}: ${escHtml(config.outLabel)}</div>
  </section>
</main>
<script>
(function(){
  var CFG={
    exportUrl:${JSON.stringify(config.exportUrl)},
    loadUrl:${JSON.stringify(config.loadUrl)},
    token:${JSON.stringify(config.token)}
  };
  var M=${JSON.stringify(m)};
  var DRAFT_KEY='daily-desk.draft.v1';
  var journalEl=document.getElementById('dd-journal');
  var todoEl=document.getElementById('dd-todo');
  var nowEl=document.getElementById('dd-now');
  var instructionEl=document.getElementById('dd-instruction');
  var statusEl=document.getElementById('dd-status');
  function setStatus(t){ statusEl.textContent=t; }
  function headers(){ return {'Content-Type':'application/json','X-DD-Token':CFG.token}; }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        journal:journalEl.value||'',
        todo:todoEl.value||'',
        now:nowEl.value||'',
        instruction:instructionEl.value||''
      }));
    }catch(e){}
  }
  function loadDraft(){
    try{
      var raw=localStorage.getItem(DRAFT_KEY);
      if(!raw) return false;
      var d=JSON.parse(raw);
      if(d.journal!=null) journalEl.value=String(d.journal);
      if(d.todo!=null) todoEl.value=String(d.todo);
      if(d.now!=null) nowEl.value=String(d.now);
      if(d.instruction!=null) instructionEl.value=String(d.instruction);
      return true;
    }catch(e){ return false; }
  }
  journalEl.addEventListener('input', saveDraft);
  todoEl.addEventListener('input', saveDraft);
  nowEl.addEventListener('input', saveDraft);
  instructionEl.addEventListener('input', saveDraft);
  document.getElementById('dd-draft').onclick=function(){ saveDraft(); setStatus(M.ready+': draft'); };
  document.getElementById('dd-clear').onclick=function(){
    if(!confirm(M.clearConfirm)) return;
    journalEl.value=''; todoEl.value=''; nowEl.value=''; instructionEl.value='';
    try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
    setStatus(M.ready);
  };
  document.getElementById('dd-handoff').onclick=function(){
    setStatus(M.exporting);
    fetch(CFG.exportUrl,{
      method:'POST',
      headers:headers(),
      body:JSON.stringify({
        journal:journalEl.value||'',
        todo:todoEl.value||'',
        now:nowEl.value||'',
        instruction:instructionEl.value||''
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(!res.ok||!res.j.ok){ setStatus(M.exportFailed+(res.j&&res.j.error?(': '+res.j.error):'')); return; }
        saveDraft();
        setStatus(M.exported+(res.j.handoff_path?(': '+res.j.handoff_path):''));
      }).catch(function(e){ setStatus(M.exportFailed+': '+e); });
  };
  document.getElementById('dd-load').onclick=function(){
    setStatus(M.loading);
    fetch(CFG.loadUrl,{
      method:'POST',
      headers:headers(),
      body:JSON.stringify({})
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(!res.ok||!res.j.ok){ setStatus(M.loadFailed+(res.j&&res.j.error?(': '+res.j.error):'')); return; }
        if(res.j.journal!=null) journalEl.value=String(res.j.journal);
        if(res.j.todo!=null) todoEl.value=String(res.j.todo);
        if(res.j.now!=null) nowEl.value=String(res.j.now);
        saveDraft();
        setStatus(M.loaded);
      }).catch(function(e){ setStatus(M.loadFailed+': '+e); });
  };
  loadDraft();
})();
</script>
</body>
</html>`;
}
