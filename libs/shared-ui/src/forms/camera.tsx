'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbAvatarPickerProps, KbCameraCaptureProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { safeHref } from '../safety.js';
import {
  KB_FORM_ACTIONS,
  KB_FORM_MESSAGE_KEYS,
  createCameraController,
  describedBy,
  cropImageToSquare,
  fileMatchesAccept,
  formAction,
  toFile,
  type KbCameraController,
  type KbCameraState,
} from '../../vanilla/forms.js';
import {
  FieldLabel,
  FormIcon,
  HelpAndError,
  IconWrap,
  fieldRootProps,
  focusSoon,
  useFieldIds,
  useFormDispatch,
  type KbFormComponentId,
} from './shared.js';

const IDLE: KbCameraState = { phase: 'idle', notice: null, previewUrl: null };

interface CameraPanelProps {
  facing?: string;
  aspect?: string;
  disabled?: boolean;
  /** Start the camera on mount (the avatar picker's explicit "Take photo"). */
  autoStart?: boolean;
  showCancelInFallback?: boolean;
  onPhase?: (phase: KbCameraState['phase']) => void;
  onConfirm: (file: Blob) => void;
  onCancel?: () => void;
  /** Wraps the stage for `ui:camera-capture` (labelled group). */
  stageLabelledBy?: string;
}

/**
 * Camera sub-UI (stage + actions + live notice) on the shared
 * `createCameraController`. The controller is created client-side only and
 * disposed on unmount (stops every track, revokes the preview URL); it also
 * stops on `pagehide`.
 */
