import { render } from 'ink';
import type { SupportedLocale } from '@agent/core/locale';
import { App } from './app.js';
import { DeckStore, initialDeckState } from './store/deck-store.js';
import { createInlineHost, createWorkerHost, type DeckHost } from './data/host.js';
import { OSC_SIGNALS } from './controller.js';
import { runHandoff, type HandoffRunner } from './actions/handoff.js';
import { auditEffect, setOperatorBaseRole } from './actions/effects.js';
import { renderSnapshotLines } from './snapshot.js';
import { sanitizeTerminalText } from './ui/terminal-text.js';
import { defaultLocale, makeI18n } from './i18n.js';
import { VIEW_ORDER, type ViewId } from './model/layout.js';

export interface RunDeckOptions {
  once?: boolean;
  view?: string;
  locale?: SupportedLocale;
  /** Run the data engine in-process instead of a worker thread. */
  inline?: boolean;
  /**
   * The operator's base role before the deck raised its own read role;
   * child processes run on this one. Undefined = no base role.
   */
  operatorBaseRole?: string;
}

function canUseInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function'
  );
}

function createHost(options: RunDeckOptions, locale: SupportedLocale): DeckHost {
  if (!options.inline) {
    try {
      return createWorkerHost({ locale, operatorBaseRole: options.operatorBaseRole });
    } catch {
      // fall through to the in-process engine
    }
  }
  return createInlineHost({ locale, operatorBaseRole: options.operatorBaseRole });
}

export async function runDeck(
  options: RunDeckOptions = {},
  handoff: HandoffRunner = runHandoff
): Promise<void> {
  let locale = options.locale ?? defaultLocale();
  setOperatorBaseRole(options.operatorBaseRole);
  if (options.once || !canUseInteractiveTerminal()) {
    const lines = renderSnapshotLines(locale);
    process.stdout.write(lines.map(sanitizeTerminalText).join('\n') + '\n');
    return;
  }
  const view = VIEW_ORDER.includes(options.view as ViewId)
    ? (options.view as ViewId)
    : 'conversation';
  const store = new DeckStore(initialDeckState({ view }));
  const host = createHost(options, locale);
  try {
    // Render → (handoff → remount)* → quit. State lives in the store, so a
    // remount after `herdr agent attach` or the approval CLI resumes exactly
    // where the operator left.
    for (;;) {
      let rerender: ((node: React.ReactNode) => void) | undefined;
      const element = () => (
        <App
          store={store}
          host={host}
          locale={locale}
          signals={OSC_SIGNALS}
          onLocaleChange={(next) => {
            locale = next;
            // Loader-built text (labels, reasons) follows the operator's language too.
            host.setLocale(next);
            rerender?.(element());
          }}
        />
      );
      const instance = render(element(), {
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 30,
        exitOnCtrlC: true,
        patchConsole: true,
      });
      rerender = instance.rerender;
      await instance.waitUntilExit();
      const spec = store.getState().handoff;
      if (!spec || store.getState().quitting) break;
      store.set({ handoff: undefined });
      const code = await handoff(spec);
      auditEffect(
        `handoff_${spec.kind}`,
        { ok: code === 0, message: `exit ${code ?? 'error'}` },
        { subject: spec.subject }
      );
      const { tr } = makeI18n(locale);
      const outcome =
        spec.kind === 'approval'
          ? code === 0
            ? 'deck:handoff_approval_done'
            : 'deck:handoff_approval_failed'
          : code === 0
            ? 'deck:handoff_attach_done'
            : 'deck:handoff_attach_failed';
      store.toast(code === 0, tr(outcome));
      host.refresh();
    }
  } finally {
    OSC_SIGNALS.title('');
    host.stop();
  }
}
