'use client';

import type { CSSProperties } from 'react';
import type { KbVoiceStateProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { KB_VOICE_BAR_COUNT, voiceStateView } from '../../vanilla/voice.js';

const BARS = Array.from({ length: KB_VOICE_BAR_COUNT }, (_, index) => index);

/**
 * `ui:voice-state` → `.kb-voice-state[role=status][data-state][data-variant][data-size]`
 * (PA-02). Display-only; `level` (0..1) becomes `--kb-voice-level`. Markup
 * mirrors `vanilla/voice.js` (parity-tested).
 */
export function VoiceState(p: KbVoiceStateProps) {
  const { t } = useKbI18n();
  const view = voiceStateView(p, t);
  const style =
    view.level === null
      ? undefined
      : ({ '--kb-voice-level': String(Math.round(view.level * 100) / 100) } as CSSProperties);
  return (
    <div
      className="kb-voice-state"
      role="status"
      data-state={view.state}
      data-variant={view.variant}
      data-size={view.size}
      data-has-level={view.level === null ? undefined : 'true'}
      style={style}
    >
      <span className="kb-voice-state__visual" aria-hidden="true">
        {view.variant === 'bars' ? (
          BARS.map((index) => <span key={index} className="kb-voice-state__bar" />)
        ) : (
          <span className={`kb-voice-state__${view.variant}`} />
        )}
        <span className="kb-voice-state__glyph" />
      </span>
      <span
        className={
          view.showLabel ? 'kb-voice-state__label' : 'kb-voice-state__label kb-visually-hidden'
        }
      >
        {view.label}
      </span>
    </div>
  );
}
