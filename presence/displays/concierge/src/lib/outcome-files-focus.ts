/** Request-owned focus for pagination/retry. DOM access is lazy for SSR. */
type FocusDocument = Pick<Document, 'activeElement' | 'body' | 'hasFocus'>;
export function createOutcomeFilesFocus(getDocument: () => FocusDocument = () => document) {
  let pending: { owner: unknown; source: HTMLElement; index: number } | undefined;
  const cancel = () => {
    pending = undefined;
  };
  return {
    cancel,
    begin(owner: unknown, source: HTMLElement, index: number) {
      pending = getDocument().activeElement === source ? { owner, source, index } : undefined;
    },
    moved(target: EventTarget | null) {
      if (
        pending &&
        target !== pending.source &&
        !(target === getDocument().body && !pending.source.isConnected)
      )
        cancel();
    },
    pointed(target: Node) {
      if (pending && !pending.source.contains(target)) cancel();
    },
    complete(
      owner: unknown,
      state: { open: boolean; busy: boolean; error: boolean },
      panel: HTMLElement | null,
      errorPanel: HTMLElement | null
    ) {
      if (!pending || state.busy) return;
      const selected = pending;
      cancel();
      const doc = getDocument();
      if (
        !state.open ||
        selected.owner !== owner ||
        !doc.hasFocus() ||
        (doc.activeElement !== selected.source &&
          !(doc.activeElement === doc.body && !selected.source.isConnected))
      )
        return;
      const target = state.error
        ? errorPanel
        : panel?.querySelector<HTMLElement>(
            '[data-outcome-file-index="' +
              selected.index +
              '"] a, ' +
              '[data-outcome-file-index="' +
              selected.index +
              '"] button, ' +
              '[data-outcome-file-index="' +
              selected.index +
              '"] [tabindex="-1"]'
          );
      (target ?? panel)?.focus();
    },
  };
}