function CameraPanel(props: CameraPanelProps) {
  const { t } = useKbI18n();
  const [state, setState] = useState<KbCameraState>(IDLE);
  const controllerRef = useRef<KbCameraController | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef(false);
  const { facing, aspect, autoStart, onPhase } = props;

  useEffect(() => {
    const controller = createCameraController({
      win: typeof window !== 'undefined' ? window : undefined,
      doc: typeof document !== 'undefined' ? document : undefined,
      facing,
      aspect,
      onState: setState,
    });
    controllerRef.current = controller;
    if (autoStart) void controller.start();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [facing, aspect, autoStart]);

  useEffect(() => {
    if (onPhase) onPhase(state.phase);
    // Focus the new primary control after a user-driven transition; while the
    // camera is starting (primary disabled) keep the request pending.
    if (!focusNext.current || state.phase === 'starting') return;
    focusNext.current = false;
    focusSoon(() => {
      const holder = actionsRef.current;
      return holder
        ? (holder.querySelector(
            'button:not([disabled]), input:not([disabled])'
          ) as HTMLElement | null)
        : null;
    });
  }, [state.phase, onPhase]);

  const run = (fn: (controller: KbCameraController) => void) => () => {
    const controller = controllerRef.current;
    if (!controller) return;
    focusNext.current = true;
    fn(controller);
  };
  const confirm = run((controller) => {
    const photo = controller.confirm();
    if (photo)
      props.onConfirm(
        toFile(photo, 'photo.jpg', typeof window !== 'undefined' ? window : undefined)
      );
  });
  const cancel = run((controller) => {
    controller.cancel();
    if (props.onCancel) props.onCancel();
  });

  const phase = state.phase;
  return (
    <>
      <div
        className="kb-camera__stage"
        data-aspect={aspect === 'landscape' ? 'landscape' : 'square'}
        data-facing={facing === 'environment' ? 'environment' : 'user'}
        role={props.stageLabelledBy ? 'group' : undefined}
        aria-labelledby={props.stageLabelledBy}
      >
        {phase === 'live' || phase === 'starting' ? (
          <video
            className="kb-camera__video"
            aria-label={t(KB_FORM_MESSAGE_KEYS.cameraLiveLabel)}
            playsInline
            muted
            autoPlay
            ref={(element) => controllerRef.current?.attach(element)}
          />
        ) : phase === 'captured' && state.previewUrl ? (
          <img
            className="kb-camera__preview"
            src={state.previewUrl}
            decoding="async"
            alt={t(KB_FORM_MESSAGE_KEYS.cameraPreviewAlt)}
          />
        ) : (
          <IconWrap className="kb-camera__placeholder" name="camera" />
        )}
      </div>
      <div className="kb-camera__actions" ref={actionsRef}>
        {phase === 'idle' ? (
          <button
            type="button"
            className="kb-btn kb-btn--primary"
            disabled={props.disabled || undefined}
            onClick={run((controller) => void controller.start())}
          >
            {t(KB_FORM_MESSAGE_KEYS.cameraStart)}
          </button>
        ) : null}
        {phase === 'starting' ? (
          <>
            <button type="button" className="kb-btn kb-btn--primary" disabled>
              {t(KB_FORM_MESSAGE_KEYS.cameraStarting)}
            </button>
            <button type="button" className="kb-btn kb-btn--ghost" onClick={cancel}>
              {t(KB_FORM_MESSAGE_KEYS.cameraCancel)}
            </button>
          </>
        ) : null}
        {phase === 'live' ? (
          <>
            <button
              type="button"
              className="kb-btn kb-btn--primary"
              onClick={run((controller) => void controller.capture())}
            >
              {t(KB_FORM_MESSAGE_KEYS.cameraTake)}
            </button>
            <button type="button" className="kb-btn kb-btn--ghost" onClick={cancel}>
              {t(KB_FORM_MESSAGE_KEYS.cameraCancel)}
            </button>
          </>
        ) : null}
        {phase === 'captured' ? (
          <>
            <button type="button" className="kb-btn kb-btn--primary" onClick={confirm}>
              {t(KB_FORM_MESSAGE_KEYS.cameraUse)}
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--secondary"
              onClick={run((controller) => void controller.retake())}
            >
              {t(KB_FORM_MESSAGE_KEYS.cameraRetake)}
            </button>
            <button type="button" className="kb-btn kb-btn--ghost" onClick={cancel}>
              {t(KB_FORM_MESSAGE_KEYS.cameraCancel)}
            </button>
          </>
        ) : null}
        {phase === 'fallback' ? (
          <>
            <label className="kb-btn kb-btn--primary kb-camera__file">
              {t(KB_FORM_MESSAGE_KEYS.cameraChooseFile)}
              <input
                className="kb-visually-hidden"
                type="file"
                accept="image/*"
                capture={facing === 'environment' ? 'environment' : 'user'}
                disabled={props.disabled || undefined}
                onChange={(event) => {
                  const picked = event.target.files && event.target.files[0];
                  if (picked && fileMatchesAccept(picked, 'image/*')) {
                    focusNext.current = true;
                    controllerRef.current?.useFile(picked);
                  }
                }}
              />
            </label>
            {props.showCancelInFallback ? (
              <button type="button" className="kb-btn kb-btn--ghost" onClick={cancel}>
                {t(KB_FORM_MESSAGE_KEYS.cameraCancel)}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <p className="kb-camera__notice" role="status">
        {state.notice === 'unavailable'
          ? t(KB_FORM_MESSAGE_KEYS.cameraUnavailable)
          : state.notice === 'denied'
            ? t(KB_FORM_MESSAGE_KEYS.cameraDenied)
            : ''}
      </p>
    </>
  );
}

/**
 * `ui:camera-capture` → `.kb-camera[data-state]`. The camera starts only when
 * the user presses Start; the confirmed photo goes to `onAction(action ??
 * 'camera.capture', { name, file })` and never into props.
 */
export function CameraCapture(p: KbCameraCaptureProps & KbFormComponentId) {
  const ids = useFieldIds(p.id, p.name);
  const dispatch = useFormDispatch();
  const [phase, setPhase] = useState<KbCameraState['phase']>('idle');
  const action = formAction(p.action, KB_FORM_ACTIONS.cameraCapture);
  const cancelAction = formAction(p.cancel_action, KB_FORM_ACTIONS.cameraCancel);
  return (
    <div className="kb-field kb-camera" {...fieldRootProps(p, 'camera-capture')} data-state={phase}>
      <FieldLabel p={p} ids={ids} as="span" />
      {p.description ? <p className="kb-field__description">{p.description}</p> : null}
      <CameraPanel
        facing={p.facing}
        aspect={p.aspect}
        disabled={p.disabled === true}
        stageLabelledBy={ids.label}
        onPhase={setPhase}
        onConfirm={(file) => dispatch(action, { name: p.name, file })}
        onCancel={() => dispatch(cancelAction, { name: p.name })}
      />
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}

/**
 * `ui:avatar-picker` → current picture + upload / take photo / remove, with a
 * square-cropped preview before `onAction(action ?? 'avatar.change', { name,
 * file, source })`. The pending image lives in a ref + object URL only.
 */
export function AvatarPicker(p: KbAvatarPickerProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const ids = useFieldIds(p.id, p.name);
  const dispatch = useFormDispatch();
  const [mode, setMode] = useState<'idle' | 'preview' | 'camera'>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const pendingRef = useRef<Blob | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef(false);
  const changeAction = formAction(p.action, KB_FORM_ACTIONS.avatarChange);
  const removeAction = formAction(p.remove_action, KB_FORM_ACTIONS.avatarRemove);
  const imageUrl = safeHref(p.image_url);
  const disabled = p.disabled === true;

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    setPreviewUrl((url) => {
      if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
        URL.revokeObjectURL(url);
      return null;
    });
  }, []);

  useEffect(() => clearPending, [clearPending]);

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    focusSoon(() => {
      const holder = actionsRef.current;
      return holder
        ? (holder.querySelector(
            'button:not([disabled]), input:not([disabled])'
          ) as HTMLElement | null)
        : null;
    });
  }, [mode]);

  const go = (next: typeof mode) => {
    focusNext.current = true;
    setMode(next);
  };

  const shownUrl = mode === 'preview' ? previewUrl : imageUrl;
  return (
    <div
      className="kb-field kb-avatar-picker"
      {...fieldRootProps(p, 'avatar-picker')}
      data-state={mode}
    >
      <FieldLabel p={p} ids={ids} as="span" />
      <div className="kb-avatar-picker__body">
        <div
          className="kb-avatar-picker__frame"
          data-shape={p.shape === 'square' ? 'square' : 'circle'}
        >
          {shownUrl ? (
            <img
              className="kb-avatar-picker__image"
              src={shownUrl}
              loading="lazy"
              decoding="async"
              alt={t(
                mode === 'preview'
                  ? KB_FORM_MESSAGE_KEYS.avatarPreviewAlt
                  : KB_FORM_MESSAGE_KEYS.avatarCurrentAlt
              )}
            />
          ) : (
            <span
              className="kb-avatar-picker__initials"
              role="img"
              aria-label={t(KB_FORM_MESSAGE_KEYS.avatarEmpty)}
            >
              {typeof p.initials === 'string' && p.initials ? (
                <span aria-hidden="true">{p.initials}</span>
              ) : (
                <FormIcon name="user" size={28} />
              )}
            </span>
          )}
        </div>
        <div className="kb-avatar-picker__actions" ref={actionsRef}>
          {mode === 'preview' ? (
            <>
              <button
                type="button"
                className="kb-btn kb-btn--primary"
                onClick={() => {
                  const file = pendingRef.current;
                  clearPending();
                  go('idle');
                  if (file) dispatch(changeAction, { name: p.name, file, source: 'upload' });
                }}
              >
                {t(KB_FORM_MESSAGE_KEYS.avatarUse)}
              </button>
              <button
                type="button"
                className="kb-btn kb-btn--ghost"
                onClick={() => {
                  clearPending();
                  go('idle');
                }}
              >
                {t(KB_FORM_MESSAGE_KEYS.avatarCancel)}
              </button>
            </>
          ) : null}
          {mode === 'idle' ? (
            <>
              <label className="kb-btn kb-btn--secondary kb-avatar-picker__upload">
                {t(KB_FORM_MESSAGE_KEYS.avatarUpload)}
                <input
                  className="kb-visually-hidden"
                  type="file"
                  accept="image/*"
                  id={ids.input}
                  aria-describedby={describedBy(ids, p)}
                  disabled={disabled || undefined}
                  onChange={(event) => {
                    const file = event.target.files && event.target.files[0];
                    event.target.value = '';
                    if (!file) return;
                    if (!fileMatchesAccept(file, 'image/*')) {
                      setNotice(t(KB_FORM_MESSAGE_KEYS.fileDropRejectType, { file: file.name }));
                      return;
                    }
                    setNotice('');
                    void cropImageToSquare(
                      file,
                      typeof document !== 'undefined' ? document : undefined,
                      typeof window !== 'undefined' ? window : undefined
                    ).then((cropped) => {
                      clearPending();
                      pendingRef.current = cropped;
                      setPreviewUrl(
                        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
                          ? URL.createObjectURL(cropped)
                          : null
                      );
                      go('preview');
                    });
                  }}
                />
              </label>
              {p.allow_camera !== false ? (
                <button
                  type="button"
                  className="kb-btn kb-btn--secondary"
                  disabled={disabled || undefined}
                  onClick={() => go('camera')}
                >
                  {t(KB_FORM_MESSAGE_KEYS.avatarTake)}
                </button>
              ) : null}
              {p.removable === true && imageUrl ? (
                <button
                  type="button"
                  className="kb-btn kb-btn--ghost"
                  disabled={disabled || undefined}
                  onClick={() => dispatch(removeAction, { name: p.name })}
                >
                  {t(KB_FORM_MESSAGE_KEYS.avatarRemove)}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <div className="kb-avatar-picker__camera">
        {mode === 'camera' ? (
          <CameraPanel
            facing="user"
            aspect="square"
            autoStart
            showCancelInFallback
            onConfirm={(file) => {
              go('idle');
              dispatch(changeAction, { name: p.name, file, source: 'camera' });
            }}
            onCancel={() => go('idle')}
          />
        ) : null}
      </div>
      <p className="kb-avatar-picker__notice" role="status">
        {notice}
      </p>
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}
