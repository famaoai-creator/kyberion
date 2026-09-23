/*
 * capture-client.js — browser module of the memory-capture pad (PA-06),
 * inlined into the page by `page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Hosts (renderA2UI replaces a whole container, so each group has its own):
 *   #mc-toolbar     ui:toolbar      hand off / restore / clear + status (status updated in place)
 *   #mc-notes       ui:textarea     notes (value lives in the model)
 *   #mc-voice       ui:voice-input  dictation → appended to the notes
 *   #mc-meta        ui:text-field + ui:select  tags + target
 *   #mc-instruction ui:textarea + ui:text      instruction + output path
 *   #pad-dialog     ui:dialog       clear confirmation
 *
 * Server contract (unchanged): POST exportUrl with header `X-MC-Token` and
 * `{ notes, tags[], target, instruction }`; draft in localStorage
 * `memory-capture.draft.v1` `{ notes, tags, target, instruction }`.
 */
/* global document, window */
import { bootPad } from '/pad-ui/pad-client.js';

const DRAFT_KEY = 'memory-capture.draft.v1';
const TARGETS = ['memory', 'now', 'todo'];
const TEXT_FIELDS = ['notes', 'tags', 'target', 'instruction'];

const host = {
  toolbar: document.getElementById('mc-toolbar'),
  notes: document.getElementById('mc-notes'),
  voice: document.getElementById('mc-voice'),
  meta: document.getElementById('mc-meta'),
  instruction: document.getElementById('mc-instruction'),
  dialog: document.getElementById('pad-dialog'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`memory_capture:${key}`);

const model = {
  notes: '',
  tags: '',
  target: 'memory',
  instruction: String(bootstrap.defaultInstruction || ''),
};
let dialog = null;

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function setStatus(text, tone) {
  const node = host.toolbar.querySelector('[data-item-id="status"]');
  if (!node) return;
  node.textContent = text;
  if (tone) node.setAttribute('data-tone', tone);
  else node.removeAttribute('data-tone');
}

function setControl(componentId, value) {
  const node = document.getElementById(`kbf-${componentId}`);
  if (node) node.value = value;
}

function saveDraft() {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(model));
  } catch {
    // storage blocked: the page still works
  }
}

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw);
    model.notes = typeof draft.notes === 'string' ? draft.notes : '';
    model.tags = typeof draft.tags === 'string' ? draft.tags : '';
    if (TARGETS.includes(draft.target)) model.target = draft.target;
    if (typeof draft.instruction === 'string') model.instruction = draft.instruction;
    return true;
  } catch {
    return false;
  }
}

// -- rendering -------------------------------------------------------------

function renderToolbar() {
  pad.render(host.toolbar, [
    {
      id: 'mc-toolbar',
      type: 'ui:toolbar',
      props: {
        label: K('toolbar_label'),
        items: [
          { type: 'button', id: 'handoff', label: K('handoff'), variant: 'primary' },
          { type: 'separator' },
          { type: 'button', id: 'restore', label: K('restore'), variant: 'secondary' },
          { type: 'button', id: 'clear', label: K('clear'), variant: 'ghost' },
          { type: 'spacer' },
          { type: 'status', id: 'status', text: K('ready') },
        ],
      },
    },
  ]);
}

function renderNotes() {
  pad.render(host.notes, [
    {
      id: 'mc-notes-field',
      type: 'ui:textarea',
      props: {
        name: 'notes',
        label: K('notes'),
        placeholder: K('notes_placeholder'),
        rows: 10,
        value: model.notes,
      },
    },
  ]);
}

function renderVoice() {
  pad.render(host.voice, [
    {
      id: 'mc-voice-input',
      type: 'ui:voice-input',
      props: {
        name: 'dictation',
        label: K('dictation_label'),
        mode: 'dictation',
        continuous: true,
        show_transcript: true,
        help: K('dictation_note'),
      },
    },
  ]);
}

function renderMeta() {
  pad.render(host.meta, [
    {
      id: 'mc-meta-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['mc-tags', 'mc-target'],
    },
    {
      id: 'mc-tags',
      type: 'ui:text-field',
      props: {
        name: 'tags',
        label: K('tags'),
        placeholder: K('tags_placeholder'),
        value: model.tags,
      },
    },
    {
      id: 'mc-target',
      type: 'ui:select',
      props: {
        name: 'target',
        label: K('target'),
        value: model.target,
        options: TARGETS.map((value) => ({ value, label: K(`target_${value}`) })),
      },
    },
  ]);
}

function renderInstruction() {
  pad.render(host.instruction, [
    {
      id: 'mc-instruction-stack',
      type: 'ui:stack',
      props: { gap: 'sm' },
      children: ['mc-instruction-field', 'mc-out'],
    },
    {
      id: 'mc-instruction-field',
      type: 'ui:textarea',
      props: {
        name: 'instruction',
        label: K('instruction'),
        placeholder: K('instruction_placeholder'),
        rows: 6,
        value: model.instruction,
      },
    },
    {
      id: 'mc-out',
      type: 'ui:text',
      props: {
        text: t('memory_capture:out_path', { path: bootstrap.outLabel }),
        variant: 'caption',
      },
    },
  ]);
}

function renderDialog() {
  pad.render(host.dialog, [
    {
      id: 'mc-dialog',
      type: 'ui:dialog',
      props: dialog
        ? {
            open: true,
            title: K('clear_confirm'),
            message: K('clear_confirm_body'),
            tone: 'danger',
            confirm_label: K('clear'),
          }
        : { open: false, title: K('clear_confirm') },
    },
  ]);
}

// -- actions ---------------------------------------------------------------

async function handoff() {
  setStatus(K('exporting'));
  const tags = model.tags
    .split(/[,\n]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    const response = await fetch(bootstrap.exportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MC-Token': bootstrap.token },
      body: JSON.stringify({
        notes: model.notes,
        tags,
        target: model.target,
        instruction: model.instruction,
      }),
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || !body || !body.ok) {
      throw new Error((body && body.error) || `HTTP ${response.status}`);
    }
    setStatus(`${K('exported')} — ${body.session_dir || ''}`, 'success');
    saveDraft();
  } catch (error) {
    setStatus(`${K('export_failed')}: ${errorText(error)}`, 'danger');
  }
}

function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
  model.notes = '';
  model.tags = '';
  model.target = 'memory';
  renderNotes();
  renderMeta();
  setStatus(K('draft_cleared'));
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'toolbar.click':
      if (payload.id === 'handoff') void handoff();
      else if (payload.id === 'restore') {
        if (loadDraft()) {
          renderNotes();
          renderMeta();
          renderInstruction();
          setStatus(K('draft_restored'), 'success');
        } else {
          setStatus(K('no_draft'));
        }
      } else if (payload.id === 'clear') {
        dialog = { kind: 'clear' };
        renderDialog();
      }
      return;
    case 'field.change':
      if (TEXT_FIELDS.includes(payload.name) && typeof payload.value === 'string') {
        model[payload.name] = payload.value;
        saveDraft();
      }
      return;
    case 'voice.transcript':
      if (payload.final && payload.text) {
        const text = String(payload.text).trim();
        model.notes = model.notes ? `${model.notes} ${text}` : text;
        setControl('mc-notes-field', model.notes);
        saveDraft();
      }
      return;
    case 'dialog.confirm':
      dialog = null;
      renderDialog();
      clearDraft();
      return;
    case 'dialog.cancel':
      dialog = null;
      renderDialog();
      return;
    default:
  }
}

loadDraft();
renderToolbar();
renderNotes();
renderVoice();
renderMeta();
renderInstruction();
renderDialog();
