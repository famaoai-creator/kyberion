/**
 * PH-02: keyboard handling of the plugin view confirm dialog. Pure (the
 * component injects `document` and the Cancel button): focus moves to Cancel
 * when the dialog opens, Escape anywhere cancels, and the returned cleanup
 * gives focus back to whatever held it before.
 */

export interface ConfirmFocusTarget {
  focus(): void;
}

export interface ConfirmKeyEvent {
  key: string;
  preventDefault?(): void;
}

export interface ConfirmFocusDocument {
  readonly activeElement: unknown;
  addEventListener(type: 'keydown', listener: (event: ConfirmKeyEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: ConfirmKeyEvent) => void): void;
}

function isFocusable(value: unknown): value is ConfirmFocusTarget & { isConnected?: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { focus?: unknown }).focus === 'function'
  );
}

export function bindConfirmDialogFocus(options: {
  document: ConfirmFocusDocument;
  /** The Cancel button (null when not rendered yet). */
  initial: ConfirmFocusTarget | null;
  onEscape: () => void;
}): () => void {
  const previous = options.document.activeElement;
  const onKeyDown = (event: ConfirmKeyEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    options.onEscape();
  };
  options.document.addEventListener('keydown', onKeyDown);
  options.initial?.focus();
  return () => {
    options.document.removeEventListener('keydown', onKeyDown);
    if (isFocusable(previous) && previous.isConnected !== false) previous.focus();
  };
}
