// PA-02: React `VoiceInput` / `VoiceState`.
//
// Static markup (renderToStaticMarkup) pins the SSR idle state (no media
// during render); interaction runs react-dom/client on the fake DOM
// (`vanilla/fake-dom.test-support.ts`) with the fake audio APIs
// (`vanilla/voice-fakes.test-support.ts`) installed on `window`, so the
// effect-owned controller, push-to-talk and unmount cleanup execute for real.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactElement } from 'react';
import { getUiMessageBundle } from '@agent/core';
import {
  fireEvent,
  installFakeDom,
  type FakeDocument,
  type FakeElement,
} from '../../vanilla/fake-dom.test-support.js';
import {
  NO_LEAKS,
  createVoiceFakes,
  type VoiceFakeOptions,
} from '../../vanilla/voice-fakes.test-support.js';
import { A2UIActionProvider, KbI18nProvider, VoiceInput, VoiceState } from '../index.js';
import { KB_VOICE_MESSAGE_KEYS } from '../../vanilla/voice.js';

const EN = getUiMessageBundle('en');
const JA = getUiMessageBundle('ja');

describe('React voice components: static markup', () => {
  it('VoiceInput server-renders the idle state (support is decided on the client)', () => {
    const out = renderToStaticMarkup(
      <VoiceInput id="v" name="note" label="Note" show_transcript help="Say it" />
    );
    expect(out).toContain(
      '<div class="kb-field kb-voice-input" data-control="voice-input" data-mode="dictation" data-state="idle">'
    );
    expect(out).toContain(
      'id="kbf-v" aria-labelledby="kbf-v-label kbf-v-action" aria-describedby="kbf-v-status kbf-v-help" aria-pressed="false"'
    );
    expect(out).toContain('<span class="kb-voice-input__action" id="kbf-v-action">Dictate</span>');
    expect(out).toContain('<span class="kb-voice-input__time" aria-hidden="true">0:00</span>');
    expect(out).toContain('<p class="kb-voice-input__transcript"></p>');
    expect(out).toContain('<p class="kb-voice-input__status" id="kbf-v-status" role="status"></p>');
  });

  it('VoiceState: role=status, level as a custom property, localized label', () => {
    const out = renderToStaticMarkup(
      <KbI18nProvider locale={JA.locale} messages={JA.messages}>
        <VoiceState state="speaking" level={0.456} variant="orb" size="lg" />
      </KbI18nProvider>
    );
    expect(out).toContain(
      '<div class="kb-voice-state" role="status" data-state="speaking" data-variant="orb" data-size="lg" data-has-level="true" style="--kb-voice-level:0.46">'
    );
    expect(out).toContain('<span class="kb-voice-state__orb"></span>');
    expect(out).toContain(
      `<span class="kb-voice-state__label">${JA.messages[KB_VOICE_MESSAGE_KEYS.stateSpeaking]}</span>`
    );
  });
});

// ---------------------------------------------------------------------------
// Interaction (react-dom/client on the fake DOM)
// ---------------------------------------------------------------------------

type ClientModule = typeof import('react-dom/client');
let client: ClientModule;
let dom: ReturnType<typeof installFakeDom>;
let installed: string[] = [];

beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});

afterAll(() => {
  dom.restore();
});

afterEach(() => {
  const w = dom.window as Record<string, unknown>;
  for (const key of installed) delete w[key];
  installed = [];
});

function useFakes(options: VoiceFakeOptions = {}) {
  const fakes = createVoiceFakes(options);
  const w = dom.window as Record<string, unknown>;
  for (const [key, value] of Object.entries(fakes.win)) {
    if (key === 'File') continue;
    w[key] = value;
    installed.push(key);
  }
  return fakes;
}

