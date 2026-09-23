// UI-01c: settings & form components in the vanilla renderer (forms.js).
//
// Runs on `mini-dom.test-support.ts` (see kyberion-ui.test.ts for why). Covers
// the interaction contract (field.change / declared actions), file screening
// for picked / dropped / pasted files, the secret-field guarantees (the value
// never reaches markup, props or field.change; the input clears after submit)
// and the camera lifecycle (explicit start, fallback without getUserMedia,
// every track stopped on capture / confirm / cancel / re-render / pagehide).
import { describe, expect, it, vi } from 'vitest';
import { getUiMessageBundle } from '@agent/core';
import { KB_FORM_ACTIONS as CORE_FORM_ACTIONS } from '@agent/core/a2ui-catalog';
import { disposeA2UI, renderA2UI } from './kyberion-ui.js';
import {
  KB_FORM_ACTIONS,
  KB_FORM_MESSAGE_KEYS,
  centerCrop,
  createCameraController,
  describeAccept,
  fileMatchesAccept,
  formatBytes,
  formFieldIds,
  screenFiles,
  secretFieldNotice,
  secretStatusText,
  sliderValueText,
} from './forms.js';
import { MiniDocument, MiniElement, MiniText } from './mini-dom.test-support.js';

type Action = { id: string; payload?: Record<string, unknown> };

const JA = getUiMessageBundle('ja');
const EN = getUiMessageBundle('en');

function mount(
  components: unknown[],
  options: Record<string, unknown> = {},
  document: MiniDocument = new MiniDocument()
) {
  const root = document.createElement('div');
  const actions: Action[] = [];
  renderA2UI(
    root as unknown as Element,
    components as never,
    {
      document: document as unknown as Document,
      onAction: (action: Action) => actions.push(action),
      ...options,
    } as never
  );
  return { root, actions, document };
}

function one(type: string, props: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return mount([{ id: 'c1', type, props }], options);
}

