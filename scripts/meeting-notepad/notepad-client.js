/*
 * notepad-client.js — browser module of the meeting-notepad pad (PA-06),
 * inlined into the page by `notepad-page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Every control is a shared `kyberion-base` component; each stateful one sits
 * in its own host because renderA2UI replaces the whole container:
 *   #mn-toolbar      ui:toolbar        actions + attach + camera toggle + status (status updated in place)
 *   #mn-fields       ui:text-field / ui:textarea  title + notes (values live in the model)
 *   #mn-dictation    ui:voice-input    dictation → appended to the notes
 *   #mn-record       ui:voice-input    record, 5 s chunks → /transcribe → transcript
 *   #mn-record-state ui:voice-state    listening / transcribing indicator
 *   #mn-fields-more  ui:textarea       transcript + instruction + output path
 *   #mn-attachments  ui:file-drop      attachments with per-file status
 *   #mn-camera       ui:camera-capture photo → attachment (shown by the camera toggle)
 *   #mn-preview      ui:section + ui:code  minutes preview
 *   #pad-dialog      ui:dialog         clear confirmation
 *
 * Server contract (unchanged): POST exportUrl / minutesUrl / transcribeUrl with
 * header `X-MN-Token`; draft in localStorage `meeting-notepad.draft.v1`.
 *
 * Recording: MediaRecorder timeslices after the first one carry no container
 * header, so a single slice cannot be decoded on its own. Each transcription
 * pass therefore sends the recording so far (all slices) and replaces this
 * recording's part of the transcript; passes are serialized, spaced out, and
 * stop while recording once the audio is large — the pass after "stop"
 * always covers the whole recording.
 */
/* global document, window, FileReader, Blob */
import { bootPad } from '/pad-ui/pad-client.js';

const DRAFT_KEY = 'meeting-notepad.draft.v1';
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const LIVE_PASS_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_PASS_MIN_INTERVAL_MS = 15000;
const ATTACH_ACCEPT = 'image/*,.pdf,.txt,.md,.doc,.docx,.png,.jpg,.jpeg,.webp';
const TEXT_FIELDS = ['title', 'notes', 'transcript', 'instruction'];

const host = {
  toolbar: document.getElementById('mn-toolbar'),
  fields: document.getElementById('mn-fields'),
  dictation: document.getElementById('mn-dictation'),
  record: document.getElementById('mn-record'),
  recordState: document.getElementById('mn-record-state'),
  fieldsMore: document.getElementById('mn-fields-more'),
  attachments: document.getElementById('mn-attachments'),
  camera: document.getElementById('mn-camera'),
  preview: document.getElementById('mn-preview'),
  dialog: document.getElementById('pad-dialog'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`meeting_notepad:${key}`);

const model = {
  title: String(bootstrap.defaultTitle || ''),
  notes: '',
  transcript: '',
  instruction: String(bootstrap.defaultInstruction || ''),
  attachments: [],
  preview: '',
};
let attachmentSeq = 0;
let dialog = null;
let cameraOpen = false;
const rec = {
  recording: false,
  chunks: [],
  mime: '',
  base: null,
  busy: false,
  again: false,
  finalChunks: null,
  live: true,
  lastPass: 0,
};

// -- helpers ---------------------------------------------------------------

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

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MN-Token': bootstrap.token },
    body: JSON.stringify(body),
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  if (!response.ok || json.ok === false) {
    throw new Error((json && json.error) || `HTTP ${response.status}`);
  }
  return json;
}

/** Update the toolbar status in place (no re-render, keyboard focus stays). */
function setStatus(text, tone) {
  const node = host.toolbar.querySelector('[data-item-id="status"]');
  if (!node) return;
  node.textContent = text;
  if (tone) node.setAttribute('data-tone', tone);
  else node.removeAttribute('data-tone');
}

/** Write a field value into its rendered control without re-rendering it. */
function setControl(componentId, value) {
  const node = document.getElementById(`kbf-${componentId}`);
  if (node) node.value = value;
}

function joinText(base, addition, separator) {
  const extra = String(addition || '').trim();
  if (!extra) return base;
  return base ? `${base}${separator}${extra}` : extra;
}

// -- draft -------------------------------------------------------------------

function saveDraft() {
  try {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        title: model.title,
        notes: model.notes,
        transcript: model.transcript,
        instruction: model.instruction,
        attachments: readyAttachments(),
      })
    );
  } catch {
    // storage full or blocked: the page still works
  }
}

function readDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function applyDraft(draft) {
  model.title = typeof draft.title === 'string' ? draft.title : model.title;
  model.notes = typeof draft.notes === 'string' ? draft.notes : '';
  model.transcript = typeof draft.transcript === 'string' ? draft.transcript : '';
  model.instruction = typeof draft.instruction === 'string' ? draft.instruction : model.instruction;
  model.attachments = (Array.isArray(draft.attachments) ? draft.attachments : [])
    .filter((item) => item && typeof item.data_base64 === 'string' && item.data_base64)
    .map((item) => ({
      id: `att-${++attachmentSeq}`,
      name: String(item.name || `attach-${attachmentSeq}`),
      mime: String(item.mime || 'application/octet-stream'),
      size: Math.round(item.data_base64.length * 0.75),
      data_base64: item.data_base64,
      status: 'done',
    }));
}

// -- attachments -----------------------------------------------------------

function readyAttachments() {
  return model.attachments
    .filter((item) => item.status === 'done')
    .map((item) => ({ name: item.name, mime: item.mime, data_base64: item.data_base64 }));
}

async function addFiles(files, rename) {
  for (const file of files) {
    const entry = {
      id: `att-${++attachmentSeq}`,
      name: rename ? rename(file) : file.name || `attach-${attachmentSeq}`,
      mime: file.type || 'application/octet-stream',
      size: file.size || 0,
      data_base64: '',
      status: 'queued',
    };
    model.attachments.push(entry);
    if (entry.size > MAX_ATTACHMENT_BYTES) {
      entry.status = 'error';
      entry.error = K('attach_too_large');
      continue;
    }
    renderAttachments();
    try {
      entry.data_base64 = await blobToBase64(file);
      entry.status = 'done';
      setStatus(`${K('attach_added')}: ${entry.name}`, 'success');
    } catch {
      entry.status = 'error';
      entry.error = K('attach_read_failed');
    }
  }
  renderAttachments();
  saveDraft();
}

function removeAttachment(id) {
  model.attachments = model.attachments.filter((item) => item.id !== id);
  renderAttachments();
  saveDraft();
}

// -- rendering -------------------------------------------------------------

