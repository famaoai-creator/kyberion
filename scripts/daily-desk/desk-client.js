/*
 * desk-client.js — browser module of the daily-desk pad (PA-06), inlined
 * into the page by `desk-page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Hosts (renderA2UI replaces a whole container, so each group has its own):
 *   #dk-toolbar     ui:toolbar   hand off / save draft / reload from disk / clear + status
 *   #dk-note        ui:callout   where the panels came from (working-memory faces)
 *   #dk-faces       ui:grid of three ui:textarea  Journal / TODO / NOW
 *   #dk-instruction ui:textarea + ui:text  instruction + output path
 *   #pad-dialog     ui:dialog    clear confirmation
 *
 * Text values live in the model; the panels are re-rendered only when their
 * content is replaced (reload from disk, draft, clear).
 *
 * Server contract (unchanged): POST exportUrl `{ journal, todo, now, instruction }`
 * and POST loadUrl `{}` → `{ ok, journal, todo, now, face_paths, ... }`, both
 * with header `X-DD-Token`; draft in localStorage `daily-desk.draft.v1`.
 */
/* global document, window */
import { bootPad } from '/pad-ui/pad-client.js';

const DRAFT_KEY = 'daily-desk.draft.v1';
const FACES = ['journal', 'todo', 'now'];
const FIELDS = [...FACES, 'instruction'];

const host = {
  toolbar: document.getElementById('dk-toolbar'),
  note: document.getElementById('dk-note'),
  faces: document.getElementById('dk-faces'),
  instruction: document.getElementById('dk-instruction'),
  dialog: document.getElementById('pad-dialog'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`daily_desk:${key}`);
const seed = bootstrap.faces || {};

const model = {
  journal: String(seed.journal || ''),
  todo: String(seed.todo || ''),
  now: String(seed.now || ''),
  instruction: String(bootstrap.defaultInstruction || ''),
};
let facePaths = Object.assign({ journal: null, todo: null, now: null }, bootstrap.facePaths || {});
let note = { tone: 'info', text: t('daily_desk:faces_pending', { period: bootstrap.periodKey }) };
let dialogOpen = false;

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

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DD-Token': bootstrap.token },
    body: JSON.stringify(body),
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  if (!response.ok || !json || !json.ok) {
    throw new Error((json && json.error) || `HTTP ${response.status}`);
  }
  return json;
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
    for (const field of FIELDS) if (draft[field] != null) model[field] = String(draft[field]);
    return true;
  } catch {
    return false;
  }
}

// -- rendering -------------------------------------------------------------

function renderToolbar() {
  pad.render(host.toolbar, [
    {
      id: 'dk-toolbar',
      type: 'ui:toolbar',
      props: {
        label: K('toolbar_label'),
        items: [
          { type: 'button', id: 'handoff', label: K('handoff'), variant: 'primary' },
          { type: 'separator' },
          { type: 'button', id: 'draft', label: K('save_draft'), variant: 'secondary' },
          { type: 'button', id: 'load', label: K('load_disk'), variant: 'secondary' },
          { type: 'button', id: 'clear', label: K('clear'), variant: 'ghost' },
          { type: 'spacer' },
          { type: 'status', id: 'status', text: K('ready') },
        ],
      },
    },
  ]);
}

function renderNote() {
  pad.render(host.note, [
    { id: 'dk-note-callout', type: 'ui:callout', props: { tone: note.tone, title: note.text } },
  ]);
}

function renderFaces() {
  pad.render(host.faces, [
    {
      id: 'dk-faces-grid',
      type: 'ui:grid',
      props: { gap: 'lg', min_column_width: 'md' },
      children: FACES.map((face) => `dk-${face}`),
    },
    ...FACES.map((face) => ({
      id: `dk-${face}`,
      type: 'ui:textarea',
      props: {
        name: face,
        label: K(face),
        rows: 12,
        value: model[face],
        help: facePaths[face]
          ? t('daily_desk:face_path', { path: facePaths[face] })
          : K('face_none'),
      },
    })),
  ]);
}

function renderInstruction() {
  pad.render(host.instruction, [
    {
      id: 'dk-instruction-stack',
      type: 'ui:stack',
      props: { gap: 'sm' },
      children: ['dk-instruction-field', 'dk-out'],
    },
    {
      id: 'dk-instruction-field',
      type: 'ui:textarea',
      props: {
        name: 'instruction',
        label: K('instruction'),
        placeholder: K('instruction_placeholder'),
        rows: 3,
        value: model.instruction,
      },
    },
    {
      id: 'dk-out',
      type: 'ui:text',
      props: { text: t('daily_desk:out_path', { path: bootstrap.outLabel }), variant: 'caption' },
    },
  ]);
}

function renderDialog() {
  pad.render(host.dialog, [
    {
      id: 'dk-dialog',
      type: 'ui:dialog',
      props: dialogOpen
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
  try {
    const body = await post(bootstrap.exportUrl, {
      journal: model.journal,
      todo: model.todo,
      now: model.now,
      instruction: model.instruction,
    });
    saveDraft();
    setStatus(`${K('exported')}${body.handoff_path ? `: ${body.handoff_path}` : ''}`, 'success');
  } catch (error) {
    setStatus(`${K('export_failed')}: ${errorText(error)}`, 'danger');
  }
}

async function loadFromDisk() {
  setStatus(K('loading'));
  try {
    const body = await post(bootstrap.loadUrl, {});
    for (const face of FACES) if (body[face] != null) model[face] = String(body[face]);
    if (body.face_paths && typeof body.face_paths === 'object') {
      facePaths = Object.assign({ journal: null, todo: null, now: null }, body.face_paths);
    }
    const seeded = FACES.some((face) => facePaths[face]);
    note = seeded
      ? { tone: 'success', text: K('faces_seeded') }
      : { tone: 'info', text: t('daily_desk:faces_missing', { period: bootstrap.periodKey }) };
    renderNote();
    renderFaces();
    saveDraft();
    setStatus(K('loaded'), 'success');
  } catch (error) {
    setStatus(`${K('load_failed')}: ${errorText(error)}`, 'danger');
  }
}

function clearAll() {
  for (const field of FIELDS) model[field] = '';
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
  renderFaces();
  renderInstruction();
  setStatus(K('cleared'));
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'toolbar.click':
      if (payload.id === 'handoff') void handoff();
      else if (payload.id === 'draft') {
        saveDraft();
        setStatus(K('draft_saved'), 'success');
      } else if (payload.id === 'load') void loadFromDisk();
      else if (payload.id === 'clear') {
        dialogOpen = true;
        renderDialog();
      }
      return;
    case 'field.change':
      if (FIELDS.includes(payload.name) && typeof payload.value === 'string') {
        model[payload.name] = payload.value;
        saveDraft();
      }
      return;
    case 'dialog.confirm':
      dialogOpen = false;
      renderDialog();
      clearAll();
      return;
    case 'dialog.cancel':
      dialogOpen = false;
      renderDialog();
      return;
    default:
  }
}

loadDraft();
renderToolbar();
renderNote();
renderFaces();
renderInstruction();
renderDialog();
