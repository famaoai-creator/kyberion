/*
 * Kyberion UI — voice components (PA-02, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23
 * §3) for the vanilla renderer: `ui:voice-input` (microphone with a live
 * level meter, elapsed time, interim transcript, record mode) and
 * `ui:voice-state` (display-only conversation state indicator).
 *
 * `kyberion-ui.js` merges `createVoiceRenderers(...)` into its renderer
 * table; the React renderer (`libs/shared-ui/src/voice/*`) imports the
 * constants and the pure view helpers from here, and the audio plumbing from
 * `voice-controller.js`, so both renderers emit the same markup.
 *
 * Interaction contract:
 *   - The microphone opens only from a user action (click / press-and-hold /
 *     Space). Recorded audio (File) and transcripts reach the host only in
 *     `onAction` payloads (`KB_VOICE_ACTIONS`); nothing is written to
 *     attributes, storage or the console.
 *   - The initial markup is the static idle state (no media starts during
 *     render). The level is the `--kb-voice-level` custom property (0..1) on
 *     the root, updated in place — no per-frame DOM rebuild.
 *   - `renderA2UI` re-renders the whole container, so the component owns its
 *     state and releases the microphone on re-render / `disposeA2UI`.
 */
import {
  createVoiceController,
  formatElapsed,
  voiceLang,
  voiceSupported,
} from './voice-controller.js';
import { formFieldIds, formAction, actionPayload } from './forms-core.js';

export {
  KB_VOICE_INPUT_STATES,
  KB_VOICE_ERROR_CODES,
  KB_VOICE_RECORDER_TYPES,
  createVoiceController,
  formatElapsed,
  voiceLang,
  voiceSupported,
  voiceErrorCode,
  pickRecorderType,
  rmsLevel,
  speechRecognitionCtor,
} from './voice-controller.js';

/** Mirrors `KB_VOICE_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_VOICE_ACTIONS = Object.freeze({
  state: 'voice.state',
  transcript: 'voice.transcript',
  recording: 'voice.recording',
  error: 'voice.error',
});

/** Vocabulary keys (`ui:*`) of every voice default string. */
export const KB_VOICE_MESSAGE_KEYS = Object.freeze({
  dictate: 'ui:voice_input_dictate',
  record: 'ui:voice_input_record',
  hold: 'ui:voice_input_hold',
  holdHint: 'ui:voice_input_hold_hint',
  requesting: 'ui:voice_input_requesting',
  listening: 'ui:voice_input_listening',
  recording: 'ui:voice_input_recording',
  processing: 'ui:voice_input_processing',
  transcribing: 'ui:voice_input_transcribing',
  stopped: 'ui:voice_input_stopped',
  unsupportedDictation: 'ui:voice_input_unsupported_dictation',
  unsupportedRecord: 'ui:voice_input_unsupported_record',
  errorPermission: 'ui:voice_input_error_permission_denied',
  errorNoSpeech: 'ui:voice_input_error_no_speech',
  errorNetwork: 'ui:voice_input_error_network',
  errorAborted: 'ui:voice_input_error_aborted',
  errorUnknown: 'ui:voice_input_error_unknown',
  stateIdle: 'ui:voice_state_idle',
  stateListening: 'ui:voice_state_listening',
  stateThinking: 'ui:voice_state_thinking',
  stateSpeaking: 'ui:voice_state_speaking',
  stateMuted: 'ui:voice_state_muted',
  stateError: 'ui:voice_state_error',
});

/** `ui:voice-state.state` values → default label key. */
export const KB_VOICE_STATE_LABEL_KEYS = Object.freeze({
  idle: KB_VOICE_MESSAGE_KEYS.stateIdle,
  listening: KB_VOICE_MESSAGE_KEYS.stateListening,
  thinking: KB_VOICE_MESSAGE_KEYS.stateThinking,
  speaking: KB_VOICE_MESSAGE_KEYS.stateSpeaking,
  muted: KB_VOICE_MESSAGE_KEYS.stateMuted,
  error: KB_VOICE_MESSAGE_KEYS.stateError,
});

/** Microphone icon (24px grid, stroke = currentColor). */
export const KB_VOICE_ICON_PATHS = Object.freeze({
  mic: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3', 'M8 21h8'],
});

/** Bars drawn by the voice-input meter and the `bars` voice-state variant. */
export const KB_VOICE_BAR_COUNT = 5;