function renderToolbar() {
  pad.render(host.toolbar, [
    {
      id: 'mn-toolbar',
      type: 'ui:toolbar',
      props: {
        label: K('toolbar_label'),
        items: [
          { type: 'button', id: 'minutes', label: K('create_minutes'), variant: 'primary' },
          { type: 'button', id: 'handoff', label: K('handoff'), variant: 'primary' },
          { type: 'separator' },
          {
            type: 'file',
            id: 'attach',
            label: K('attach'),
            icon: '📎',
            accept: ATTACH_ACCEPT,
            multiple: true,
          },
          { type: 'toggle', id: 'camera', label: K('camera'), icon: '📷', pressed: cameraOpen },
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

function renderFields() {
  pad.render(host.fields, [
    {
      id: 'mn-fields-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['mn-title', 'mn-notes'],
    },
    {
      id: 'mn-title',
      type: 'ui:text-field',
      props: {
        name: 'title',
        label: K('meeting_title'),
        placeholder: K('meeting_title_placeholder'),
        value: model.title,
      },
    },
    {
      id: 'mn-notes',
      type: 'ui:textarea',
      props: {
        name: 'notes',
        label: K('notes'),
        placeholder: K('notes_placeholder'),
        rows: 8,
        value: model.notes,
      },
    },
  ]);
}

function renderMoreFields() {
  pad.render(host.fieldsMore, [
    {
      id: 'mn-more-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['mn-transcript', 'mn-instruction', 'mn-out'],
    },
    {
      id: 'mn-transcript',
      type: 'ui:textarea',
      props: {
        name: 'transcript',
        label: K('transcript'),
        placeholder: K('transcript_placeholder'),
        rows: 6,
        value: model.transcript,
      },
    },
    {
      id: 'mn-instruction',
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
      id: 'mn-out',
      type: 'ui:text',
      props: {
        text: t('meeting_notepad:out_path', { path: bootstrap.outLabel }),
        variant: 'caption',
      },
    },
  ]);
}

function renderVoiceInputs() {
  pad.render(host.dictation, [
    {
      id: 'mn-dictation-input',
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
  pad.render(host.record, [
    {
      id: 'mn-record-input',
      type: 'ui:voice-input',
      props: {
        name: 'record',
        label: K('record_label'),
        mode: 'record',
        chunk_ms: 5000,
        help: K('record_help'),
      },
    },
  ]);
}

function renderRecordState() {
  let props = null;
  if (rec.busy) props = { state: 'thinking', label: K('transcribing') };
  else if (rec.recording && !rec.live)
    props = { state: 'listening', label: K('transcribing_later') };
  else if (rec.recording) props = { state: 'listening', label: K('recording') };
  pad.render(
    host.recordState,
    props ? [{ id: 'mn-record-state-indicator', type: 'ui:voice-state', props }] : []
  );
}

function renderAttachments() {
  pad.render(host.attachments, [
    {
      id: 'mn-attach-drop',
      type: 'ui:file-drop',
      props: {
        name: 'attachments',
        label: K('attachments'),
        accept: ATTACH_ACCEPT,
        multiple: true,
        max_bytes: MAX_ATTACHMENT_BYTES,
        files: model.attachments.map((item) => {
          const entry = { id: item.id, name: item.name, size: item.size, status: item.status };
          if (item.error) entry.error = item.error;
          return entry;
        }),
      },
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
            id: 'mn-camera-capture',
            type: 'ui:camera-capture',
            props: { name: 'camera', label: K('camera_label'), facing: 'environment' },
          },
        ]
      : []
  );
}

function renderPreview() {
  pad.render(host.preview, [
    {
      id: 'mn-preview-section',
      type: 'ui:section',
      props: { title: K('preview') },
      children: ['mn-preview-body'],
    },
    model.preview
      ? {
          id: 'mn-preview-body',
          type: 'ui:code',
          props: { code: model.preview, language: 'markdown' },
        }
      : {
          id: 'mn-preview-body',
          type: 'ui:text',
          props: { text: K('preview_empty'), variant: 'muted' },
        },
  ]);
}

function renderDialog() {
  pad.render(host.dialog, [
    {
      id: 'mn-dialog',
      type: 'ui:dialog',
      props: dialog
        ? {
            open: true,
            title: dialog.title,
            message: dialog.message,
            tone: dialog.tone || 'neutral',
            confirm_label: dialog.confirmLabel,
          }
        : { open: false, title: K('clear_confirm') },
    },
  ]);
}

function askToConfirm(options) {
  dialog = options;
  renderDialog();
}

// -- actions ---------------------------------------------------------------

function payloadBase() {
  return {
    title: model.title,
    notes: model.notes,
    transcript: model.transcript,
    instruction: model.instruction,
    language: bootstrap.language,
    attachments: readyAttachments(),
  };
}

async function handoff() {
  setStatus(K('exporting'));
  try {
    const body = await post(bootstrap.exportUrl, payloadBase());
    setStatus(`${K('exported')} — ${body.handoff_path || ''}`, 'success');
    if (body.minutes_preview) {
      model.preview = body.minutes_preview;
      renderPreview();
    }
  } catch (error) {
    setStatus(`${K('export_failed')}: ${errorText(error)}`, 'danger');
  }
}

async function createMinutes() {
  setStatus(K('minutes_running'));
  try {
    const body = await post(bootstrap.minutesUrl, payloadBase());
    model.preview = body.minutes_markdown || '';
    renderPreview();
    setStatus(`${K('minutes_done')} — ${body.minutes_path || ''}`, 'success');
  } catch (error) {
    setStatus(`${K('minutes_failed')}: ${errorText(error)}`, 'danger');
  }
}

function restoreDraft() {
  const draft = readDraft();
  if (!draft) {
    setStatus(K('no_draft'));
    return;
  }
  applyDraft(draft);
  renderFields();
  renderMoreFields();
  renderAttachments();
  setStatus(K('draft_restored'), 'success');
}

function clearAll() {
  model.title = '';
  model.notes = '';
  model.transcript = '';
  model.instruction = '';
  model.attachments = [];
  model.preview = '';
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
  renderFields();
  renderMoreFields();
  renderAttachments();
  renderPreview();
  setStatus(K('cleared'));
}

// -- recording → transcription -----------------------------------------------

function onRecording(payload) {
  if (!payload || !payload.file) return;
  rec.chunks.push(payload.file);
  if (payload.file.type) rec.mime = payload.file.type;
  if (payload.final) {
    rec.finalChunks = rec.chunks;
    rec.chunks = [];
  }
  pumpTranscription();
}

async function pumpTranscription() {
  if (rec.busy) {
    rec.again = true;
    return;
  }
  const final = Boolean(rec.finalChunks);
  const chunks = final ? rec.finalChunks : rec.chunks;
  if (chunks.length === 0) return;
  const blob = new Blob(chunks, { type: rec.mime || 'audio/webm' });
  if (!final) {
    if (!rec.live || Date.now() - rec.lastPass < LIVE_PASS_MIN_INTERVAL_MS) return;
    if (blob.size > LIVE_PASS_MAX_BYTES) {
      rec.live = false;
      renderRecordState();
      return;
    }
  }
  if (rec.base === null) rec.base = model.transcript;
  const base = rec.base;
  if (final) {
    rec.finalChunks = null;
    rec.base = null;
    rec.live = true;
  }
  rec.busy = true;
  rec.lastPass = Date.now();
  renderRecordState();
  try {
    const body = await post(bootstrap.transcribeUrl, {
      audio_base64: await blobToBase64(blob),
      mime: blob.type || 'audio/webm',
      language: bootstrap.language,
    });
    const text = String(body.text || '').trim();
    if (!final && (body.backend === 'unavailable' || !text)) rec.live = false;
    model.transcript = joinText(base, text, '\n');
    setControl('mn-transcript', model.transcript);
    saveDraft();
    if (final) setStatus(`${K('recording_stopped')}${text ? ' + STT' : ''}`, 'success');
  } catch (error) {
    setStatus(`${K('recording_error')}: ${errorText(error)}`, 'danger');
    if (!final) rec.live = false;
  } finally {
    rec.busy = false;
    renderRecordState();
    if (rec.again || rec.finalChunks) {
      rec.again = false;
      pumpTranscription();
    }
  }
}

function onVoiceState(payload) {
  if (!payload || payload.name !== 'record') return;
  const recording = payload.state === 'recording';
  if (recording && !rec.recording) {
    rec.live = true;
    rec.lastPass = Date.now();
    setStatus(K('recording'));
  }
  rec.recording = recording;
  renderRecordState();
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'toolbar.click':
      if (payload.id === 'minutes') void createMinutes();
      else if (payload.id === 'handoff') void handoff();
      else if (payload.id === 'restore') restoreDraft();
      else if (payload.id === 'clear')
        askToConfirm({
          title: K('clear_confirm'),
          message: K('clear_confirm_body'),
          tone: 'danger',
          confirmLabel: K('clear'),
          run: clearAll,
        });
      return;
    case 'toolbar.toggle':
      if (payload.id === 'camera') {
        cameraOpen = payload.pressed === true;
        renderCamera();
      }
      return;
    case 'toolbar.files':
      void addFiles(Array.from(payload.files || []));
      return;
    case 'file.add':
      void addFiles(Array.from(payload.files || []));
      return;
    case 'file.remove':
      removeAttachment(payload.file_id);
      return;
    case 'camera.capture':
      if (payload.file)
        void addFiles([payload.file], (file) => {
          const ext = /png/.test(file.type || '') ? 'png' : 'jpg';
          return `camera-${Date.now()}.${ext}`;
        });
      return;
    case 'field.change':
      if (TEXT_FIELDS.includes(payload.name) && typeof payload.value === 'string') {
        model[payload.name] = payload.value;
        saveDraft();
      }
      return;
    case 'voice.transcript':
      if (payload.name === 'dictation' && payload.final && payload.text) {
        model.notes = joinText(model.notes, payload.text, ' ');
        setControl('mn-notes', model.notes);
        saveDraft();
      }
      return;
    case 'voice.recording':
      if (payload.name === 'record') onRecording(payload);
      return;
    case 'voice.state':
      onVoiceState(payload);
      return;
    case 'voice.error':
      // The voice input shows the localized reason itself; the toolbar only flags it.
      setStatus(payload.name === 'record' ? K('recording_error') : K('voice_error'), 'danger');
      return;
    case 'dialog.confirm': {
      const pending = dialog;
      dialog = null;
      renderDialog();
      if (pending && typeof pending.run === 'function') pending.run();
      return;
    }
    case 'dialog.cancel':
      dialog = null;
      renderDialog();
      return;
    default:
  }
}

// -- boot ------------------------------------------------------------------

const initialDraft = readDraft();
if (
  initialDraft &&
  (initialDraft.notes ||
    initialDraft.transcript ||
    initialDraft.instruction ||
    (Array.isArray(initialDraft.attachments) && initialDraft.attachments.length))
) {
  applyDraft(initialDraft);
}
renderToolbar();
renderFields();
renderVoiceInputs();
renderRecordState();
renderMoreFields();
renderAttachments();
renderCamera();
renderPreview();
renderDialog();
