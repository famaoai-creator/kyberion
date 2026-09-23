// PA-02: `ui:voice-input` / `ui:voice-state` — the shared microphone
// controller (voice-controller.js) against fake browser audio APIs, and the
// vanilla renderer (voice.js via kyberion-ui.js) on mini-dom.
//
// Covers state transitions, level metering, transcript / recording payloads,
// push-to-talk, max_seconds auto-stop, error mapping and — above all — that
// nothing keeps the microphone (tracks, AudioContext, rAF, recognition,
// recorder, timers) after stop / error / start→stop→start / dispose.
import { describe, expect, it, vi } from 'vitest';
import { getUiMessageBundle } from '@agent/core';
import { KB_VOICE_ACTIONS as CORE_VOICE_ACTIONS } from '@agent/core/a2ui-catalog';
import { disposeA2UI, renderA2UI } from './kyberion-ui.js';
import {
  KB_VOICE_ACTIONS,
  KB_VOICE_MESSAGE_KEYS,
  createVoiceController,
  formatElapsed,
  pickRecorderType,
  rmsLevel,
  setVoiceLevel,
  voiceErrorCode,
  voiceLang,
  voiceStateView,
} from './voice.js';
import { MiniDocument, type MiniElement } from './mini-dom.test-support.js';
import { NO_LEAKS, createVoiceFakes, settle } from './voice-fakes.test-support.js';

type Action = { id: string; payload?: Record<string, unknown> };
const EN = getUiMessageBundle('en');
const JA = getUiMessageBundle('ja');

function controllerWith(
  fakes: ReturnType<typeof createVoiceFakes>,
  extra: Record<string, unknown> = {}
) {
  const events: Array<[string, unknown]> = [];
  const controller = createVoiceController({
    win: fakes.win,
    onState: (state, detail) =>
      events.push(['state', detail.error ? `${state}:${detail.error}` : state]),
    onLevel: (level) => events.push(['level', level]),
    onElapsed: (ms) => events.push(['elapsed', ms]),
    onTranscript: (result) => events.push(['transcript', result]),
    onRecording: (result) => events.push(['recording', result]),
    onError: (code) => events.push(['error', code]),
    ...extra,
  });
  const of = (kind: string) => events.filter(([k]) => k === kind).map(([, v]) => v);
  return { controller, events, of };
}

describe('voice helpers', () => {
  it('mirrors the core action ids', () => {
    expect({ ...KB_VOICE_ACTIONS }).toEqual({ ...CORE_VOICE_ACTIONS });
  });

  it('derives the recognition language from the locale unless given', () => {
    expect(voiceLang(undefined, 'en')).toBe('en-US');
    expect(voiceLang(undefined, 'ja')).toBe('ja-JP');
    expect(voiceLang(undefined, 'qps-ploc')).toBe('en-US');
    expect(voiceLang('fr-CA', 'ja')).toBe('fr-CA');
    expect(voiceLang('not a tag', 'ja')).toBe('ja-JP');
  });

  it('formats m:ss, RMS levels and the recorder type', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(61_900)).toBe('1:01');
    expect(formatElapsed(-5)).toBe('0:00');
    expect(rmsLevel(new Uint8Array([128, 128]))).toBe(0);
    expect(rmsLevel(new Uint8Array([228, 28]))).toBe(1);
    expect(rmsLevel(new Uint8Array([138, 118]))).toBeCloseTo(0.234, 2);
    expect(pickRecorderType(createVoiceFakes().win)).toBe('audio/webm');
    expect(pickRecorderType(createVoiceFakes({ recorderTypes: ['audio/mp4'] }).win)).toBe(
      'audio/mp4'
    );
    expect(pickRecorderType({})).toBe('');
  });

  it('maps browser errors to voice.error codes', () => {
    expect(voiceErrorCode({ name: 'NotAllowedError' })).toBe('permission_denied');
    expect(voiceErrorCode({ error: 'not-allowed' })).toBe('permission_denied');
    expect(voiceErrorCode({ error: 'service-not-allowed' })).toBe('permission_denied');
    expect(voiceErrorCode({ name: 'NotFoundError' })).toBe('not_supported');
    expect(voiceErrorCode({ error: 'audio-capture' })).toBe('not_supported');
    expect(voiceErrorCode({ error: 'no-speech' })).toBe('no_speech');
    expect(voiceErrorCode({ error: 'network' })).toBe('network');
    expect(voiceErrorCode({ error: 'aborted' })).toBe('aborted');
    expect(voiceErrorCode({ name: 'AbortError' })).toBe('aborted');
    expect(voiceErrorCode(new Error('boom'))).toBe('unknown');
    expect(voiceErrorCode(undefined)).toBe('unknown');
  });

  it('sets --kb-voice-level only where style.setProperty exists', () => {
    const setProperty = vi.fn();
    setVoiceLevel({ style: { setProperty } }, 0.456);
    expect(setProperty).toHaveBeenCalledWith('--kb-voice-level', '0.46');
    expect(() => setVoiceLevel({ style: {} }, 1)).not.toThrow();
    expect(() => setVoiceLevel(null, 1)).not.toThrow();
  });
});

