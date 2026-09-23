/*
 * drop-client.js — browser module of the doc-drop pad (PA-06), inlined into
 * the page by `drop-page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Hosts (renderA2UI replaces a whole container, so each group has its own):
 *   #dd-toolbar     ui:toolbar         file picker / camera toggle / hand off / clear + status
 *   #dd-files       ui:file-drop       drop zone + attachment list with per-file status
 *   #dd-instruction ui:textarea        instruction (value lives in the model) + output path
 *   #dd-camera      ui:camera-capture  photo → attachment (shown by the camera toggle)
 *   #pad-dialog     ui:dialog          clear confirmation
 *
 * Server contract (unchanged): POST exportUrl with headers `X-DDROP-Token` /
 * `X-DOC-Token` and `{ instruction, attachments: [{ name, mime, data_base64 }] }`;
 * draft in localStorage `doc-drop.draft.v1` `{ instruction, attachments }`.
 */
/* global document, window, FileReader */
import { bootPad } from '/pad-ui/pad-client.js';

const DRAFT_KEY = 'doc-drop.draft.v1';

const host = {
  toolbar: document.getElementById('dd-toolbar'),
  files: document.getElementById('dd-files'),
  instruction: document.getElementById('dd-instruction'),
  camera: document.getElementById('dd-camera'),
  dialog: document.getElementById('pad-dialog'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`doc_drop:${key}`);
const MAX_FILE_BYTES = Number(bootstrap.maxFileBytes) || 12 * 1024 * 1024;
const ACCEPT = String(bootstrap.accept || '');

const model = {
  instruction: String(bootstrap.defaultInstruction || ''),
  attachments: [],
};
let attachmentSeq = 0;
let dialogOpen = false;
let cameraOpen = false;

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function setStatus(text, tone) {
  const node = host.toolbar.querySelector('[data-item-id="status"]');
  if (!node) return;
  node.textContent = text;
  if (tone) node.setAttribute('data-tone', tone);
  else node.removeAttribute('data-tone');
}

function readyAttachments() {
  return model.attachments
    .filter((item) => item.status === 'done')
    .map((item) => ({ name: item.name, mime: item.mime, data_base64: item.data_base64 }));
}

function saveDraft() {
  try {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ instruction: model.instruction, attachments: readyAttachments() })
    );
  } catch {
    // storage full or blocked: the page still works
  }
}

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.instruction != null) model.instruction = String(draft.instruction);
    if (Array.isArray(draft.attachments)) {
      model.attachments = draft.attachments
        .filter((item) => item && typeof item.data_base64 === 'string' && item.data_base64)
        .map((item) => ({
          id: `doc-${++attachmentSeq}`,
          name: String(item.name || `attach-${attachmentSeq}`),
          mime: String(item.mime || 'application/octet-stream'),
          size: Math.round(item.data_base64.length * 0.75),
          data_base64: item.data_base64,
          status: 'done',
        }));
    }
  } catch {
    // unreadable draft: start empty
  }
}

async function addFiles(files, rename) {
  for (const file of files) {
    const entry = {
      id: `doc-${++attachmentSeq}`,
      name: rename ? rename(file) : file.name || `attach-${attachmentSeq}`,
      mime: file.type || 'application/octet-stream',
      size: file.size || 0,
      data_base64: '',
      status: 'queued',
    };
    model.attachments.push(entry);
    if (entry.size > MAX_FILE_BYTES) {
      entry.status = 'error';
      entry.error = K('attach_too_large');
      continue;
    }
    renderFiles();
    try {
      entry.data_base64 = await blobToBase64(file);
      entry.status = 'done';
      setStatus(`${K('attach_added')}: ${entry.name}`, 'success');
    } catch {
      entry.status = 'error';
      entry.error = K('attach_read_failed');
    }
  }
  renderFiles();
  saveDraft();
}

// -- rendering -------------------------------------------------------------

