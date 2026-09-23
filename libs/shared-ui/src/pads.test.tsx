// PA-01: React pad components (Toolbar, Dialog, DrawingPalette, SketchBoard).
//
// Static markup (renderToStaticMarkup) pins the contract the parity test does
// not see (closed dialog, tab stops); interaction runs the real
// react-dom/client on `vanilla/fake-dom.test-support.ts` so handlers, effects
// (focus, the drawing engine) and cleanups execute for real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, useState, type ReactElement } from 'react';
import { getUiMessageBundle } from '@agent/core';
import {
  FakeElement,
  fireEvent,
  installFakeDom,
  type FakeDocument,
} from '../vanilla/fake-dom.test-support.js';
import {
  A2UIActionProvider,
  A2UIRenderer,
  Dialog,
  DrawingPalette,
  KbI18nProvider,
  SketchBoard,
  Toolbar,
} from './index.js';

const ja = getUiMessageBundle('ja');

describe('React pad components: static markup', () => {
  it('Dialog renders an empty hidden root while closed', () => {
    expect(renderToStaticMarkup(<Dialog id="d" open={false} title="x" />)).toBe(
      '<div class="kb-dialog" data-state="closed" hidden=""></div>'
    );
  });

  it('Toolbar gives exactly the first enabled control a tab stop', () => {
    const out = renderToStaticMarkup(
      <Toolbar
        label="T"
        items={[
          { type: 'button', id: 'a', label: 'A', disabled: true },
          { type: 'button', id: 'b', label: 'B' },
          { type: 'toggle', id: 'c', label: 'C', pressed: true, hide_label: true },
        ]}
      />
    );
    expect(out).toContain('data-item-id="a" tabindex="-1" disabled=""');
    expect(out).toContain('data-item-id="b" tabindex="0"');
    expect(out).toContain('aria-label="C" title="C" aria-pressed="true"');
  });

  it('Toolbar item descriptions: title tooltip + aria-describedby hidden text', () => {
    const out = renderToStaticMarkup(
      <Toolbar
        id="tb"
        label="T"
        sticky
        items={[{ type: 'button', id: 'save', label: 'Save', description: 'Write to disk' }]}
      />
    );
    expect(out).toContain('data-sticky="true"');
    expect(out).toContain('title="Write to disk" aria-describedby="kbt-tb-save-desc"');
    expect(out).toContain(
      '<span id="kbt-tb-save-desc" class="kb-visually-hidden">Write to disk</span>'
    );
  });

  it('palette and sketch board strings come from the locale bundle', () => {
    const out = renderToStaticMarkup(
      <KbI18nProvider locale="ja" messages={ja.messages}>
        <SketchBoard id="s" name="s" label="スケッチ" accept_image_drop />
      </KbI18nProvider>
    );
    expect(out).toContain(`aria-label="${ja.messages['ui:drawing_tool_pen']}"`);
    expect(out).toContain(ja.messages['ui:sketch_drop_hint']);
    expect(out).toContain('width="1280" height="720"');
    expect(out).toContain('style="--kb-swatch:#e5484d"');
  });
});

// ---------------------------------------------------------------------------
// Interaction (react-dom/client on the fake DOM)
// ---------------------------------------------------------------------------

type ClientModule = typeof import('react-dom/client');
let client: ClientModule;
let dom: ReturnType<typeof installFakeDom>;

beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});

afterAll(() => {
  dom.restore();
});

