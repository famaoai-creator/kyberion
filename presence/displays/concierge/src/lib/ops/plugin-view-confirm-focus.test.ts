import { describe, expect, it, vi } from 'vitest';
import {
  bindConfirmDialogFocus,
  type ConfirmFocusDocument,
  type ConfirmKeyEvent,
} from './plugin-view-confirm-focus';

function fakeDocument(activeElement: unknown) {
  const listeners = new Set<(event: ConfirmKeyEvent) => void>();
  const doc: ConfirmFocusDocument = {
    activeElement,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const press = (key: string) => {
    const event = { key, preventDefault: vi.fn() };
    for (const listener of [...listeners]) listener(event);
    return event;
  };
  return { doc, listeners, press };
}

describe('plugin view confirm dialog focus (PH-02)', () => {
  it('focuses Cancel on open, cancels on Escape and restores focus on close', () => {
    const opener = { focus: vi.fn(), isConnected: true };
    const cancel = { focus: vi.fn() };
    const onEscape = vi.fn();
    const { doc, listeners, press } = fakeDocument(opener);

    const release = bindConfirmDialogFocus({ document: doc, initial: cancel, onEscape });
    expect(cancel.focus).toHaveBeenCalledTimes(1);
    expect(press('Enter').preventDefault).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    expect(press('Escape').preventDefault).toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledTimes(1);

    release();
    expect(listeners.size).toBe(0);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('does not restore focus to a detached or non-focusable element', () => {
    const detached = { focus: vi.fn(), isConnected: false };
    bindConfirmDialogFocus({
      document: fakeDocument(detached).doc,
      initial: null,
      onEscape: () => undefined,
    })();
    expect(detached.focus).not.toHaveBeenCalled();
    expect(() =>
      bindConfirmDialogFocus({
        document: fakeDocument(null).doc,
        initial: null,
        onEscape: () => undefined,
      })()
    ).not.toThrow();
  });
});
