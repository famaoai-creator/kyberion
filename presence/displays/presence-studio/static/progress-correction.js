/* One delivery draft, one visible editor. The caller owns scope and live-render fences. */
/* global window, document */
(function () {
  'use strict';
  function render(options) {
    var state = options.state,
      row = options.row,
      item = options.item,
      vocab = options.vocab;
    var rowCurrent = options.current,
      vt = options.vt,
      submitVerdict = options.submitVerdict,
      renderList = options.renderList;
    var draft = state.correctionDrafts[item.entry_id];
    if (
      !draft ||
      !item.can_verdict ||
      !item.entry_id ||
      draft.editorId !== item.id ||
      !state.verdictStorageKey ||
      row.querySelector('.progress-revise-form')
    )
      return;
    function current() {
      return (
        rowCurrent() &&
        state.correctionDrafts[item.entry_id] === draft &&
        draft.editorId === item.id
      );
    }
    var locked = Boolean(
      state.pendingVerdicts[item.entry_id] || state.uncertainVerdicts[item.entry_id]
    );
    var form = document.createElement('div');
    form.className = 'progress-revise-form';
    var textarea = document.createElement('textarea');
    textarea.className = 'kb-input kb-textarea progress-revise-note';
    textarea.setAttribute('data-entry-id', item.entry_id);
    textarea.setAttribute('aria-label', vt(vocab, 'action_revise'));
    textarea.value = draft.text;
    textarea.maxLength = 4000;
    textarea.disabled = locked;
    textarea.addEventListener('input', function () {
      if (current()) draft.text = textarea.value;
    });
    var note = document.createElement('p');
    note.textContent = vt(vocab, 'progress_correction_draft_note');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'kb-btn kb-btn--primary progress-row-action';
    submit.textContent = vt(vocab, 'progress_correction_save');
    submit.disabled = locked || !state.verdictStorageVerified;
    submit.addEventListener('click', function (event) {
      event.stopPropagation();
      if (current()) submitVerdict(item, 'rejected', draft.text.trim() || undefined, row);
    });
    var discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'kb-btn kb-btn--secondary progress-row-action';
    discard.setAttribute('data-action', 'discard-correction');
    discard.textContent = vt(vocab, 'progress_correction_discard');
    discard.disabled = locked;
    discard.addEventListener('click', function (event) {
      event.stopPropagation();
      if (!current()) return;
      delete state.correctionDrafts[item.entry_id];
      renderList();
    });
    form.appendChild(textarea);
    form.appendChild(note);
    form.appendChild(submit);
    form.appendChild(discard);
    row.appendChild(form);
  }

  function open(options) {
    var state = options.state,
      row = options.row,
      item = options.item;
    if (!options.current() || row.querySelector('.progress-revise-form')) return;
    var draft = state.correctionDrafts[item.entry_id];
    if (draft) {
      draft.editorId = item.id;
      options.renderList();
    } else {
      state.correctionDrafts[item.entry_id] = { text: '', editorId: item.id };
      render(options);
      document
        .getElementById('progress-list')
        .querySelectorAll('button')
        .forEach(function (button) {
          if (
            button.getAttribute('data-entry-id') === item.entry_id &&
            button.getAttribute('data-action') === 'receive'
          )
            button.disabled = true;
        });
    }
    document
      .getElementById('progress-list')
      .querySelectorAll('.progress-revise-note')
      .forEach(function (note) {
        if (note.getAttribute('data-entry-id') === item.entry_id && note.focus) note.focus();
      });
  }

  window.KyberionProgressCorrection = { render: render, open: open };
})();
