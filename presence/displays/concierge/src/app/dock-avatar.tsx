'use client';

import * as React from 'react';
import {
  A2UIActionProvider,
  KB_AVATAR_ACTIONS,
  TalkingAvatar,
  type KbTalkingAvatarRuntimeController,
  type TalkingAvatarProps,
} from '@agent/shared-ui';
import type { UseVoiceResult } from '../lib/use-voice';

/**
 * PA-09: the secretary's talking avatar in the conversation dock header.
 *
 * Images: the owner's adopted personal set (`GET /api/me/avatar`, owner
 * session only — anything else is 403 and falls back) or the default
 * Kyberion set (`/api/agent-avatar/:expression`). Mouth: the controller from
 * `avatar.ready` is attached to `use-voice` (`attachLipsync`), which then
 * plays replies through the shared speech player — browser audio from
 * `/api/voice/synthesize` (analyser lip-sync) falling back to
 * speechSynthesis (synthetic), and host-spoken voice-hub turns as synthetic
 * motion bounded by `speech.estimated_ms`. State (listening / thinking /
 * speaking) goes through `controller.setState` — never a re-render.
 */

export type DockAvatarState = 'listening' | 'thinking' | 'speaking' | null;

type AvatarImages = TalkingAvatarProps['images'];
type AvatarMouth = NonNullable<TalkingAvatarProps['mouth']>;

export const DOCK_AGENT_AVATAR: { images: AvatarImages; mouth: AvatarMouth } = {
  images: {
    neutral: '/api/agent-avatar/neutral',
    joy: '/api/agent-avatar/joy',
    thinking: '/api/agent-avatar/thinking',
    listening: '/api/agent-avatar/listening',
    blink: '/api/agent-avatar/blink',
  },
  mouth: { x: 0.5, y: 0.51, width: 0.16 },
};

const AVATAR_NAME = 'concierge-secretary';
const SAME_ORIGIN_PATH = /^\/(?!\/)/u;

/** Voice state → avatar state: speaking wins, then listening, then a pending reply. */
export function dockAvatarState(input: {
  speaking: boolean;
  listening: boolean;
  busy: boolean;
}): DockAvatarState {
  if (input.speaking) return 'speaking';
  if (input.listening) return 'listening';
  if (input.busy) return 'thinking';
  return null;
}

/** The adopted personal set from a `/api/me/avatar` body, or null. */
export function adoptedDockAvatar(
  body: unknown
): { images: AvatarImages; mouth?: AvatarMouth } | null {
  if (!body || typeof body !== 'object') return null;
  const avatar = (body as { avatar?: unknown }).avatar;
  if (!avatar || typeof avatar !== 'object') return null;
  const record = avatar as Record<string, unknown>;
  if (record.adopted !== true || !record.images || typeof record.images !== 'object') return null;
  const version = encodeURIComponent(String(record.generated_at ?? ''));
  const images: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.images as Record<string, unknown>)) {
    if (typeof value === 'string' && SAME_ORIGIN_PATH.test(value)) {
      images[key] = `${value}?v=${version}`;
    }
  }
  if (!images.neutral) return null;
  const mouth =
    record.mouth && typeof record.mouth === 'object' ? (record.mouth as AvatarMouth) : undefined;
  return { images: images as unknown as AvatarImages, ...(mouth ? { mouth } : {}) };
}

export function DockAvatar({
  voice,
  busy,
  label,
  personalLabel,
}: {
  voice: Pick<UseVoiceResult, 'attachLipsync' | 'listening' | 'speaking'>;
  busy: boolean;
  label: string;
  personalLabel: string;
}) {
  const [own, setOwn] = React.useState<{ images: AvatarImages; mouth?: AvatarMouth } | null>(null);
  const controllerRef = React.useRef<KbTalkingAvatarRuntimeController | null>(null);
  const { attachLipsync } = voice;
  const state = dockAvatarState({ speaking: voice.speaking, listening: voice.listening, busy });
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/me/avatar', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!cancelled) setOwn(adoptedDockAvatar(body));
      })
      .catch(() => {
        // Not the owner / no set: the default secretary avatar stays.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId !== KB_AVATAR_ACTIONS.ready || payload?.name !== AVATAR_NAME) return;
      const controller = payload.controller as KbTalkingAvatarRuntimeController;
      controllerRef.current = controller;
      attachLipsync(controller);
      controller.setState(stateRef.current);
    },
    [attachLipsync]
  );

  // Detach when the dock closes (the avatar unmounts and its controller is disposed).
  React.useEffect(() => () => attachLipsync(null), [attachLipsync]);

  React.useEffect(() => {
    controllerRef.current?.setState(state);
  }, [state]);

  const avatar = own ?? DOCK_AGENT_AVATAR;
  return (
    <A2UIActionProvider onAction={onAction}>
      <div className="dock-avatar" data-avatar-source={own ? 'personal' : 'agent'}>
        <TalkingAvatar
          name={AVATAR_NAME}
          label={own ? personalLabel : label}
          images={avatar.images}
          {...(avatar.mouth ? { mouth: avatar.mouth } : {})}
          size="sm"
        />
      </div>
    </A2UIActionProvider>
  );
}
