/**
 * Type declarations for `voice.js` (PA-02 `ui:voice-input` / `ui:voice-state`;
 * plain JS + JSDoc, no build step). The React renderer (`src/voice/*`)
 * imports the constants and the pure view helpers from here so both
 * renderers emit the same markup. Kept loose like `forms.d.ts`.
 */

import type { KbTranslate } from './kyberion-ui.js';
import type { KbResolvedAction } from './forms.js';
import type { KbVoiceErrorCode, KbVoiceInputState } from './voice-controller.js';

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
  type KbVoiceController,
  type KbVoiceControllerOptions,
  type KbVoiceErrorCode,
  type KbVoiceInputState,
  type KbVoiceTimers,
} from './voice-controller.js';

export declare const KB_VOICE_ACTIONS: Readonly<{
  state: string;
  transcript: string;
  recording: string;
  error: string;
}>;

export declare const KB_VOICE_MESSAGE_KEYS: Readonly<Record<string, string>>;
export declare const KB_VOICE_STATE_LABEL_KEYS: Readonly<Record<string, string>>;
export declare const KB_VOICE_ICON_PATHS: Readonly<{ mic: readonly string[] }>;
export declare const KB_VOICE_BAR_COUNT: number;

export interface KbVoiceInputOptions {
  mode: 'dictation' | 'record';
  lang: string;
  continuous: boolean;
  pushToTalk: boolean;
  showLevel: boolean;
  showTranscript: boolean;
  chunkMs: number | undefined;
  maxSeconds: number | undefined;
}

export interface KbVoiceLocal {
  state: KbVoiceInputState;
  error: KbVoiceErrorCode | null;
  /** Back at idle after an activity ("Stopped" is announced). */
  stopped: boolean;
  elapsedMs: number;
  interim: string;
}

export interface KbVoiceInputView {
  state: KbVoiceInputState;
  pressed: boolean;
  disabled: boolean;
  action: string;
  status: string;
  time: string;
  interim: string;
}

export interface KbVoiceInputIds {
  input: string;
  label: string;
  help: string;
  error: string;
  hint: string;
  status: string;
  title: string;
  action: string;
}

export interface KbVoiceStateView {
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';
  variant: 'bars' | 'orb' | 'dot';
  size: 'sm' | 'md' | 'lg';
  label: string;
  showLabel: boolean;
  /** 0..1, or null when the host gave no level. */
  level: number | null;
}

type Props = Record<string, unknown> | object;

export declare function voiceInputOptions(p: Props, locale: string): KbVoiceInputOptions;
export declare function voiceInputActions(p: Props): {
  state: KbResolvedAction;
  transcript: KbResolvedAction;
  recording: KbResolvedAction;
  error: KbResolvedAction;
};
export declare function initialVoiceLocal(supported: boolean | null): KbVoiceLocal;
export declare function voiceInputView(
  p: Props,
  local: KbVoiceLocal,
  t: KbTranslate
): KbVoiceInputView;
export declare function voiceInputIds(componentId: unknown, name: unknown): KbVoiceInputIds;
export declare function voiceInputDescribedBy(ids: KbVoiceInputIds, p: Props): string;
export declare function voiceStateView(p: Props, t: KbTranslate): KbVoiceStateView;
export declare function setVoiceLevel(node: unknown, level: number): void;

export declare function createVoiceRenderers(h: {
  el: (ctx: any, tag: string, className?: string, text?: unknown) => any;
  setData: (node: any, name: string, value: unknown) => void;
}): Record<string, (ctx: any, props: any, component: any, depth?: number) => any>;
