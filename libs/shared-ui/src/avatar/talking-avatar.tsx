'use client';

import { useEffect, useRef, type CSSProperties, type SyntheticEvent } from 'react';
import type { KbTalkingAvatarProps, KbVoiceStateProps } from '@agent/core/a2ui-catalog';
import { useA2UIActions } from '../actions.js';
import { useKbI18n, type KbTranslate } from '../i18n.js';
import { VoiceState } from '../voice/voice-state.js';
import {
  KB_AVATAR_ACTIONS,
  KB_AVATAR_MOUTH_SHAPES,
  avatarStateProps,
  avatarStyleVars,
  createAvatarController,
  talkingAvatarView,
} from '../../vanilla/avatar.js';

export interface TalkingAvatarProps extends KbTalkingAvatarProps {
  /** A2UI component id (unused in the markup; kept for the renderer hook). */
  id?: string;
}

const markFailed = (event: SyntheticEvent<HTMLImageElement>) => {
  event.currentTarget.setAttribute('data-failed', 'true');
};

/**
 * `ui:talking-avatar` (PA-09): markup mirrors `vanilla/avatar.js`
 * (parity-tested). The shared DOM controller (`createAvatarController`, on
 * the `vanilla/lipsync.js` engine) is created in an effect, handed to the
 * host in `avatar.ready { name, controller }` and disposed on unmount — the
 * mouth (`--kb-mouth-open`), expression and state change in place, without
 * a React re-render.
 */
export function TalkingAvatar(p: TalkingAvatarProps) {
  const { t } = useKbI18n();
  const { onAction } = useA2UIActions();
  const view = talkingAvatarView(p as unknown as Record<string, unknown>, t);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Latest translator / action handler for the long-lived controller.
  const tRef = useRef<KbTranslate>(t);
  tRef.current = t;
  const send = useRef<(id: string, payload: Record<string, unknown>) => void>(() => {});
  send.current = (id, payload) => {
    if (onAction) onAction(id, payload);
  };

  const structure = [
    view.name,
    view.label,
    view.explicit ?? '',
    view.mouthMode,
    view.showState ? 'state' : '',
    view.images.map((image) => image.key).join(','),
  ].join('|');
  const name = view.name;
  const label = view.label;
  const explicit = view.explicit;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const controller = createAvatarController({
      root,
      label,
      explicit,
      t: (key, params) => tRef.current(key, params),
      win: typeof window !== 'undefined' ? window : undefined,
    });
    send.current(KB_AVATAR_ACTIONS.ready, { name, controller });
    return () => controller.dispose();
  }, [structure, name, label, explicit]);

  return (
    <div
      ref={rootRef}
      className="kb-talking-avatar"
      data-name={view.name || undefined}
      data-size={view.size}
      data-shape={view.shape}
      data-expression={view.expression}
      data-state={view.state ?? undefined}
      data-mouth-mode={view.mouthMode}
      style={avatarStyleVars(view) as CSSProperties}
    >
      <div className="kb-talking-avatar__figure" role="img" aria-label={view.ariaLabel}>
        <span className="kb-talking-avatar__initials" aria-hidden="true">
          {view.initials || null}
        </span>
        {view.images.map((image) => (
          <img
            key={image.key}
            className="kb-talking-avatar__image"
            src={image.url}
            alt=""
            draggable={false}
            data-expression={image.key}
            data-active={image.key === view.expression ? 'true' : 'false'}
            onError={markFailed}
          />
        ))}
        {view.blink ? (
          <img
            className="kb-talking-avatar__blink"
            src={view.blink}
            alt=""
            draggable={false}
            onError={markFailed}
          />
        ) : null}
        {view.mouthFrame ? (
          <img
            className="kb-talking-avatar__mouth-frame"
            src={view.mouthFrame}
            alt=""
            draggable={false}
            onError={markFailed}
          />
        ) : (
          <svg
            className="kb-talking-avatar__mouth"
            viewBox="0 0 100 60"
            aria-hidden="true"
            focusable="false"
          >
            {KB_AVATAR_MOUTH_SHAPES.map((shape) => (
              <ellipse
                key={shape.part}
                className={`kb-talking-avatar__mouth-${shape.part}`}
                cx={shape.cx}
                cy={shape.cy}
                rx={shape.rx}
                ry={shape.ry}
              />
            ))}
          </svg>
        )}
      </div>
      {view.showState ? (
        <VoiceState {...(avatarStateProps(view.state) as KbVoiceStateProps)} />
      ) : null}
    </div>
  );
}
