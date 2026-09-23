// UI-01c: React settings & form components.
//
// Static markup (renderToStaticMarkup) pins the class / attribute contract;
// interaction runs the real react-dom/client against the small fake DOM in
// `vanilla/fake-dom.test-support.ts` (the workspace jsdom cannot load), so
// handlers, state and effects (camera disposal, focus) execute for real.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactElement } from 'react';
import { getUiMessageBundle } from '@agent/core';
import {
  FakeElement,
  fireEvent,
  installFakeDom,
  serializeFake,
  type FakeDocument,
} from '../vanilla/fake-dom.test-support.js';
import {
  A2UIActionProvider,
  AvatarPicker,
  CameraCapture,
  Checkbox,
  DisplayControls,
  FileDrop,
  IntegrationItem,
  KbI18nProvider,
  NavRail,
  RadioGroup,
  SaveBar,
  SecretField,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  Slider,
  Switch,
  TextField,
  Textarea,
} from './index.js';

const ja = getUiMessageBundle('ja');
const html = (element: ReactElement) => renderToStaticMarkup(element);
const htmlJa = (element: ReactElement) =>
  renderToStaticMarkup(
    <KbI18nProvider locale={ja.locale} messages={ja.messages}>
      {element}
    </KbI18nProvider>
  );

describe('React form components: static markup contract', () => {
  it('TextField: label[for], describedby help + error, aria-invalid, required marker', () => {
    const out = html(
      <TextField
        id="c1"
        name="profile.email"
        label="Email"
        type="email"
        value="a@b"
        help="Work"
        error="Invalid"
        required
        maxlength={80}
      />
    );
    expect(out).toContain(
      '<div class="kb-field" data-control="text-field" data-invalid="true"><label class="kb-field__label" for="kbf-c1">Email<span class="kb-field__required" aria-hidden="true">Required</span></label>'
    );
    expect(out).toContain(
      '<input class="kb-input" type="email" id="kbf-c1" aria-describedby="kbf-c1-help kbf-c1-error" aria-invalid="true" required="" maxLength="80" name="profile.email" value="a@b"/>'
    );
    expect(out).toContain('<p class="kb-field__help" id="kbf-c1-help">Work</p>');
    expect(out).toContain('<p class="kb-field__error" id="kbf-c1-error">Invalid</p>');
  });

  it('Switch / Checkbox / Select / RadioGroup / Segmented / Slider / Textarea', () => {
    expect(html(<Switch id="s" name="n" label="L" value hide_label />)).toBe(
      '<div class="kb-field" data-control="switch"><label class="kb-switch"><input class="kb-switch__input" type="checkbox" role="switch" id="kbf-s" name="n" checked=""/><span class="kb-switch__track" aria-hidden="true"><span class="kb-switch__thumb"></span></span><span class="kb-switch__label kb-visually-hidden">L</span></label></div>'
    );
    expect(html(<Checkbox id="c" name="n" label="L" />)).toContain(
      '<label class="kb-check"><input class="kb-check__input" type="checkbox" id="kbf-c" name="n"/>'
    );
    const select = htmlJa(
      <Select id="s" name="lang" label="言語" options={[{ value: 'en', label: 'English' }]} />
    );
    expect(select).toContain(
      `<option value="" disabled="" selected="">${ja.messages['ui:select_placeholder']}</option>`
    );
    const radios = html(
      <RadioGroup
        id="r"
        name="mode"
        label="Mode"
        value="a"
        direction="horizontal"
        options={[
          { value: 'a', label: 'A', description: 'first' },
          { value: 'b', label: 'B', disabled: true },
        ]}
      />
    );
    expect(radios).toMatch(
      /^<fieldset class="kb-field kb-choice-group" data-control="radio-group" data-direction="horizontal"><legend class="kb-field__label">Mode<\/legend>/
    );
    expect(radios).toContain(
      'id="kbf-r-0" aria-describedby="kbf-r-0-description" name="kbf-r" checked="" value="a"'
    );
    expect(radios).toContain('<label class="kb-check" data-disabled="true">');
    expect(
      html(
        <Segmented
          id="g"
          name="d"
          label="D"
          value="y"
          options={[
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
          ]}
        />
      )
    ).toMatch(
      /<label class="kb-segmented__option"><input class="kb-segmented__input" type="radio" id="kbf-g-1" [^>]*checked=""[^>]*\/><span class="kb-segmented__label">Y<\/span><\/label>/
    );
    expect(html(<Slider id="v" name="vol" label="Volume" value={40} unit="%" />)).toContain(
      '<output class="kb-slider__value" for="kbf-v" aria-hidden="true">40%</output>'
    );
    expect(html(<Textarea id="t" name="n" label="N" value="abc" maxlength={10} />)).toContain(
      '>abc</textarea><p class="kb-field__count" aria-hidden="true">3 / 10</p>'
    );
  });

  it('settings group / row, integration item and save bar', () => {
    const group = html(
      <SettingsGroup id="g" title="Notifications" description="When">
        <SettingRow label="Email" tone="danger">
          <span>control</span>
        </SettingRow>
      </SettingsGroup>
    );
    expect(group).toBe(
      '<section class="kb-settings-group" aria-labelledby="kbf-g-title"><header class="kb-settings-group__header"><h2 class="kb-settings-group__title" id="kbf-g-title">Notifications</h2><p class="kb-settings-group__description">When</p></header><div class="kb-settings-group__rows"><div class="kb-setting-row" data-tone="danger"><div class="kb-setting-row__text"><p class="kb-setting-row__label">Email</p></div><div class="kb-setting-row__control"><span>control</span></div></div></div></section>'
    );
    const item = htmlJa(<IntegrationItem title="Slack" state="error" />);
    expect(item).toContain('data-status="error"');
    expect(item).toContain(ja.messages['ui:integration_error']);
    const saving = html(<SaveBar state="saving" save_action={{ id: 's' }} />);
    expect(saving).toContain('role="region" aria-label="Unsaved changes"');
    expect(saving).toContain('disabled="" data-action-id="s" aria-busy="true">Save</button>');
  });

  it('secret field has no value attribute, no name and never renders a stored secret', () => {
    const out = html(
      <SecretField id="k" name="openai" label="Key" action={{ id: 'secret.introduce' }} />
    );
    expect(out).toContain('type="password"');
    expect(out).toContain('autoComplete="off"');
    expect(out).toContain('spellCheck="false"');
    expect(out).not.toMatch(/\bvalue=/);
    expect(out).not.toMatch(/\bname=/);
    const configured = htmlJa(
      <SecretField id="k" name="openai" label="Key" configured last4="Q7xk" action={{ id: 'x' }} />
    );
    expect(configured).not.toContain('<input');
    expect(configured).toContain('設定済み · ••••Q7xk');
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

const prop = <T,>(el: FakeElement, name: string) => (el as unknown as Record<string, T>)[name];
const setProp = (el: FakeElement, name: string, value: unknown) => {
  (el as unknown as Record<string, unknown>)[name] = value;
};
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function file(name: string, size: number, type: string): File {
  const f = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('React form components: interaction', () => {
  it('TextField echoes the edit and dispatches field.change; a new value prop re-syncs', () => {
    const m = mount(<TextField id="t" name="profile.name" label="Name" value="Ada" />);
    const input = m.q('input');
    expect(prop(input, 'value')).toBe('Ada');
    act(() => {
      setProp(input, 'value', 'Ada L');
      fireEvent(input, 'input');
    });
    expect(m.actions).toEqual([
      { id: 'field.change', payload: { name: 'profile.name', value: 'Ada L' } },
    ]);
    m.rerender(<TextField id="t" name="profile.name" label="Name" value="Grace" />);
    expect(prop(m.q('input'), 'value')).toBe('Grace');
    m.unmount();
  });

  it('Switch dispatches booleans; number TextField dispatches numbers', () => {
    const m = mount(<Switch id="s" name="notify" label="Notify" value={false} />);
    const input = m.q('input');
    act(() => {
      setProp(input, 'checked', true);
      fireEvent(input, 'click');
    });
    expect(m.actions).toEqual([{ id: 'field.change', payload: { name: 'notify', value: true } }]);
    m.unmount();
    const n = mount(<TextField id="n" name="count" label="Count" type="number" />);
    act(() => {
      setProp(n.q('input'), 'value', '7');
      fireEvent(n.q('input'), 'input');
    });
    expect(n.actions[0].payload).toEqual({ name: 'count', value: 7 });
    n.unmount();
  });

  it('FileDrop: drop + paste hand File objects to onAction only; rejections are announced', () => {
    const m = mount(
      <FileDrop
        id="f"
        name="docs"
        label="Docs"
        accept=".pdf"
        multiple
        max_bytes={1000}
        action={{ id: 'ingest.upload', payload: { tenant: 'acme' } }}
        files={[{ id: 'x1', name: 'old.pdf', size: 10, status: 'done' }]}
      />
    );
    const zone = m.q('.kb-file-drop__zone');
    const ok = file('a.pdf', 100, 'application/pdf');
    const exe = file('b.exe', 100, 'application/x-msdownload');
    act(() => {
      fireEvent(zone, 'dragover');
    });
    expect(m.q('.kb-file-drop').getAttribute('data-dragging')).toBe('true');
    const drop = { dataTransfer: { files: [ok, exe] } };
    let dropEvent!: ReturnType<typeof fireEvent>;
    act(() => {
      dropEvent = fireEvent(zone, 'drop', drop);
    });
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(m.q('.kb-file-drop').hasAttribute('data-dragging')).toBe(false);
    expect(m.actions).toHaveLength(1);
    expect(m.actions[0].id).toBe('ingest.upload');
    expect(m.actions[0].payload!.tenant).toBe('acme');
    expect((m.actions[0].payload!.files as File[])[0]).toBe(ok);
    expect(m.actions[0].payload!.rejected).toEqual([{ name: 'b.exe', size: 100, reason: 'type' }]);
    expect(m.q('.kb-file-drop__notice').textContent).toBe("b.exe isn't an accepted file type");
    const pasted = file('p.pdf', 5, 'application/pdf');
    act(() => {
      fireEvent(m.q('.kb-file-drop__input'), 'paste', { clipboardData: { files: [pasted] } });
    });
    expect((m.actions[1].payload!.files as File[])[0]).toBe(pasted);
    act(() => {
      fireEvent(m.q('.kb-file-list__remove'), 'click');
    });
    expect(m.actions[2]).toEqual({ id: 'file.remove', payload: { name: 'docs', file_id: 'x1' } });
    expect(serializeFake(m.container)).not.toContain('a.pdf');
    m.unmount();
  });

  it('SecretField: value only in the submit payload; never in markup / state; cleared after', () => {
    const SECRET = 'sk-live-REACT-secret-1234';
    const m = mount(
      <SecretField
        id="k"
        name="secrets.openai"
        label="Key"
        service_id="openai"
        secret_key="api_key"
        action={{ id: 'secret.introduce' }}
      />
    );
    const input = m.q('input.kb-secret-field__input');
    expect(prop(m.q('.kb-secret-field__save'), 'disabled')).toBe(true);
    act(() => {
      setProp(input, 'value', SECRET);
      fireEvent(input, 'input');
    });
    expect(prop(m.q('.kb-secret-field__save'), 'disabled')).toBe(false);
    act(() => {
      fireEvent(m.q('.kb-secret-field__toggle'), 'click');
    });
    expect(m.q('input.kb-secret-field__input').getAttribute('type')).toBe('text');
    expect(m.q('.kb-secret-field__toggle').getAttribute('aria-pressed')).toBe('true');
    expect(serializeFake(m.container)).not.toContain(SECRET);
    expect(m.actions).toEqual([]);
    act(() => {
      fireEvent(m.q('.kb-secret-field__save'), 'click');
    });
    expect(m.actions).toEqual([
      {
        id: 'secret.introduce',
        payload: {
          name: 'secrets.openai',
          service_id: 'openai',
          secret_key: 'api_key',
          value: SECRET,
        },
      },
    ]);
    const after = m.q('input.kb-secret-field__input');
    expect(prop(after, 'value')).toBe('');
    expect(after.getAttribute('type')).toBe('password');
    // Submitting is not saving: "sending" until the host reports the outcome.
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('pending');
    expect(m.q('.kb-secret-field__notice').textContent).toBe(
      'Sending… The value is not kept on this page.'
    );
    expect(serializeFake(m.container)).not.toContain(SECRET);
    m.unmount();
  });

  it('SecretField host status: pending → error reopens the input with the reason → saved', () => {
    const field = (status?: 'idle' | 'pending' | 'error' | 'saved', statusError?: string) => (
      <SecretField
        id="k"
        name="slack"
        label="Token"
        configured
        last4="Q7xk"
        action={{ id: 'secret.introduce' }}
        status={status}
        status_error={statusError}
      />
    );
    const m = mount(field());
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('idle');
    expect(m.q('.kb-secret-field__notice').textContent).toBe('');
    m.rerender(field('pending'));
    expect(m.q('.kb-secret-field__notice').textContent).toBe(
      'Sending… The value is not kept on this page.'
    );
    m.rerender(field('error', 'Approval expired.'));
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('error');
    expect(m.q('.kb-secret-field').getAttribute('data-state')).toBe('editing');
    expect(m.container.querySelector('input.kb-secret-field__input')).not.toBeNull();
    expect(m.q('.kb-secret-field__notice').textContent).toBe('Approval expired.');
    // Typing again hides the stale error; submitting shows "sending", not the old outcome.
    const input = m.q('input.kb-secret-field__input');
    act(() => {
      setProp(input, 'value', 'xoxb-2');
      fireEvent(input, 'input');
    });
    expect(m.q('.kb-secret-field__notice').textContent).toBe('');
    act(() => {
      fireEvent(input, 'keydown', { key: 'Enter' });
    });
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('pending');
    m.rerender(field('saved'));
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('saved');
    expect(m.q('.kb-secret-field__notice').textContent).toBe(
      'Saved. The value is not kept on this page.'
    );
    m.unmount();
  });

  it('SecretField configured: replace focuses the input, Enter submits, cancel returns', async () => {
    const m = mount(
      <SecretField
        id="k"
        name="slack"
        label="Token"
        configured
        last4="Q7xk"
        action={{ id: 'secret.introduce' }}
        remove_action={{ id: 'secret.remove' }}
      />
    );
    expect(m.container.querySelector('input')).toBeNull();
    act(() => {
      fireEvent(m.qa('.kb-secret-field__actions button')[1], 'click');
    });
    expect(m.actions).toEqual([{ id: 'secret.remove', payload: { name: 'slack' } }]);
    act(() => {
      fireEvent(m.qa('.kb-secret-field__actions button')[0], 'click');
    });
    await flush();
    const input = m.q('input.kb-secret-field__input');
    expect(dom.document.activeElement).toBe(input);
    act(() => {
      setProp(input, 'value', 'xoxb-1');
      fireEvent(input, 'keydown', { key: 'Enter' });
    });
    expect(m.actions[1].payload!.value).toBe('xoxb-1');
    expect(m.q('.kb-secret-field').getAttribute('data-state')).toBe('configured');
    m.unmount();
  });

  it('CameraCapture: falls back to a capture file input when getUserMedia is missing', async () => {
    const m = mount(<CameraCapture id="cam" name="receipt" label="Receipt" facing="environment" />);
    expect(m.q('.kb-camera').getAttribute('data-state')).toBe('idle');
    act(() => {
      fireEvent(m.q('.kb-camera__actions button'), 'click');
    });
    await flush();
    expect(m.q('.kb-camera').getAttribute('data-state')).toBe('fallback');
    expect(m.q('.kb-camera__notice').textContent).toBe(
      "The camera isn't available here. Choose a photo instead."
    );
    const input = m.q('.kb-camera__file input');
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    m.unmount();
  });

  it('CameraCapture: live stream tracks stop on cancel and on unmount', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const w = dom.window as Record<string, unknown>;
    w.navigator = { mediaDevices: { getUserMedia: vi.fn(async () => stream) } };
    try {
      const m = mount(<CameraCapture id="cam" name="receipt" label="Receipt" />);
      act(() => {
        fireEvent(m.q('.kb-camera__actions button'), 'click');
      });
      await flush();
      expect(m.q('.kb-camera').getAttribute('data-state')).toBe('live');
      expect(prop(m.q('video'), 'srcObject')).toBe(stream);
      act(() => {
        fireEvent(m.q('.kb-camera__actions .kb-btn--ghost'), 'click');
      });
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(m.actions).toEqual([{ id: 'camera.cancel', payload: { name: 'receipt' } }]);
      act(() => {
        fireEvent(m.q('.kb-camera__actions button'), 'click');
      });
      await flush();
      expect(m.q('.kb-camera').getAttribute('data-state')).toBe('live');
      m.unmount();
      expect(track.stop).toHaveBeenCalledTimes(2);
    } finally {
      delete w.navigator;
    }
  });

  it('AvatarPicker: remove dispatches; take-photo opens the camera and cancel stops it', async () => {
    const track = { stop: vi.fn() };
    const w = dom.window as Record<string, unknown>;
    w.navigator = {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    };
    try {
      const m = mount(
        <AvatarPicker id="a" name="avatar" label="Avatar" image_url="/a.png" removable />
      );
      expect(m.q('img.kb-avatar-picker__image').getAttribute('src')).toBe('/a.png');
      act(() => {
        fireEvent(m.qa('.kb-avatar-picker__actions button')[1], 'click');
      });
      expect(m.actions).toEqual([{ id: 'avatar.remove', payload: { name: 'avatar' } }]);
      act(() => {
        fireEvent(m.qa('.kb-avatar-picker__actions button')[0], 'click');
      });
      await flush();
      expect(m.q('.kb-avatar-picker').getAttribute('data-state')).toBe('camera');
      expect(m.container.querySelector('.kb-avatar-picker__camera video')).not.toBeNull();
      act(() => {
        fireEvent(m.q('.kb-avatar-picker__camera .kb-btn--ghost'), 'click');
      });
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(m.q('.kb-avatar-picker').getAttribute('data-state')).toBe('idle');
      m.unmount();
    } finally {
      delete w.navigator;
    }
  });
});

describe('React shell controls: interaction (display controls, rail context switcher)', () => {
  it('DisplayControls re-emits the inner field changes as display.theme / display.locale', () => {
    const m = mount(<DisplayControls id="prefs" theme="system" locale="ja" />);
    expect(m.q('.kb-display-controls').getAttribute('role')).toBe('group');
    const radios = m.qa('input.kb-segmented__input');
    expect(radios.map((radio) => prop<string>(radio, 'value'))).toEqual([
      'system',
      'light',
      'dark',
    ]);
    act(() => {
      setProp(radios[2], 'checked', true);
      fireEvent(radios[2], 'click');
    });
    const select = m.q('select.kb-select');
    act(() => {
      setProp(select, 'value', 'en');
      fireEvent(select, 'change');
    });
    expect(m.actions).toEqual([
      { id: 'display.theme', payload: { value: 'dark' } },
      { id: 'display.locale', payload: { value: 'en' } },
    ]);
    m.unmount();
  });

  it('NavRail context switcher toggles its listbox and dispatches the action with { value }', () => {
    const m = mount(
      <NavRail
        items={[]}
        context={{
          label: 'Default',
          detail: 'Owner',
          action: { id: 'tenant.switch', payload: { source: 'rail' } },
          options: [
            { value: 'default', label: 'Default', selected: true },
            { value: 'acme', label: 'Acme' },
          ],
        }}
      />
    );
    const button = m.q('button.kb-nav-rail__context-button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(true);
    act(() => fireEvent(button, 'click'));
    expect(m.q('button.kb-nav-rail__context-button').getAttribute('aria-expanded')).toBe('true');
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(false);
    act(() => fireEvent(m.qa('.kb-nav-rail__context-option')[1], 'click'));
    expect(m.actions).toEqual([
      { id: 'tenant.switch', payload: { source: 'rail', value: 'acme' } },
    ]);
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(true);
    // Escape and a press outside the block also close it.
    act(() => fireEvent(m.q('button.kb-nav-rail__context-button'), 'click'));
    act(() => fireEvent(m.q('button.kb-nav-rail__context-button'), 'keydown', { key: 'Escape' }));
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(true);
    act(() => fireEvent(m.q('button.kb-nav-rail__context-button'), 'click'));
    act(() => fireEvent(m.q('.kb-nav-rail__context-option'), 'pointerdown'));
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(false);
    act(() => fireEvent((dom.document as FakeDocument).body, 'pointerdown'));
    expect(m.q('ul.kb-nav-rail__context-menu').hasAttribute('hidden')).toBe(true);
    m.unmount();
  });
});