function mount(element: ReactElement) {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const actions: Array<{ id: string; payload?: Record<string, unknown> }> = [];
  const root = client.createRoot(container as unknown as Element);
  const wrap = (child: ReactElement) => (
    <A2UIActionProvider onAction={(id, payload) => actions.push({ id, payload })}>
      {child}
    </A2UIActionProvider>
  );
  act(() => root.render(wrap(element)));
  const q = (selector: string): FakeElement => {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  return {
    actions,
    q,
    state: () => q('.kb-voice-input').getAttribute('data-state'),
    unmount: () => act(() => root.unmount()),
  };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('React VoiceInput: interaction', () => {
  it('shows unsupported on the client when SpeechRecognition is missing', () => {
    useFakes({ noRecognition: true });
    const m = mount(<VoiceInput id="v" name="note" label="Note" />);
    expect(m.state()).toBe('unsupported');
    expect(m.q('.kb-voice-input__button').disabled).toBe(true);
    expect(m.q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.unsupportedDictation]
    );
    m.unmount();
  });

  it('click toggles dictation: level, elapsed, interim transcript, stop → idle, no leaks', async () => {
    const fakes = useFakes();
    const m = mount(<VoiceInput id="v" name="note" label="Note" show_transcript />);
    act(() => {
      fireEvent(m.q('.kb-voice-input__button'), 'click');
    });
    expect(m.state()).toBe('requesting');
    await flush();
    const rec = fakes.recognitions[0];
    expect(rec.lang).toBe('en-US');
    act(() => rec.fireStart());
    expect(m.state()).toBe('listening');
    expect(m.q('.kb-voice-input__button').getAttribute('aria-pressed')).toBe('true');
    fakes.setAmplitude(0.25);
    act(() => fakes.frame());
    const style = m.q('.kb-voice-input').style as unknown as Record<string, string>;
    expect(Number(style['--kb-voice-level'])).toBeGreaterThan(0.5);
    act(() => fakes.advance(2_000));
    expect(m.q('.kb-voice-input__time').textContent).toBe('0:02');
    act(() => rec.fireResult([['hello', false]]));
    expect(m.q('.kb-voice-input__transcript').textContent).toBe('hello');
    act(() => {
      fireEvent(m.q('.kb-voice-input__button'), 'click');
    });
    expect(m.state()).toBe('processing');
    act(() => {
      rec.fireResult([['hello there', true]]);
      rec.fireEnd();
    });
    expect(m.state()).toBe('idle');
    expect(m.q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.stopped]
    );
    expect(m.actions).toEqual([
      { id: 'voice.state', payload: { name: 'note', state: 'requesting' } },
      { id: 'voice.state', payload: { name: 'note', state: 'listening' } },
      { id: 'voice.transcript', payload: { name: 'note', text: 'hello', final: false } },
      { id: 'voice.state', payload: { name: 'note', state: 'processing' } },
      { id: 'voice.transcript', payload: { name: 'note', text: 'hello there', final: true } },
      { id: 'voice.state', payload: { name: 'note', state: 'idle' } },
    ]);
    expect(fakes.live()).toEqual(NO_LEAKS);
    m.unmount();
  });

  it('push-to-talk records while held (pointer, then Space) and hands over a File', async () => {
    const fakes = useFakes();
    const m = mount(
      <KbI18nProvider locale={JA.locale} messages={JA.messages}>
        <VoiceInput id="v" name="memo" label="メモ" mode="record" push_to_talk chunk_ms={1000} />
      </KbI18nProvider>
    );
    const button = m.q('.kb-voice-input__button');
    expect(m.q('.kb-voice-input__action').textContent).toBe(
      JA.messages[KB_VOICE_MESSAGE_KEYS.hold]
    );
    act(() => {
      fireEvent(button, 'click');
    });
    expect(fakes.mediaCalls).toBe(0);
    act(() => {
      fireEvent(button, 'pointerdown');
    });
    await flush();
    expect(m.state()).toBe('recording');
    expect(fakes.recorders[0].timeslice).toBe(1000);
    act(() => fakes.recorders[0].emit('chunk-1'));
    act(() => {
      fireEvent(button, 'pointerup');
    });
    expect(m.state()).toBe('processing');
    act(() => {
      fakes.recorders[0].emit('chunk-2');
      fakes.recorders[0].finish();
    });
    const recordings = m.actions.filter((a) => a.id === 'voice.recording');
    expect(recordings.map((r) => r.payload?.final)).toEqual([false, true]);
    expect(recordings[1].payload?.file).toBeInstanceOf(File);
    expect(recordings[1].payload?.name).toBe('memo');

    act(() => {
      fireEvent(button, 'keydown', { key: ' ', code: 'Space' });
    });
    await flush();
    expect(m.state()).toBe('recording');
    act(() => {
      fireEvent(button, 'keyup', { key: ' ', code: 'Space' });
    });
    expect(m.state()).toBe('processing');
    act(() => fakes.recorders[1].finish());
    expect(fakes.live()).toEqual(NO_LEAKS);
    m.unmount();
  });

  it('a denied microphone shows the localized reason and dispatches voice.error', async () => {
    useFakes({ deny: 'NotAllowedError' });
    const m = mount(<VoiceInput id="v" name="memo" label="Memo" mode="record" />);
    act(() => {
      fireEvent(m.q('.kb-voice-input__button'), 'click');
    });
    await flush();
    expect(m.state()).toBe('error');
    expect(m.q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.errorPermission]
    );
    expect(m.actions.at(-1)).toEqual({
      id: 'voice.error',
      payload: { name: 'memo', code: 'permission_denied' },
    });
    m.unmount();
  });

  it('unmount mid-start stops the late stream; unmount while recording releases everything', async () => {
    const held = useFakes({ holdMedia: true });
    const m = mount(<VoiceInput id="v" name="memo" label="Memo" mode="record" />);
    act(() => {
      fireEvent(m.q('.kb-voice-input__button'), 'click');
    });
    m.unmount();
    const late = held.resolveMedia();
    await flush();
    expect(late.stopped).toBe(true);
    expect(m.actions.map((a) => a.payload?.state)).toEqual(['requesting']);
    expect(held.live()).toEqual(NO_LEAKS);

    const fakes = useFakes();
    const n = mount(<VoiceInput id="w" name="memo" label="Memo" mode="record" />);
    act(() => {
      fireEvent(n.q('.kb-voice-input__button'), 'click');
    });
    await flush();
    expect(n.state()).toBe('recording');
    expect(fakes.live().streams).toBe(1);
    n.unmount();
    expect(fakes.live()).toEqual(NO_LEAKS);
  });
});
