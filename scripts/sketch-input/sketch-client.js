/*
 * sketch-client.js — browser module of the sketch-input pad (PA-04), inlined
 * into the page by `sketch-page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Every control is a shared `kyberion-base` component, each stateful one in
 * its own container (renderA2UI replaces the whole container):
 *   #sk-toolbar     ui:toolbar      hand off + status (re-rendered for status only)
 *   #sk-board       ui:sketch-board palette + canvas + clear dialog + PNG download
 *   #sk-instruction ui:textarea     instruction (kept in the model, never re-rendered)
 *   #sk-voice       ui:voice-input  dictation; final text is appended to the instruction
 *
 * Export contract (unchanged): POST bootstrap.exportUrl with header
 * `X-SK-Token` and JSON `{ png_base64, instruction, width, height }`.
 * No user-visible text lives here — everything comes from the bootstrap.
 */
/* global document, FileReader */
import { bootPad } from '/pad-ui/pad-client.js';

const BOARD_NAME = 'sketch-input';
const INSTRUCTION_NAME = 'instruction';

const host = {
  toolbar: document.getElementById('sk-toolbar'),
  board: document.getElementById('sk-board'),
  instruction: document.getElementById('sk-instruction'),
  voice: document.getElementById('sk-voice'),
};

let controller = null;
let busy = false;
let instruction = '';
let status = { text: '', tone: 'neutral' };

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const canvas = bootstrap.canvas || { width: 1280, height: 720 };
instruction = typeof bootstrap.defaultInstruction === 'string' ? bootstrap.defaultInstruction : '';
status = { text: t('sketch_input:ready'), tone: 'neutral' };

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

/** Re-render the toolbar, keeping keyboard focus on the same item. */
function renderToolbar() {
  const active = document.activeElement;
  const focusedId =
    active && host.toolbar.contains(active) ? active.getAttribute('data-item-id') : null;
  pad.render(host.toolbar, [
    {
      id: 'sk-toolbar',
      type: 'ui:toolbar',
      props: {
        label: t('sketch_input:toolbar_label'),
        sticky: true,
        items: [
          {
            type: 'button',
            id: 'handoff',
            label: t('sketch_input:handoff'),
            variant: 'primary',
            disabled: busy || !controller,
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

async function handoff() {
  if (!controller || busy) return;
  busy = true;
  setStatus(t('sketch_input:exporting'), 'info');
  try {
    const blob = await controller.toBlob();
    const response = await fetch(bootstrap.exportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SK-Token': bootstrap.token },
      body: JSON.stringify({
        png_base64: await blobToBase64(blob),
        instruction,
        width: canvas.width,
        height: canvas.height,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    busy = false;
    setStatus(t('sketch_input:exported_detail', { detail: text }), 'success');
  } catch (error) {
    busy = false;
    setStatus(t('sketch_input:export_failed_detail', { error: errorText(error) }), 'danger');
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
    case 'toolbar.click':
      if (payload.id === 'handoff') void handoff();
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

renderToolbar();
pad.render(host.board, [
  {
    id: 'sk-board',
    type: 'ui:sketch-board',
    props: {
      name: BOARD_NAME,
      label: t('sketch_input:board_label'),
      tools: ['pen', 'rect', 'ellipse', 'line', 'arrow', 'text', 'eraser'],
      background: 'dark',
      canvas_width: canvas.width,
      canvas_height: canvas.height,
      show_download: true,
    },
  },
]);
pad.render(host.instruction, [
  {
    id: 'sk-instruction',
    type: 'ui:textarea',
    props: {
      name: INSTRUCTION_NAME,
      label: t('sketch_input:instruction'),
      placeholder: t('sketch_input:instruction_placeholder'),
      rows: 3,
      value: instruction,
    },
  },
]);
pad.render(host.voice, [
  {
    id: 'sk-voice',
    type: 'ui:voice-input',
    props: {
      name: 'instruction-voice',
      label: t('sketch_input:voice_label'),
      mode: 'dictation',
      continuous: true,
      show_transcript: true,
      help: t('sketch_input:dictation_note'),
    },
  },
]);