describe('createVoiceController — dictation', () => {
  it('requesting → listening with a level meter, interim + final transcripts, stop → idle', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { lang: 'ja-JP', continuous: true });
    expect(fakes.mediaCalls).toBe(0);
    const started = controller.start();
    expect(controller.state).toBe('requesting');
    await started;
    expect(fakes.mediaCalls).toBe(1);
    const rec = fakes.recognitions[0];
    expect(rec).toMatchObject({ lang: 'ja-JP', interimResults: true, continuous: true });
    expect(rec.started).toBe(true);
    rec.fireStart();
    expect(controller.state).toBe('listening');

    fakes.setAmplitude(0.3);
    fakes.frame();
    const levels = of('level') as number[];
    expect(levels.length).toBe(1);
    expect(levels[0]).toBeGreaterThan(0.5);
    // Throttled: another frame in the same 50 ms window reports nothing new.
    fakes.frame();
    expect((of('level') as number[]).length).toBe(1);
    fakes.advance(60);
    fakes.setAmplitude(0);
    fakes.frame();
    expect((of('level') as number[]).length).toBe(2);

    rec.fireResult([['こんにち', false]]);
    rec.fireResult([
      ['こんにちは', true],
      ['今日', false],
    ]);
    expect(of('transcript')).toEqual([
      { text: 'こんにち', final: false },
      { text: 'こんにちは', final: true },
      { text: '今日', final: false },
    ]);

    controller.stop();
    expect(controller.state).toBe('processing');
    expect(rec.stopped).toBe(true);
    expect(rec.aborted).toBe(false);
    expect(fakes.streams[0].stopped).toBe(true);
    expect(fakes.contexts[0].closed).toBe(true);
    // The final result still arrives after stop().
    rec.fireResult([['今日は晴れ', true]], 0);
    rec.fireEnd();
    expect(controller.state).toBe('idle');
    expect(of('transcript').at(-1)).toEqual({ text: '今日は晴れ', final: true });
    expect(of('state')).toEqual(['requesting', 'listening', 'processing', 'idle']);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('does not open the microphone when the meter is off', async () => {
    const fakes = createVoiceFakes();
    const { controller } = controllerWith(fakes, { meter: false });
    await controller.start();
    fakes.recognitions[0].fireStart();
    expect(fakes.mediaCalls).toBe(0);
    expect(fakes.contexts).toHaveLength(0);
    controller.dispose();
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('reports elapsed time once per second and auto-stops at max_seconds', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { maxSeconds: 2 });
    await controller.start();
    fakes.recognitions[0].fireStart();
    fakes.advance(1_100);
    expect(of('elapsed')).toEqual([0, 1000]);
    fakes.advance(1_000);
    expect(controller.state).toBe('processing');
    expect(fakes.recognitions[0].stopped).toBe(true);
    fakes.recognitions[0].fireEnd();
    expect(controller.state).toBe('idle');
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('a recognition that ends on its own releases the meter', async () => {
    const fakes = createVoiceFakes();
    const { controller } = controllerWith(fakes);
    await controller.start();
    fakes.recognitions[0].fireStart();
    fakes.recognitions[0].fireEnd();
    expect(controller.state).toBe('idle');
    expect(fakes.live()).toMatchObject({ streams: 0, contexts: 0, frames: 0, intervals: 0 });
  });

  it('maps recognition errors and releases everything', async () => {
    for (const [error, code] of [
      ['no-speech', 'no_speech'],
      ['network', 'network'],
      ['not-allowed', 'permission_denied'],
    ] as const) {
      const fakes = createVoiceFakes();
      const { controller, of } = controllerWith(fakes);
      await controller.start();
      fakes.recognitions[0].fireStart();
      fakes.recognitions[0].fireError(error);
      expect(controller.state).toBe('error');
      expect(controller.error).toBe(code);
      expect(of('error')).toEqual([code]);
      expect(fakes.recognitions[0].aborted).toBe(true);
      expect(fakes.live()).toEqual(NO_LEAKS);
      // A retry after an error starts fresh.
      await controller.start();
      expect(fakes.recognitions).toHaveLength(2);
      controller.dispose();
      expect(fakes.live()).toEqual(NO_LEAKS);
    }
  });

  it('permission denied on getUserMedia → error, nothing held', async () => {
    const fakes = createVoiceFakes({ deny: 'NotAllowedError' });
    const { controller, of } = controllerWith(fakes);
    await controller.start();
    expect(controller.state).toBe('error');
    expect(of('error')).toEqual(['permission_denied']);
    expect(fakes.recognitions).toHaveLength(0);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('unsupported browser → unsupported + not_supported, no media request', async () => {
    const fakes = createVoiceFakes({ noRecognition: true });
    const { controller, of } = controllerWith(fakes);
    expect(controller.supported).toBe(false);
    await controller.start();
    expect(controller.state).toBe('unsupported');
    expect(of('error')).toEqual(['not_supported']);
    expect(fakes.mediaCalls).toBe(0);
    expect(createVoiceController({ win: undefined }).supported).toBeNull();
  });
});

describe('createVoiceController — record', () => {
  it('records until stop and delivers one audio file', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { mode: 'record' });
    await controller.start();
    expect(controller.state).toBe('recording');
    const recorder = fakes.recorders[0];
    expect(recorder.mimeType).toBe('audio/webm');
    expect(recorder.timeslice).toBeUndefined();
    fakes.advance(3_200);
    recorder.emit('part-1');
    controller.stop();
    expect(controller.state).toBe('processing');
    expect(recorder.stopCalls).toBe(1);
    expect(fakes.streams[0].stopped).toBe(true);
    recorder.emit('part-2');
    recorder.finish();
    expect(controller.state).toBe('idle');
    const [result] = of('recording') as Array<{ file: File; durationMs: number; final: boolean }>;
    expect(result.final).toBe(true);
    expect(result.durationMs).toBe(3_200);
    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('recording.webm');
    expect(result.file.type).toBe('audio/webm');
    expect(await result.file.text()).toBe('part-1part-2');
    expect(of('state')).toEqual(['requesting', 'recording', 'processing', 'idle']);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('with chunk_ms delivers chunks while recording and the last one as final', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { mode: 'record', chunkMs: 1000 });
    await controller.start();
    const recorder = fakes.recorders[0];
    expect(recorder.timeslice).toBe(1000);
    recorder.emit('a');
    recorder.emit('b');
    controller.stop();
    recorder.emit('c');
    recorder.finish();
    const results = of('recording') as Array<{ file: File; final: boolean }>;
    expect(results.map((r) => r.final)).toEqual([false, false, true]);
    expect(await Promise.all(results.map((r) => r.file.text()))).toEqual(['a', 'b', 'c']);
  });

  it('max_seconds stops the recording', async () => {
    const fakes = createVoiceFakes();
    const { controller } = controllerWith(fakes, { mode: 'record', maxSeconds: 1 });
    await controller.start();
    fakes.advance(1_000);
    expect(controller.state).toBe('processing');
    fakes.recorders[0].finish();
    expect(controller.state).toBe('idle');
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('a recorder error maps and releases', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { mode: 'record' });
    await controller.start();
    fakes.recorders[0].onerror?.({ error: { name: 'NotReadableError' } });
    expect(controller.state).toBe('error');
    expect(of('error')).toEqual(['not_supported']);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('is unsupported without MediaRecorder', async () => {
    const fakes = createVoiceFakes({ noRecorder: true });
    const { controller } = controllerWith(fakes, { mode: 'record' });
    await controller.start();
    expect(controller.state).toBe('unsupported');
    expect(fakes.mediaCalls).toBe(0);
  });
});

describe('createVoiceController — no leaks across generations', () => {
  it('start → stop (permission prompt open) → start: the stale stream is stopped', async () => {
    const fakes = createVoiceFakes({ holdMedia: true });
    const { controller, of } = controllerWith(fakes, { mode: 'record' });
    const first = controller.start();
    controller.stop();
    expect(controller.state).toBe('idle');
    const second = controller.start();
    const stale = fakes.resolveMedia();
    await first;
    expect(stale.stopped).toBe(true);
    expect(fakes.recorders).toHaveLength(0);
    const fresh = fakes.resolveMedia();
    await second;
    expect(controller.state).toBe('recording');
    expect(fresh.stopped).toBe(false);
    expect(fakes.recorders).toHaveLength(1);
    expect(of('state')).toEqual(['requesting', 'idle', 'requesting', 'recording']);
    controller.dispose();
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('dispose mid-start: the late stream is stopped and no callback fires', async () => {
    const fakes = createVoiceFakes({ holdMedia: true });
    const { controller, events } = controllerWith(fakes);
    const started = controller.start();
    const before = events.length;
    controller.dispose();
    const late = fakes.resolveMedia();
    await started;
    expect(late.stopped).toBe(true);
    expect(fakes.recognitions).toHaveLength(0);
    expect(events.length).toBe(before);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('dispose while listening aborts recognition and closes the context', async () => {
    const fakes = createVoiceFakes();
    const { controller } = controllerWith(fakes);
    await controller.start();
    fakes.recognitions[0].fireStart();
    fakes.frame();
    controller.dispose();
    expect(fakes.recognitions[0].aborted).toBe(true);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('dispose while a graceful stop is pending drops the late final file', async () => {
    const fakes = createVoiceFakes();
    const { controller, of } = controllerWith(fakes, { mode: 'record' });
    await controller.start();
    controller.stop();
    controller.dispose();
    fakes.recorders[0].emit('late');
    fakes.recorders[0].finish();
    expect(of('recording')).toEqual([]);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });
});

// ---------------------------------------------------------------------------
// Vanilla renderer
// ---------------------------------------------------------------------------

function mount(
  components: unknown[],
  win: unknown,
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
      window: win,
      onAction: (action: Action) => actions.push(action),
      ...options,
    } as never
  );
  const q = (selector: string) => {
    const found = root.query(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
  };
  return { root, actions, q, document };
}

const voice = (props: Record<string, unknown>) => [
  { id: 'v1', type: 'ui:voice-input', props: { name: 'note', label: 'Note', ...props } },
];

describe('ui:voice-input (vanilla)', () => {
  it('renders the static idle state and opens nothing during render', () => {
    const fakes = createVoiceFakes();
    const { q } = mount(voice({ show_transcript: true, help: 'Say it' }), fakes.win);
    const field = q('.kb-voice-input');
    expect(field.getAttribute('data-state')).toBe('idle');
    expect(field.getAttribute('data-mode')).toBe('dictation');
    const button = q('.kb-voice-input__button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-labelledby')).toBe('kbf-v1-label kbf-v1-action');
    expect(button.getAttribute('aria-describedby')).toBe('kbf-v1-status kbf-v1-help');
    expect(q('.kb-voice-input__action').textContent).toBe('Dictate');
    expect(q('.kb-voice-input__time').textContent).toBe('0:00');
    expect(q('.kb-voice-input__status').getAttribute('role')).toBe('status');
    expect(q('.kb-voice-input__meter').getAttribute('aria-hidden')).toBe('true');
    expect(field.queryAll('.kb-voice-input__bar')).toHaveLength(5);
    expect(fakes.mediaCalls).toBe(0);
    expect(fakes.recognitions).toHaveLength(0);
  });

  it('shows unsupported as a disabled button with a localized reason (en / ja)', () => {
    const fakes = createVoiceFakes({ noRecognition: true });
    const en = mount(voice({}), fakes.win);
    expect(en.q('.kb-voice-input').getAttribute('data-state')).toBe('unsupported');
    expect(en.q('.kb-voice-input__button').disabled).toBe(true);
    expect(en.q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.unsupportedDictation]
    );
    const ja = mount(voice({ mode: 'record' }), createVoiceFakes({ noRecorder: true }).win, {
      locale: JA.locale,
      messages: JA.messages,
    });
    expect(ja.q('.kb-voice-input__status').textContent).toBe(
      JA.messages[KB_VOICE_MESSAGE_KEYS.unsupportedRecord]
    );
    expect(ja.q('.kb-voice-input__action').textContent).toBe(
      JA.messages[KB_VOICE_MESSAGE_KEYS.record]
    );
  });

  it('toggle: click starts dictation, updates level / time / transcript, click stops', async () => {
    const fakes = createVoiceFakes();
    const { q, actions } = mount(voice({ show_transcript: true, lang: 'en-GB' }), fakes.win);
    const field = q('.kb-voice-input');
    const setProperty = vi.fn();
    (field as unknown as { style: unknown }).style = { setProperty };
    q('.kb-voice-input__button').click();
    expect(field.getAttribute('data-state')).toBe('requesting');
    expect(q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.requesting]
    );
    await settle();
    const rec = fakes.recognitions[0];
    expect(rec.lang).toBe('en-GB');
    rec.fireStart();
    expect(field.getAttribute('data-state')).toBe('listening');
    expect(q('.kb-voice-input__button').getAttribute('aria-pressed')).toBe('true');
    fakes.setAmplitude(0.2);
    fakes.frame();
    expect(setProperty).toHaveBeenCalledWith('--kb-voice-level', expect.any(String));
    fakes.advance(1_000);
    expect(q('.kb-voice-input__time').textContent).toBe('0:01');
    rec.fireResult([['hello wor', false]]);
    expect(q('.kb-voice-input__transcript').textContent).toBe('hello wor');
    rec.fireResult([['hello world', true]]);
    expect(q('.kb-voice-input__transcript').textContent).toBe('');
    q('.kb-voice-input__button').click();
    expect(field.getAttribute('data-state')).toBe('processing');
    expect(q('.kb-voice-input__button').disabled).toBe(true);
    rec.fireEnd();
    expect(field.getAttribute('data-state')).toBe('idle');
    expect(q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.stopped]
    );
    expect(actions).toEqual([
      { id: 'voice.state', payload: { name: 'note', state: 'requesting' } },
      { id: 'voice.state', payload: { name: 'note', state: 'listening' } },
      { id: 'voice.transcript', payload: { name: 'note', text: 'hello wor', final: false } },
      { id: 'voice.transcript', payload: { name: 'note', text: 'hello world', final: true } },
      { id: 'voice.state', payload: { name: 'note', state: 'processing' } },
      { id: 'voice.state', payload: { name: 'note', state: 'idle' } },
    ]);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('push-to-talk (pointer and Space) records and delivers the file via the override action', async () => {
    const fakes = createVoiceFakes();
    const { q, actions } = mount(
      voice({
        mode: 'record',
        push_to_talk: true,
        actions: { recording: { id: 'memo.audio', payload: { pad: 'notes' } } },
      }),
      fakes.win
    );
    const button = q('.kb-voice-input__button');
    expect(q('.kb-voice-input').getAttribute('data-push-to-talk')).toBe('true');
    expect(q('.kb-voice-input__action').textContent).toBe(EN.messages[KB_VOICE_MESSAGE_KEYS.hold]);
    expect(q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.holdHint]
    );
    button.click(); // a click alone never toggles in push-to-talk mode
    expect(fakes.mediaCalls).toBe(0);
    button.dispatch('pointerdown', { preventDefault() {} });
    await settle();
    expect(q('.kb-voice-input').getAttribute('data-state')).toBe('recording');
    fakes.recorders[0].emit('audio');
    button.dispatch('pointerup');
    expect(q('.kb-voice-input').getAttribute('data-state')).toBe('processing');
    fakes.recorders[0].finish();
    const recording = actions.find((a) => a.id === 'memo.audio');
    expect(recording?.payload).toMatchObject({ pad: 'notes', name: 'note', final: true });
    expect(recording?.payload?.file).toBeInstanceOf(File);
    expect(recording?.payload?.duration_ms).toBe(0);

    // Space: keydown starts (repeats ignored), keyup stops.
    button.dispatch('keydown', { key: ' ', code: 'Space', preventDefault() {} });
    button.dispatch('keydown', { key: ' ', code: 'Space', repeat: true, preventDefault() {} });
    await settle();
    expect(fakes.recorders).toHaveLength(2);
    expect(q('.kb-voice-input').getAttribute('data-state')).toBe('recording');
    button.dispatch('keyup', { key: ' ', code: 'Space', preventDefault() {} });
    expect(q('.kb-voice-input').getAttribute('data-state')).toBe('processing');
    fakes.recorders[1].finish();
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('maps a denied microphone to a localized error and voice.error', async () => {
    const fakes = createVoiceFakes({ deny: 'NotAllowedError' });
    const { q, actions } = mount(voice({ mode: 'record' }), fakes.win, {
      locale: JA.locale,
      messages: JA.messages,
    });
    q('.kb-voice-input__button').click();
    await settle();
    expect(q('.kb-voice-input').getAttribute('data-state')).toBe('error');
    expect(q('.kb-voice-input__status').textContent).toBe(
      JA.messages[KB_VOICE_MESSAGE_KEYS.errorPermission]
    );
    expect(actions.at(-1)).toEqual({
      id: 'voice.error',
      payload: { name: 'note', code: 'permission_denied' },
    });
  });

  it('shows host status (transcribing / error) while idle', () => {
    const fakes = createVoiceFakes();
    const busy = mount(voice({ mode: 'record', status: 'transcribing' }), fakes.win);
    expect(busy.q('.kb-voice-input').getAttribute('data-state')).toBe('processing');
    expect(busy.q('.kb-voice-input__button').disabled).toBe(true);
    expect(busy.q('.kb-voice-input__status').textContent).toBe(
      EN.messages[KB_VOICE_MESSAGE_KEYS.transcribing]
    );
    const failed = mount(voice({ status: 'error', status_error: 'Service offline.' }), fakes.win);
    expect(failed.q('.kb-voice-input').getAttribute('data-state')).toBe('error');
    expect(failed.q('.kb-voice-input__status').textContent).toBe('Service offline.');
    expect(failed.q('.kb-voice-input__button').disabled).toBe(false);
  });

  it('re-render and disposeA2UI release the microphone mid-recording', async () => {
    const fakes = createVoiceFakes();
    const doc = new MiniDocument();
    const { root, q } = mount(voice({ mode: 'record' }), fakes.win, {}, doc);
    q('.kb-voice-input__button').click();
    await settle();
    expect(fakes.live().streams).toBe(1);
    renderA2UI(
      root as unknown as Element,
      voice({ mode: 'record' }) as never,
      {
        document: doc as unknown as Document,
        window: fakes.win,
      } as never
    );
    expect(fakes.live()).toEqual(NO_LEAKS);
    (root.query('.kb-voice-input__button') as MiniElement).click();
    await settle();
    disposeA2UI(root as unknown as Element);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });

  it('disposeA2UI while the permission prompt is open stops the late stream', async () => {
    const fakes = createVoiceFakes({ holdMedia: true });
    const { root, q, actions } = mount(voice({ mode: 'record' }), fakes.win);
    q('.kb-voice-input__button').click();
    disposeA2UI(root as unknown as Element);
    const late = fakes.resolveMedia();
    await settle();
    expect(late.stopped).toBe(true);
    expect(actions.map((a) => a.payload?.state)).toEqual(['requesting']);
    expect(fakes.live()).toEqual(NO_LEAKS);
  });
});

describe('ui:voice-state (vanilla)', () => {
  it('renders role=status, per-state data attributes and the localized default label', () => {
    const { q } = mount(
      [{ id: 's', type: 'ui:voice-state', props: { state: 'thinking' } }],
      undefined,
      { locale: JA.locale, messages: JA.messages }
    );
    const root = q('.kb-voice-state');
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('data-state')).toBe('thinking');
    expect(root.getAttribute('data-variant')).toBe('bars');
    expect(root.getAttribute('data-size')).toBe('md');
    expect(root.getAttribute('data-has-level')).toBeNull();
    expect(root.queryAll('.kb-voice-state__bar')).toHaveLength(5);
    expect(q('.kb-voice-state__visual').getAttribute('aria-hidden')).toBe('true');
    expect(q('.kb-voice-state__label').textContent).toBe(
      JA.messages[KB_VOICE_MESSAGE_KEYS.stateThinking]
    );
  });

  it('variants, custom label, hidden label and a clamped level', () => {
    const t = (key: string) => EN.messages[key] ?? key;
    expect(voiceStateView({ state: 'speaking', level: 3 }, t).level).toBe(1);
    expect(voiceStateView({ state: 'nope' }, t).state).toBe('idle');
    const { q } = mount(
      [
        {
          id: 's',
          type: 'ui:voice-state',
          props: { state: 'muted', variant: 'orb', label: 'Paused', show_label: false, level: 0.5 },
        },
      ],
      undefined
    );
    expect(q('.kb-voice-state').getAttribute('data-has-level')).toBe('true');
    expect(q('.kb-voice-state__orb')).toBeTruthy();
    const label = q('.kb-voice-state__label');
    expect(label.textContent).toBe('Paused');
    expect(label.classList.contains('kb-visually-hidden')).toBe(true);
  });
});
