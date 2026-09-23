// UI-06 (設定 on the shared settings components): the secret / file wiring.
//
// - settings-api.ts keeps the exact endpoints + payload shapes the page used
//   before (multipart /api/setup upload; introduce without the value; apply
//   with {approvalId, value, storageChannel, channel}).
// - The API-token panel's SecretField never renders a value, sends it only in
//   the apply body, and clears its input after submit.
// - The avatar / voice-sample controls hand the chosen File to the page's
//   upload handler (which feeds postSetupUpload).
//
// Interaction runs react-dom/client on the shared-ui fake DOM (jsdom cannot
// load in this workspace), same harness as libs/shared-ui/src/forms.test.tsx.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KbI18nProvider } from '@agent/shared-ui';
import { getUiMessageBundle } from '@agent/core';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
  serializeFake,
  type FakeDocument,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import {
  applySecret,
  fetchSecretReadiness,
  postSetupUpload,
  proposeSecret,
  toUploadFile,
} from '../src/app/settings/settings-api';
import { IntroduceSecretPanel } from '../src/app/settings/sections/IntroduceSecretPanel';
import { VoiceSection, VOICE_SAMPLE_ACCEPT } from '../src/app/settings/sections/VoiceSection';
import { AvatarGenerationPanel } from '../src/app/settings/sections/AvatarGenerationPanel';
import { conciergeText, type ConciergeMessageKey } from '../src/lib/i18n';
import type { Setup } from '../src/lib/settings-types';

const SECRET = 'sk-live-CONCIERGE-secret-9876';
const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
  conciergeText(key, 'en', params);
const ui = getUiMessageBundle('en');
const withKit = (element: ReactElement) =>
  createElement(KbI18nProvider, { locale: ui.locale, messages: ui.messages }, element);

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(respond: (url: string, init?: RequestInit) => unknown) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(respond(url, init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings-api: same endpoints and payload shapes', () => {
  it('postSetupUpload posts multipart action / profile_id / source / file to /api/setup', async () => {
    const calls = mockFetch(() => ({ ok: true }));
    const file = new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' });
    await postSetupUpload({ action: 'avatar', profileId: 'my-voice', source: 'camera', file });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/setup');
    expect(calls[0].init?.method).toBe('POST');
    const body = calls[0].init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect([...body.keys()]).toEqual(['action', 'profile_id', 'source', 'file']);
    expect(body.get('action')).toBe('avatar');
    expect(body.get('profile_id')).toBe('my-voice');
    expect(body.get('source')).toBe('camera');
    expect((body.get('file') as File).name).toBe('avatar.png');
  });

  it('toUploadFile names a bare Blob and passes a File through', () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const named = toUploadFile(blob, 'avatar.png');
    expect(named).toBeInstanceOf(File);
    expect(named.name).toBe('avatar.png');
    const file = new File([blob], 'mine.png', { type: 'image/png' });
    expect(toUploadFile(file, 'avatar.png')).toBe(file);
  });

  it('proposeSecret never carries a value; applySecret sends it once with the approval id', async () => {
    const calls = mockFetch((url) =>
      url === '/api/secrets/introduce'
        ? {
            ok: true,
            approvalId: 'APR-1',
            status: 'approved',
            envName: 'SLACK_API_KEY',
            storageChannel: 'concierge',
          }
        : { ok: true, status: 'applied', envName: 'SLACK_API_KEY' }
    );
    const proposal = await proposeSecret({ serviceId: 'slack', secretKey: 'API_KEY', reason: '' });
    expect(proposal).toEqual({
      ok: true,
      approvalId: 'APR-1',
      status: 'approved',
      envName: 'SLACK_API_KEY',
      storageChannel: 'concierge',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      serviceId: 'slack',
      secretKey: 'API_KEY',
      reason: 'Introduce slack API_KEY',
      autoApprove: true,
    });
    const applied = await applySecret({
      approvalId: 'APR-1',
      value: SECRET,
      storageChannel: 'concierge',
    });
    expect(applied).toEqual({ ok: true, status: 'applied', envName: 'SLACK_API_KEY' });
    expect(calls[1].url).toBe('/api/secrets/apply');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      approvalId: 'APR-1',
      value: SECRET,
      storageChannel: 'concierge',
      channel: 'concierge',
    });
  });

  it('fetchSecretReadiness maps keys and presence only (never a value)', async () => {
    const calls = mockFetch(() => ({
      ok: true,
      readiness: {
        serviceId: 'slack',
        identities: [
          { envName: 'SLACK_API_KEY', secretKey: 'API_KEY', present: true },
          { envName: 'SLACK_BOT_TOKEN', secretKey: 'BOT_TOKEN', present: false },
        ],
      },
      secretKeys: ['API_KEY', 'BOT_TOKEN'],
    }));
    const readiness = await fetchSecretReadiness('slack');
    expect(calls[0].url).toBe('/api/secrets/introduce?serviceId=slack');
    expect(readiness).toEqual({
      secretKeys: ['API_KEY', 'BOT_TOKEN'],
      present: { API_KEY: true, BOT_TOKEN: false },
    });
  });
});

