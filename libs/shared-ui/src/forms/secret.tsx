'use client';

import { useEffect, useRef, useState } from 'react';
import type { KbSecretFieldProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { KB_FORM_MESSAGE_KEYS, formAction, secretStatusText } from '../../vanilla/forms.js';
import {
  FieldLabel,
  HelpAndError,
  IconWrap,
  controlProps,
  fieldRootProps,
  focusSoon,
  useFieldIds,
  useFormDispatch,
  type KbFormComponentId,
} from './shared.js';

/**
 * `ui:secret-field` → masked token input. The typed value lives ONLY in the
 * uncontrolled `<input>`'s DOM `value` property: it is never React state, a
 * prop, an attribute, `data-*` or storage. Submit sends it once in the
 * `action` payload (`{ name, service_id?, secret_key?, value }` — the
 * governed secret-introduction path does the storing) and clears the input.
 * A configured secret shows only "Set · ••••last4" with Replace / Remove.
 * It never emits `field.change`.
 */
export function SecretField(p: KbSecretFieldProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const ids = useFieldIds(p.id, p.name);
  const dispatch = useFormDispatch();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState(p.configured !== true);
  const [seenConfigured, setSeenConfigured] = useState(p.configured === true);
  const [hasValue, setHasValue] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [notice, setNotice] = useState('');
  const [focusTarget, setFocusTarget] = useState<'input' | 'replace' | null>(null);
  const disabled = p.disabled === true;

  if (seenConfigured !== (p.configured === true)) {
    setSeenConfigured(p.configured === true);
    setEditing(p.configured !== true);
  }

  useEffect(() => {
    if (!focusTarget) return;
    setFocusTarget(null);
    focusSoon(() => (focusTarget === 'input' ? inputRef.current : replaceRef.current));
  }, [focusTarget]);

  const identity = () => {
    const out: Record<string, unknown> = { name: p.name };
    if (typeof p.service_id === 'string') out.service_id = p.service_id;
    if (typeof p.secret_key === 'string') out.secret_key = p.secret_key;
    return out;
  };

  const submit = () => {
    const input = inputRef.current;
    const value = input ? input.value : '';
    if (!value || disabled) return;
    if (input) input.value = '';
    setHasValue(false);
    setRevealed(false);
    dispatch(formAction(p.action, 'secret.submit'), { ...identity(), value });
    const nextEditing = p.configured !== true;
    setEditing(nextEditing);
    setFocusTarget(nextEditing ? 'input' : 'replace');
    setNotice(t(KB_FORM_MESSAGE_KEYS.secretSubmitted));
  };

  const paste = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    const input = inputRef.current;
    if (!clipboard || typeof clipboard.readText !== 'function') {
      setNotice(t(KB_FORM_MESSAGE_KEYS.secretPasteUnavailable));
      input?.focus();
      return;
    }
    clipboard.readText().then(
      (text) => {
        if (inputRef.current) {
          inputRef.current.value = String(text || '').trim();
          setHasValue(Boolean(inputRef.current.value));
          inputRef.current.focus();
        }
      },
      () => {
        setNotice(t(KB_FORM_MESSAGE_KEYS.secretPasteUnavailable));
        inputRef.current?.focus();
      }
    );
  };

  const state = editing ? (p.configured === true ? 'editing' : 'empty') : 'configured';
  return (
    <div
      className="kb-field kb-secret-field"
      {...fieldRootProps(p, 'secret-field')}
      data-state={state}
    >
      {!editing ? (
        <>
          <FieldLabel p={p} ids={ids} as="span" />
          <div className="kb-secret-field__summary" role="group" aria-labelledby={ids.label}>
            <span className="kb-secret-field__status" id={ids.status}>
              <IconWrap className="kb-secret-field__icon" name="lock" />
              {secretStatusText(p, t)}
            </span>
            <div className="kb-secret-field__actions">
              <button
                type="button"
                className="kb-btn kb-btn--secondary"
                ref={replaceRef}
                disabled={disabled || undefined}
                aria-describedby={ids.status}
                onClick={() => {
                  setEditing(true);
                  setFocusTarget('input');
                }}
              >
                {t(KB_FORM_MESSAGE_KEYS.secretReplace)}
              </button>
              {p.remove_action ? (
                <button
                  type="button"
                  className="kb-btn kb-btn--ghost"
                  disabled={disabled || undefined}
                  aria-describedby={ids.status}
                  onClick={() => dispatch(formAction(p.remove_action, 'secret.remove'), identity())}
                >
                  {t(KB_FORM_MESSAGE_KEYS.secretRemove)}
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <>
          <FieldLabel p={p} ids={ids} as="label" />
          <div className="kb-secret-field__row">
            <div className="kb-secret-field__control">
              <input
                ref={inputRef}
                className="kb-input kb-secret-field__input"
                type={revealed ? 'text' : 'password'}
                {...controlProps(p, ids)}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={p.placeholder || undefined}
                onInput={(event) => {
                  setNotice('');
                  setHasValue(Boolean(event.currentTarget.value));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <button
                type="button"
                className="kb-secret-field__toggle"
                aria-pressed={revealed}
                aria-controls={ids.input}
                disabled={disabled || undefined}
                onClick={() => setRevealed((value) => !value)}
              >
                {t(revealed ? KB_FORM_MESSAGE_KEYS.secretHide : KB_FORM_MESSAGE_KEYS.secretShow)}
              </button>
            </div>
            <button
              type="button"
              className="kb-btn kb-btn--secondary kb-secret-field__paste"
              disabled={disabled || undefined}
              onClick={paste}
            >
              {t(KB_FORM_MESSAGE_KEYS.secretPaste)}
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--primary kb-secret-field__save"
              disabled={disabled || !hasValue || undefined}
              onClick={submit}
            >
              {t(KB_FORM_MESSAGE_KEYS.secretSave)}
            </button>
            {p.configured === true ? (
              <button
                type="button"
                className="kb-btn kb-btn--ghost"
                onClick={() => {
                  if (inputRef.current) inputRef.current.value = '';
                  setHasValue(false);
                  setRevealed(false);
                  setEditing(false);
                  setFocusTarget('replace');
                }}
              >
                {t(KB_FORM_MESSAGE_KEYS.secretCancel)}
              </button>
            ) : null}
          </div>
        </>
      )}
      <p className="kb-secret-field__notice" role="status">
        {notice}
      </p>
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}
