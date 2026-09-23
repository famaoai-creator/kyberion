'use client';

import type { ReactNode } from 'react';
import type { KbTalkingAvatarProps } from '@agent/core/a2ui-catalog';
import { TalkingAvatar } from './talking-avatar.js';

/**
 * PA-09 talking avatar (PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §6).
 * `renderAvatarComponent` is the A2UIRenderer hook: it returns `undefined`
 * for types outside this group so the base switch handles them.
 */

export const KB_AVATAR_COMPONENT_TYPES = ['ui:talking-avatar'] as const;

export type KbAvatarComponentType = (typeof KB_AVATAR_COMPONENT_TYPES)[number];

const AVATAR_TYPES: ReadonlySet<string> = new Set(KB_AVATAR_COMPONENT_TYPES);

export function isKbAvatarComponentType(type: string): type is KbAvatarComponentType {
  return AVATAR_TYPES.has(type);
}

/** Render an avatar catalog type with its A2UI component id. */
export function renderAvatarComponent(
  type: string,
  id: string,
  rawProps: Record<string, unknown>
): ReactNode | undefined {
  if (!isKbAvatarComponentType(type)) return undefined;
  // Props were schema-validated upstream (or are best-effort from a trusted
  // host); the component hardens what it reads (image URLs included).
  return <TalkingAvatar {...({ ...rawProps, id } as unknown as KbTalkingAvatarProps)} />;
}

export { TalkingAvatar };
