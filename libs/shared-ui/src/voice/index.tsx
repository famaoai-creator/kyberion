'use client';

import type { ReactNode } from 'react';
import type { KbVoiceInputProps, KbVoiceStateProps } from '@agent/core/a2ui-catalog';
import { VoiceInput } from './voice-input.js';
import { VoiceState } from './voice-state.js';

/**
 * PA-02 voice components (PADS_A2UI_AND_AVATAR_PLAN §3). `renderVoiceComponent`
 * is the A2UIRenderer hook: it returns `undefined` for types outside this
 * group so the base switch handles them.
 */

export const KB_VOICE_COMPONENT_TYPES = ['ui:voice-input', 'ui:voice-state'] as const;

export type KbVoiceComponentType = (typeof KB_VOICE_COMPONENT_TYPES)[number];

const VOICE_TYPES: ReadonlySet<string> = new Set(KB_VOICE_COMPONENT_TYPES);

export function isKbVoiceComponentType(type: string): type is KbVoiceComponentType {
  return VOICE_TYPES.has(type);
}

/** Render a voice catalog type with its A2UI component id (deterministic DOM ids). */
export function renderVoiceComponent(
  type: string,
  id: string,
  rawProps: Record<string, unknown>
): ReactNode | undefined {
  if (!isKbVoiceComponentType(type)) return undefined;
  // Props were schema-validated upstream (or are best-effort from a trusted host);
  // each component hardens what it reads.
  if (type === 'ui:voice-input')
    return <VoiceInput {...({ ...rawProps, id } as unknown as KbVoiceInputProps)} />;
  return <VoiceState {...(rawProps as unknown as KbVoiceStateProps)} />;
}

export { VoiceInput, VoiceState };
