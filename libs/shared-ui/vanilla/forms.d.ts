/**
 * Type declarations for `forms.js` (UI-01c settings & form components; plain
 * JS + JSDoc, no build step). The React renderer (`src/forms/*`) imports the
 * pure helpers and the camera controller from here so both renderers behave
 * identically. Kept loose (no `@agent/core` types) like `kyberion-ui.d.ts`.
 */

import type { KbTranslate } from './kyberion-ui.js';

export declare const KB_FORM_ACTIONS: Readonly<{
  fieldChange: string;
  filesAdd: string;
  fileRemove: string;
  cameraCapture: string;
  cameraCancel: string;
  avatarChange: string;
  avatarRemove: string;
}>;

export declare const KB_FORM_MESSAGE_KEYS: Readonly<Record<string, string>> & {
  readonly required: string;
  readonly selectPlaceholder: string;
  readonly textCount: string;
  readonly saveBarLabel: string;
  readonly saveBarSave: string;
  readonly saveBarDiscard: string;
  readonly fileDropPrompt: string;
  readonly fileDropPromptSingle: string;
  readonly fileDropBrowse: string;
  readonly fileDropBrowseSingle: string;
  readonly fileListLabel: string;
  readonly fileRemove: string;
  readonly fileCancel: string;
  readonly fileDropRejectType: string;
  readonly cameraStart: string;
  readonly cameraStarting: string;
  readonly cameraLiveLabel: string;
  readonly cameraTake: string;
  readonly cameraRetake: string;
  readonly cameraUse: string;
  readonly cameraCancel: string;
  readonly cameraChooseFile: string;
  readonly cameraPreviewAlt: string;
  readonly cameraUnavailable: string;
  readonly cameraDenied: string;
  readonly avatarUpload: string;
  readonly avatarTake: string;
  readonly avatarRemove: string;
  readonly avatarUse: string;
  readonly avatarCancel: string;
  readonly avatarCurrentAlt: string;
  readonly avatarPreviewAlt: string;
  readonly avatarEmpty: string;
  readonly secretShow: string;
  readonly secretHide: string;
  readonly secretPaste: string;
  readonly secretPasteUnavailable: string;
  readonly secretSave: string;
  readonly secretReplace: string;
  readonly secretRemove: string;
  readonly secretCancel: string;
  readonly secretPending: string;
  readonly secretSaved: string;
  readonly secretError: string;
};

/** Host-reported outcome of a secret-field submit (`status` prop). */
export type KbSecretFieldStatus = 'idle' | 'pending' | 'error' | 'saved';
export declare const KB_SECRET_FIELD_STATUSES: readonly KbSecretFieldStatus[];
/** The field's own last event and the host status it happened under. */
export interface KbSecretFieldLocalEvent {
  kind: 'submitted' | 'dismissed';
  under: KbSecretFieldStatus;
}

export declare const KB_SAVE_BAR_MESSAGE_KEYS: Readonly<Record<string, string>>;
export declare const KB_FILE_STATUS_MESSAGE_KEYS: Readonly<Record<string, string>>;
export declare const KB_INTEGRATION_STATES: Readonly<
  Record<string, Readonly<{ status: string; key: string }>>
>;
export declare const KB_FORM_ICON_PATHS: Readonly<Record<string, readonly string[]>>;

export interface KbFormFieldIds {
  input: string;
  label: string;
  help: string;
  error: string;
  hint: string;
  status: string;
  title: string;
}

export interface KbFormFieldLike {
  help?: string;
  error?: string;
}

export interface KbFileLike {
  name?: string;
  type?: string;
  size?: number;
}

export interface KbFileRejection {
  name: string;
  size: number;
  reason: 'type' | 'size' | 'count';
}

export interface KbFileScreening<F> {
  accepted: F[];
  rejected: KbFileRejection[];
}

export interface KbFileScreenProps {
  accept?: string;
  multiple?: boolean;
  max_bytes?: number;
  max_files?: number;
}

export interface KbFileEntryLike {
  status?: string;
  size?: number;
  progress?: number;
}

export interface KbResolvedAction {
  id: string;
  payload?: Record<string, unknown>;
}

export declare function formFieldIds(componentId: unknown, name: unknown): KbFormFieldIds;
export declare function describedBy(
  ids: KbFormFieldIds,
  p: KbFormFieldLike,
  extra?: readonly (string | undefined)[]
): string | undefined;
export declare function formatBytes(bytes: unknown): string;
export declare function describeAccept(accept: unknown): string;
export declare function fileMatchesAccept(file: KbFileLike, accept: unknown): boolean;
export declare function screenFiles<F extends KbFileLike>(
  files: ArrayLike<F> | Iterable<F> | null | undefined,
  p: KbFileScreenProps,
  existing?: number
): KbFileScreening<F>;
export declare function screeningNotice(
  result: KbFileScreening<unknown>,
  p: KbFileScreenProps,
  t: KbTranslate
): string;
export declare function fileDropHint(p: KbFileScreenProps, t: KbTranslate): string;
export declare function fileStatusText(entry: KbFileEntryLike, t: KbTranslate): string;
export declare function fileMetaText(entry: KbFileEntryLike, t: KbTranslate): string;
export declare function sliderValueText(value: unknown, unit?: string): string;
export declare function sliderRange(p: {
  min?: number;
  max?: number;
  step?: number;
  value?: number;
}): { min: number; max: number; step: number; value: number };
export declare function secretStatusText(
  p: { configured?: boolean; last4?: string },
  t: KbTranslate
): string;
export declare function secretFieldHostStatus(p: { status?: unknown }): KbSecretFieldStatus;
export declare function secretFieldNotice(
  p: { status?: unknown; status_error?: unknown },
  local: KbSecretFieldLocalEvent | null,
  t: KbTranslate
): { status: KbSecretFieldStatus; text: string };
export declare function textFieldValue(type: string, raw: string): string | number;
export declare function formAction(action: unknown, defaultId: string): KbResolvedAction;
export declare function actionPayload(
  action: KbResolvedAction,
  runtime: Record<string, unknown>
): Record<string, unknown>;
export declare function toFile(blob: Blob, name: string, win?: unknown): Blob;
export declare function stopStream(stream: unknown): void;
export declare function cameraSupported(win: unknown): boolean;
export declare function centerCrop(
  width: number,
  height: number,
  aspect?: string
): { sx: number; sy: number; sw: number; sh: number };
export declare function captureVideoFrame(
  video: unknown,
  doc: unknown,
  aspect?: string,
  maxSize?: number
): Promise<Blob | null>;
export declare function cropImageToSquare(
  file: Blob,
  doc: unknown,
  win: unknown,
  size?: number
): Promise<Blob>;

export type KbCameraPhase = 'idle' | 'starting' | 'live' | 'captured' | 'fallback';

export interface KbCameraState {
  phase: KbCameraPhase;
  notice: 'unavailable' | 'denied' | null;
  previewUrl: string | null;
}

export interface KbCameraController {
  readonly state: KbCameraState;
  readonly stream: unknown;
  attach(element: unknown): void;
  start(): Promise<void>;
  capture(): Promise<void>;
  useFile(file: Blob): void;
  retake(): Promise<void>;
  confirm(): Blob | null;
  cancel(): void;
  dispose(): void;
}

export declare function createCameraController(options?: {
  win?: unknown;
  doc?: unknown;
  facing?: string;
  aspect?: string;
  onState?: (state: KbCameraState) => void;
}): KbCameraController;

export declare function createFormRenderers(helpers: unknown): Record<string, unknown>;