interface Mounted {
  container: FakeElement;
  actions: Array<{ id: string; payload?: Record<string, unknown> }>;
  q: (selector: string) => FakeElement;
  qa: (selector: string) => FakeElement[];
  rerender: (element: ReactElement) => void;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const actions: Mounted['actions'] = [];
  const onAction = (id: string, payload?: Record<string, unknown>) => actions.push({ id, payload });
  const root = client.createRoot(container as unknown as Element);
  const wrap = (child: ReactElement) => (
    <A2UIActionProvider onAction={onAction}>{child}</A2UIActionProvider>
  );
  act(() => root.render(wrap(element)));
  const q = (selector: string) => {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  return {
    container,
    actions,
    q,
    qa: (selector) => container.querySelectorAll(selector),
    rerender: (next) => act(() => root.render(wrap(next))),
    unmount: () => act(() => root.unmount()),
  };
}

const setProp = (el: FakeElement, name: string, value: unknown) => {
  (el as unknown as Record<string, unknown>)[name] = value;
};
const active = () => (dom.document as FakeDocument).activeElement;
const click = (el: FakeElement) => act(() => void fireEvent(el, 'click'));
const key = (el: FakeElement, k: string, init: Record<string, unknown> = {}) =>
  act(() => void fireEvent(el, 'keydown', { key: k, ...init }));

describe('React pad components: interaction', () => {
  it('Toolbar dispatches click / toggle / files and roves focus with arrow keys', () => {
    const m = mount(
      <Toolbar
        label="Review"
        items={[
          { type: 'button', id: 'save', label: 'Save' },
          { type: 'toggle', id: 'comments', label: 'Comments' },
          { type: 'button', id: 'off', label: 'Off', disabled: true },
          { type: 'file', id: 'import', label: 'Import', multiple: true },
        ]}
      />
    );
    click(m.q('[data-item-id="save"]'));
    const toggle = m.q('[data-item-id="comments"]');
    click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const input = m.q('input.kb-toolbar__file');
    const picked = [new File(['x'], 'a.md', { type: 'text/markdown' })];
    act(() => {
      setProp(input, 'files', picked);
      fireEvent(input, 'change');
    });
    expect(m.actions).toEqual([
      { id: 'toolbar.click', payload: { id: 'save' } },
      { id: 'toolbar.toggle', payload: { id: 'comments', pressed: true } },
      { id: 'toolbar.files', payload: { id: 'import', files: picked } },
    ]);
    key(m.q('[data-item-id="save"]'), 'ArrowRight');
    expect(active()).toBe(toggle);
    expect(toggle.getAttribute('tabindex')).toBe('0');
    expect(m.q('[data-item-id="save"]').getAttribute('tabindex')).toBe('-1');
    key(toggle, 'ArrowRight');
    expect(active()).toBe(m.q('[data-item-id="import"]'));
    key(m.q('[data-item-id="import"]'), 'Home');
    expect(active()).toBe(m.q('[data-item-id="save"]'));
    m.unmount();
  });

  it('Dialog focuses the input, confirms / cancels, traps Tab and restores focus', () => {
    const document = dom.document as FakeDocument;
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    function Host({ open }: { open: boolean }) {
      return (
        <Dialog
          id="rn"
          open={open}
          title="Rename"
          input={{ name: 'title', label: 'Name', value: 'Old' }}
          action={{ id: 'note.rename' }}
        />
      );
    }
    const m = mount(<Host open />);
    const input = m.q('input.kb-input');
    expect(active()).toBe(input);
    expect(m.q('.kb-dialog__panel').getAttribute('aria-labelledby')).toBe('kbdlg-rn-title');
    setProp(input, 'value', 'New');
    key(input, 'Enter');
    click(m.q('[data-dialog-button="cancel"]'));
    key(m.q('.kb-dialog__panel'), 'Escape');
    expect(m.actions).toEqual([
      { id: 'note.rename', payload: { value: 'New' } },
      { id: 'dialog.cancel', payload: {} },
      { id: 'dialog.cancel', payload: {} },
    ]);
    const confirm = m.q('[data-dialog-button="confirm"]');
    confirm.focus();
    key(m.q('.kb-dialog__panel'), 'Tab');
    expect(active()).toBe(input);
    key(m.q('.kb-dialog__panel'), 'Tab', { shiftKey: true });
    expect(active()).toBe(confirm);
    m.rerender(<Host open={false} />);
    expect(m.q('.kb-dialog').getAttribute('data-state')).toBe('closed');
    expect(active()).toBe(opener);
    m.unmount();
  });

  it('DrawingPalette echoes the choice and dispatches drawing.* actions', () => {
    const m = mount(
      <DrawingPalette id="p" name="pen" label="P" can_undo show_clear max_width={10} />
    );
    click(m.q('[data-tool="arrow"]'));
    expect(m.q('[data-tool="arrow"]').getAttribute('aria-checked')).toBe('true');
    key(m.q('[data-color="#e5484d"]'), 'ArrowRight');
    expect(active()).toBe(m.q('[data-color="#f76b15"]'));
    const range = m.q('input.kb-drawing-palette__range');
    act(() => {
      setProp(range, 'value', '8');
      fireEvent(range, 'input');
    });
    click(m.q('[data-palette-action="undo"]'));
    click(m.q('[data-palette-action="clear"]'));
    expect(m.actions).toEqual([
      { id: 'drawing.change', payload: { name: 'pen', tool: 'arrow' } },
      { id: 'drawing.change', payload: { name: 'pen', color: '#f76b15' } },
      { id: 'drawing.change', payload: { name: 'pen', width: 8 } },
      { id: 'drawing.undo', payload: { name: 'pen' } },
      { id: 'drawing.clear', payload: { name: 'pen' } },
    ]);
    m.unmount();
  });

  it('SketchBoard: ready controller, strokes, undo, clear confirmation, inline text', () => {
    function Host() {
      const [show, setShow] = useState(true);
      return show ? (
        <>
          <button type="button" className="unmount" onClick={() => setShow(false)} />
          <SketchBoard
            id="sb"
            name="sketch"
            label="Sketch"
            canvas_width={800}
            canvas_height={400}
          />
        </>
      ) : null;
    }
    const m = mount(<Host />);
    expect(m.actions[0].id).toBe('drawing.ready');
    const controller = m.actions[0].payload?.controller as { isEmpty(): boolean };
    expect(controller.isEmpty()).toBe(true);
    const canvas = m.q('canvas');
    const stroke = (from: [number, number], to: [number, number]) =>
      act(() => {
        const base = { pointerId: 1, pointerType: 'pen' };
        fireEvent(canvas, 'pointerdown', { ...base, clientX: from[0], clientY: from[1] });
        fireEvent(canvas, 'pointermove', { ...base, clientX: to[0], clientY: to[1] });
        fireEvent(canvas, 'pointerup', { ...base, clientX: to[0], clientY: to[1] });
      });
    stroke([10, 10], [60, 60]);
    expect(m.q('.kb-sketch-board').getAttribute('data-state')).toBe('dirty');
    expect(controller.isEmpty()).toBe(false);
    click(m.q('[data-palette-action="undo"]'));
    expect(m.q('[data-palette-action="undo"]').hasAttribute('disabled')).toBe(true);
    stroke([10, 10], [60, 60]);
    // Clear asks first (alertdialog), then clears.
    const clear = m.q('[data-palette-action="clear"]');
    clear.focus();
    click(clear);
    expect(m.q('.kb-sketch-board__dialog .kb-dialog__panel').getAttribute('role')).toBe(
      'alertdialog'
    );
    expect(active()).toBe(m.q('[data-dialog-button="confirm"]'));
    click(m.q('[data-dialog-button="confirm"]'));
    expect(m.q('.kb-sketch-board__dialog .kb-dialog').getAttribute('data-state')).toBe('closed');
    expect(active()).toBe(clear);
    // Text tool: inline input, Enter commits once (the following blur is a no-op).
    click(m.q('[data-tool="text"]'));
    act(() => void fireEvent(canvas, 'pointerdown', { clientX: 200, clientY: 100 }));
    const input = m.q('input.kb-sketch-board__text');
    expect(active()).toBe(input);
    setProp(input, 'value', 'Hi');
    key(input, 'Enter');
    expect(m.container.querySelector('input.kb-sketch-board__text')).toBeNull();
    expect(m.actions.slice(1)).toEqual([
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: false, strokes: 0 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: false, strokes: 0 } },
      { id: 'drawing.change', payload: { name: 'sketch', dirty: true, strokes: 1 } },
    ]);
    // Unmount disposes the engine: later pointer input on the old canvas is ignored.
    const before = m.actions.length;
    click(m.q('.unmount'));
    stroke([1, 1], [40, 40]);
    expect(m.actions).toHaveLength(before);
    m.unmount();
  });