const ACTIVE_STATES = new Set(['requesting', 'listening', 'recording']);
const ERROR_KEYS = Object.freeze({
  permission_denied: KB_VOICE_MESSAGE_KEYS.errorPermission,
  no_speech: KB_VOICE_MESSAGE_KEYS.errorNoSpeech,
  network: KB_VOICE_MESSAGE_KEYS.errorNetwork,
  aborted: KB_VOICE_MESSAGE_KEYS.errorAborted,
  unknown: KB_VOICE_MESSAGE_KEYS.errorUnknown,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalized `ui:voice-input` options (defaults applied). */
export function voiceInputOptions(p, locale) {
  const mode = p.mode === 'record' ? 'record' : 'dictation';
  const chunk = Number(p.chunk_ms);
  const max = Number(p.max_seconds);
  return {
    mode,
    lang: voiceLang(p.lang, locale),
    continuous: p.continuous === true,
    pushToTalk: p.push_to_talk === true,
    showLevel: p.show_level !== false,
    showTranscript: mode === 'dictation' && p.show_transcript === true,
    chunkMs: Number.isFinite(chunk) && chunk > 0 ? chunk : undefined,
    maxSeconds: Number.isFinite(max) && max > 0 ? max : undefined,
  };
}

/** Resolved action (id + declared payload) per voice event; `actions.<event>` overrides. */
export function voiceInputActions(p) {
  const given = isRecord(p.actions) ? p.actions : {};
  return {
    state: formAction(given.state, KB_VOICE_ACTIONS.state),
    transcript: formAction(given.transcript, KB_VOICE_ACTIONS.transcript),
    recording: formAction(given.recording, KB_VOICE_ACTIONS.recording),
    error: formAction(given.error, KB_VOICE_ACTIONS.error),
  };
}

/** The idle local state before any interaction (`supported`: `voiceSupported`). */
export function initialVoiceLocal(supported) {
  return {
    state: supported === false ? 'unsupported' : 'idle',
    error: null,
    stopped: false,
    elapsedMs: 0,
    interim: '',
  };
}

/**
 * Everything both renderers show for `ui:voice-input`, from props, the local
 * controller state and the translator:
 * `{ state, pressed, disabled, action, status, time, interim }`.
 * Internal activity wins over the host `status` (`transcribing` / `error`).
 */
export function voiceInputView(p, local, t) {
  const K = KB_VOICE_MESSAGE_KEYS;
  const options = voiceInputOptions(p, 'en');
  const unsupportedText = t(
    options.mode === 'record' ? K.unsupportedRecord : K.unsupportedDictation
  );
  let state = local.state;
  let status = '';
  if (state === 'unsupported') {
    status = unsupportedText;
  } else if (state === 'requesting') {
    status = t(K.requesting);
  } else if (state === 'listening') {
    status = t(K.listening);
  } else if (state === 'recording') {
    status = t(K.recording);
  } else if (state === 'processing') {
    status = t(K.processing);
  } else if (state === 'error') {
    status =
      local.error === 'not_supported'
        ? unsupportedText
        : t(ERROR_KEYS[local.error] || K.errorUnknown);
  } else if (p.status === 'transcribing') {
    state = 'processing';
    status = t(K.transcribing);
  } else if (p.status === 'error') {
    state = 'error';
    status =
      typeof p.status_error === 'string' && p.status_error ? p.status_error : t(K.errorUnknown);
  } else if (local.stopped) {
    status = t(K.stopped);
  } else if (options.pushToTalk) {
    status = t(K.holdHint);
  }
  return {
    state,
    pressed: ACTIVE_STATES.has(state),
    disabled: p.disabled === true || state === 'unsupported' || state === 'processing',
    action: t(options.pushToTalk ? K.hold : options.mode === 'record' ? K.record : K.dictate),
    status,
    time: formatElapsed(local.elapsedMs),
    interim: local.interim || '',
  };
}

/** DOM ids of the voice-input parts (from the field ids). */
export function voiceInputIds(componentId, name) {
  const ids = formFieldIds(componentId, name);
  return { ...ids, action: `${ids.input}-action` };
}

/** `aria-describedby` of the mic button: the live status line, then help. */
export function voiceInputDescribedBy(ids, p) {
  return typeof p.help === 'string' && p.help ? `${ids.status} ${ids.help}` : ids.status;
}

/** `ui:voice-state` view: `{ state, variant, size, label, showLabel, level }` (level null = unset). */
export function voiceStateView(p, t) {
  const state = Object.prototype.hasOwnProperty.call(KB_VOICE_STATE_LABEL_KEYS, p.state)
    ? p.state
    : 'idle';
  const level = Number(p.level);
  return {
    state,
    variant: p.variant === 'orb' || p.variant === 'dot' ? p.variant : 'bars',
    size: p.size === 'sm' || p.size === 'lg' ? p.size : 'md',
    label: typeof p.label === 'string' && p.label ? p.label : t(KB_VOICE_STATE_LABEL_KEYS[state]),
    showLabel: p.show_label !== false,
    level:
      p.level === undefined || p.level === null || !Number.isFinite(level)
        ? null
        : Math.min(1, Math.max(0, level)),
  };
}

/** Set `--kb-voice-level` on an element (no-op where `style.setProperty` is missing). */
export function setVoiceLevel(node, level) {
  if (!node || !node.style || typeof node.style.setProperty !== 'function') return;
  node.style.setProperty('--kb-voice-level', String(Math.round(level * 100) / 100));
}

// ---------------------------------------------------------------------------
// Vanilla DOM renderers
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build the voice renderers on top of `kyberion-ui.js`'s helpers (passed in
 * to keep this module free of a circular import).
 * @param {{ el: (ctx: any, tag: string, className?: string, text?: unknown) => any, setData: (node: any, name: string, value: unknown) => void }} h
 */
export function createVoiceRenderers(h) {
  const { el, setData } = h;

  const micIcon = (ctx) => {
    const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of KB_VOICE_ICON_PATHS.mic) {
      const path = ctx.doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  };

  const bars = (ctx, parent, className) => {
    for (let i = 0; i < KB_VOICE_BAR_COUNT; i += 1) parent.appendChild(el(ctx, 'span', className));
  };

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text || '';
  };

  const voiceInput = (ctx, p, c) => {
    const ids = voiceInputIds(c.id, p.name);
    const options = voiceInputOptions(p, ctx.locale);
    const actions = voiceInputActions(p);
    const dispatch = (action, runtime) => {
      if (typeof ctx.onAction === 'function') {
        ctx.onAction({ id: action.id, payload: actionPayload(action, runtime) }, c);
      }
    };
    let local = initialVoiceLocal(voiceSupported(ctx.win, options.mode));

    const root = el(ctx, 'div', 'kb-field kb-voice-input');
    setData(root, 'control', 'voice-input');
    setData(root, 'mode', options.mode);
    if (options.pushToTalk) setData(root, 'push-to-talk', 'true');
    if (p.disabled === true) setData(root, 'disabled', 'true');

    const label = el(
      ctx,
      'span',
      p.hide_label === true ? 'kb-field__label kb-visually-hidden' : 'kb-field__label'
    );
    label.setAttribute('id', ids.label);
    label.appendChild(ctx.doc.createTextNode(String(p.label ?? '')));
    root.appendChild(label);

    const body = el(ctx, 'div', 'kb-voice-input__body');
    const button = el(ctx, 'button', 'kb-voice-input__button');
    button.setAttribute('type', 'button');
    button.setAttribute('id', ids.input);
    button.setAttribute('aria-labelledby', `${ids.label} ${ids.action}`);
    button.setAttribute('aria-describedby', voiceInputDescribedBy(ids, p));
    const iconWrap = el(ctx, 'span', 'kb-voice-input__icon');
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(micIcon(ctx));
    button.appendChild(iconWrap);
    const actionText = el(ctx, 'span', 'kb-voice-input__action');
    actionText.setAttribute('id', ids.action);
    button.appendChild(actionText);
    body.appendChild(button);
    if (options.showLevel) {
      const meter = el(ctx, 'span', 'kb-voice-input__meter');
      meter.setAttribute('aria-hidden', 'true');
      bars(ctx, meter, 'kb-voice-input__bar');
      body.appendChild(meter);
    }
    const time = el(ctx, 'span', 'kb-voice-input__time');
    time.setAttribute('aria-hidden', 'true');
    body.appendChild(time);
    root.appendChild(body);

    const transcript = options.showTranscript ? el(ctx, 'p', 'kb-voice-input__transcript') : null;
    if (transcript) root.appendChild(transcript);
    const status = el(ctx, 'p', 'kb-voice-input__status');
    status.setAttribute('id', ids.status);
    status.setAttribute('role', 'status');
    root.appendChild(status);
    if (typeof p.help === 'string' && p.help) {
      const help = el(ctx, 'p', 'kb-field__help', p.help);
      help.setAttribute('id', ids.help);
      root.appendChild(help);
    }

    const sync = () => {
      const view = voiceInputView(p, local, ctx.t);
      root.setAttribute('data-state', view.state);
      button.setAttribute('aria-pressed', view.pressed ? 'true' : 'false');
      button.disabled = view.disabled;
      setText(actionText, view.action);
      setText(time, view.time);
      setText(status, view.status);
      if (transcript) setText(transcript, view.interim);
    };
    const patch = (next) => {
      local = { ...local, ...next };
      sync();
    };

    let controller = null;
    const ensureController = () => {
      if (controller) return controller;
      controller = createVoiceController({
        win: ctx.win,
        mode: options.mode,
        lang: options.lang,
        continuous: options.continuous,
        meter: options.showLevel,
        chunkMs: options.chunkMs,
        maxSeconds: options.maxSeconds,
        onState: (state, detail) => {
          const wasActive = local.state !== 'idle' && local.state !== 'error';
          patch({
            state,
            error: detail.error,
            stopped: state === 'idle' && wasActive,
            ...(state === 'requesting' ? { elapsedMs: 0, interim: '' } : {}),
          });
          dispatch(actions.state, { name: p.name, state });
        },
        onLevel: (level) => setVoiceLevel(root, level),
        onElapsed: (ms) => patch({ elapsedMs: ms }),
        onTranscript: ({ text, final }) => {
          if (transcript) patch({ interim: final ? '' : text });
          dispatch(actions.transcript, { name: p.name, text, final });
        },
        onRecording: ({ file, durationMs, final }) =>
          dispatch(actions.recording, {
            name: p.name,
            file,
            duration_ms: Math.round(durationMs),
            final,
          }),
        onError: (code) => dispatch(actions.error, { name: p.name, code }),
      });
      return controller;
    };

    const active = () => ACTIVE_STATES.has(local.state);
    const begin = () => {
      if (button.disabled || active()) return;
      void ensureController().start();
    };
    const end = () => {
      if (controller && active()) controller.stop();
    };

    button.addEventListener('click', () => {
      if (options.pushToTalk) return;
      if (active()) end();
      else begin();
    });
    if (options.pushToTalk) {
      let held = false;
      const press = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        held = true;
        begin();
      };
      const release = () => {
        if (!held) return;
        held = false;
        end();
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointerleave', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('blur', release);
      button.addEventListener('keydown', (event) => {
        if (!event || (event.key !== ' ' && event.code !== 'Space')) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (event.repeat || held) return;
        press();
      });
      button.addEventListener('keyup', (event) => {
        if (!event || (event.key !== ' ' && event.code !== 'Space')) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        release();
      });
    }

    if (Array.isArray(ctx.cleanups)) {
      ctx.cleanups.push(() => {
        if (controller) controller.dispose();
        controller = null;
      });
    }
    sync();
    return root;
  };

  const voiceState = (ctx, p) => {
    const view = voiceStateView(p, ctx.t);
    const root = el(ctx, 'div', 'kb-voice-state');
    root.setAttribute('role', 'status');
    setData(root, 'state', view.state);
    setData(root, 'variant', view.variant);
    setData(root, 'size', view.size);
    if (view.level !== null) {
      setData(root, 'has-level', 'true');
      setVoiceLevel(root, view.level);
    }
    const visual = el(ctx, 'span', 'kb-voice-state__visual');
    visual.setAttribute('aria-hidden', 'true');
    if (view.variant === 'bars') bars(ctx, visual, 'kb-voice-state__bar');
    else visual.appendChild(el(ctx, 'span', `kb-voice-state__${view.variant}`));
    visual.appendChild(el(ctx, 'span', 'kb-voice-state__glyph'));
    root.appendChild(visual);
    root.appendChild(
      el(
        ctx,
        'span',
        view.showLabel ? 'kb-voice-state__label' : 'kb-voice-state__label kb-visually-hidden',
        view.label
      )
    );
    return root;
  };

  return {
    'ui:voice-input'(ctx, p, c) {
      return voiceInput(ctx, p, c);
    },
    'ui:voice-state'(ctx, p) {
      return voiceState(ctx, p);
    },
  };
}
