'use client';

import * as React from 'react';
import { Button, Select, SettingRow } from '@agent/shared-ui';
import type { VoiceSelection } from '../../../lib/settings-types';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

export function VoicePriorityEditor({
  priority,
  busy,
  t,
  save,
}: {
  priority: NonNullable<VoiceSelection['tts_priority']>;
  busy: boolean;
  t: SettingsTranslate;
  save: (order: string[]) => void;
}) {
  const [order, setOrder] = React.useState(priority.order);
  const options = priority.options.filter(({ engine_id }) => !order.includes(engine_id));
  const names = new Map(
    priority.options.map(({ engine_id, display_name }) => [engine_id, display_name])
  );
  const move = (index: number, offset: number) => {
    setOrder((current) => {
      const next = current.slice();
      const other = index + offset;
      [next[index], next[other]] = [next[other]!, next[index]!];
      return next;
    });
  };
  return (
    <div className="settings-row-block">
      <h4>{t('setup.voice_priority')}</h4>
      <p className="kb-text kb-text--muted">{t('setup.voice_priority_help')}</p>
      <ol className="settings-plain-list">
        {order.map((id, index) => (
          <li key={id}>
            {names.get(id) ?? id}
            <Button
              variant="ghost"
              label={t('setup.voice_priority_up')}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            />
            <Button
              variant="ghost"
              label={t('setup.voice_priority_down')}
              disabled={busy || index === order.length - 1}
              onClick={() => move(index, 1)}
            />
            <Button
              variant="ghost"
              label={t('setup.voice_priority_remove')}
              disabled={busy}
              onClick={() => setOrder((current) => current.filter((item) => item !== id))}
            />
          </li>
        ))}
      </ol>
      <FormScope
        fields={{
          'voice.priority_add': (value) => {
            const engine = asText(value);
            if (options.some(({ engine_id }) => engine_id === engine))
              setOrder((current) => (current.includes(engine) ? current : [...current, engine]));
          },
        }}
      >
        <SettingRow label={t('setup.voice_priority_add')} control_id="voice-priority-add">
          <Select
            id="voice-priority-add"
            name="voice.priority_add"
            label={t('setup.voice_priority_add')}
            hide_label
            value=""
            placeholder={t('authority.choose')}
            disabled={busy || !options.length}
            options={options.map(({ engine_id, display_name }) => ({
              value: engine_id,
              label: display_name,
            }))}
          />
        </SettingRow>
      </FormScope>
      <div className="settings-row-actions">
        <Button
          variant="primary"
          label={t('setup.voice_priority_save')}
          disabled={
            busy ||
            JSON.stringify(order) === JSON.stringify(priority.order) ||
            order.some((id) => !names.has(id))
          }
          onClick={() => save(order)}
        />
      </div>
    </div>
  );
}
