'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { KbDialogProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import {
  activeElementFor,
  dialogCancelResult,
  dialogFocusables,
  dialogIds,
  dialogModel,
  dialogResult,
  dialogTrapTarget,
  type KbDialogButtonModel,
  type KbDialogIds,
  type KbDialogModel,
} from '../../vanilla/pads.js';
import { useA2UIActions } from '../actions.js';
import { canRefocus } from './shared.js';

export interface DialogViewProps {
  model: KbDialogModel;
  ids: KbDialogIds;
  /** A button press (or Enter in a single-line input) with the input's current value. */
  onResult: (button: KbDialogButtonModel, value: string) => void;
  /** Escape. */
  onCancel: () => void;
  /** Rendered A2UI children, placed between the message / input and the buttons. */
  content?: ReactNode;
}

/**
 * The `ui:dialog` markup (mirrors `buildDialogDom` in vanilla/dialog.js).
 * Opening focuses the input (else the primary button) and remembers the
 * previously focused element; closing (open → false, or unmount) restores it.
 */
export function DialogView({ model, ids, onResult, onCancel, content }: DialogViewProps) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const open = model.open;
  const primaryIndex = Math.max(
    0,
    model.buttons.findIndex((button) => button.primary)
  );

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    // Shadow-root aware: the focused element inside the panel's tree.
    const previous = activeElementFor(panelRef.current, document);
    const initial = inputRef.current ?? buttonRefs.current[primaryIndex] ?? null;
    if (initial && typeof initial.focus === 'function') initial.focus({ preventScroll: true });
    return () => {
      if (canRefocus(previous)) previous.focus();
    };
    // Focus once per open; re-renders while open keep the user's focus.
  }, [open]);

  if (!open) return <div className="kb-dialog" data-state="closed" hidden />;

  const value = () => (inputRef.current ? inputRef.current.value : '');
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Tab') {
      const panel = panelRef.current;
      const target = dialogTrapTarget<HTMLElement>(
        dialogFocusables<HTMLElement>(panel),
        activeElementFor(panel, typeof document !== 'undefined' ? document : null),
        event.shiftKey
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
  };
  const input = model.input;
  return (
    <div className="kb-dialog" data-state="open" data-tone={model.danger ? 'danger' : undefined}>
      <div className="kb-dialog__backdrop" aria-hidden="true" />
      <div
        className="kb-dialog__panel"
        id={ids.root}
        role={model.role}
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={model.message ? ids.message : undefined}
        onKeyDown={onKeyDown}
        ref={panelRef}
      >
        <h2 className="kb-dialog__title" id={ids.title}>
          {model.title}
        </h2>
        {model.message ? (
          <p className="kb-dialog__message" id={ids.message}>
            {model.message}
          </p>
        ) : null}
        {input ? (
          <div
            className="kb-field kb-dialog__field"
            data-control={input.multiline ? 'textarea' : 'text-field'}
          >
            <label className="kb-field__label" htmlFor={ids.input}>
              {input.label}
            </label>
            {input.multiline ? (
              <textarea
                className="kb-input kb-textarea"
                id={ids.input}
                name={input.name}
                placeholder={input.placeholder || undefined}
                defaultValue={input.value}
                ref={(node) => {
                  inputRef.current = node;
                }}
              />
            ) : (
              <input
                className="kb-input"
                type="text"
                id={ids.input}
                name={input.name}
                placeholder={input.placeholder || undefined}
                defaultValue={input.value}
                ref={(node) => {
                  inputRef.current = node;
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  onResult(model.buttons[primaryIndex], value());
                }}
              />
            )}
          </div>
        ) : null}
        {hasContent(content) ? <div className="kb-dialog__content">{content}</div> : null}
        <div className="kb-dialog__actions">
          {model.buttons.map((button, index) => (
            <button
              key={`${button.kind}:${button.choice}:${index}`}
              type="button"
              className={`kb-btn kb-btn--${button.variant}`}
              data-choice-id={button.kind === 'choice' ? button.choice : undefined}
              data-dialog-button={button.kind === 'choice' ? undefined : button.kind}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              onClick={() => onResult(button, value())}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function hasContent(content: ReactNode): boolean {
  if (content === null || content === undefined || content === false) return false;
  return !(Array.isArray(content) && content.length === 0);
}

export interface DialogProps extends KbDialogProps {
  /** A2UI component id; the dialog's DOM ids derive from it. */
  id?: string;
  /** Rendered A2UI `children` (the body content slot). */
  children?: ReactNode;
}

/**
 * `ui:dialog` (PA-01): in-page confirm / prompt / multi-choice, controlled by
 * `open`. Confirm and choices dispatch `action` (default `dialog.confirm`)
 * with `{ choice?, value? }`; Cancel / Escape dispatch `cancel_action`
 * (default `dialog.cancel`).
 */
export function Dialog(p: DialogProps) {
  const { t } = useKbI18n();
  const { onAction } = useA2UIActions();
  const model = dialogModel(p, t);
  const ids = dialogIds(p.id);
  const send = (result: { id: string; payload: Record<string, unknown> }) => {
    if (onAction) onAction(result.id, result.payload);
  };
  return (
    <DialogView
      model={model}
      ids={ids}
      onResult={(button, value) => send(dialogResult(p, model, button, value))}
      onCancel={() => send(dialogCancelResult(p))}
      content={model.open ? p.children : null}
    />
  );
}
