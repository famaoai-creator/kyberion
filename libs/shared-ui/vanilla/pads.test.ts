// PA-01: pad components in the vanilla renderer (pads.js — toolbar, dialog,
// drawing palette, sketch board).
//
// Runs on `mini-dom.test-support.ts` (see kyberion-ui.test.ts for why). Covers
// the action contract (ids + payloads, File objects only in payloads), the
// WAI-ARIA keyboard behaviour (toolbar roving tabindex, radio groups, dialog
// focus trap / Escape / Enter), dialog focus restore across re-renders, and
// the sketch board (ready controller, strokes, undo depth, clear
// confirmation, inline text input, image drop, disposal).
import { describe, expect, it } from 'vitest';
import { getUiMessageBundle } from '@agent/core';
import {
  KB_DIALOG_ACTIONS as CORE_DIALOG_ACTIONS,
  KB_DRAWING_ACTIONS as CORE_DRAWING_ACTIONS,
  KB_DRAWING_TOOLS as CORE_DRAWING_TOOLS,
  KB_TOOLBAR_ACTIONS as CORE_TOOLBAR_ACTIONS,
} from '@agent/core/a2ui-catalog';
import { disposeA2UI, renderA2UI } from './kyberion-ui.js';
import {
  KB_DIALOG_ACTIONS,
  KB_DRAWING_ACTIONS,
  KB_DRAWING_DEFAULT_COLORS,
  KB_DRAWING_MESSAGE_KEYS,
  KB_DRAWING_TOOL_MESSAGE_KEYS,
  KB_DRAWING_TOOLS,
  KB_TOOLBAR_ACTIONS,
  KB_DIALOG_MESSAGE_KEYS,
  containFit,
  createDrawingEngine,
  dialogFocusables,
  dialogTrapTarget,
  drawingPaletteState,
  normalizeHexColor,
  rovingIndex,
  sketchFileName,
  sketchDownloadName,
  sketchImageSource,
  toolbarItems,
  toolbarRovingTarget,
} from './pads.js';
import { MiniDocument, MiniElement } from './mini-dom.test-support.js';

type Action = { id: string; payload?: Record<string, unknown> };

