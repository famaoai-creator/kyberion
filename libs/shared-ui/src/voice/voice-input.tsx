'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { KbVoiceInputProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { useFormDispatch, type KbFormComponentId } from '../forms/shared.js';
import {
  KB_VOICE_BAR_COUNT,
  KB_VOICE_ICON_PATHS,
  createVoiceController,
  initialVoiceLocal,
  setVoiceLevel,
  voiceInputActions,
  voiceInputDescribedBy,
  voiceInputIds,
  voiceInputOptions,
  voiceInputView,
  voiceSupported,
  type KbVoiceController,
  type KbVoiceInputState,
  type KbVoiceLocal,
} from '../../vanilla/voice.js';

const BARS = Array.from({ length: KB_VOICE_BAR_COUNT }, (_, index) => index);
const ACTIVE: ReadonlySet<KbVoiceInputState> = new Set(['requesting', 'listening', 'recording']);
const noSubscribe = () => () => undefined;

type VoiceEvent = 'state' | 'transcript' | 'recording' | 'error';

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {KB_VOICE_ICON_PATHS.mic.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}

/**
 * `ui:voice-input` → `.kb-field.kb-voice-input[data-state][data-mode]` (PA-02).
 * The shared `createVoiceController` is created client-side in an effect and
 * disposed on unmount (tracks stopped, AudioContext closed, rAF cancelled,
 * recognition aborted). The microphone opens only from a click / hold / Space;
 * transcripts and recorded files go to `onAction` only. The level meter
 * writes `--kb-voice-level` on the root directly (no re-render per frame).
 * Server render = the static idle state; browser support is decided on the
 * client (`useSyncExternalStore`, hydration-safe).
 */
export function VoiceInput(p: KbVoiceInputProps & KbFormComponentId) {
  const { t, locale } = useKbI18n();
  const ids = voiceInputIds(p.id, p.name);
  const options = voiceInputOptions(p, locale);
  const dispatch = useFormDispatch();
  const [local, setLocal] = useState<KbVoiceLocal>(() => initialVoiceLocal(null));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<KbVoiceController | null>(null);
  const stateRef = useRef<KbVoiceInputState>('idle');
  const heldRef = useRef(false);
  const latest = useRef({ p, dispatch });
  useEffect(() => {
    latest.current = { p, dispatch };
  });

  const supported = useSyncExternalStore(
    noSubscribe,
    () => voiceSupported(typeof window !== 'undefined' ? window : undefined, options.mode),
    () => null
  );

  const { mode, lang, continuous, showLevel, showTranscript, chunkMs, maxSeconds } = options;
  useEffect(() => {
    const send = (event: VoiceEvent, runtime: Record<string, unknown>) => {
      const current = latest.current;
      current.dispatch(voiceInputActions(current.p)[event], { name: current.p.name, ...runtime });
    };
    const controller = createVoiceController({
      win: typeof window !== 'undefined' ? window : undefined,
      mode,
      lang,
      continuous,
      meter: showLevel,
      chunkMs,
      maxSeconds,
      onState: (state, detail) => {
        const previous = stateRef.current;
        stateRef.current = state;
        setLocal((prev) => ({
          ...prev,
          state,
          error: detail.error,
          stopped: state === 'idle' && previous !== 'idle' && previous !== 'error',
          ...(state === 'requesting' ? { elapsedMs: 0, interim: '' } : {}),
        }));
        send('state', { state });
      },
      onLevel: (level) => setVoiceLevel(rootRef.current, level),
      onElapsed: (ms) => setLocal((prev) => ({ ...prev, elapsedMs: ms })),
      onTranscript: ({ text, final }) => {
        if (showTranscript) setLocal((prev) => ({ ...prev, interim: final ? '' : text }));
        send('transcript', { text, final });
      },
      onRecording: ({ file, durationMs, offsetMs, final }) =>
        send('recording', {
          file,
          duration_ms: Math.round(durationMs),
          offset_ms: Math.round(offsetMs),
          final,
        }),
      onError: (code) => send('error', { code }),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      stateRef.current = 'idle';
    };
  }, [mode, lang, continuous, showLevel, showTranscript, chunkMs, maxSeconds]);

  const effective: KbVoiceLocal =
    supported === false && local.state === 'idle' ? { ...local, state: 'unsupported' } : local;
  const view = voiceInputView(p, effective, t);

  const begin = () => {
    if (view.disabled || ACTIVE.has(stateRef.current)) return;
    void controllerRef.current?.start();
  };
  const end = () => {
    if (ACTIVE.has(stateRef.current)) controllerRef.current?.stop();
  };
  const press = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    heldRef.current = true;
    begin();
  };
  const release = () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    end();
  };
  const isSpace = (event: { key: string; code: string }) =>
    event.key === ' ' || event.code === 'Space';

  const pushToTalk = options.pushToTalk
    ? {
        onPointerDown: press,
        onPointerUp: release,
        onPointerLeave: release,
        onPointerCancel: release,
        onBlur: release,
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
          if (!isSpace(event)) return;
          event.preventDefault();
          if (event.repeat || heldRef.current) return;
          press();
        },
        onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
          if (!isSpace(event)) return;
          event.preventDefault();
          release();
        },
      }
    : {};

  return (
    <div
      ref={rootRef}
      className="kb-field kb-voice-input"
      data-control="voice-input"
      data-mode={options.mode}
      data-push-to-talk={options.pushToTalk ? 'true' : undefined}
      data-disabled={p.disabled === true ? 'true' : undefined}
      data-state={view.state}
    >
      <span
        className={p.hide_label === true ? 'kb-field__label kb-visually-hidden' : 'kb-field__label'}
        id={ids.label}
      >
        {String(p.label ?? '')}
      </span>
      <div className="kb-voice-input__body">
        <button
          type="button"
          className="kb-voice-input__button"
          id={ids.input}
          aria-labelledby={`${ids.label} ${ids.action}`}
          aria-describedby={voiceInputDescribedBy(ids, p)}
          aria-pressed={view.pressed ? 'true' : 'false'}
          disabled={view.disabled || undefined}
          onClick={() => {
            if (options.pushToTalk) return;
            if (ACTIVE.has(stateRef.current)) end();
            else begin();
          }}
          {...pushToTalk}
        >
          <span className="kb-voice-input__icon" aria-hidden="true">
            <MicIcon />
          </span>
          <span className="kb-voice-input__action" id={ids.action}>
            {view.action}
          </span>
        </button>
        {options.showLevel ? (
          <span className="kb-voice-input__meter" aria-hidden="true">
            {BARS.map((index) => (
              <span key={index} className="kb-voice-input__bar" />
            ))}
          </span>
        ) : null}
        <span className="kb-voice-input__time" aria-hidden="true">
          {view.time}
        </span>
      </div>
      {options.showTranscript ? <p className="kb-voice-input__transcript">{view.interim}</p> : null}
      <p className="kb-voice-input__status" id={ids.status} role="status">
        {view.status}
      </p>
      {typeof p.help === 'string' && p.help ? (
        <p className="kb-field__help" id={ids.help}>
          {p.help}
        </p>
      ) : null}
    </div>
  );
}