/** Every attribute value and text node in the tree (what could leak into markup). */
function serialize(node: MiniElement): string {
  const parts: string[] = [node.tagName];
  for (const name of node.getAttributeNames()) parts.push(`${name}=${node.getAttribute(name)}`);
  for (const child of node.childNodes) {
    if (child instanceof MiniText) parts.push(child.data);
    else if (child instanceof MiniElement) parts.push(serialize(child));
  }
  return parts.join('|');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function file(name: string, size: number, type: string): File {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('forms.js pure helpers', () => {
  it('mirrors the core action ids', () => {
    expect({ ...KB_FORM_ACTIONS }).toEqual({ ...CORE_FORM_ACTIONS });
  });

  it('every message key has en + ja text', () => {
    for (const key of Object.values(KB_FORM_MESSAGE_KEYS)) {
      expect(EN.messages[key], key).toMatch(/\S/);
      expect(JA.messages[key], key).toMatch(/\S/);
    }
  });

  it('derives deterministic, attribute-safe ids', () => {
    expect(formFieldIds('fi-name', 'x').input).toBe('kbf-fi-name');
    expect(formFieldIds(undefined, 'profile.name').help).toBe('kbf-profile-name-help');
    expect(formFieldIds('a b"<', 'x').input).toBe('kbf-a-b--');
  });

  it('formats bytes, accept lists and slider values', () => {
    expect(formatBytes(26214400)).toBe('25 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(-1)).toBe('');
    expect(describeAccept('.pdf, image/*')).toBe('PDF, image/*');
    expect(sliderValueText(40, '%')).toBe('40%');
    expect(sliderValueText(3, 'min')).toBe('3 min');
    expect(centerCrop(640, 480, 'square')).toEqual({ sx: 80, sy: 0, sw: 480, sh: 480 });
  });

  it('screens files by type, size and count', () => {
    expect(fileMatchesAccept({ name: 'A.PDF', type: '' }, '.pdf')).toBe(true);
    expect(fileMatchesAccept({ name: 'x.png', type: 'image/png' }, 'image/*')).toBe(true);
    expect(fileMatchesAccept({ name: 'x.exe', type: 'application/x' }, '.pdf,image/*')).toBe(false);
    const files = [
      file('a.pdf', 10, 'application/pdf'),
      file('b.exe', 10, 'application/x-msdownload'),
      file('c.pdf', 999, 'application/pdf'),
      file('d.pdf', 10, 'application/pdf'),
      file('e.pdf', 10, 'application/pdf'),
    ];
    const result = screenFiles(
      files,
      { accept: '.pdf', max_bytes: 100, multiple: true, max_files: 3 },
      1
    );
    expect(result.accepted.map((f) => f.name)).toEqual(['a.pdf', 'd.pdf']);
    expect(result.rejected).toEqual([
      { name: 'b.exe', size: 10, reason: 'type' },
      { name: 'c.pdf', size: 999, reason: 'size' },
      { name: 'e.pdf', size: 10, reason: 'count' },
    ]);
    expect(screenFiles(files.slice(0, 1).concat(files.slice(3)), {}).accepted).toHaveLength(1);
  });

  it('secret status shows only "set" and at most the last four characters', () => {
    const t = (key: string, params?: Record<string, unknown>) =>
      `${key}${params ? JSON.stringify(params) : ''}`;
    expect(secretStatusText({ configured: true, last4: 'Q7xk' }, t)).toBe(
      'ui:secret_configured{"last4":"Q7xk"}'
    );
    expect(secretStatusText({ configured: true, last4: 'too-long!' }, t)).toBe(
      'ui:secret_configured_plain'
    );
    expect(secretStatusText({}, t)).toBe('ui:secret_not_configured');
  });

  it('secret outcome: a local submit stays pending until the host status changes', () => {
    const t = (key: string) => key;
    expect(secretFieldNotice({}, null, t)).toEqual({ status: 'idle', text: '' });
    const submitted = { kind: 'submitted', under: 'idle' } as const;
    expect(secretFieldNotice({}, submitted, t)).toEqual({
      status: 'pending',
      text: 'ui:secret_pending',
    });
    // Host moved on: its outcome wins over the local submit.
    expect(secretFieldNotice({ status: 'saved' }, submitted, t).status).toBe('saved');
    expect(secretFieldNotice({ status: 'error' }, submitted, t)).toEqual({
      status: 'error',
      text: 'ui:secret_error',
    });
    // A re-submit under an old "saved" is pending again, never "saved".
    const resubmitted = { kind: 'submitted', under: 'saved' } as const;
    expect(secretFieldNotice({ status: 'saved' }, resubmitted, t).status).toBe('pending');
    // Typing again hides the old outcome until the host changes it.
    const dismissed = { kind: 'dismissed', under: 'error' } as const;
    expect(secretFieldNotice({ status: 'error' }, dismissed, t)).toEqual({
      status: 'idle',
      text: '',
    });
    expect(secretFieldNotice({ status: 'error', status_error: '  Nope  ' }, null, t).text).toBe(
      'Nope'
    );
  });
});

describe('controlled fields dispatch field.change { name, value }', () => {
  it('text-field: label[for], aria-describedby help+error, aria-invalid, required marker', () => {
    const { root, actions } = one('ui:text-field', {
      name: 'profile.email',
      label: 'Email',
      type: 'email',
      value: 'a@b',
      help: 'Work address',
      error: 'Invalid',
      required: true,
      maxlength: 80,
    });
    const field = root.query('.kb-field')!;
    expect(field.getAttribute('data-control')).toBe('text-field');
    expect(field.getAttribute('data-invalid')).toBe('true');
    const label = field.query('label.kb-field__label')!;
    const input = field.query('input.kb-input')!;
    expect(label.getAttribute('for')).toBe(input.getAttribute('id'));
    expect(label.query('.kb-field__required')!.getAttribute('aria-hidden')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('kbf-c1-help kbf-c1-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('maxlength')).toBe('80');
    expect(field.query('[id="kbf-c1-help"]')!.textContent).toBe('Work address');
    expect(field.query('[id="kbf-c1-error"]')!.textContent).toBe('Invalid');
    expect((input as unknown as { value: string }).value).toBe('a@b');
    (input as unknown as { value: string }).value = 'a@b.co';
    input.dispatch('input');
    expect(actions).toEqual([
      { id: 'field.change', payload: { name: 'profile.email', value: 'a@b.co' } },
    ]);
  });

  it('text-field type=number reports numbers', () => {
    const { root, actions } = one('ui:text-field', { name: 'n', label: 'N', type: 'number' });
    const input = root.query('input')! as unknown as MiniElement & { value: string };
    input.value = '12';
    input.dispatch('input');
    input.value = '';
    input.dispatch('input');
    expect(actions.map((a) => a.payload!.value)).toEqual([12, '']);
  });

  it('switch / checkbox report booleans; switch has role=switch', () => {
    const { root, actions } = one('ui:switch', { name: 'notify', label: 'Notify', value: false });
    const input = root.query('input.kb-switch__input')! as MiniElement & { checked: boolean };
    expect(input.getAttribute('role')).toBe('switch');
    expect(root.query('.kb-switch__track')!.getAttribute('aria-hidden')).toBe('true');
    input.checked = true;
    input.dispatch('change');
    expect(actions).toEqual([{ id: 'field.change', payload: { name: 'notify', value: true } }]);
    const hidden = one('ui:checkbox', { name: 'x', label: 'X', hide_label: true });
    expect(hidden.root.query('.kb-check__label')!.classList.contains('kb-visually-hidden')).toBe(
      true
    );
  });

  it('select renders a placeholder when no option matches and reports the chosen value', () => {
    const { root, actions } = one('ui:select', {
      name: 'lang',
      label: 'Language',
      options: [
        { value: 'en', label: 'English' },
        { value: 'ja', label: 'Japanese' },
      ],
    });
    const select = root.query('select.kb-select')!;
    expect(select.children[0].textContent).toBe('Select…');
    select.value = 'ja';
    select.dispatch('change');
    expect(actions[0]).toEqual({ id: 'field.change', payload: { name: 'lang', value: 'ja' } });
    const ja = one(
      'ui:select',
      { name: 'x', label: 'X', options: [{ value: 'a', label: 'A' }] },
      { locale: 'ja', messages: JA.messages }
    );
    expect(ja.root.query('option')!.textContent).toBe(JA.messages['ui:select_placeholder']);
  });

  it('radio-group / segmented: one radio group per component, option descriptions linked', () => {
    const { root, actions } = one('ui:radio-group', {
      name: 'mode',
      label: 'Mode',
      value: 'a',
      options: [
        { value: 'a', label: 'A', description: 'first' },
        { value: 'b', label: 'B', disabled: true },
      ],
    });
    const radios = root.queryAll('input.kb-check__input') as Array<
      MiniElement & { checked: boolean }
    >;
    expect(radios.map((r) => r.getAttribute('name'))).toEqual(['kbf-c1', 'kbf-c1']);
    expect(radios[0].checked).toBe(true);
    expect(radios[0].getAttribute('aria-describedby')).toBe('kbf-c1-0-description');
    expect(root.query('label.kb-check[data-disabled="true"]')).not.toBeNull();
    radios[1].checked = true;
    radios[1].dispatch('change');
    expect(actions).toEqual([{ id: 'field.change', payload: { name: 'mode', value: 'b' } }]);
    const seg = one('ui:segmented', {
      name: 'd',
      label: 'D',
      options: [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
      ],
    });
    expect(seg.root.query('fieldset.kb-segmented > legend.kb-field__label')).not.toBeNull();
    expect(seg.root.queryAll('.kb-segmented__option')).toHaveLength(2);
  });

  it('slider updates the visible value and aria-valuetext', () => {
    const { root, actions } = one('ui:slider', {
      name: 'vol',
      label: 'Volume',
      value: 40,
      unit: '%',
    });
    const input = root.query('input.kb-slider')! as MiniElement & { value: string };
    expect(input.getAttribute('aria-valuetext')).toBe('40%');
    input.value = '55';
    input.dispatch('input');
    expect(root.query('.kb-slider__value')!.textContent).toBe('55%');
    expect(input.getAttribute('aria-valuetext')).toBe('55%');
    expect(actions).toEqual([{ id: 'field.change', payload: { name: 'vol', value: 55 } }]);
  });

  it('textarea counts characters against maxlength', () => {
    const { root } = one('ui:textarea', { name: 'n', label: 'N', maxlength: 10, value: 'abc' });
    const area = root.query('textarea')! as MiniElement & { value: string };
    expect(root.query('.kb-field__count')!.textContent).toBe('3 / 10');
    area.value = 'abcdef';
    area.dispatch('input');
    expect(root.query('.kb-field__count')!.textContent).toBe('6 / 10');
  });
});

describe('settings layout, integrations and the save bar', () => {
  it('settings-group labels its section and setting-row hosts one control', () => {
    const { root } = mount([
      { id: 'g', type: 'ui:settings-group', props: { title: 'Notifications' }, children: ['r'] },
      {
        id: 'r',
        type: 'ui:setting-row',
        props: { label: 'Email', tone: 'danger' },
        children: ['s'],
      },
      { id: 's', type: 'ui:switch', props: { name: 's', label: 'Email', hide_label: true } },
    ]);
    const group = root.query('section.kb-settings-group')!;
    expect(group.getAttribute('aria-labelledby')).toBe('kbf-g-title');
    expect(group.query('h2.kb-settings-group__title')!.getAttribute('id')).toBe('kbf-g-title');
    const row = group.query('.kb-settings-group__rows > .kb-setting-row')!;
    expect(row.getAttribute('data-tone')).toBe('danger');
    expect(row.query('.kb-setting-row__control > .kb-field[data-control="switch"]')).not.toBeNull();
  });

  it('integration-item: state pill with localized label (not color-only) and actions', () => {
    const { root, actions } = one(
      'ui:integration-item',
      {
        title: 'Slack',
        state: 'needs_reauth',
        actions: [
          { label: '再接続', action: { id: 'oauth.begin', payload: { service_id: 'slack' } } },
        ],
      },
      { locale: 'ja', messages: JA.messages }
    );
    const item = root.query('.kb-integration')!;
    expect(item.getAttribute('data-state')).toBe('needs_reauth');
    const pill = item.query('.kb-status-pill')!;
    expect(pill.getAttribute('data-status')).toBe('needs_setup');
    expect(pill.query('.kb-status-pill__label')!.textContent).toBe(
      JA.messages['ui:integration_needs_reauth']
    );
    item.query('.kb-integration__actions button')!.click();
    expect(actions).toEqual([{ id: 'oauth.begin', payload: { service_id: 'slack' } }]);
  });

  it('save-bar: region + status message; buttons enabled only while dirty/error', () => {
    const dirty = one('ui:save-bar', {
      state: 'dirty',
      save_action: { id: 'settings.save' },
      discard_action: { id: 'settings.discard' },
    });
    const bar = dirty.root.query('.kb-save-bar')!;
    expect(bar.getAttribute('role')).toBe('region');
    expect(bar.getAttribute('aria-label')).toBe('Unsaved changes');
    expect(bar.query('.kb-save-bar__message')!.getAttribute('role')).toBe('status');
    const [discard, save] = bar.queryAll('button');
    expect(discard.className).toContain('kb-btn--ghost');
    save.click();
    discard.click();
    expect(dirty.actions.map((a) => a.id)).toEqual(['settings.save', 'settings.discard']);
    const saving = one('ui:save-bar', { state: 'saving', save_action: { id: 's' } });
    const button = saving.root.query('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(saving.root.query('.kb-save-bar__message')!.textContent).toBe('Saving…');
  });
});

describe('ui:file-drop', () => {
  const props = {
    name: 'docs',
    label: 'Documents',
    accept: '.pdf',
    multiple: true,
    max_bytes: 1000,
    max_files: 3,
    action: { id: 'ingest.upload', payload: { tenant: 'acme' } },
    files: [{ id: 'f1', name: 'old.pdf', size: 10, status: 'uploading', progress: 40 }],
  };

  it('is a keyboard-focusable file input labelled by the field label, with hint text', () => {
    const { root } = one('ui:file-drop', props);
    const input = root.query('input.kb-file-drop__input')!;
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('accept')).toBe('.pdf');
    expect(input.classList.contains('kb-visually-hidden')).toBe(true);
    expect(input.getAttribute('aria-labelledby')).toBe('kbf-c1-label');
    expect(input.getAttribute('aria-describedby')).toBe('kbf-c1-hint');
    expect(root.query('label.kb-file-drop__zone')!.getAttribute('for')).toBe(
      input.getAttribute('id')
    );
    expect(root.query('.kb-file-drop__hint')!.textContent).toBe(
      'Accepted: PDF · Up to 1000 B each · Up to 3 files'
    );
    expect(root.query('.kb-file-drop__notice')!.getAttribute('role')).toBe('status');
  });

  it('drop: accepted File objects go to the action payload only; rejections are announced', () => {
    const { root, actions } = one('ui:file-drop', props);
    const zone = root.query('.kb-file-drop__zone')!;
    const prevented: string[] = [];
    zone.dispatch('dragover', { preventDefault: () => prevented.push('over') });
    expect(root.query('.kb-file-drop')!.getAttribute('data-dragging')).toBe('true');
    const ok = file('a.pdf', 100, 'application/pdf');
    const big = file('big.pdf', 5000, 'application/pdf');
    zone.dispatch('drop', {
      preventDefault: () => prevented.push('drop'),
      dataTransfer: { files: [ok, big] },
    });
    expect(prevented).toEqual(['over', 'drop']);
    expect(root.query('.kb-file-drop')!.hasAttribute('data-dragging')).toBe(false);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('ingest.upload');
    expect(actions[0].payload!.tenant).toBe('acme');
    expect(actions[0].payload!.name).toBe('docs');
    expect(actions[0].payload!.files).toEqual([ok]);
    expect((actions[0].payload!.files as File[])[0]).toBe(ok);
    expect(actions[0].payload!.rejected).toEqual([{ name: 'big.pdf', size: 5000, reason: 'size' }]);
    expect(root.query('.kb-file-drop__notice')!.textContent).toBe('big.pdf is larger than 1000 B');
    // File contents never reach markup.
    expect(serialize(root)).not.toContain('a.pdf');
  });

  it('paste and click-to-pick feed the same path; the input is reset for re-picking', () => {
    const { root, actions } = one('ui:file-drop', props);
    const pasted = file('p.pdf', 10, 'application/pdf');
    let prevented = false;
    root.query('.kb-file-drop')!.dispatch('paste', {
      preventDefault: () => (prevented = true),
      clipboardData: { files: [pasted] },
    });
    expect(prevented).toBe(true);
    const input = root.query('input.kb-file-drop__input')! as MiniElement & {
      files: File[];
      value: string;
    };
    input.files = [file('q.pdf', 10, 'application/pdf'), file('x.exe', 1, 'application/x')];
    input.value = 'C:\\fakepath\\q.pdf';
    input.dispatch('change');
    expect(input.value).toBe('');
    expect(actions.map((a) => (a.payload!.files as File[]).map((f) => f.name))).toEqual([
      ['p.pdf'],
      ['q.pdf'],
    ]);
    expect(root.query('.kb-file-drop__notice')!.textContent).toBe(
      "x.exe isn't an accepted file type"
    );
    // Pasting text (no files) is left alone.
    let textPrevented = false;
    root.query('.kb-file-drop')!.dispatch('paste', {
      preventDefault: () => (textPrevented = true),
      clipboardData: { files: [] },
    });
    expect(textPrevented).toBe(false);
  });

  it('respects max_files against files already listed, and disabled ignores input', () => {
    const { root, actions } = one('ui:file-drop', { ...props, max_files: 2 });
    root.query('.kb-file-drop__zone')!.dispatch('drop', {
      dataTransfer: {
        files: [file('1.pdf', 1, 'application/pdf'), file('2.pdf', 1, 'application/pdf')],
      },
    });
    expect((actions[0].payload!.files as File[]).map((f) => f.name)).toEqual(['1.pdf']);
    expect(root.query('.kb-file-drop__notice')!.textContent).toBe('Only 2 files can be added');
    const disabled = one('ui:file-drop', { ...props, disabled: true });
    disabled.root.query('.kb-file-drop__zone')!.dispatch('drop', {
      dataTransfer: { files: [file('1.pdf', 1, 'application/pdf')] },
    });
    expect(disabled.actions).toEqual([]);
  });

  it('file list: progress, status text and a labelled cancel/remove per entry', () => {
    const { root, actions } = one('ui:file-drop', {
      ...props,
      files: [
        { id: 'f1', name: 'a.pdf', size: 2048, status: 'uploading', progress: 40 },
        { id: 'f2', name: 'b.pdf', status: 'error', error: 'Too big' },
      ],
    });
    const items = root.queryAll('.kb-file-list__item');
    expect(root.query('ul.kb-file-list')!.getAttribute('aria-label')).toBe('Selected files');
    expect(items[0].getAttribute('data-status')).toBe('uploading');
    expect(items[0].query('.kb-file-list__meta')!.textContent).toBe('2 KB · Uploading 40%');
    expect(items[0].query('progress')!.getAttribute('value')).toBe('40');
    expect(items[0].query('button')!.getAttribute('aria-label')).toBe('Cancel upload of a.pdf');
    expect(items[1].query('.kb-file-list__error')!.textContent).toBe('Too big');
    expect(items[1].query('button')!.getAttribute('aria-label')).toBe('Remove b.pdf');
    items[1].query('button')!.click();
    expect(actions).toEqual([{ id: 'file.remove', payload: { name: 'docs', file_id: 'f2' } }]);
  });
});

describe('ui:secret-field keeps the secret out of markup, props and field.change', () => {
  const SECRET = 'sk-live-SUPER-secret-9f8e7d';
  const props = {
    name: 'secrets.openai',
    label: 'API key',
    service_id: 'openai',
    secret_key: 'api_key',
    action: { id: 'secret.introduce', payload: { reason: 'setup' } },
  };

  it('renders a masked, non-autocompleting input without a name', () => {
    const { root } = one('ui:secret-field', props);
    const input = root.query('input.kb-secret-field__input')!;
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.hasAttribute('name')).toBe(false);
    expect(input.hasAttribute('value')).toBe(false);
    const save = root.query('.kb-secret-field__save')!;
    expect(save.disabled).toBe(true);
  });

  it('typing + submit: value only in the action payload, never in DOM / field.change; input cleared', () => {
    const component = { id: 'c1', type: 'ui:secret-field', props };
    const { root, actions } = mount([component]);
    const input = root.query('input.kb-secret-field__input')! as MiniElement & { value: string };
    input.value = SECRET;
    input.dispatch('input');
    expect(root.query('.kb-secret-field__save')!.disabled).toBe(false);
    // Reveal toggles the input type only (the value stays a DOM property).
    const reveal = root.query('.kb-secret-field__toggle')!;
    reveal.click();
    expect(input.getAttribute('type')).toBe('text');
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
    expect(serialize(root)).not.toContain(SECRET);
    expect(actions).toEqual([]); // no field.change for secrets
    root.query('.kb-secret-field__save')!.click();
    expect(actions).toEqual([
      {
        id: 'secret.introduce',
        payload: {
          reason: 'setup',
          name: 'secrets.openai',
          service_id: 'openai',
          secret_key: 'api_key',
          value: SECRET,
        },
      },
    ]);
    expect(input.value).toBe('');
    const after = root.query('input.kb-secret-field__input')! as MiniElement & { value: string };
    expect(after.value ?? '').toBe('');
    expect(after.getAttribute('type')).toBe('password');
    // Submitting is not saving: the field says "sending" until the host
    // reports the outcome through `status`.
    expect(root.query('.kb-secret-field')!.getAttribute('data-status')).toBe('pending');
    expect(root.query('.kb-secret-field__notice')!.textContent).toBe(
      'Sending… The value is not kept on this page.'
    );
    expect(serialize(root)).not.toContain(SECRET);
    expect(JSON.stringify(component)).not.toContain(SECRET);
    // Typing again dismisses the pending notice.
    after.value = 'x';
    after.dispatch('input');
    expect(root.query('.kb-secret-field__notice')!.textContent).toBe('');
    expect(root.query('.kb-secret-field')!.getAttribute('data-status')).toBe('idle');
  });

  it('host status: saved / error (with the host reason) / pending; error reopens the input', () => {
    const saved = one('ui:secret-field', { ...props, configured: true, status: 'saved' });
    expect(saved.root.query('.kb-secret-field')!.getAttribute('data-status')).toBe('saved');
    expect(saved.root.query('.kb-secret-field__notice')!.textContent).toBe(
      'Saved. The value is not kept on this page.'
    );
    const pending = one('ui:secret-field', { ...props, status: 'pending' });
    expect(pending.root.query('.kb-secret-field__notice')!.textContent).toBe(
      'Sending… The value is not kept on this page.'
    );
    const failed = one('ui:secret-field', { ...props, configured: true, status: 'error' });
    const field = failed.root.query('.kb-secret-field')!;
    expect(field.getAttribute('data-status')).toBe('error');
    expect(field.getAttribute('data-state')).toBe('editing');
    expect(failed.root.query('input.kb-secret-field__input')).not.toBeNull();
    expect(failed.root.query('.kb-secret-field__notice')!.textContent).toBe(
      'Could not save the value. Enter it again.'
    );
    const reason = one('ui:secret-field', {
      ...props,
      status: 'error',
      status_error: 'Approval expired.',
    });
    expect(reason.root.query('.kb-secret-field__notice')!.textContent).toBe('Approval expired.');
    const unknown = one('ui:secret-field', { ...props, status: 'done' });
    expect(unknown.root.query('.kb-secret-field')!.getAttribute('data-status')).toBe('idle');
    expect(unknown.root.query('.kb-secret-field__notice')!.textContent).toBe('');
  });

  it('Enter submits; an empty value does not', () => {
    const { root, actions } = one('ui:secret-field', props);
    const input = root.query('input.kb-secret-field__input')! as MiniElement & { value: string };
    input.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(actions).toEqual([]);
    input.value = SECRET;
    input.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(actions[0].payload!.value).toBe(SECRET);
    expect(serialize(root)).not.toContain(SECRET);
  });

  it('configured: shows only "set · ••••last4" with replace / remove; replace focuses a fresh input', () => {
    const { root, actions } = one(
      'ui:secret-field',
      { ...props, configured: true, last4: 'Q7xk', remove_action: { id: 'secret.remove' } },
      { locale: 'ja', messages: JA.messages }
    );
    const field = root.query('.kb-secret-field')!;
    expect(field.getAttribute('data-state')).toBe('configured');
    expect(root.query('input')).toBeNull();
    expect(root.query('.kb-secret-field__status')!.textContent).toBe('設定済み · ••••Q7xk');
    const [replace, remove] = root.queryAll('.kb-secret-field__actions button');
    expect(replace.getAttribute('aria-describedby')).toBe('kbf-c1-status');
    remove.click();
    expect(actions).toEqual([
      {
        id: 'secret.remove',
        payload: { name: 'secrets.openai', service_id: 'openai', secret_key: 'api_key' },
      },
    ]);
    replace.click();
    expect(field.getAttribute('data-state')).toBe('editing');
    const input = root.query('input.kb-secret-field__input')!;
    expect(MiniElement.focused).toBe(input);
    // Cancel returns to the summary and focuses Replace again.
    const cancel = root.queryAll('.kb-secret-field__row button').at(-1)!;
    cancel.click();
    expect(field.getAttribute('data-state')).toBe('configured');
    expect(MiniElement.focused!.textContent).toBe(JA.messages['ui:secret_replace']);
  });

  it('paste reads the clipboard into the input property only', async () => {
    const win = { navigator: { clipboard: { readText: vi.fn(async () => `  ${SECRET}\n`) } } };
    const { root } = one('ui:secret-field', props, { window: win });
    root.query('.kb-secret-field__paste')!.click();
    await tick();
    const input = root.query('input.kb-secret-field__input')! as MiniElement & { value: string };
    expect(input.value).toBe(SECRET);
    expect(root.query('.kb-secret-field__save')!.disabled).toBe(false);
    expect(serialize(root)).not.toContain(SECRET);
    const noClipboard = one('ui:secret-field', props, { window: {} });
    noClipboard.root.query('.kb-secret-field__paste')!.click();
    expect(noClipboard.root.query('.kb-secret-field__notice')!.textContent).toBe(
      'Paste with Ctrl+V or ⌘V'
    );
  });
});

// ---------------------------------------------------------------- camera --

function fakeCamera(options: { deny?: boolean } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const listeners = new Map<string, () => void>();
  const win = {
    navigator: {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          if (options.deny) throw new Error('NotAllowedError');
          return stream;
        }),
      },
    },
    URL: { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() },
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    File,
  };
  return { win, track, stream, listeners };
}

/** A document whose canvases can draw a frame and produce a JPEG blob. */
function canvasDocument() {
  const document = new MiniDocument();
  const create = document.createElement.bind(document);
  document.createElement = (tag: string) => {
    const element = create(tag);
    if (tag === 'canvas') {
      Object.assign(element, {
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb: (blob: Blob) => void, type: string) => cb(new Blob(['jpeg'], { type })),
      });
    }
    return element;
  };
  return document;
}