function renderToolbar() {
  pad.render(host.toolbar, [
    {
      id: 'dd-toolbar',
      type: 'ui:toolbar',
      props: {
        label: K('toolbar_label'),
        items: [
          {
            type: 'file',
            id: 'attach',
            label: K('attach'),
            icon: '📎',
            accept: ACCEPT,
            multiple: true,
          },
          { type: 'toggle', id: 'camera', label: K('camera'), icon: '📷', pressed: cameraOpen },
          { type: 'separator' },
          { type: 'button', id: 'handoff', label: K('handoff'), variant: 'primary' },
          { type: 'button', id: 'clear', label: K('clear'), variant: 'ghost' },
          { type: 'spacer' },
          { type: 'status', id: 'status', text: K('ready') },
        ],
      },
    },
  ]);
}

function renderFiles() {
  pad.render(host.files, [
    {
      id: 'dd-drop',
      type: 'ui:file-drop',
      props: {
        name: 'documents',
        label: K('files_label'),
        accept: ACCEPT,
        multiple: true,
        max_bytes: MAX_FILE_BYTES,
        files: model.attachments.map((item) => {
          const entry = { id: item.id, name: item.name, size: item.size, status: item.status };
          if (item.error) entry.error = item.error;
          return entry;
        }),
      },
    },
  ]);
}

function renderInstruction() {
  pad.render(host.instruction, [
    {
      id: 'dd-instruction-stack',
      type: 'ui:stack',
      props: { gap: 'sm' },
      children: ['dd-instruction-field', 'dd-out'],
    },
    {
      id: 'dd-instruction-field',
      type: 'ui:textarea',
      props: {
        name: 'instruction',
        label: K('instruction'),
        placeholder: K('instruction_placeholder'),
        rows: 4,
        value: model.instruction,
      },
    },
    {
      id: 'dd-out',
      type: 'ui:text',
      props: { text: t('doc_drop:out_path', { path: bootstrap.outLabel }), variant: 'caption' },
    },
  ]);
}

function renderCamera() {
  host.camera.hidden = !cameraOpen;
  pad.render(
    host.camera,
    cameraOpen
      ? [
          {
            id: 'dd-camera-capture',
            type: 'ui:camera-capture',
            props: { name: 'camera', label: K('camera_label'), facing: 'environment' },
          },
        ]
      : []
  );
}

function renderDialog() {
  pad.render(host.dialog, [
    {
      id: 'dd-dialog',
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
  const attachments = readyAttachments();
  if (attachments.length === 0) {
    setStatus(K('need_files'), 'warning');
    return;
  }
  setStatus(K('exporting'));
  try {
    const response = await fetch(bootstrap.exportUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DDROP-Token': bootstrap.token,
        'X-DOC-Token': bootstrap.token,
      },
      body: JSON.stringify({ instruction: model.instruction, attachments }),
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || !body.ok)
      throw new Error((body && body.error) || `HTTP ${response.status}`);
    saveDraft();
    setStatus(`${K('exported')}${body.handoff_path ? `: ${body.handoff_path}` : ''}`, 'success');
  } catch (error) {
    setStatus(`${K('export_failed')}: ${errorText(error)}`, 'danger');
  }
}

function clearAll() {
  model.attachments = [];
  model.instruction = '';
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
  renderFiles();
  renderInstruction();
  setStatus(K('cleared'));
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'toolbar.click':
      if (payload.id === 'handoff') void handoff();
      else if (payload.id === 'clear') {
        dialogOpen = true;
        renderDialog();
      }
      return;
    case 'toolbar.toggle':
      if (payload.id === 'camera') {
        cameraOpen = payload.pressed === true;
        renderCamera();
      }
      return;
    case 'toolbar.files':
    case 'file.add':
      void addFiles(Array.from(payload.files || []));
      return;
    case 'file.remove':
      model.attachments = model.attachments.filter((item) => item.id !== payload.file_id);
      renderFiles();
      saveDraft();
      return;
    case 'camera.capture':
      if (payload.file)
        void addFiles([payload.file], (file) => {
          const ext = /png/.test(file.type || '') ? 'png' : 'jpg';
          return `camera-${Date.now()}.${ext}`;
        });
      return;
    case 'field.change':
      if (payload.name === 'instruction' && typeof payload.value === 'string') {
        model.instruction = payload.value;
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
renderFiles();
renderInstruction();
renderCamera();
renderDialog();
