/**
 * review-layer.ts — 任意のHTMLレポートに後付けする「推敲・修正・音声・保存」レイヤ（正本）
 *
 * このモジュールが単一の正本。server.ts（配信時注入）と stamp.ts（ファイル焼き込み）が共用する。
 * 生成物はすべてインライン（外部リソース読込なし＝CSP/機密運用に安全）。
 *
 * 機能:
 *  - ✏️ 編集       : 本文を contenteditable で直接書換（localStorage 自動保存）
 *  - 💬 コメント     : 選択テキストに注釈（テキストエリア入力 / OSディクテーション / 🎤Web Speech）
 *  - 🗂 一覧        : コメント一覧
 *  - ↺ 復元        : localStorage の前回編集を手動反映（起動時自動復元はしない＝ファイル更新の上書き事故防止）
 *  - ⤓ HTML書出し  : 編集後HTMLをダウンロード（方式A）
 *  - ⤓ コメントMD  : コメントを Markdown で書出し
 *  - 💾 保存(直書き) : サーバ経由でファイルへ直書き（window.__RV_SAVE__ がある時のみ表示＝方式B）
 *  - 🗑 破棄        : localStorage の破棄
 *
 * マーカー: レイヤ全体を <!--RV-LAYER-->…<!--/RV-LAYER--> で囲む。server.ts は保存時にこの範囲を除去し、
 * 正本HTMLにレイヤが焼き込まれない（配信時オーバーレイ）ようにする。
 */

import { resolveLocale } from '@agent/core/locale';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export const RV_LAYER_OPEN = '<!--RV-LAYER-->';
export const RV_LAYER_CLOSE = '<!--/RV-LAYER-->';

/** 本文とみなす要素のCSSセレクタ（既定は .wrap → 無ければ body）。レポート側で変えたい場合に指定。 */
export interface ReviewLayerOptions {
  contentSelector?: string;
}

function rt(key: VocabularyKey, params?: Record<string, string | number>): string {
  return catalogT(key, params);
}

function reviewMessages() {
  return {
    barTitle: rt('report_review:bar_title'),
    edit: rt('report_review:edit'),
    comment: rt('report_review:comment'),
    list: rt('report_review:list'),
    restore: rt('report_review:restore'),
    exportHtml: rt('report_review:export_html'),
    exportMd: rt('report_review:export_md'),
    save: rt('report_review:save'),
    discard: rt('report_review:discard'),
    commentsTitle: rt('report_review:comments_title'),
    notePlaceholder: rt('report_review:note_placeholder'),
    cancel: rt('report_review:cancel'),
    register: rt('report_review:register'),
    dictationNote: rt('report_review:dictation_note'),
    voice: rt('report_review:voice'),
    voiceStop: rt('report_review:voice_stop'),
    reviewAvailable: rt('report_review:review_available'),
    previousEdit: rt('report_review:previous_edit'),
    saved: rt('report_review:saved'),
    saveFailed: rt('report_review:save_failed'),
    editOn: rt('report_review:edit_on'),
    editOff: rt('report_review:edit_off'),
    commentOn: rt('report_review:comment_on'),
    commentOff: rt('report_review:comment_off'),
    voiceStopped: rt('report_review:voice_stopped'),
    voiceError: rt('report_review:voice_error'),
    voiceStarted: rt('report_review:voice_started'),
    voiceStartFailed: rt('report_review:voice_start_failed'),
    noComments: rt('report_review:no_comments'),
    noRestore: rt('report_review:no_restore'),
    restoreConfirm: rt('report_review:restore_confirm'),
    restored: rt('report_review:restored'),
    htmlExported: rt('report_review:html_exported'),
    mdEmpty: rt('report_review:md_empty'),
    mdExported: rt('report_review:md_exported'),
    discardConfirm: rt('report_review:discard_confirm'),
    discarded: rt('report_review:discarded'),
    saving: rt('report_review:saving'),
    savedToFile: rt('report_review:saved_to_file'),
    markdownTitle: rt('report_review:markdown_title'),
    generated: rt('report_review:generated'),
    target: rt('report_review:target'),
    commentLabel: rt('report_review:comment_label'),
    dateLocale: resolveLocale() === 'ja' ? 'ja-JP' : 'en-US',
  };
}

