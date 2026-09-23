/*
 * inbox-client.js — browser module of the clipboard-inbox pad (PA-06),
 * inlined into the page by `page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Hosts (renderA2UI replaces a whole container, so each group has its own):
 *   #ci-toolbar     ui:toolbar   pull / add / hand off / clear all (danger) + status
 *   #ci-items       ui:section + ui:list (title, size + preview, Delete row action) or ui:empty-state
 *   #ci-new         ui:textarea + ui:text-field  new text + label (values live in the model)
 *   #ci-instruction ui:textarea + ui:callout     instruction + secrets reminder + output path
 *   #pad-dialog     ui:dialog    clear-all confirmation
 *
 * Server contract (unchanged): POST exportUrl `{ items: [{ id, text, label }], instruction }`
 * and POST clipboardReadUrl `{}` → `{ ok, text, label }`, both with header `X-CI-Token`.
 */
/* global document */
import { bootPad } from '/pad-ui/pad-client.js';

const PREVIEW_CHARS = 120;

const host = {
  toolbar: document.getElementById('ci-toolbar'),
  items: document.getElementById('ci-items'),
  fresh: document.getElementById('ci-new'),
  instruction: document.getElementById('ci-instruction'),
  dialog: document.getElementById('pad-dialog'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`clipboard_inbox:${key}`);

const model = {
  items: [],
  text: '',
  label: '',
  instruction: String(bootstrap.defaultInstruction || ''),
};
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
    headers: { 'Content-Type': 'application/json', 'X-CI-Token': bootstrap.token },
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

function addItem(text, label) {
  const value = String(text || '').trim();
  if (!value) return false;
  model.items.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text: value,
    label: String(label || '').trim(),
  });
  return true;
}

// -- rendering -------------------------------------------------------------

function renderToolbar() {
  pad.render(host.toolbar, [
    {
      id: 'ci-toolbar',
      type: 'ui:toolbar',
      props: {
        label: K('toolbar_label'),
        items: [
          { type: 'button', id: 'pull', label: K('pull'), icon: '📋', variant: 'secondary' },
          { type: 'button', id: 'add', label: K('add'), icon: '+', variant: 'secondary' },
          { type: 'separator' },
          { type: 'button', id: 'handoff', label: K('handoff'), variant: 'primary' },
          { type: 'button', id: 'clear', label: K('clear_all'), variant: 'danger' },
          { type: 'spacer' },
          { type: 'status', id: 'status', text: K('ready') },
        ],
      },
    },
  ]);
}

function renderItems() {
  if (model.items.length === 0) {
    pad.render(host.items, [
      {
        id: 'ci-items-section',
        type: 'ui:section',
        props: { title: K('items') },
        children: ['ci-items-empty'],
      },
      {
        id: 'ci-items-empty',
        type: 'ui:empty-state',
        props: { title: K('empty'), body: K('empty_body') },
      },
    ]);
    return;
  }
  const items = model.items.map((item, index) => {
    const flat = item.text.replace(/\s+/g, ' ');
    const preview = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
    return {
      title: item.label || t('clipboard_inbox:item_title', { index: index + 1 }),
      meta: `${t('clipboard_inbox:item_meta', { count: item.text.length })} · ${preview}`,
      actions: [
        {
          label: K('delete'),
          variant: 'ghost',
          action: { id: 'clip.remove', payload: { item_id: item.id } },
        },
      ],
    };
  });
  const components = [
    {
      id: 'ci-items-section',
      type: 'ui:section',
      props: { title: K('items') },
      children: ['ci-items-list'],
    },
    { id: 'ci-items-list', type: 'ui:list', props: { items } },
  ];
  pad.render(host.items, components);
}

function renderNew() {
  pad.render(host.fresh, [
    {
      id: 'ci-new-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['ci-new-text', 'ci-new-label'],
    },
    {
      id: 'ci-new-text',
      type: 'ui:textarea',
      props: {
        name: 'text',
        label: K('new_item'),
        placeholder: K('new_placeholder'),
        rows: 5,
        value: model.text,
      },
    },
    {
      id: 'ci-new-label',
      type: 'ui:text-field',
      props: {
        name: 'label',
        label: K('label'),
        placeholder: K('label_placeholder'),
        value: model.label,
      },
    },
  ]);
}

function renderInstruction() {
  pad.render(host.instruction, [
    {
      id: 'ci-instruction-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['ci-instruction-field', 'ci-redact', 'ci-out'],
    },
    {
      id: 'ci-instruction-field',
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
      id: 'ci-redact',
      type: 'ui:callout',
      props: { tone: 'warning', title: K('redact_title'), body: K('redact_hint') },
    },
    {
      id: 'ci-out',
      type: 'ui:text',
      props: {
        text: t('clipboard_inbox:out_path', { path: bootstrap.outLabel }),
        variant: 'caption',
      },
    },
  ]);
}

function renderDialog() {
  pad.render(host.dialog, [
    {
      id: 'ci-dialog',
      type: 'ui:dialog',
      props: dialogOpen
        ? {
            open: true,
            title: K('clear_confirm'),
            message: K('clear_confirm_body'),
            tone: 'danger',
            confirm_label: K('clear_all'),
          }
        : { open: false, title: K('clear_confirm') },
    },
  ]);
}

// -- actions ---------------------------------------------------------------

function addFromFields() {
  if (!addItem(model.text, model.label)) {
    setStatus(K('need_text'), 'warning');
    return;
  }
  model.text = '';
  model.label = '';
  renderNew();
  renderItems();
  setStatus(K('added'), 'success');
}

async function pullClipboard() {
  try {
    const body = await post(bootstrap.clipboardReadUrl, {});
    if (addItem(body.text || '', body.label || 'clipboard')) {
      renderItems();
      setStatus(K('pulled'), 'success');
    } else {
      setStatus(K('pull_fail'), 'warning');
    }
  } catch (error) {
    setStatus(`${K('pull_fail')}: ${errorText(error)}`, 'warning');
  }
}

async function handoff() {
  if (model.items.length === 0) {
    setStatus(K('need_items'), 'warning');
    return;
  }
  setStatus(K('exporting'));
  try {
    const body = await post(bootstrap.exportUrl, {
      items: model.items.map((item) => ({ id: item.id, text: item.text, label: item.label })),
      instruction: model.instruction,
    });
    setStatus(`${K('exported')} — ${body.session_dir || ''}`, 'success');
  } catch (error) {
    setStatus(`${K('export_failed')}: ${errorText(error)}`, 'danger');
  }
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'toolbar.click':
      if (payload.id === 'add') addFromFields();
      else if (payload.id === 'pull') void pullClipboard();
      else if (payload.id === 'handoff') void handoff();
      else if (payload.id === 'clear') {
        dialogOpen = true;
        renderDialog();
      }
      return;
    case 'clip.remove':
      model.items = model.items.filter((item) => item.id !== payload.item_id);
      renderItems();
      setStatus(K('removed'));
      return;
    case 'field.change':
      if (
        ['text', 'label', 'instruction'].includes(payload.name) &&
        typeof payload.value === 'string'
      )
        model[payload.name] = payload.value;
      return;
    case 'dialog.confirm':
      dialogOpen = false;
      renderDialog();
      model.items = [];
      renderItems();
      setStatus(K('cleared'));
      return;
    case 'dialog.cancel':
      dialogOpen = false;
      renderDialog();
      return;
    default:
  }
}

renderToolbar();
renderItems();
renderNew();
renderInstruction();
renderDialog();
