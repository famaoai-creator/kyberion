'use client';

import { useCallback, useState } from 'react';
import type { KbFieldBase } from '@agent/core/a2ui-catalog';
import { useA2UIActions } from '../actions.js';
import { useKbI18n } from '../i18n.js';
import { KB_ICON_PATHS } from '../../vanilla/kyberion-ui.js';
import {
  KB_FORM_ACTIONS,
  KB_FORM_ICON_PATHS,
  KB_FORM_MESSAGE_KEYS,
  actionPayload,
  describedBy,
  formFieldIds,
  type KbFormFieldIds,
  type KbResolvedAction,
} from '../../vanilla/forms.js';

/**
 * Shared pieces of the React form components (UI-01c). Markup mirrors
 * `libs/shared-ui/vanilla/forms.js` exactly (parity-tested); ids, file
 * screening and the camera state machine come from that module.
 */

/** Every form component also takes the A2UI component id (deterministic DOM ids). */
export interface KbFormComponentId {
  /** A2UI component id; field DOM ids derive from it (else from `name`). */
  id?: string;
}

export function useFieldIds(id: string | undefined, name: unknown): KbFormFieldIds {
  return formFieldIds(id, name);
}

/**
 * Controlled value with a local echo: the host owns `value`, but the control
 * shows the user's edit immediately and re-syncs whenever `value` changes.
 */
export function useEcho<T>(value: T): [T, (next: T) => void] {
  const [local, setLocal] = useState(value);
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    setLocal(value);
  }
  return [local, setLocal];
}

/** Dispatch through the enclosing `A2UIActionProvider` (declared payload + runtime data). */
export function useFormDispatch() {
  const { onAction } = useA2UIActions();
  return useCallback(
    (action: KbResolvedAction, runtime: Record<string, unknown>) => {
      if (onAction) onAction(action.id, actionPayload(action, runtime));
    },
    [onAction]
  );
}

/** `field.change` `{ name, value }` for a controlled field. */
export function useFieldChange(name: string) {
  const dispatch = useFormDispatch();
  return useCallback(
    (value: unknown) => dispatch({ id: KB_FORM_ACTIONS.fieldChange }, { name, value }),
    [dispatch, name]
  );
}

export function fieldRootProps(p: Pick<KbFieldBase, 'disabled' | 'error'>, control: string) {
  return {
    'data-control': control,
    'data-disabled': p.disabled === true ? 'true' : undefined,
    'data-invalid': typeof p.error === 'string' && p.error ? 'true' : undefined,
  } as const;
}

export function controlProps(
  p: Pick<KbFieldBase, 'help' | 'error' | 'required' | 'disabled'>,
  ids: KbFormFieldIds,
  extra?: readonly (string | undefined)[]
) {
  return {
    id: ids.input,
    'aria-describedby': describedBy(ids, p, extra),
    'aria-invalid': typeof p.error === 'string' && p.error ? (true as const) : undefined,
    required: p.required === true || undefined,
    disabled: p.disabled === true || undefined,
  };
}

export function RequiredMark({ required }: { required?: boolean }) {
  const { t } = useKbI18n();
  if (required !== true) return null;
  return (
    <span className="kb-field__required" aria-hidden="true">
      {t(KB_FORM_MESSAGE_KEYS.required)}
    </span>
  );
}

/** `.kb-field__label` as `label[for]`, `span[id]` or `legend`, plus the required marker. */
export function FieldLabel({
  p,
  ids,
  as,
}: {
  p: Pick<KbFieldBase, 'label' | 'hide_label' | 'required'>;
  ids: KbFormFieldIds;
  as: 'label' | 'span' | 'legend';
}) {
  const className =
    p.hide_label === true ? 'kb-field__label kb-visually-hidden' : 'kb-field__label';
  const content = (
    <>
      {String(p.label ?? '')}
      <RequiredMark required={p.required} />
    </>
  );
  if (as === 'label')
    return (
      <label className={className} htmlFor={ids.input}>
        {content}
      </label>
    );
  if (as === 'span')
    return (
      <span className={className} id={ids.label}>
        {content}
      </span>
    );
  return <legend className={className}>{content}</legend>;
}

export function HelpAndError({
  p,
  ids,
}: {
  p: Pick<KbFieldBase, 'help' | 'error'>;
  ids: KbFormFieldIds;
}) {
  return (
    <>
      {typeof p.help === 'string' && p.help ? (
        <p className="kb-field__help" id={ids.help}>
          {p.help}
        </p>
      ) : null}
      {typeof p.error === 'string' && p.error ? (
        <p className="kb-field__error" id={ids.error}>
          {p.error}
        </p>
      ) : null}
    </>
  );
}

/** Decorative icon from the form set, else the base kit set; null when unknown. */
export function FormIcon({ name, size = 18 }: { name: string; size?: number }) {
  const paths = Object.prototype.hasOwnProperty.call(KB_FORM_ICON_PATHS, name)
    ? KB_FORM_ICON_PATHS[name]
    : Object.prototype.hasOwnProperty.call(KB_ICON_PATHS, name)
      ? KB_ICON_PATHS[name]
      : null;
  if (!paths) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}

/** `span[aria-hidden]` wrapper around a `FormIcon`; null when the icon is unknown. */
export function IconWrap({ className, name }: { className: string; name: string }) {
  const hasIcon =
    Object.prototype.hasOwnProperty.call(KB_FORM_ICON_PATHS, name) ||
    Object.prototype.hasOwnProperty.call(KB_ICON_PATHS, name);
  if (!hasIcon) return null;
  return (
    <span className={className} aria-hidden="true">
      <FormIcon name={name} />
    </span>
  );
}

/** Focus `element` after the next paint (post-transition focus management). */
export function focusSoon(getElement: () => { focus?: () => void } | null | undefined): void {
  const run = () => {
    const element = getElement();
    if (element && typeof element.focus === 'function') element.focus();
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else void Promise.resolve().then(run);
}
