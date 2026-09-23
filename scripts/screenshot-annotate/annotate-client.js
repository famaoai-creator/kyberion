/*
 * annotate-client.js — browser module of the screenshot-annotate pad (PA-04),
 * inlined into the page by `page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Every control is a shared `kyberion-base` component, each stateful one in
 * its own container (renderA2UI replaces the whole container):
 *   #sa-toolbar     ui:toolbar      load image (file) / OS capture / hand off / status
 *   #sa-board       ui:sketch-board the image is the board background (drop / paste
 *                                   on the board, or `controller.setBackgroundImage`)
 *   #sa-instruction ui:textarea     instruction (kept in the model, never re-rendered)
 *   #sa-voice       ui:voice-input  dictation; final text is appended to the instruction
 *
 * Server contract (unchanged): POST bootstrap.screenshotUrl / exportUrl with
 * header `X-SA-Token`; export body `{ png_base64, instruction, width, height }`.
 * No user-visible text lives here — everything comes from the bootstrap.
 */
/* global document, window, FileReader, Blob, atob */
import { bootPad } from '/pad-ui/pad-client.js';

const BOARD_NAME = 'screenshot-annotate';
const INSTRUCTION_NAME = 'instruction';

const host = {
  toolbar: document.getElementById('sa-toolbar'),
  board: document.getElementById('sa-board'),
  instruction: document.getElementById('sa-instruction'),
  voice: document.getElementById('sa-voice'),
};

let controller = null;
let busy = false;
let hasImage = false;
let instruction = '';
let status = { text: '', tone: 'neutral' };

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const canvas = bootstrap.canvas || { width: 1280, height: 720 };
instruction = typeof bootstrap.defaultInstruction === 'string' ? bootstrap.defaultInstruction : '';
status = { text: t('screenshot_annotate:ready'), tone: 'neutral' };

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function isImage(file) {
  return Boolean(file) && typeof file.type === 'string' && /^image\//i.test(file.type);
}

/** Re-render the toolbar, keeping keyboard focus on the same item. */
function renderToolbar() {
  const active = document.activeElement;
  const focusedId =
    active && host.toolbar.contains(active) ? active.getAttribute('data-item-id') : null;
  const locked = busy || !controller;
  pad.render(host.toolbar, [
    {
      id: 'sa-toolbar',
      type: 'ui:toolbar',
      props: {
        label: t('screenshot_annotate:toolbar_label'),
        items: [
          {
            type: 'file',
            id: 'load-image',
            label: t('screenshot_annotate:load_image'),
            accept: 'image/*',
            disabled: locked,
          },
          {
            type: 'button',
            id: 'os-capture',
            label: t('screenshot_annotate:os_capture'),
            disabled: locked,
          },
          { type: 'separator' },
          {
            type: 'button',
            id: 'handoff',
            label: t('screenshot_annotate:handoff'),
            variant: 'primary',
            disabled: locked,
          },
          { type: 'spacer' },
          { type: 'status', id: 'status', text: status.text, tone: status.tone },
        ],
      },
    },
  ]);
  if (focusedId) {
    const again = host.toolbar.querySelector(`[data-item-id="${focusedId}"]`);
    if (again && !again.disabled) again.focus();
  }
}

function setStatus(text, tone) {
  status = { text, tone: tone || 'neutral' };
  renderToolbar();
}

function appendInstruction(text) {
  const value = String(text || '').trim();
  if (!value) return;
  instruction = instruction ? `${instruction} ${value}` : value;
  const field = host.instruction.querySelector('textarea');
  if (field) field.value = instruction;
}

async function useImage(source, okKey) {
  if (!controller) return;
  const loaded = await controller.setBackgroundImage(source);
  if (loaded) {
    hasImage = true;
    setStatus(t(okKey || 'screenshot_annotate:image_loaded'), 'success');
  }
}