describe('API tokens panel (SecretField)', () => {
  it('static render: the secret input has no value / name attribute', () => {
    const html = renderToStaticMarkup(
      withKit(
        createElement(IntroduceSecretPanel, {
          t,
          busy: false,
          services: [{ id: 'slack', label: 'Slack' }],
        })
      )
    );
    expect(html).toContain('kb-secret-field');
    const input = html.match(/<input[^>]*kb-secret-field__input[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="off"');
    expect(input).not.toMatch(/\svalue=/);
    expect(input).not.toMatch(/\sname=/);
    expect(html).toContain(t('settings.secrets_title'));
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
  // The shared fake DOM has no <select>.options; react-dom reads it when a
  // controlled Select mounts. Local, test-only shim (option descendants).
  if (!Object.getOwnPropertyDescriptor(FakeElement.prototype, 'options')) {
    Object.defineProperty(FakeElement.prototype, 'options', {
      configurable: true,
      get(this: FakeElement) {
        if (this.localName !== 'select') return undefined;
        const out: FakeElement[] = [];
        const walk = (node: FakeElement) => {
          for (const child of node.children) {
            if (child.localName === 'option') out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
    });
  }
  client = await import('react-dom/client');
});

afterAll(() => {
  dom.restore();
});

function mount(element: ReactElement) {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  act(() => root.render(withKit(element)));
  const q = (selector: string) => {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  return { container, q, unmount: () => act(() => root.unmount()) };
}

const setProp = (el: FakeElement, name: string, value: unknown) => {
  (el as unknown as Record<string, unknown>)[name] = value;
};
const prop = (el: FakeElement, name: string) => (el as unknown as Record<string, unknown>)[name];
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('settings interaction', () => {
  it('SecretField: value goes only into /api/secrets/apply, never into markup, and is cleared', async () => {
    const calls = mockFetch((url) =>
      url.startsWith('/api/secrets/introduce?')
        ? { ok: true, readiness: { identities: [] }, secretKeys: [] }
        : url === '/api/secrets/introduce'
          ? {
              ok: true,
              approvalId: 'APR-7',
              status: 'approved',
              envName: 'SLACK_API_KEY',
              storageChannel: 'concierge',
            }
          : { ok: true, status: 'applied', envName: 'SLACK_API_KEY' }
    );
    const m = mount(
      createElement(IntroduceSecretPanel, {
        t,
        busy: false,
        services: [{ id: 'slack', label: 'Slack' }],
      })
    );
    await flush();
    // Locked until an approval exists.
    expect(prop(m.q('input.kb-secret-field__input'), 'disabled')).toBe(true);
    // Propose (no value in the body).
    const proposeButton = [...m.container.querySelectorAll('button')].find(
      (button) => button.textContent === t('settings.secret_propose')
    )!;
    await act(async () => {
      fireEvent(proposeButton, 'click');
    });
    await flush();
    const proposeCall = calls.find(
      (call) => call.url === '/api/secrets/introduce' && call.init?.method === 'POST'
    )!;
    expect(String(proposeCall.init?.body)).not.toContain('value');

    const input = m.q('input.kb-secret-field__input');
    expect(prop(input, 'disabled')).toBeFalsy();
    act(() => {
      setProp(input, 'value', SECRET);
      fireEvent(input, 'input');
    });
    expect(serializeFake(m.container)).not.toContain(SECRET);
    await act(async () => {
      fireEvent(m.q('.kb-secret-field__save'), 'click');
    });
    await flush();
    const applyCall = calls.find((call) => call.url === '/api/secrets/apply')!;
    expect(JSON.parse(String(applyCall.init?.body))).toEqual({
      approvalId: 'APR-7',
      value: SECRET,
      storageChannel: 'concierge',
      channel: 'concierge',
    });
    expect(prop(m.q('input.kb-secret-field__input'), 'value')).toBe('');
    expect(serializeFake(m.container)).not.toContain(SECRET);
    expect(serializeFake(m.container)).toContain(
      t('settings.secret_applied', { env: 'SLACK_API_KEY' })
    );
    // The field reports the governed apply's outcome, not its own submit.
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('saved');
    expect(m.q('.kb-secret-field__notice').textContent).toBe(ui.messages['ui:secret_saved']);
    m.unmount();
  });

  it('SecretField: a failed apply shows sending, then the error — never "saved"', async () => {
    let releaseApply: () => void = () => {};
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === '/api/secrets/apply') {
          await applyGate;
          return new Response(JSON.stringify({ ok: false, error: 'approval expired' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = url.startsWith('/api/secrets/introduce?')
          ? { ok: true, readiness: { identities: [] }, secretKeys: [] }
          : {
              ok: true,
              approvalId: 'APR-8',
              status: 'approved',
              envName: 'SLACK_API_KEY',
              storageChannel: 'concierge',
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const m = mount(
      createElement(IntroduceSecretPanel, {
        t,
        busy: false,
        services: [{ id: 'slack', label: 'Slack' }],
      })
    );
    await flush();
    const proposeButton = [...m.container.querySelectorAll('button')].find(
      (button) => button.textContent === t('settings.secret_propose')
    )!;
    await act(async () => {
      fireEvent(proposeButton, 'click');
    });
    await flush();
    const input = m.q('input.kb-secret-field__input');
    act(() => {
      setProp(input, 'value', SECRET);
      fireEvent(input, 'input');
    });
    await act(async () => {
      fireEvent(m.q('.kb-secret-field__save'), 'click');
    });
    // While the apply is in flight: neutral "sending", value already cleared.
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('pending');
    expect(m.q('.kb-secret-field__notice').textContent).toBe(ui.messages['ui:secret_pending']);
    expect(prop(m.q('input.kb-secret-field__input'), 'value')).toBe('');
    releaseApply();
    await flush();
    expect(calls.some((call) => call.url === '/api/secrets/apply')).toBe(true);
    expect(m.q('.kb-secret-field').getAttribute('data-status')).toBe('error');
    const failure = t('settings.secret_failed', { error: 'approval expired' });
    expect(m.q('.kb-secret-field__notice').textContent).toBe(failure);
    expect(serializeFake(m.container)).not.toContain(ui.messages['ui:secret_saved']);
    expect(serializeFake(m.container)).not.toContain(SECRET);
    // The input is open again for a retry.
    expect(prop(m.q('input.kb-secret-field__input'), 'disabled')).toBeFalsy();
    m.unmount();
  });

  it('voice sample FileDrop hands the File to the page upload handler', () => {
    const onVoiceSampleFileChange = vi.fn();
    const onAvatarChange = vi.fn();
    // PA-10: the avatar-generation panel asks for its plan on mount.
    mockFetch(() => ({ ok: true, photo_available: false, plan: null, avatar: null }));
    const setup = {
      profile: { name: 'Ada', avatar_registered: false },
    } as unknown as Setup;
    const m = mount(
      createElement(VoiceSection, {
        locale: 'en',
        t,
        setup,
        busy: false,
        onAvatarChange,
        voice: { profile_id: 'my-voice', display_name: 'My voice' },
        setVoice: () => {},
        voiceSampleRefs: [],
        voiceRecording: false,
        onStartVoiceRecording: () => {},
        onStopVoiceRecording: () => {},
        onVoiceSampleFileChange,
        onSaveVoice: () => {},
        voiceSelection: null,
        voiceDevices: [],
        voiceSelectionBusy: false,
        onSaveVoiceSelection: () => {},
        sectionRef: () => {},
      })
    );
    expect(m.q('.kb-file-drop__input').getAttribute('accept')).toBe(VOICE_SAMPLE_ACCEPT);
    expect(m.container.querySelector('.kb-avatar-picker')).toBeTruthy();
    const sample = new File([new Uint8Array(4)], 'voice.webm', { type: 'audio/webm' });
    act(() => {
      fireEvent(m.q('.kb-file-drop__zone'), 'drop', { dataTransfer: { files: [sample] } });
    });
    expect(onVoiceSampleFileChange).toHaveBeenCalledTimes(1);
    expect(onVoiceSampleFileChange.mock.calls[0][0]).toBe(sample);
    expect(serializeFake(m.container)).not.toContain('voice.webm');
    m.unmount();
  });

  it('PA-10: the consent dialog names the provider; cancel sends nothing, confirm starts the job', async () => {
    const calls = mockFetch((url) =>
      url === '/api/setup'
        ? { ok: true, job: { id: 'job-1', status: 'running', provider_id: 'gemini_image' } }
        : {
            ok: true,
            photo_available: true,
            plan: {
              provider_id: 'gemini_image',
              display_name: 'Google Gemini API',
              data_egress: 'cloud',
              interactive_handoff: false,
            },
            avatar: null,
          }
    );
    const m = mount(createElement(AvatarGenerationPanel, { t, busy: false, photoVersion: 'v1' }));
    await flush();
    expect(calls.map((call) => call.url)).toEqual(['/api/setup/avatar-generation']);
    const open = () => act(() => fireEvent(m.q('.kb-setting-row .kb-btn'), 'click'));

    open();
    const consent = t('setup.avatar_consent_cloud', { provider: 'Google Gemini API' });
    expect(serializeFake(m.q('.kb-dialog__message'))).toContain('Google Gemini API');
    expect(consent).toContain('Google Gemini API');
    act(() => fireEvent(m.q('[data-dialog-button="cancel"]'), 'click'));
    await flush();
    expect(calls.some((call) => call.url === '/api/setup')).toBe(false);

    open();
    act(() => fireEvent(m.q('[data-dialog-button="confirm"]'), 'click'));
    await flush();
    const post = calls.find((call) => call.url === '/api/setup')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({
      action: 'avatar_generate',
      consent: { provider_id: 'gemini_image', confirmed: true },
    });
    m.unmount();
  });

  it('PA-10: a generated set previews through the authenticated avatar URLs only', async () => {
    mockFetch(() => ({
      ok: true,
      photo_available: true,
      plan: null,
      avatar: {
        images: { neutral: '/api/me/avatar/neutral', joy: '/api/me/avatar/joy' },
        mouth: { x: 0.5, y: 0.68, width: 0.22 },
        generated_at: '2026-09-24T00:00:00Z',
        adopted: false,
      },
    }));
    const m = mount(createElement(AvatarGenerationPanel, { t, busy: false, photoVersion: 'v1' }));
    await flush();
    const html = serializeFake(m.container);
    expect(html).toContain('/api/me/avatar/joy?v=');
    expect(html).not.toContain('knowledge/personal');
    expect(html).toContain(t('setup.avatar_use'));
    m.unmount();
  });
});
