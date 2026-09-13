/**
 * page.ts — clipboard-inbox pad: park pasted clips, pull OS clipboard when available.
 * Bilingual via resolveLocale() maps (vocabulary can be added later).
 */
import { resolveLocale } from '@agent/core/locale';
import { escHtml, padShellCss } from '../lib/local-artifact-pad.js';

export interface ClipboardInboxPageConfig {
  token: string;
  exportUrl: string;
  clipboardReadUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

function messages() {
  const ja = resolveLocale() === 'ja';
  return {
    title: ja ? 'クリップボード受信箱' : 'Clipboard Inbox',
    subtitle: ja
      ? '一時的にクリップを溜めてから Kyberion に渡します（秘密情報に注意）。'
      : 'Park clipboard snippets, then hand them to Kyberion (watch for secrets).',
    items: ja ? 'アイテム' : 'Items',
    empty: ja ? 'まだアイテムがありません' : 'No items yet',
    newItem: ja ? '新規テキスト' : 'New text',
    newPlaceholder: ja ? 'ここに貼り付け…' : 'Paste here…',
    label: ja ? 'ラベル（任意）' : 'Label (optional)',
    labelPlaceholder: ja ? '例: URL / メモ' : 'e.g. URL / note',
    add: ja ? '追加' : 'Add',
    pull: ja ? 'クリップボード取得' : 'Pull clipboard',
    delete: ja ? '削除' : 'Delete',
    instruction: ja ? 'Kyberion への指示' : 'Instruction for Kyberion',
    instructionPlaceholder: ja ? 'これらのクリップをどう処理するか' : 'How to process these clips',
    handoff: ja ? 'Kyberionへ渡す' : 'Hand off',
    clearAll: ja ? '全消去' : 'Clear all',
    ready: ja ? '準備完了' : 'Ready',
    exporting: ja ? '書き出し中…' : 'Exporting…',
    exported: ja ? '書き出し完了' : 'Exported',
    exportFailed: ja ? '書き出し失敗' : 'Export failed',
    added: ja ? '追加しました' : 'Added',
    pulled: ja ? '取得しました' : 'Pulled',
    pullFail: ja ? '取得不可 — 手動で貼り付けてください' : 'Pull unavailable — paste manually',
    needItems: ja ? 'アイテムを追加してください' : 'Add at least one item',
    clearConfirm: ja ? 'すべてのアイテムを消しますか？' : 'Clear all items?',
    outLabel: ja ? '出力先' : 'Output',
    redactHint: ja
      ? 'パスワードやトークンは渡す前に削除してください。'
      : 'Remove passwords/tokens before handoff.',
  };
}

export function clipboardInboxPageHtml(config: ClipboardInboxPageConfig): string {
  const m = messages();
  const instruction = config.defaultInstruction ?? '';
  const lang = resolveLocale() === 'ja' ? 'ja' : 'en';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(m.title)}</title>
<style>${padShellCss('#6b4f8a')}
  main{grid-template-columns:1.1fr .9fr}
  @media (max-width:900px){main{grid-template-columns:1fr}}
  .preview{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;flex:1}
  .list li .meta{font-size:10px;color:var(--muted);margin-bottom:4px}
  #ci-new{min-height:100px}
</style>
</head>
<body>
<header>
  <h1>${escHtml(m.title)}</h1>
  <p>${escHtml(m.subtitle)}</p>
</header>
<div class="bar">
  <button type="button" id="ci-pull">${escHtml(m.pull)}</button>
  <button type="button" id="ci-add">${escHtml(m.add)}</button>
  <button type="button" class="primary" id="ci-handoff">${escHtml(m.handoff)}</button>
  <button type="button" class="danger" id="ci-clear">${escHtml(m.clearAll)}</button>
  <span class="status" id="ci-status">${escHtml(m.ready)}</span>
</div>
<main>
  <section class="panel">
    <label class="field">${escHtml(m.items)}</label>
    <ul class="list" id="ci-list"></ul>
    <p class="note" id="ci-empty">${escHtml(m.empty)}</p>
  </section>
  <section class="panel">
    <label class="field" for="ci-new">${escHtml(m.newItem)}</label>
    <textarea id="ci-new" placeholder="${escHtml(m.newPlaceholder)}"></textarea>
    <label class="field" for="ci-label">${escHtml(m.label)}</label>
    <input id="ci-label" type="text" placeholder="${escHtml(m.labelPlaceholder)}"/>
    <label class="field" for="ci-instruction">${escHtml(m.instruction)}</label>
    <textarea id="ci-instruction" placeholder="${escHtml(m.instructionPlaceholder)}">${escHtml(instruction)}</textarea>
    <p class="note">${escHtml(m.redactHint)}</p>
    <div class="note">${escHtml(m.outLabel)}: ${escHtml(config.outLabel)}</div>
  </section>
</main>
<script>
(function(){
  var CFG={url:${JSON.stringify(config.exportUrl)},clip:${JSON.stringify(config.clipboardReadUrl)},token:${JSON.stringify(config.token)}};
  var M=${JSON.stringify(m)};
  var items=[];
  var listEl=document.getElementById('ci-list');
  var emptyEl=document.getElementById('ci-empty');
  var newEl=document.getElementById('ci-new');
  var labelEl=document.getElementById('ci-label');
  var instructionEl=document.getElementById('ci-instruction');
  var statusEl=document.getElementById('ci-status');
  function setStatus(t){ statusEl.textContent=t; }
  function trunc(s){
    var t=String(s||'');
    return t.length>120?t.slice(0,120)+'…':t;
  }
  function render(){
    listEl.innerHTML='';
    emptyEl.style.display=items.length? 'none':'block';
    items.forEach(function(it, idx){
      var li=document.createElement('li');
      var body=document.createElement('div');
      body.style.flex='1';
      var meta=document.createElement('div');
      meta.className='meta';
      meta.textContent=(it.label?it.label+' · ':'')+'#'+(idx+1)+' · '+it.text.length+' chars';
      var preview=document.createElement('div');
      preview.className='preview';
      preview.textContent=trunc(it.text);
      body.appendChild(meta); body.appendChild(preview);
      var del=document.createElement('button');
      del.type='button'; del.textContent=M.delete;
      del.onclick=function(){ items.splice(idx,1); render(); };
      li.appendChild(body); li.appendChild(del);
      listEl.appendChild(li);
    });
  }
  function addItem(text, label){
    var t=String(text||'').trim();
    if(!t) return false;
    items.push({id:String(Date.now())+'-'+Math.random().toString(16).slice(2), text:t, label:String(label||'').trim()});
    return true;
  }
  document.getElementById('ci-add').onclick=function(){
    if(addItem(newEl.value, labelEl.value)){
      newEl.value=''; labelEl.value='';
      render(); setStatus(M.added);
    }
  };
  document.getElementById('ci-pull').onclick=function(){
    fetch(CFG.clip,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-CI-Token':CFG.token},
      body:'{}'
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok||!res.body||!res.body.ok){
          throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        }
        if(addItem(res.body.text||'', res.body.label||'clipboard')){
          render(); setStatus(M.pulled);
        } else {
          setStatus(M.pullFail);
        }
      }).catch(function(err){ setStatus(M.pullFail+': '+(err&&err.message?err.message:String(err))); });
  };
  document.getElementById('ci-clear').onclick=function(){
    if(!window.confirm(M.clearConfirm)) return;
    items=[]; render(); setStatus(M.ready);
  };
  document.getElementById('ci-handoff').onclick=function(){
    if(!items.length){ setStatus(M.needItems); return; }
    setStatus(M.exporting);
    fetch(CFG.url,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-CI-Token':CFG.token},
      body:JSON.stringify({
        items:items.map(function(it){ return {id:it.id, text:it.text, label:it.label}; }),
        instruction:instructionEl.value||''
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok||!res.body||!res.body.ok) throw new Error((res.body&&res.body.error)||('HTTP '+res.status));
        setStatus(M.exported+' — '+(res.body.session_dir||''));
      }).catch(function(err){ setStatus(M.exportFailed+': '+(err&&err.message?err.message:String(err))); });
  };
  render();
})();
</script>
</body>
</html>`;
}