async function osCapture() {
  if (!controller || busy) return;
  busy = true;
  renderToolbar();
  try {
    const response = await fetch(bootstrap.screenshotUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SA-Token': bootstrap.token },
      body: '{}',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.ok || !body.png_base64) {
      throw new Error((body && body.error) || `HTTP ${response.status}`);
    }
    busy = false;
    await useImage(base64ToBlob(body.png_base64, 'image/png'), 'screenshot_annotate:capture_ok');
  } catch (error) {
    busy = false;
    setStatus(
      t('screenshot_annotate:capture_failed_detail', { error: errorText(error) }),
      'warning'
    );
  }
}

async function handoff() {
  if (!controller || busy) return;
  if (!hasImage) {
    setStatus(t('screenshot_annotate:image_needed'), 'warning');
    return;
  }
  busy = true;
  setStatus(t('screenshot_annotate:exporting'), 'info');
  try {
    const blob = await controller.toBlob();
    const response = await fetch(bootstrap.exportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SA-Token': bootstrap.token },
      body: JSON.stringify({
        png_base64: await blobToBase64(blob),
        instruction,
        width: canvas.width,
        height: canvas.height,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.ok) {
      throw new Error((body && body.error) || `HTTP ${response.status}`);
    }
    busy = false;
    setStatus(
      t('screenshot_annotate:exported_detail', { path: String(body.image_path || '') }),
      'success'
    );
  } catch (error) {
    busy = false;
    setStatus(t('screenshot_annotate:export_failed_detail', { error: errorText(error) }), 'danger');
  }
}

function handleAction(action) {
  const payload = (action && action.payload) || {};
  switch (action && action.id) {
    case 'drawing.ready':
      if (payload.name === BOARD_NAME) {
        controller = payload.controller;
        renderToolbar();
      }
      break;
    case 'drawing.background':
      // The board itself loads a dropped / pasted image; remember that one exists.
      if (payload.name === BOARD_NAME && isImage(payload.file)) {
        hasImage = true;
        setStatus(t('screenshot_annotate:image_loaded'), 'success');
      }
      break;
    case 'toolbar.files':
      if (payload.id === 'load-image') {
        const file = Array.isArray(payload.files) ? payload.files[0] : null;
        if (isImage(file)) void useImage(file);
      }
      break;
    case 'toolbar.click':
      if (payload.id === 'os-capture') void osCapture();
      else if (payload.id === 'handoff') void handoff();
      break;
    case 'field.change':
      if (payload.name === INSTRUCTION_NAME) instruction = String(payload.value ?? '');
      break;
    case 'voice.transcript':
      if (payload.final) appendInstruction(payload.text);
      break;
    default:
      break;
  }
}

// A pasted screenshot anywhere on the page (the board handles paste only while
// it has focus; text fields keep their own paste).
window.addEventListener('paste', (event) => {
  if (event.defaultPrevented || !event.clipboardData) return;
  const target = event.target;
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
  const files = Array.from(event.clipboardData.files || []);
  const file = files.find(isImage);
  if (!file) return;
  event.preventDefault();
  void useImage(file);
});

renderToolbar();
pad.render(host.board, [
  {
    id: 'sa-board',
    type: 'ui:sketch-board',
    props: {
      name: BOARD_NAME,
      label: t('screenshot_annotate:board_label'),
      tools: ['pen', 'rect', 'arrow', 'text', 'eraser'],
      background: 'dark',
      default_color: '#ff5533',
      canvas_width: canvas.width,
      canvas_height: canvas.height,
      accept_image_drop: true,
      show_download: true,
    },
  },
]);
pad.render(host.instruction, [
  {
    id: 'sa-instruction',
    type: 'ui:textarea',
    props: {
      name: INSTRUCTION_NAME,
      label: t('screenshot_annotate:instruction'),
      placeholder: t('screenshot_annotate:instruction_placeholder'),
      rows: 3,
      value: instruction,
    },
  },
]);
pad.render(host.voice, [
  {
    id: 'sa-voice',
    type: 'ui:voice-input',
    props: {
      name: 'instruction-voice',
      label: t('screenshot_annotate:voice_label'),
      mode: 'dictation',
      continuous: true,
      show_transcript: true,
      help: t('screenshot_annotate:dictation_note'),
    },
  },
]);
