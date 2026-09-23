'use client';

import { useState, type ClipboardEvent, type DragEvent } from 'react';
import type { KbFileDropProps, KbFileEntry } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import {
  KB_FORM_ACTIONS,
  KB_FORM_MESSAGE_KEYS,
  fileDropHint,
  fileMetaText,
  formAction,
  screenFiles,
  screeningNotice,
} from '../../vanilla/forms.js';
import {
  FieldLabel,
  FormIcon,
  HelpAndError,
  IconWrap,
  controlProps,
  fieldRootProps,
  useFieldIds,
  useFormDispatch,
  type KbFormComponentId,
} from './shared.js';

function entriesOf(files: unknown): KbFileEntry[] {
  return Array.isArray(files)
    ? files.filter(
        (entry): entry is KbFileEntry =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
      )
    : [];
}

/**
 * `ui:file-drop` → drop zone (`label.kb-file-drop__zone` for a visually
 * hidden, keyboard-focusable `input[type=file]`) + host-driven file list.
 * Picked / dropped / pasted files are screened (`accept`, `max_bytes`,
 * `max_files`) and handed to `onAction(action ?? 'file.add', { name, files,
 * rejected })` — they never enter props or React state.
 */
export function FileDrop(p: KbFileDropProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const ids = useFieldIds(p.id, p.name);
  const dispatch = useFormDispatch();
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const entries = entriesOf(p.files);
  const hint = fileDropHint(p, t);
  const multiple = p.multiple === true;
  const disabled = p.disabled === true;
  const existing = entries.filter((entry) => entry.status !== 'error').length;
  const addAction = formAction(p.action, KB_FORM_ACTIONS.filesAdd);
  const removeAction = formAction(p.remove_action, KB_FORM_ACTIONS.fileRemove);

  const take = (files: FileList | null | undefined) => {
    if (disabled || !files || files.length === 0) return;
    const result = screenFiles(files, p, existing);
    setNotice(screeningNotice(result, p, t));
    if (result.accepted.length > 0) {
      dispatch(addAction, { name: p.name, files: result.accepted, rejected: result.rejected });
    }
  };
  const over = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (!disabled) setDragging(true);
  };

  return (
    <div
      className="kb-field kb-file-drop"
      {...fieldRootProps(p, 'file-drop')}
      data-dragging={dragging ? 'true' : undefined}
      onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
        const files = event.clipboardData ? event.clipboardData.files : null;
        if (files && files.length > 0) {
          event.preventDefault();
          take(files);
        }
      }}
    >
      <FieldLabel p={p} ids={ids} as="span" />
      {p.description ? <p className="kb-field__description">{p.description}</p> : null}
      <input
        className="kb-file-drop__input kb-visually-hidden"
        type="file"
        {...controlProps(p, ids, hint ? [ids.hint] : [])}
        aria-labelledby={ids.label}
        accept={typeof p.accept === 'string' && p.accept ? p.accept : undefined}
        multiple={multiple || undefined}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
      <label
        className="kb-file-drop__zone"
        htmlFor={ids.input}
        onDragEnter={over}
        onDragOver={over}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer ? event.dataTransfer.files : null);
        }}
      >
        <IconWrap className="kb-file-drop__icon" name="upload" />
        <span className="kb-file-drop__prompt">
          {t(
            multiple
              ? KB_FORM_MESSAGE_KEYS.fileDropPrompt
              : KB_FORM_MESSAGE_KEYS.fileDropPromptSingle
          )}
        </span>
        <span className="kb-file-drop__browse">
          {t(
            multiple
              ? KB_FORM_MESSAGE_KEYS.fileDropBrowse
              : KB_FORM_MESSAGE_KEYS.fileDropBrowseSingle
          )}
        </span>
        {hint ? (
          <span className="kb-file-drop__hint" id={ids.hint}>
            {hint}
          </span>
        ) : null}
      </label>
      <p className="kb-file-drop__notice" role="status">
        {notice}
      </p>
      {entries.length > 0 ? (
        <ul className="kb-file-list" aria-label={t(KB_FORM_MESSAGE_KEYS.fileListLabel)}>
          {entries.map((entry) => (
            <li key={entry.id} className="kb-file-list__item" data-status={entry.status}>
              <div className="kb-file-list__body">
                <span className="kb-file-list__name">{entry.name}</span>
                <span className="kb-file-list__meta">{fileMetaText(entry, t)}</span>
                {entry.status === 'uploading' ? (
                  <progress
                    className="kb-file-list__progress"
                    max={100}
                    value={
                      typeof entry.progress === 'number'
                        ? Math.round(Math.min(Math.max(entry.progress, 0), 100))
                        : undefined
                    }
                    aria-label={String(entry.name)}
                  />
                ) : null}
                {entry.status === 'error' && entry.error ? (
                  <span className="kb-file-list__error">{entry.error}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="kb-btn kb-btn--ghost kb-file-list__remove"
                aria-label={t(
                  entry.status === 'uploading'
                    ? KB_FORM_MESSAGE_KEYS.fileCancel
                    : KB_FORM_MESSAGE_KEYS.fileRemove,
                  { file: entry.name }
                )}
                disabled={disabled || undefined}
                onClick={() => dispatch(removeAction, { name: p.name, file_id: entry.id })}
              >
                <FormIcon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}