  it('Dialog renders children in its body and traps Tab across them', () => {
    const m = mount(
      <Dialog id="dc" open title="Note" input={{ name: 'note', label: 'Note', multiline: true }}>
        <button type="button" className="extra">
          Extra
        </button>
      </Dialog>
    );
    const panel = m.q('.kb-dialog__panel');
    expect(panel.children.map((child) => child.className)).toEqual([
      'kb-dialog__title',
      'kb-field kb-dialog__field',
      'kb-dialog__content',
      'kb-dialog__actions',
    ]);
    const extra = m.q('.kb-dialog__content .extra');
    extra.focus();
    // Inside the content the browser moves on: no wrap back to the input.
    key(panel, 'Tab');
    expect(active()).toBe(extra);
    m.q('[data-dialog-button="confirm"]').focus();
    key(panel, 'Tab');
    expect(active()).toBe(m.q('textarea'));
    m.unmount();
  });

  it('list and nav-rail item actions dispatch on activation', () => {
    const m = mount(
      <A2UIRenderer
        components={[
          {
            id: 'l',
            type: 'ui:list',
            props: {
              items: [
                {
                  title: 'Clip',
                  action: { id: 'clip.open', payload: { index: 0 } },
                  actions: [{ label: 'Remove', action: { id: 'clip.remove' } }],
                },
              ],
            },
          },
          {
            id: 'n',
            type: 'ui:nav-rail',
            props: {
              items: [
                { id: 'a', label: 'A', action: 'pad.a' },
                { id: 'b', label: 'B', href: '#pad=b', action: 'pad.b' },
              ],
            },
          },
        ]}
      />
    );
    click(m.q('button.kb-list__title'));
    const remove = m.q('.kb-list__actions button');
    expect(remove.getAttribute('aria-describedby')).toBe('kbl-l-0-title');
    click(remove);
    click(m.q('button.kb-nav-rail__item'));
    const link = m.q('a.kb-nav-rail__item');
    const plain = { current: null as null | { defaultPrevented: boolean } };
    act(() => {
      plain.current = fireEvent(link, 'click', { button: 0 });
    });
    expect(plain.current?.defaultPrevented).toBe(true);
    const modified = { current: null as null | { defaultPrevented: boolean } };
    act(() => {
      modified.current = fireEvent(link, 'click', { button: 0, metaKey: true });
    });
    expect(modified.current?.defaultPrevented).toBe(false);
    expect(m.actions).toEqual([
      { id: 'clip.open', payload: { index: 0 } },
      { id: 'clip.remove', payload: undefined },
      { id: 'pad.a', payload: undefined },
      { id: 'pad.b', payload: undefined },
    ]);
    m.unmount();
  });

  it("SketchBoard paste_scope 'document' takes page-wide image pastes, not in fields", () => {
    const document = dom.document as FakeDocument;
    const m = mount(
      <SketchBoard id="sp" name="s" label="S" accept_image_drop paste_scope="document" />
    );
    const png = new File([new Uint8Array(4)], 'clip.png', { type: 'image/png' });
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    act(() => void fireEvent(field, 'paste', { clipboardData: { files: [png] } }));
    expect(m.actions.filter((a) => a.id === 'drawing.background')).toHaveLength(0);
    act(() => void fireEvent(document.body, 'paste', { clipboardData: { files: [png] } }));
    expect(m.actions.filter((a) => a.id === 'drawing.background')).toHaveLength(1);
    m.unmount();
    act(() => void fireEvent(document.body, 'paste', { clipboardData: { files: [png] } }));
    expect(m.actions.filter((a) => a.id === 'drawing.background')).toHaveLength(1);
  });
});