describe('ui:camera-capture', () => {
  const props = { name: 'receipt', label: 'Receipt', action: { id: 'receipt.capture' } };

  it('never touches the camera until the user presses Start', () => {
    const cam = fakeCamera();
    const { root } = one('ui:camera-capture', props, { window: cam.win });
    expect(cam.win.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('idle');
    expect(root.query('.kb-camera__stage')!.getAttribute('aria-labelledby')).toBe('kbf-c1-label');
  });

  it('falls back to <input type=file accept=image/* capture> when getUserMedia is missing', async () => {
    const win = { URL: { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }, File };
    const { root, actions } = one('ui:camera-capture', props, { window: win });
    root.query('.kb-camera__actions button')!.click();
    await tick();
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('fallback');
    expect(root.query('.kb-camera__notice')!.textContent).toBe(
      "The camera isn't available here. Choose a photo instead."
    );
    const input = root.query('.kb-camera__file input')! as MiniElement & { files: File[] };
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('user');
    const photo = file('me.jpg', 100, 'image/jpeg');
    input.files = [photo];
    input.dispatch('change');
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('captured');
    expect(root.query('img.kb-camera__preview')!.getAttribute('src')).toBe('blob:x');
    root.query('.kb-camera__actions .kb-btn--primary')!.click();
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('receipt.capture');
    expect(actions[0].payload!.name).toBe('receipt');
    expect((actions[0].payload!.file as File).type).toBe('image/jpeg');
    expect(win.URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('fallback');
  });

  it('falls back with a "blocked" notice when permission is denied', async () => {
    const cam = fakeCamera({ deny: true });
    const { root } = one('ui:camera-capture', props, { window: cam.win });
    root.query('.kb-camera__actions button')!.click();
    await tick();
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('fallback');
    expect(root.query('.kb-camera__notice')!.textContent).toBe(
      'Camera access was blocked. Choose a photo instead.'
    );
  });

  it('live → cancel stops every track and dispatches the cancel action', async () => {
    const cam = fakeCamera();
    const { root, actions } = one('ui:camera-capture', props, { window: cam.win });
    root.query('.kb-camera__actions button')!.click();
    await tick();
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('live');
    const video = root.query('video.kb-camera__video')! as MiniElement & { srcObject: unknown };
    expect(video.srcObject).toBe(cam.stream);
    expect(video.getAttribute('playsinline')).toBe('');
    expect(MiniElement.focused!.textContent).toBe('Take photo');
    root.query('.kb-camera__actions .kb-btn--ghost')!.click();
    expect(cam.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(actions).toEqual([{ id: 'camera.cancel', payload: { name: 'receipt' } }]);
  });

  it('capture → confirm: frame to canvas → Blob in the payload; tracks stopped at capture', async () => {
    const cam = fakeCamera();
    const document = canvasDocument();
    const { root, actions } = mount(
      [{ id: 'c1', type: 'ui:camera-capture', props }],
      { window: cam.win },
      document
    );
    root.query('.kb-camera__actions button')!.click();
    await tick();
    Object.assign(root.query('video')!, { videoWidth: 640, videoHeight: 480 });
    root.query('.kb-camera__actions .kb-btn--primary')!.click();
    await tick();
    expect(cam.track.stop).toHaveBeenCalledTimes(1);
    expect(root.query('.kb-camera')!.getAttribute('data-state')).toBe('captured');
    root.query('.kb-camera__actions .kb-btn--primary')!.click();
    const photo = actions[0].payload!.file as File;
    expect(actions[0].id).toBe('receipt.capture');
    expect(photo).toBeInstanceOf(Blob);
    expect(photo.type).toBe('image/jpeg');
    expect(cam.win.URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('re-render (disposeA2UI) and pagehide stop the stream', async () => {
    const cam = fakeCamera();
    const { root } = one('ui:camera-capture', props, { window: cam.win });
    root.query('.kb-camera__actions button')!.click();
    await tick();
    disposeA2UI(root as unknown as Element);
    expect(cam.track.stop).toHaveBeenCalledTimes(1);
    expect(cam.win.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));

    const again = fakeCamera();
    const second = one('ui:camera-capture', props, { window: again.win });
    second.root.query('.kb-camera__actions button')!.click();
    await tick();
    again.listeners.get('pagehide')!();
    expect(again.track.stop).toHaveBeenCalledTimes(1);
  });

  it('controller: a stream that arrives after cancel is stopped immediately', async () => {
    let resolve!: (stream: unknown) => void;
    const track = { stop: vi.fn() };
    const win = {
      navigator: {
        mediaDevices: { getUserMedia: () => new Promise((r) => (resolve = r)) },
      },
    };
    const controller = createCameraController({ win });
    const started = controller.start();
    controller.cancel();
    resolve({ getTracks: () => [track] });
    await started;
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(controller.state.phase).toBe('idle');
  });

  describe('controller: start → cancel → start with streams resolving out of order', () => {
    type Pending = { resolve: (stream: unknown) => void; reject: (error: unknown) => void };
    function racingCamera() {
      const pending: Pending[] = [];
      const win = {
        navigator: {
          mediaDevices: {
            getUserMedia: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
          },
        },
      };
      const stream = () => {
        const track = { stop: vi.fn() };
        return { track, stream: { getTracks: () => [track] } };
      };
      return { win, pending, stream };
    }

    it('the stale first stream resolving first is stopped; the second one goes live', async () => {
      const cam = racingCamera();
      const controller = createCameraController({ win: cam.win });
      const first = controller.start();
      controller.cancel();
      const second = controller.start();
      const a = cam.stream();
      const b = cam.stream();
      cam.pending[0].resolve(a.stream);
      await first;
      expect(a.track.stop).toHaveBeenCalledTimes(1);
      expect(controller.state.phase).toBe('starting');
      expect(controller.stream).toBeNull();
      cam.pending[1].resolve(b.stream);
      await second;
      expect(controller.state.phase).toBe('live');
      expect(controller.stream).toBe(b.stream);
      expect(b.track.stop).not.toHaveBeenCalled();
      controller.cancel();
      expect(b.track.stop).toHaveBeenCalledTimes(1);
    });

    it('the stale first stream resolving last is stopped and never replaces the live one', async () => {
      const cam = racingCamera();
      const controller = createCameraController({ win: cam.win });
      const first = controller.start();
      controller.cancel();
      const second = controller.start();
      const a = cam.stream();
      const b = cam.stream();
      cam.pending[1].resolve(b.stream);
      await second;
      expect(controller.stream).toBe(b.stream);
      cam.pending[0].resolve(a.stream);
      await first;
      expect(a.track.stop).toHaveBeenCalledTimes(1);
      expect(controller.stream).toBe(b.stream);
      expect(b.track.stop).not.toHaveBeenCalled();
      expect(controller.state.phase).toBe('live');
      controller.dispose();
      expect(b.track.stop).toHaveBeenCalledTimes(1);
    });

    it('a stale request failing does not knock the current one into fallback', async () => {
      const cam = racingCamera();
      const controller = createCameraController({ win: cam.win });
      const first = controller.start();
      controller.cancel();
      const second = controller.start();
      cam.pending[0].reject(new Error('NotAllowedError'));
      await first;
      expect(controller.state.phase).toBe('starting');
      const b = cam.stream();
      cam.pending[1].resolve(b.stream);
      await second;
      expect(controller.state.phase).toBe('live');
      expect(controller.stream).toBe(b.stream);
    });
  });
});

describe('ui:avatar-picker', () => {
  it('shows the current image, uploads a square-cropped preview, then dispatches on confirm', async () => {
    const win = { URL: { createObjectURL: vi.fn(() => 'blob:avatar'), revokeObjectURL: vi.fn() } };
    const { root, actions } = one(
      'ui:avatar-picker',
      {
        name: 'avatar',
        label: 'Avatar',
        image_url: '/assets/a.svg',
        removable: true,
        action: { id: 'setup.avatar', payload: { profile_id: 'p1' } },
      },
      { window: win }
    );
    const picker = root.query('.kb-avatar-picker')!;
    expect(picker.query('img.kb-avatar-picker__image')!.getAttribute('src')).toBe('/assets/a.svg');
    const buttons = picker.queryAll('.kb-avatar-picker__actions button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Take photo', 'Remove']);
    const input = picker.query('.kb-avatar-picker__upload input')! as MiniElement & {
      files: File[];
      value: string;
    };
    expect(input.getAttribute('accept')).toBe('image/*');
    input.files = [file('notes.txt', 3, 'text/plain')];
    input.dispatch('change');
    expect(picker.query('.kb-avatar-picker__notice')!.textContent).toBe(
      "notes.txt isn't an accepted file type"
    );
    const photo = file('me.png', 10, 'image/png');
    input.files = [photo];
    input.dispatch('change');
    await tick();
    expect(picker.getAttribute('data-state')).toBe('preview');
    expect(picker.query('img')!.getAttribute('src')).toBe('blob:avatar');
    picker.query('.kb-avatar-picker__actions .kb-btn--primary')!.click();
    expect(actions).toEqual([
      {
        id: 'setup.avatar',
        payload: { profile_id: 'p1', name: 'avatar', file: photo, source: 'upload' },
      },
    ]);
    expect(win.URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar');
    expect(picker.getAttribute('data-state')).toBe('idle');
  });

  it('remove dispatches; empty state shows initials; take photo opens the camera panel', async () => {
    const cam = fakeCamera();
    const { root, actions } = one(
      'ui:avatar-picker',
      { name: 'avatar', label: 'Avatar', initials: 'AL' },
      { window: cam.win }
    );
    const initials = root.query('.kb-avatar-picker__initials')!;
    expect(initials.getAttribute('role')).toBe('img');
    expect(initials.getAttribute('aria-label')).toBe('No picture');
    expect(initials.textContent).toBe('AL');
    root.queryAll('.kb-avatar-picker__actions button')[0].click();
    await tick();
    expect(cam.win.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(root.query('.kb-avatar-picker')!.getAttribute('data-state')).toBe('camera');
    expect(root.query('.kb-avatar-picker__camera video')).not.toBeNull();
    root.query('.kb-avatar-picker__camera .kb-btn--ghost')!.click();
    expect(cam.track.stop).toHaveBeenCalledTimes(1);
    expect(root.query('.kb-avatar-picker')!.getAttribute('data-state')).toBe('idle');
    expect(actions).toEqual([]);

    const removable = one('ui:avatar-picker', {
      name: 'avatar',
      label: 'Avatar',
      image_url: '/a.png',
      removable: true,
      allow_camera: false,
    });
    removable.root.query('.kb-avatar-picker__actions button')!.click();
    expect(removable.actions).toEqual([{ id: 'avatar.remove', payload: { name: 'avatar' } }]);
  });
});