export function reviewLayerMarkup(opts: ReviewLayerOptions = {}): string {
  const sel = opts.contentSelector || '.wrap';
  const m = reviewMessages();
  // 注意: 以下はブラウザで動くJS。TS側の型は付けない（テンプレート文字列）。
  return `${RV_LAYER_OPEN}
<style>
  #rv-bar{position:fixed;top:10px;left:14px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;z-index:2147483000;
    background:#fff;color:#1a1f29;border:1px solid #d7dbe4;border-radius:10px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.15);
    font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif}
  @media (prefers-color-scheme:dark){#rv-bar{background:#161d2b;color:#e7ecf3;border-color:#26303f}}
  #rv-bar button{background:#eef1f6;border:1px solid #d7dbe4;color:inherit;border-radius:7px;padding:5px 9px;font-size:12px;cursor:pointer;font-family:inherit}
  @media (prefers-color-scheme:dark){#rv-bar button{background:#1c2636;border-color:#26303f}}
  #rv-bar button.on{background:#2f5c9e;color:#fff;border-color:#2f5c9e}
  #rv-bar .rv-status{font-size:11px;opacity:.7;margin-left:2px;max-width:230px}
  body.rv-editing ${sel}{outline:2px dashed #2f5c9e;outline-offset:6px}
  mark.rv-cmt{background:rgba(216,187,82,.45);border-bottom:2px solid #b8860b;cursor:help;border-radius:2px}
  #rv-comments{position:fixed;right:14px;bottom:14px;width:340px;max-width:88vw;max-height:46vh;overflow:auto;z-index:2147483000;
    background:#fff;color:#1a1f29;border:1px solid #d7dbe4;border-radius:10px;padding:10px 12px;font-size:12.5px;box-shadow:0 2px 10px rgba(0,0,0,.18);display:none}
  @media (prefers-color-scheme:dark){#rv-comments{background:#161d2b;color:#e7ecf3;border-color:#26303f}}
  #rv-comments.show{display:block}
  #rv-comments h4{margin:0 0 6px;font-size:12px}
  #rv-comments .c{border-top:1px solid #d7dbe4;padding:6px 0}
  #rv-comments q{opacity:.65}
  #rv-pop{position:fixed;z-index:2147483001;width:320px;max-width:90vw;background:#fff;color:#1a1f29;border:1px solid #2f5c9e;
    border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.3);display:none}
  @media (prefers-color-scheme:dark){#rv-pop{background:#161d2b;color:#e7ecf3}}
  #rv-pop.show{display:block}
  #rv-pop textarea{width:100%;min-height:66px;resize:vertical;font-family:inherit;font-size:13px;box-sizing:border-box;
    border:1px solid #d7dbe4;border-radius:7px;padding:6px 8px;background:transparent;color:inherit}
  #rv-pop .row{display:flex;gap:6px;align-items:center;margin-top:7px}
  #rv-pop .sp{flex:1}
  #rv-pop button{border:1px solid #d7dbe4;background:#eef1f6;color:#1a1f29;border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit}
  @media (prefers-color-scheme:dark){#rv-pop button{background:#1c2636;color:#e7ecf3;border-color:#26303f}}
  #rv-pop button.primary{background:#2f5c9e;color:#fff;border-color:#2f5c9e}
  #rv-pop button.rec{background:#fdeaef;color:#b3123b;border-color:#b3123b}
  #rv-pop .note{font-size:10.5px;opacity:.7;margin-top:6px;line-height:1.45}
  @media print{#rv-bar,#rv-comments,#rv-pop{display:none!important}body.rv-editing ${sel}{outline:none}}
</style>
<div id="rv-bar" title=${JSON.stringify(m.barTitle)}>
  <button id="rv-edit">✏️ ${escHtml(m.edit)}</button>
  <button id="rv-comment">💬 ${escHtml(m.comment)}</button>
  <button id="rv-list">🗂 ${escHtml(m.list)}</button>
  <button id="rv-restore">↺ ${escHtml(m.restore)}</button>
  <button id="rv-html">⤓ ${escHtml(m.exportHtml)}</button>
  <button id="rv-md">⤓ ${escHtml(m.exportMd)}</button>
  <button id="rv-save" style="display:none">💾 ${escHtml(m.save)}</button>
  <button id="rv-discard">🗑 ${escHtml(m.discard)}</button>
  <span class="rv-status" id="rv-status"></span>
</div>
<div id="rv-comments"><h4>${escHtml(m.commentsTitle)}</h4><div id="rv-clist"></div></div>
<div id="rv-pop">
  <textarea id="rv-note" placeholder=${JSON.stringify(m.notePlaceholder)}></textarea>
  <div class="row">
    <button id="rv-mic" type="button">🎤 ${escHtml(m.voice)}</button>
    <span class="sp"></span>
    <button id="rv-pop-cancel" type="button">${escHtml(m.cancel)}</button>
    <button id="rv-pop-ok" class="primary" type="button">${escHtml(m.register)}</button>
  </div>
  <div class="note">${escHtml(m.dictationNote)}</div>
</div>
<script>
(function(){
  var M=${JSON.stringify(m)};
  function msg(name, values){ return (M[name]||name).replace(/\{(\w+)\}/g,function(_,key){ return values&&values[key]!==undefined?values[key]:''; }); }
  var content=document.querySelector(${JSON.stringify(sel)})||document.body;
  var KEY='rvedit:'+location.pathname;
  var status=document.getElementById('rv-status'), panel=document.getElementById('rv-comments');
  var editing=false, commenting=false;
  function now(){return new Date().toLocaleString(M.dateLocale);}
  function set(t){if(status)status.textContent=t;}
  function esc(s){return (s||'').replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];});}
  function slug(){return (document.title||'report').replace(/[^\\w.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'report';}
  function stamp(){var d=new Date(),p=function(n){return(''+n).padStart(2,'0');};return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes());}
  function save(){try{localStorage.setItem(KEY,content.innerHTML);set(msg('saved',{time:now()}));}catch(e){set(msg('saveFailed',{error:e.message}));}}
  function dl(text,mime,name){var b=new Blob([text],{type:mime});var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove();},1500);}
  try{ set(localStorage.getItem(KEY)?M.previousEdit:M.reviewAvailable); }catch(e){ set(M.reviewAvailable); }
  content.addEventListener('input',function(){ if(editing) save(); });
  document.getElementById('rv-edit').onclick=function(){ editing=!editing; content.contentEditable=editing; document.body.classList.toggle('rv-editing',editing); this.classList.toggle('on',editing); set(editing?M.editOn:M.editOff); if(!editing) save(); };
  document.getElementById('rv-comment').onclick=function(){ commenting=!commenting; this.classList.toggle('on',commenting); set(commenting?M.commentOn:M.commentOff); };
  var pop=document.getElementById('rv-pop'), note=document.getElementById('rv-note'), mic=document.getElementById('rv-mic');
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition, rec=null, recing=false, savedRange=null;
  function stopRec(){ recing=false; if(rec){ try{rec.stop();}catch(e){} } if(mic){ mic.classList.remove('rec'); mic.textContent='🎤 '+M.voice; } }
  function closePop(){ pop.classList.remove('show'); stopRec(); savedRange=null; }
  function openPop(x,y){ pop.style.left=Math.max(8,Math.min(x,window.innerWidth-336))+'px'; pop.style.top=Math.max(8,Math.min(y,window.innerHeight-200))+'px'; note.value=''; pop.classList.add('show'); setTimeout(function(){note.focus();},0); }
  content.addEventListener('mouseup',function(ev){ if(!commenting) return; var s=window.getSelection(); if(!s||s.isCollapsed) return; var t=s.toString().trim(); if(!t) return; savedRange=s.getRangeAt(0).cloneRange(); savedRange.__anchor=t.slice(0,80); openPop(ev.clientX+8,ev.clientY+8); });
  document.getElementById('rv-pop-cancel').onclick=closePop;
  document.getElementById('rv-pop-ok').onclick=function(){ if(!savedRange){ closePop(); return; } var v=note.value.trim(); if(!v){ note.focus(); return; } var m=document.createElement('mark'); m.className='rv-cmt'; m.setAttribute('data-note',v); m.title=v; try{ savedRange.surroundContents(m); }catch(e){ m.setAttribute('data-anchor',savedRange.__anchor||''); m.textContent='⚑'; try{ savedRange.insertNode(m); }catch(_){ } } window.getSelection().removeAllRanges(); closePop(); rebuild(); save(); };
  if(SR && mic){
    mic.onclick=function(){
      if(recing){ stopRec(); set(M.voiceStopped); return; }
      rec=new SR(); rec.lang=M.dateLocale; rec.interimResults=true; rec.continuous=true;
      var base=note.value?note.value+' ':'';
      rec.onresult=function(e){ var fin='',inte=''; for(var i=e.resultIndex;i<e.results.length;i++){ var r=e.results[i]; if(r.isFinal) fin+=r[0].transcript; else inte+=r[0].transcript; } if(fin) base+=fin; note.value=base+inte; };
      rec.onerror=function(e){ set(msg('voiceError',{error:e.error||''})); stopRec(); };
      rec.onend=function(){ if(recing){ try{ rec.start(); }catch(_){ stopRec(); } } };
      try{ rec.start(); recing=true; mic.classList.add('rec'); mic.textContent='⏹ '+M.voiceStop; set(M.voiceStarted); }catch(e){ set(msg('voiceStartFailed',{error:e.message})); stopRec(); }
    };
  } else if(mic){ mic.style.display='none'; }
  function rebuild(){ var list=document.getElementById('rv-clist'); var marks=content.querySelectorAll('mark.rv-cmt'); if(!marks.length){ list.innerHTML='<div class="c" style="border:0;opacity:.6">'+M.noComments+'</div>'; return; } list.innerHTML=''; marks.forEach(function(m,i){ var a=m.getAttribute('data-anchor')||m.textContent||''; var d=document.createElement('div'); d.className='c'; d.innerHTML='<b>#'+(i+1)+'</b> <q>'+esc(a.slice(0,80))+'</q><br>'+esc(m.getAttribute('data-note')||''); list.appendChild(d); }); }
  document.getElementById('rv-list').onclick=function(){ panel.classList.toggle('show'); if(panel.classList.contains('show')) rebuild(); };
  document.getElementById('rv-restore').onclick=function(){ var s; try{ s=localStorage.getItem(KEY); }catch(e){} if(!s){ set(M.noRestore); return; } if(!confirm(M.restoreConfirm)) return; content.innerHTML=s; rebuild(); set(msg('restored',{time:now()})); };
  document.getElementById('rv-html').onclick=function(){ var was=editing; if(editing) content.contentEditable=false; var html='<!doctype html>\\n'+document.documentElement.outerHTML; if(was) content.contentEditable=true; dl(html,'text/html;charset=utf-8',slug()+'-edited-'+stamp()+'.html'); set(M.htmlExported); };
  document.getElementById('rv-md').onclick=function(){ var marks=content.querySelectorAll('mark.rv-cmt'); var md='# '+msg('markdownTitle',{title:document.title})+'\\n\\n'+M.generated+': '+now()+'\\n\\n'; if(!marks.length) md+=M.mdEmpty+'\\n'; marks.forEach(function(m,i){ md+='## #'+(i+1)+'\\n- '+M.target+': '+((m.getAttribute('data-anchor')||m.textContent||'').trim())+'\\n- '+M.commentLabel+': '+(m.getAttribute('data-note')||'')+'\\n\\n'; }); dl(md,'text/markdown;charset=utf-8',slug()+'-comments-'+stamp()+'.md'); set(M.mdExported); };
  document.getElementById('rv-discard').onclick=function(){ if(!confirm(M.discardConfirm)) return; try{ localStorage.removeItem(KEY); }catch(e){} set(M.discarded); };
  if(window.__RV_SAVE__){
    var sb=document.getElementById('rv-save'); sb.style.display='';
    sb.onclick=function(){ var was=editing; if(editing) content.contentEditable=false; var html='<!doctype html>\\n'+document.documentElement.outerHTML; if(was) content.contentEditable=true; set(M.saving);
      fetch(window.__RV_SAVE__.url,{method:'POST',headers:{'Content-Type':'text/html','x-rv-token':window.__RV_SAVE__.token},body:html})
        .then(function(r){return r.text().then(function(t){return{ok:r.ok,t:t};});})
        .then(function(res){ set(res.ok?msg('savedToFile',{time:now()}):msg('saveFailed',{error:res.t})); })
        .catch(function(e){ set(msg('saveFailed',{error:e.message})); }); };
  }
  rebuild();
})();
</script>
${RV_LAYER_CLOSE}`;
}

function escHtml(value: string): string {
  return value.replace(
    /[&<>\"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character
  );
}
