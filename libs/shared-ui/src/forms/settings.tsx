'use client';

import type { ReactNode } from 'react';
import type {
  KbActionRef,
  KbIntegrationItemProps,
  KbSaveBarProps,
  KbSettingRowProps,
  KbSettingsGroupProps,
} from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { ActionRefButton } from '../components/controls.js';
import { StatusPill } from '../components/feedback.js';
import {
  KB_FORM_MESSAGE_KEYS,
  KB_INTEGRATION_STATES,
  KB_SAVE_BAR_MESSAGE_KEYS,
  formFieldIds,
} from '../../vanilla/forms.js';
import { IconWrap, type KbFormComponentId } from './shared.js';

/** `ui:settings-group` → `section.kb-settings-group` (header + `__rows` of children). */
export function SettingsGroup({
  id,
  title,
  description,
  children,
}: KbSettingsGroupProps & KbFormComponentId & { children?: ReactNode }) {
  const ids = formFieldIds(id, 'group');
  return (
    <section className="kb-settings-group" aria-labelledby={ids.title}>
      <header className="kb-settings-group__header">
        <h2 className="kb-settings-group__title" id={ids.title}>
          {title}
        </h2>
        {description ? <p className="kb-settings-group__description">{description}</p> : null}
      </header>
      <div className="kb-settings-group__rows">{children}</div>
    </section>
  );
}

/** `ui:setting-row` → `.kb-setting-row` (text left, one control right). */
export function SettingRow({
  label,
  description,
  tone,
  children,
}: KbSettingRowProps & KbFormComponentId & { children?: ReactNode }) {
  return (
    <div className="kb-setting-row" data-tone={tone === 'danger' ? 'danger' : undefined}>
      <div className="kb-setting-row__text">
        <p className="kb-setting-row__label">{label}</p>
        {description ? <p className="kb-setting-row__description">{description}</p> : null}
      </div>
      <div className="kb-setting-row__control">{children}</div>
    </div>
  );
}

/** `ui:integration-item` → `.kb-integration[data-state]` with a status pill and actions. */
export function IntegrationItem(p: KbIntegrationItemProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const state = Object.prototype.hasOwnProperty.call(KB_INTEGRATION_STATES, p.state)
    ? p.state
    : 'disconnected';
  const mapped = KB_INTEGRATION_STATES[state];
  const actions = (Array.isArray(p.actions) ? p.actions : []).filter(
    (ref: KbActionRef) =>
      ref && typeof ref.label === 'string' && ref.label && (ref.action || ref.href !== undefined)
  );
  return (
    <div className="kb-integration" data-state={state}>
      <IconWrap
        className="kb-integration__icon"
        name={typeof p.icon === 'string' ? p.icon : 'plug'}
      />
      <div className="kb-integration__body">
        <div className="kb-integration__heading">
          <p className="kb-integration__title">{p.title}</p>
          <StatusPill status={mapped.status as never} label={t(mapped.key)} />
        </div>
        {p.detail ? <p className="kb-integration__detail">{p.detail}</p> : null}
        {p.description ? <p className="kb-integration__description">{p.description}</p> : null}
      </div>
      {actions.length > 0 ? (
        <div className="kb-integration__actions">
          {actions.map((ref, index) => (
            <ActionRefButton key={`${ref.label}-${index}`} actionRef={ref} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SAVE_BAR_STATES: ReadonlySet<string> = new Set([
  'clean',
  'dirty',
  'saving',
  'saved',
  'error',
]);

/** `ui:save-bar` → sticky `.kb-save-bar[data-state]` region with discard / save. */
export function SaveBar(p: KbSaveBarProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const state = SAVE_BAR_STATES.has(p.state) ? p.state : 'clean';
  const actionable = state === 'dirty' || state === 'error';
  return (
    <div
      className="kb-save-bar"
      data-state={state}
      role="region"
      aria-label={t(KB_FORM_MESSAGE_KEYS.saveBarLabel)}
    >
      <p className="kb-save-bar__message" role="status">
        {p.message || t(KB_SAVE_BAR_MESSAGE_KEYS[state])}
      </p>
      <div className="kb-save-bar__actions">
        {p.discard_action ? (
          <ActionRefButton
            actionRef={{
              label: p.discard_label || t(KB_FORM_MESSAGE_KEYS.saveBarDiscard),
              action: p.discard_action,
              variant: 'ghost',
              disabled: !actionable,
            }}
            defaultVariant="ghost"
          />
        ) : null}
        <SaveButton
          label={p.save_label || t(KB_FORM_MESSAGE_KEYS.saveBarSave)}
          action={p.save_action}
          disabled={!actionable}
          busy={state === 'saving'}
        />
      </div>
    </div>
  );
}

function SaveButton({
  label,
  action,
  disabled,
  busy,
}: {
  label: string;
  action: KbSaveBarProps['save_action'];
  disabled: boolean;
  busy: boolean;
}) {
  if (!action || typeof action.id !== 'string') return null;
  if (!busy) {
    return (
      <ActionRefButton
        actionRef={{ label, action, variant: 'primary', disabled }}
        defaultVariant="primary"
      />
    );
  }
  // `aria-busy` while saving (the vanilla renderer sets the same attribute).
  return (
    <button
      type="button"
      className="kb-btn kb-btn--primary"
      disabled
      data-action-id={action.id}
      aria-busy="true"
    >
      {label}
    </button>
  );
}
