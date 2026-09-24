/**
 * Type declarations for `avatar.js` (PA-09 `ui:talking-avatar`; plain JS +
 * JSDoc, no build step). The React renderer (`src/avatar/*`) imports the
 * view helpers and the DOM controller from here so both renderers emit the
 * same markup and behave the same. Kept loose like `voice.d.ts`.
 */

import type { KbAnalyserLike, KbLipsyncCue, KbSyntheticOptions } from './lipsync.js';

export * from './lipsync.js';

type Translate = (key: string, params?: Record<string, unknown>) => string;

export declare const KB_AVATAR_ACTIONS: Readonly<{ ready: string }>;
export declare const KB_AVATAR_EXPRESSIONS: readonly string[];
export declare const KB_AVATAR_SIZES: readonly string[];
export declare const KB_AVATAR_MOUTH_MODES: readonly string[];
export declare const KB_AVATAR_DEFAULT_MOUTH: Readonly<{ x: number; y: number; width: number }>;
export declare const KB_AVATAR_MESSAGE_KEYS: Readonly<{ labelState: string }>;
export declare const KB_AVATAR_MOUTH_SHAPES: ReadonlyArray<{
  part: string;
  cx: string;
  cy: string;
  rx: string;
  ry: string;
}>;

export interface KbTalkingAvatarView {
  name: string;
  label: string;
  ariaLabel: string;
  explicit: string | null;
  expression: string;
  state: string | null;
  showState: boolean;
  mouth: { x: number; y: number; width: number };
  mouthMode: 'overlay' | 'frames';
  size: string;
  shape: 'circle' | 'rounded';
  initials: string;
  images: Array<{ key: string; url: string }>;
  blink: string | null;
  mouthFrame: string | null;
}

export interface KbTalkingAvatarRuntimeController {
  setLevel(level: number): void;
  applyCue(cue: KbLipsyncCue): boolean;
  attachAnalyser(node: KbAnalyserLike): () => void;
  detachAnalyser(): void;
  startSynthetic(options?: KbSyntheticOptions): void;
  stopSynthetic(): void;
  pulse(): void;
  setExpression(expression: string | null): boolean;
  setState(state: string | null): boolean;
  dispose(): void;
}

export interface KbAvatarControllerOptions {
  root: unknown;
  label: string;
  explicit?: string | null;
  t: Translate;
  win?: unknown;
  now?: () => number;
  raf?: (callback: (time: number) => void) => unknown;
  caf?: (handle: unknown) => void;
  reducedMotion?: boolean;
}

export declare function avatarImageUrl(value: unknown): string | null;
export declare function avatarInitials(props: Record<string, unknown>): string;
export declare function displayedExpression(
  explicit: string | null | undefined,
  state: string | null | undefined,
  available: readonly string[]
): string;
export declare function avatarAriaLabel(label: string, state: string | null, t: Translate): string;
export declare function talkingAvatarView(
  props: Record<string, unknown>,
  t: Translate
): KbTalkingAvatarView;
export declare function avatarStyleVars(view: KbTalkingAvatarView): Record<string, string>;
export declare function avatarStateProps(state: string | null): {
  state: string;
  variant: 'dot';
  size: 'sm';
};
export declare function prefersReducedMotion(win: unknown): boolean;
export declare function avatarParts(root: unknown): {
  figure: unknown;
  images: unknown[];
  stateRoot: unknown;
  stateLabel: unknown;
};
export declare function setMouthOpen(root: unknown, openness: number): void;
export declare function createAvatarController(
  options: KbAvatarControllerOptions
): KbTalkingAvatarRuntimeController;
export declare function createAvatarRenderers(h: {
  el: (...args: unknown[]) => unknown;
  setData: (...args: unknown[]) => void;
  voiceState: (...args: unknown[]) => unknown;
}): Record<string, (...args: unknown[]) => unknown>;