const JA = getUiMessageBundle('ja');
const EN = getUiMessageBundle('en');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(
  components: unknown[],
  options: Record<string, unknown> = {},
  document: MiniDocument = new MiniDocument()
) {
  const root = document.createElement('div');
  const actions: Action[] = [];
  const render = (list: unknown[]) =>
    renderA2UI(
      root as unknown as Element,
      list as never,
      {
        document: document as unknown as Document,
        onAction: (action: Action) => actions.push(action),
        ...options,
      } as never
    );
  render(components);
  const q = (selector: string) => {
    const found = root.query(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  return { root, actions, document, q, qa: (s: string) => root.queryAll(s), render };
}

function one(type: string, props: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return mount([{ id: 'c1', type, props }], options);
}

function file(name: string, type: string): File {
  return new File([new Uint8Array(4)], name, { type });
}

describe('pads.js pure helpers', () => {
  it('mirrors the core action ids and tool list', () => {
    expect({ ...KB_TOOLBAR_ACTIONS }).toEqual({ ...CORE_TOOLBAR_ACTIONS });
    expect({ ...KB_DIALOG_ACTIONS }).toEqual({ ...CORE_DIALOG_ACTIONS });
    expect({ ...KB_DRAWING_ACTIONS }).toEqual({ ...CORE_DRAWING_ACTIONS });
    expect([...KB_DRAWING_TOOLS]).toEqual([...CORE_DRAWING_TOOLS]);
  });

  it('has en + ja vocabulary for every default string', () => {
    const keys = [
      ...Object.values(KB_DRAWING_MESSAGE_KEYS),
      ...Object.values(KB_DRAWING_TOOL_MESSAGE_KEYS),
      ...Object.values(KB_DIALOG_MESSAGE_KEYS),
    ];
    for (const key of keys) {
      expect(EN.messages[key], key).toMatch(/\S/);
      expect(JA.messages[key], key).toMatch(/\S/);
    }
  });

  it('normalizes colors, tools and widths', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('#E5484D')).toBe('#e5484d');
    expect(normalizeHexColor('red')).toBeNull();
    const state = drawingPaletteState({
      tools: ['text', 'bogus', 'text', 'pen'],
      tool: 'eraser',
      colors: ['#fff', 'nope'],
      width: 99,
      max_width: 12,
    });
    expect(state.tools).toEqual(['text', 'pen']);
    expect(state.tool).toBe('text');
    expect(state.colors).toEqual(['#ffffff']);
    expect(state.color).toBe('#ffffff');
    expect(state.width).toBe(12);
    const defaults = drawingPaletteState({});
    expect(defaults.tools).toEqual(['pen', 'rect', 'ellipse', 'line', 'arrow', 'text', 'eraser']);
    expect(defaults.colors).toEqual([...KB_DRAWING_DEFAULT_COLORS]);
    expect(defaults.width).toBe(4);
  });

  it('computes roving / trap targets and export geometry', () => {
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingIndex('Home', 2, 3)).toBe(0);
    expect(rovingIndex('End', 0, 3)).toBe(2);
    expect(rovingIndex('a', 0, 3)).toBe(-1);
    const items = toolbarItems({
      items: [
        { type: 'button', id: 'a', label: 'A' },
        { type: 'separator' },
        { type: 'button', id: 'b', label: 'B', disabled: true },
        { type: 'toggle', id: 'c', label: 'C' },
        { type: 'button', id: 'broken' },
      ],
    });
    expect(items.map((item) => item.type)).toEqual(['button', 'separator', 'button', 'toggle']);
    expect(toolbarRovingTarget(items, 0, 'ArrowRight')).toBe(3);
    expect(toolbarRovingTarget(items, 3, 'ArrowRight')).toBe(0);
    const [a, b, c] = ['a', 'b', 'c'];
    expect(dialogTrapTarget([a, b, c], c, false)).toBe(a);
    expect(dialogTrapTarget([a, b, c], a, true)).toBe(c);
    expect(dialogTrapTarget([a, b, c], b, false)).toBeNull();
    expect(containFit(200, 100, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(sketchFileName('../My sketch')).toBe('My-sketch.png');
    expect(sketchFileName('')).toBe('sketch.png');
  });
});

describe('ui:toolbar (vanilla)', () => {
  const props = {
    label: 'Review',
    sticky: true,
    density: 'compact',
    items: [
      { type: 'button', id: 'save', label: 'Save', icon: 'S', variant: 'primary' },
      {
        type: 'button',
        id: 'publish',
        label: 'Publish',
        action: { id: 'doc.publish', payload: { draft: false } },
      },
      { type: 'separator' },
      { type: 'toggle', id: 'comments', label: 'Comments', pressed: false, hide_label: true },
      { type: 'button', id: 'off', label: 'Off', disabled: true },
      { type: 'file', id: 'import', label: 'Import', accept: '.md', multiple: true },
      { type: 'spacer' },
      { type: 'status', id: 'st', text: 'Saved', tone: 'success' },
    ],
  };

  it('renders a labelled WAI-ARIA toolbar with one tab stop', () => {
    const m = one('ui:toolbar', props);
    const bar = m.q('.kb-toolbar');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Review');
    expect(bar.getAttribute('data-sticky')).toBe('true');
    expect(bar.getAttribute('data-density')).toBe('compact');
    const buttons = m.qa('.kb-toolbar__item');
    expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    const toggle = m.q('[data-item-id="comments"]');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Comments');
    expect(toggle.getAttribute('title')).toBe('Comments');
    expect(toggle.query('.kb-toolbar__label')).toBeNull();
    const status = m.q('.kb-toolbar__status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(m.q('.kb-toolbar__separator').getAttribute('role')).toBe('separator');
  });

  it('dispatches click / declared action / toggle payloads', () => {
    const m = one('ui:toolbar', props);
    m.q('[data-item-id="save"]').click();
    m.q('[data-item-id="publish"]').click();
    m.q('[data-item-id="comments"]').click();
    expect(m.q('[data-item-id="comments"]').getAttribute('aria-pressed')).toBe('true');
    m.q('[data-item-id="comments"]').click();
    expect(m.actions).toEqual([
      { id: 'toolbar.click', payload: { id: 'save' } },
      { id: 'doc.publish', payload: { draft: false, id: 'publish' } },
      { id: 'toolbar.toggle', payload: { id: 'comments', pressed: true } },
      { id: 'toolbar.toggle', payload: { id: 'comments', pressed: false } },
    ]);
  });

  it('hands picked files only to onAction', () => {
    const m = one('ui:toolbar', props);
    const input = m.q('input.kb-toolbar__file');
    expect(input.getAttribute('accept')).toBe('.md');
    expect(input.getAttribute('aria-hidden')).toBe('true');
    const picked = [file('a.md', 'text/markdown')];
    (input as unknown as { files: File[] }).files = picked;
    input.dispatch('change');
    expect(m.actions).toEqual([{ id: 'toolbar.files', payload: { id: 'import', files: picked } }]);
    expect(input.getAttribute('value')).toBeNull();
  });

  it('moves focus with arrow keys / Home / End, skipping disabled items', () => {
    const m = one('ui:toolbar', props);
    const save = m.q('[data-item-id="save"]');
    save.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
    expect(MiniElement.focused).toBe(m.q('[data-item-id="publish"]'));
    expect(save.getAttribute('tabindex')).toBe('-1');
    expect(m.q('[data-item-id="publish"]').getAttribute('tabindex')).toBe('0');
    m.q('[data-item-id="publish"]').dispatch('keydown', { key: 'End', preventDefault() {} });
    expect(MiniElement.focused).toBe(m.q('[data-item-id="import"]'));
    m.q('[data-item-id="import"]').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
    expect(MiniElement.focused).toBe(save);
    save.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
    expect(MiniElement.focused).toBe(m.q('[data-item-id="import"]'));
    m.q('[data-item-id="comments"]').dispatch('keydown', { key: 'Home', preventDefault() {} });
    expect(MiniElement.focused).toBe(save);
  });
});

describe('ui:dialog (vanilla)', () => {
  const prompt = {
    open: true,
    title: 'Rename',
    message: 'New name',
    input: { name: 'title', label: 'Name', value: 'Old' },
  };

  it('renders nothing visible while closed', () => {
    const m = one('ui:dialog', { open: false, title: 'x' });
    const root = m.q('.kb-dialog');
    expect(root.getAttribute('data-state')).toBe('closed');
    expect(root.hasAttribute('hidden')).toBe(true);
    expect(root.childNodes).toHaveLength(0);
  });

  it('is a labelled modal dialog; danger tone makes it an alertdialog', async () => {
    const m = one('ui:dialog', prompt);
    const panel = m.q('.kb-dialog__panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe(m.q('.kb-dialog__title').getAttribute('id'));
    expect(panel.getAttribute('aria-describedby')).toBe(
      m.q('.kb-dialog__message').getAttribute('id')
    );
    await tick();
    expect(MiniElement.focused).toBe(m.q('input.kb-input'));
    const danger = one(
      'ui:dialog',
      { open: true, title: 'Delete?', tone: 'danger' },
      { locale: 'ja', messages: JA.messages }
    );
    expect(danger.q('.kb-dialog__panel').getAttribute('role')).toBe('alertdialog');
    expect(danger.q('.kb-dialog').getAttribute('data-tone')).toBe('danger');
    const buttons = danger.qa('.kb-dialog__actions button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      JA.messages['ui:dialog_cancel'],
      JA.messages['ui:dialog_confirm'],
    ]);
    expect(buttons[1].className).toContain('kb-btn--danger');
    await tick();
    expect(MiniElement.focused).toBe(buttons[1]);
  });

  it('confirms with the input value (button or Enter) and cancels with Escape', () => {
    const m = one('ui:dialog', { ...prompt, action: { id: 'note.rename', payload: { note: 7 } } });
    const input = m.q('input.kb-input');
    input.value = 'New';
    input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
    m.q('[data-dialog-button="confirm"]').click();
    m.q('[data-dialog-button="cancel"]').click();
    m.q('.kb-dialog__panel').dispatch('keydown', {
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {},
    });
    expect(m.actions).toEqual([
      { id: 'note.rename', payload: { note: 7, value: 'New' } },
      { id: 'note.rename', payload: { note: 7, value: 'New' } },
      { id: 'dialog.cancel', payload: {} },
      { id: 'dialog.cancel', payload: {} },
    ]);
  });

  it('reports the chosen choice', () => {
    const m = one('ui:dialog', {
      open: true,
      title: 'Unsaved',
      choices: [
        { id: 'save', label: 'Save', variant: 'primary' },
        { id: 'discard', label: 'Discard', variant: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    expect(m.qa('.kb-dialog__actions button').map((b) => b.getAttribute('data-choice-id'))).toEqual(
      ['save', 'discard', 'cancel']
    );
    m.q('[data-choice-id="discard"]').click();
    expect(m.actions).toEqual([{ id: 'dialog.confirm', payload: { choice: 'discard' } }]);
  });

  it('traps Tab inside the panel', () => {
    const document = new MiniDocument();
    const m = mount([{ id: 'd', type: 'ui:dialog', props: prompt }], {}, document);
    const input = m.q('input.kb-input');
    const confirm = m.q('[data-dialog-button="confirm"]');
    const doc = document as unknown as { activeElement: unknown };
    doc.activeElement = confirm;
    let prevented = false;
    m.q('.kb-dialog__panel').dispatch('keydown', {
      key: 'Tab',
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(MiniElement.focused).toBe(input);
    doc.activeElement = input;
    m.q('.kb-dialog__panel').dispatch('keydown', {
      key: 'Tab',
      shiftKey: true,
      preventDefault() {},
    });
    expect(MiniElement.focused).toBe(confirm);
  });

  it('restores focus to the opener when the host closes it', async () => {
    const document = new MiniDocument();
    const opener = document.createElement('button');
    (document as unknown as { activeElement: unknown }).activeElement = opener;
    const m = mount([{ id: 'd2', type: 'ui:dialog', props: prompt }], {}, document);
    await tick();
    expect(MiniElement.focused).toBe(m.q('input.kb-input'));
    // A re-render while still open keeps the original opener.
    (document as unknown as { activeElement: unknown }).activeElement = m.q('input.kb-input');
    m.render([{ id: 'd2', type: 'ui:dialog', props: prompt }]);
    m.render([{ id: 'd2', type: 'ui:dialog', props: { ...prompt, open: false } }]);
    await tick();
    expect(MiniElement.focused).toBe(opener);
  });
});

describe('ui:dialog children and shadow roots (vanilla)', () => {
  const prompt = {
    open: true,
    title: 'Note',
    input: { name: 'note', label: 'Note', multiline: true },
  };
  const withChild = (open: boolean) => [
    { id: 'd', type: 'ui:dialog', props: { ...prompt, open }, children: ['extra'] },
    { id: 'extra', type: 'ui:button', props: { label: 'Extra', action: 'extra.go' } },
  ];
  const tab = (panel: MiniElement, shiftKey = false) => {
    let prevented = false;
    panel.dispatch('keydown', {
      key: 'Tab',
      shiftKey,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };

  it('renders children in the body between the input and the buttons', () => {
    const m = mount(withChild(true));
    const panel = m.q('.kb-dialog__panel');
    const classes = panel.children.map((child) => child.className);
    expect(classes).toEqual([
      'kb-dialog__title',
      'kb-field kb-dialog__field',
      'kb-dialog__content',
      'kb-dialog__actions',
    ]);
    expect(m.q('.kb-dialog__content button').textContent).toBe('Extra');
    const closed = mount(withChild(false));
    expect(closed.root.query('.kb-dialog__content')).toBeNull();
    expect(closed.root.query('button')).toBeNull();
  });

  it('the focus trap includes the children controls', () => {
    const document = new MiniDocument();
    const m = mount(withChild(true), {}, document);
    const panel = m.q('.kb-dialog__panel');
    const textarea = m.q('textarea');
    const extra = m.q('.kb-dialog__content button');
    const confirm = m.q('[data-dialog-button="confirm"]');
    expect(dialogFocusables(panel)).toEqual([
      textarea,
      extra,
      m.q('[data-dialog-button="cancel"]'),
      confirm,
    ]);
    const doc = document as unknown as { activeElement: unknown };
    // Inside the children: the browser moves on (no wrap to the start).
    doc.activeElement = extra;
    expect(tab(panel)).toBe(false);
    doc.activeElement = confirm;
    expect(tab(panel)).toBe(true);
    expect(MiniElement.focused).toBe(textarea);
    doc.activeElement = textarea;
    expect(tab(panel, true)).toBe(true);
    expect(MiniElement.focused).toBe(confirm);
  });

  it('reads focus from the shadow root it is rendered into', async () => {
    const proto = MiniElement.prototype as unknown as { getRootNode?: () => unknown };
    const topOf = (start: MiniElement) => {
      let node = start;
      while (node.parentNode instanceof MiniElement) node = node.parentNode;
      return node;
    };
    proto.getRootNode = function (this: MiniElement) {
      return topOf(this);
    };
    try {
      const document = new MiniDocument();
      const shadowHost = document.createElement('div');
      const shadow = document.createElement('div') as MiniElement & { activeElement: unknown };
      shadow.activeElement = null;
      const opener = document.createElement('button');
      shadow.appendChild(opener);
      const box = document.createElement('div');
      shadow.appendChild(box);
      const doc = document as unknown as { activeElement: unknown };
      // Focus is inside the shadow tree: the document only sees the host.
      doc.activeElement = shadowHost;
      shadow.activeElement = opener;
      const actions: Action[] = [];
      const render = (open: boolean) =>
        renderA2UI(
          box as unknown as Element,
          [{ id: 'sd', type: 'ui:dialog', props: { ...prompt, open } }] as never,
          {
            document: document as unknown as Document,
            onAction: (a: Action) => actions.push(a),
          } as never
        );
      render(true);
      await tick();
      const panel = box.query('.kb-dialog__panel') as MiniElement;
      const cancel = box.query('[data-dialog-button="cancel"]') as MiniElement;
      // A middle control focused inside the shadow root: no wrap.
      shadow.activeElement = cancel;
      expect(tab(panel)).toBe(false);
      shadow.activeElement = box.query('[data-dialog-button="confirm"]');
      expect(tab(panel)).toBe(true);
      expect(MiniElement.focused).toBe(box.query('textarea'));
      // Close: focus returns to the opener inside the shadow root, not the host.
      render(false);
      await tick();
      expect(MiniElement.focused).toBe(opener);
    } finally {
      delete proto.getRootNode;
    }
  });
});

describe('ui:drawing-palette (vanilla)', () => {
  const base = { name: 'pen', label: 'Palette', tool: 'pen', color: '#0090ff', width: 4 };

  it('renders radio groups with accessible names and one tab stop each', () => {
    const m = one('ui:drawing-palette', base, { locale: 'ja', messages: JA.messages });
    const tools = m.q('.kb-drawing-palette__tools');
    expect(tools.getAttribute('role')).toBe('radiogroup');
    expect(tools.getAttribute('aria-label')).toBe(JA.messages['ui:drawing_tools']);
    const toolButtons = m.qa('.kb-drawing-palette__tool');
    expect(toolButtons.map((b) => b.getAttribute('data-tool'))).toEqual([
      'pen',
      'rect',
      'ellipse',
      'line',
      'arrow',
      'text',
      'eraser',
    ]);
    expect(toolButtons[0].getAttribute('aria-checked')).toBe('true');
    expect(toolButtons[0].getAttribute('aria-label')).toBe(JA.messages['ui:drawing_tool_pen']);
    expect(toolButtons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    const blue = m.q('[data-color="#0090ff"]');
    expect(blue.getAttribute('aria-checked')).toBe('true');
    expect(blue.getAttribute('aria-label')).toBe(
      JA.messages['ui:drawing_color'].replace('{color}', '#0090ff')
    );
    expect(m.q('[data-palette-action="undo"]').disabled).toBe(true);
    expect(m.root.query('[data-palette-action="clear"]')).toBeNull();
    expect(m.root.query('.kb-drawing-palette__custom')).toBeNull();
  });

  it('dispatches drawing.change / undo / clear and echoes the selection', () => {
    const m = one('ui:drawing-palette', {
      ...base,
      can_undo: true,
      show_clear: true,
      allow_custom_color: true,
      max_width: 10,
    });
    m.q('[data-tool="arrow"]').click();
    expect(m.q('[data-tool="arrow"]').getAttribute('aria-checked')).toBe('true');
    expect(m.q('[data-tool="pen"]').getAttribute('aria-checked')).toBe('false');
    m.q('[data-color="#e5484d"]').click();
    const range = m.q('input.kb-drawing-palette__range');
    range.value = '30';
    range.dispatch('input');
    const custom = m.q('input.kb-drawing-palette__custom-input');
    custom.value = '#123ABC';
    custom.dispatch('input');
    m.q('[data-palette-action="undo"]').click();
    m.q('[data-palette-action="clear"]').click();
    expect(m.actions).toEqual([
      { id: 'drawing.change', payload: { name: 'pen', tool: 'arrow' } },
      { id: 'drawing.change', payload: { name: 'pen', color: '#e5484d' } },
      { id: 'drawing.change', payload: { name: 'pen', width: 10 } },
      { id: 'drawing.change', payload: { name: 'pen', color: '#123abc' } },
      { id: 'drawing.undo', payload: { name: 'pen' } },
      { id: 'drawing.clear', payload: { name: 'pen' } },
    ]);
    expect(m.q('.kb-drawing-palette__width-value').textContent).toBe('10 px');
  });

  it('arrow keys move and select within a radio group', () => {
    const m = one('ui:drawing-palette', base);
    m.q('[data-tool="pen"]').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
    expect(MiniElement.focused).toBe(m.q('[data-tool="rect"]'));
    expect(m.q('[data-tool="rect"]').getAttribute('tabindex')).toBe('0');
    m.q('[data-tool="rect"]').dispatch('keydown', { key: 'End', preventDefault() {} });
    expect(m.actions.map((a) => a.payload?.tool)).toEqual(['rect', 'eraser']);
  });
});

describe('ui:sketch-board (vanilla)', () => {
  const board = { name: 'sketch', label: 'Sketch', canvas_width: 800, canvas_height: 400 };
  const stroke = (canvas: MiniElement, from: [number, number], to: [number, number]) => {
    const base = { pointerId: 1, pointerType: 'mouse', button: 0, preventDefault() {} };
    canvas.dispatch('pointerdown', { ...base, clientX: from[0], clientY: from[1] });
    canvas.dispatch('pointermove', { ...base, clientX: to[0], clientY: to[1] });
    canvas.dispatch('pointerup', { ...base, clientX: to[0], clientY: to[1] });
  };

  it('renders palette + canvas + closed clear dialog and hands the host a controller', async () => {
    const m = one('ui:sketch-board', { ...board, accept_image_drop: true, show_download: true });
    const root = m.q('.kb-sketch-board');
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('data-state')).toBe('empty');
    expect(root.getAttribute('data-background')).toBe('dark');
    const canvas = m.q('canvas.kb-sketch-board__canvas');
    expect(canvas.getAttribute('width')).toBe('800');
    expect(canvas.getAttribute('height')).toBe('400');
    expect(canvas.getAttribute('aria-label')).toBe('Sketch: drawing canvas');
    expect(canvas.getAttribute('aria-describedby')).toBe(
      m.q('.kb-sketch-board__hint').getAttribute('id')
    );
    expect(m.q('[data-palette-action="download"]')).toBeTruthy();
    expect(m.q('.kb-sketch-board__dialog .kb-dialog').getAttribute('data-state')).toBe('closed');
    expect(m.actions).toEqual([]);
    await tick();
    expect(m.actions).toHaveLength(1);
    expect(m.actions[0].id).toBe('drawing.ready');
    const controller = m.actions[0].payload?.controller as {
      isEmpty(): boolean;
      toBlob(): Promise<Blob>;
    };
    expect(controller.isEmpty()).toBe(true);
    await expect(controller.toBlob()).rejects.toThrow(/unavailable/);
  });

  it('commits strokes, reports drawing.change and undoes them', () => {
    const m = one('ui:sketch-board', board);
    const canvas = m.q('canvas');
    stroke(canvas, [10, 10], [50, 60]);
    m.q('[data-tool="rect"]').click();
    stroke(canvas, [100, 100], [180, 160]);
    stroke(canvas, [5, 5], [5, 5]); // a click without a drag draws no rectangle
    expect(m.q('.kb-sketch-board').getAttribute('data-state')).toBe('dirty');
    expect(m.q('[data-palette-action="undo"]').disabled).toBe(false);
    m.q('[data-palette-action="undo"]').click();
    m.q('[data-palette-action="undo"]').click();
    expect(m.q('[data-palette-action="undo"]').disabled).toBe(true);
    expect(m.q('.kb-sketch-board').getAttribute('data-state')).toBe('empty');
    expect(m.actions).toEqual([
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 2 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: false, strokes: 0 } },
    ]);
  });

  it('asks before clearing (ui:dialog markup) and returns focus to the clear button', () => {
    const m = one('ui:sketch-board', board);
    stroke(m.q('canvas'), [10, 10], [40, 40]);
    m.q('[data-palette-action="clear"]').click();
    const dialog = m.q('.kb-sketch-board__dialog .kb-dialog');
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(m.q('.kb-dialog__panel').getAttribute('role')).toBe('alertdialog');
    expect(m.q('.kb-dialog__title').textContent).toBe('Clear the drawing?');
    expect(MiniElement.focused).toBe(m.q('[data-dialog-button="confirm"]'));
    m.q('[data-dialog-button="cancel"]').click();
    expect(m.q('.kb-sketch-board__dialog .kb-dialog').getAttribute('data-state')).toBe('closed');
    expect(MiniElement.focused).toBe(m.q('[data-palette-action="clear"]'));
    expect(m.q('.kb-sketch-board').getAttribute('data-state')).toBe('dirty');
    m.q('[data-palette-action="clear"]').click();
    m.q('[data-dialog-button="confirm"]').click();
    expect(m.q('.kb-sketch-board').getAttribute('data-state')).toBe('empty');
    expect(m.actions.at(-1)).toEqual({
      id: 'drawing.change',
      payload: { name: 'sketch', dirty: false, strokes: 0 },
    });
  });

  it('places text with an inline input (Enter commits, Escape cancels)', () => {
    const m = one('ui:sketch-board', board, { locale: 'ja', messages: JA.messages });
    m.q('[data-tool="text"]').click();
    const canvas = m.q('canvas');
    canvas.dispatch('pointerdown', { clientX: 200, clientY: 100, button: 0, preventDefault() {} });
    const input = m.q('input.kb-sketch-board__text');
    expect(input.getAttribute('aria-label')).toBe(JA.messages['ui:sketch_text_input']);
    expect(input.style.left).toBe('25%');
    expect(input.style.top).toBe('25%');
    expect(MiniElement.focused).toBe(input);
    input.value = 'Hello';
    input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
    expect(m.root.query('input.kb-sketch-board__text')).toBeNull();
    expect(m.actions).toEqual([
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
    ]);
    canvas.dispatch('pointerdown', { clientX: 20, clientY: 20, button: 0, preventDefault() {} });
    const second = m.q('input.kb-sketch-board__text');
    second.value = 'Nope';
    second.dispatch('keydown', { key: 'Escape', preventDefault() {} });
    second.dispatch('blur');
    expect(m.actions).toHaveLength(1);
  });

  it('keeps max_undo steps undoable and flattens older strokes', () => {
    const m = one('ui:sketch-board', { ...board, max_undo: 2 });
    const canvas = m.q('canvas');
    for (let i = 0; i < 3; i += 1) stroke(canvas, [i, i], [i + 20, i + 20]);
    const undo = m.q('[data-palette-action="undo"]');
    undo.click();
    undo.click();
    expect(undo.disabled).toBe(true);
    expect(m.actions.at(-1)?.payload).toEqual({ name: 'sketch', dirty: true, strokes: 1 });
  });

  it('takes a dropped image as background (File only in the payload) and rejects others', () => {
    const m = one('ui:sketch-board', { ...board, accept_image_drop: true });
    const stage = m.q('.kb-sketch-board__stage');
    stage.dispatch('dragover', { preventDefault() {} });
    expect(stage.getAttribute('data-dragging')).toBe('true');
    const png = file('shot.png', 'image/png');
    stage.dispatch('drop', { preventDefault() {}, dataTransfer: { files: [png] } });
    expect(stage.getAttribute('data-dragging')).toBeNull();
    expect(m.actions).toEqual([
      { id: 'drawing.background', payload: { name: 'sketch', file: png } },
    ]);
    stage.dispatch('drop', {
      preventDefault() {},
      dataTransfer: { files: [file('notes.txt', 'text/plain')] },
    });
    expect(m.actions).toHaveLength(1);
    expect(m.q('.kb-sketch-board__notice').textContent).toBe('notes.txt is not an image.');
  });

  it('stops listening after disposal and never dispatches ready for a disposed board', async () => {
    const m = one('ui:sketch-board', board);
    disposeA2UI(m.root as unknown as Element);
    await tick();
    expect(m.actions).toEqual([]);
    stroke(m.q('canvas'), [1, 1], [30, 30]);
    // mini-dom has no removeEventListener: the disposed engine ignores input.
    expect(m.actions).toEqual([]);
  });
});

// Fake `Image` + `URL` for background / drawing-layer image loads: each load
// waits until the test calls `images[i].load()` / `.fail()`.
function imageWin() {
  const images: FakeImage[] = [];
  const revoked: string[] = [];
  let next = 0;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 200;
    naturalHeight = 100;
    width = 200;
    height = 100;
    crossOrigin = '';
    source = '';
    set src(value: string) {
      this.source = value;
      images.push(this);
    }
    load() {
      this.onload?.();
    }
    fail() {
      this.onerror?.();
    }
  }
  const win = {
    Image: FakeImage,
    URL: {
      createObjectURL: () => `blob:test/${next++}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  };
  return { win, images, revoked };
}

describe('sketch board runtime images (vanilla)', () => {
  const board = { name: 'sketch', label: 'Sketch', canvas_width: 800, canvas_height: 400 };
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  type Controller = {
    setBackgroundImage(source: unknown): Promise<boolean>;
    loadImage(source: unknown, options?: { layer?: string }): Promise<boolean>;
    isEmpty(): boolean;
    clear(): void;
  };
  const ready = async (m: ReturnType<typeof one>) => {
    await tick();
    const action = m.actions.find((a) => a.id === 'drawing.ready');
    return action?.payload?.controller as Controller;
  };

  it('classifies runtime sources: Blob, blob:, data:image raster, safe URLs', () => {
    const safe = (value: unknown) =>
      typeof value === 'string' && value.startsWith('/') ? value : null;
    const png = file('a.png', 'image/png');
    expect(sketchImageSource(png, safe)).toEqual({ kind: 'blob', blob: png });
    expect(sketchImageSource('blob:http://x/1', safe)).toMatchObject({ kind: 'url' });
    expect(sketchImageSource(PNG, safe)).toMatchObject({ kind: 'url', url: PNG });
    expect(sketchImageSource('data:image/svg+xml;base64,PHN2Zz4=', safe)).toBeNull();
    expect(sketchImageSource('data:text/html,<b>x</b>', safe)).toBeNull();
    expect(sketchImageSource('javascript:alert(1)', safe)).toBeNull();
    expect(sketchImageSource('/shot.png', safe)).toEqual({
      kind: 'url',
      url: '/shot.png',
      crossOrigin: false,
    });
    expect(sketchImageSource(42, safe)).toBeNull();
  });

  it('controller.setBackgroundImage takes File / data: URLs and never clears on bad input', async () => {
    const fake = imageWin();
    const m = one('ui:sketch-board', board, { window: fake.win });
    const controller = await ready(m);
    const first = controller.setBackgroundImage(PNG);
    expect(fake.images[0].source).toBe(PNG);
    fake.images[0].load();
    expect(await first).toBe(true);
    expect(controller.isEmpty()).toBe(false);
    // Unsupported input: resolves false, the background stays.
    expect(await controller.setBackgroundImage('data:text/html,hi')).toBe(false);
    expect(fake.images).toHaveLength(1);
    expect(controller.isEmpty()).toBe(false);
    const blob = controller.setBackgroundImage(file('b.png', 'image/png'));
    fake.images[1].load();
    expect(await blob).toBe(true);
    expect(fake.revoked).toEqual(['blob:test/0']);
    expect(await controller.setBackgroundImage(null)).toBe(true);
    expect(controller.isEmpty()).toBe(true);
  });

  it('the latest background call wins (slower earlier loads and pending loads after null)', async () => {
    const fake = imageWin();
    const engine = createDrawingEngine({ canvas: null, win: fake.win });
    const slow = engine.setBackgroundImage('/slow.png');
    const fast = engine.setBackgroundImage('/fast.png');
    fake.images[1].load();
    expect(await fast).toBe(true);
    fake.images[0].load();
    expect(await slow).toBe(false);
    expect(engine.hasBackground()).toBe(true);
    const pending = engine.setBackgroundImage('/late.png');
    await engine.setBackgroundImage(null);
    fake.images[2].load();
    expect(await pending).toBe(false);
    expect(engine.hasBackground()).toBe(false);
  });

  it("loadImage({ layer: 'drawing' }) is undoable and removed by Clear", async () => {
    const fake = imageWin();
    const m = one('ui:sketch-board', board, { window: fake.win });
    const controller = await ready(m);
    const loading = controller.loadImage(file('saved.png', 'image/png'), { layer: 'drawing' });
    fake.images[0].load();
    expect(await loading).toBe(true);
    expect(m.actions.at(-1)).toEqual({
      id: 'drawing.change',
      payload: { name: 'sketch', dirty: true, strokes: 1 },
    });
    expect(m.q('[data-palette-action="undo"]').disabled).toBe(false);
    controller.clear();
    expect(controller.isEmpty()).toBe(true);
    // Background layer by default.
    const bg = controller.loadImage(PNG);
    fake.images[1].load();
    expect(await bg).toBe(true);
    expect(m.q('[data-palette-action="undo"]').disabled).toBe(true);
    expect(await controller.loadImage('data:text/html,x', { layer: 'drawing' })).toBe(false);
  });

  it("paste_scope 'document' takes a pasted image anywhere except editable fields", () => {
    const document = new MiniDocument() as MiniDocument & {
      listeners?: Map<string, Array<(event: unknown) => void>>;
      addEventListener?: (type: string, fn: (event: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (event: unknown) => void) => void;
    };
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    document.addEventListener = (type, fn) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    document.removeEventListener = (type, fn) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn)
      );
    const paste = (target: unknown, files: File[]) => {
      let prevented = false;
      for (const fn of listeners.get('paste') ?? [])
        fn({ target, clipboardData: { files }, preventDefault: () => (prevented = true) });
      return prevented;
    };
    const m = mount(
      [
        {
          id: 'sb',
          type: 'ui:sketch-board',
          props: { ...board, accept_image_drop: true, paste_scope: 'document' },
        },
      ],
      {},
      document
    );
    const png = file('clip.png', 'image/png');
    const field = document.createElement('textarea');
    expect(paste(field, [png])).toBe(false);
    expect(paste(document.createElement('div'), [png])).toBe(true);
    expect(m.actions.filter((a) => a.id === 'drawing.background')).toHaveLength(1);
    disposeA2UI(m.root as unknown as Element);
    expect(listeners.get('paste')).toEqual([]);
  });

  it('download_name names the PNG (sanitized, .png ensured)', () => {
    expect(sketchDownloadName({ name: 'sketch', download_name: 'Weekly board' })).toBe(
      'Weekly board.png'
    );
    expect(sketchDownloadName({ name: 'sketch', download_name: 'a/b:c.PNG' })).toBe('a-b-c.png');
    expect(sketchDownloadName({ name: 'my sketch' })).toBe('my-sketch.png');
    expect(sketchDownloadName({ download_name: '...' })).toBe('sketch.png');
  });

  it('the custom colour control is a "+" picker, marked active for a non-swatch colour', () => {
    const m = one('ui:drawing-palette', {
      name: 'p',
      label: 'P',
      colors: ['#ffffff'],
      color: '#ffffff',
      allow_custom_color: true,
    });
    const custom = m.q('.kb-drawing-palette__custom');
    expect(custom.getAttribute('title')).toBe('Custom color');
    expect(m.q('.kb-drawing-palette__custom-glyph').getAttribute('aria-hidden')).toBe('true');
    expect(m.q('.kb-drawing-palette__custom-glyph svg')).toBeTruthy();
    expect(custom.getAttribute('data-active')).toBeNull();
    const input = m.q('.kb-drawing-palette__custom-input');
    input.value = '#123456';
    input.dispatch('input');
    expect(custom.getAttribute('data-active')).toBe('true');
    expect(m.q('.kb-drawing-palette__custom-dot').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('createDrawingEngine', () => {
  it('paints through a 2D context and exports a PNG', async () => {
    const calls: string[] = [];
    const ctx2d = new Proxy(
      {},
      {
        get: (_target, key) =>
          typeof key === 'string' && !['fillStyle', 'strokeStyle'].includes(key)
            ? (..._args: unknown[]) => calls.push(key)
            : undefined,
        set: () => true,
      }
    );
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx2d,
      addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) =>
        listeners.set(type, fn),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
      toBlob: (cb: (blob: Blob) => void, type: string) => cb(new Blob(['x'], { type })),
    };
    const commits: number[] = [];
    const engine = createDrawingEngine({
      canvas,
      width: 800,
      height: 400,
      background: 'light',
      onCommit: (count) => commits.push(count),
    });
    expect(canvas.width).toBe(800);
    listeners.get('pointerdown')!({ clientX: 10, clientY: 10, pointerId: 3 });
    listeners.get('pointermove')!({ clientX: 100, clientY: 50, pointerId: 3 });
    listeners.get('pointerup')!({ type: 'pointerup', clientX: 100, clientY: 50, pointerId: 3 });
    expect(commits).toEqual([1]);
    expect(calls).toContain('fillRect');
    expect(calls).toContain('lineTo');
    const blob = await engine.toBlob();
    expect(blob.type).toBe('image/png');
    expect(engine.addText({ x: 1, y: 1 }, '   ')).toBe(false);
    expect(engine.addText({ x: 1, y: 1 }, 'Hi')).toBe(true);
    expect(calls).toContain('fillText');
    engine.dispose();
  });
});
