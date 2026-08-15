import { render } from 'ink';
import { App } from './app.js';
import { renderSnapshotLines } from './snapshot.js';
import { isPanelId, type PanelId } from './keymap.js';

export interface RunTuiOptions {
  once?: boolean;
  panel?: string;
}

function canUseInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function'
  );
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  // Ink needs a real TTY for raw mode. A command invoked from CI, a pipe, or
  // an IDE task runner should still be useful and should never fail just
  // because interactive input is unavailable.
  if (options.once || !canUseInteractiveTerminal()) {
    const lines = await renderSnapshotLines({ panel: options.panel });
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  const initialPanel: PanelId | undefined =
    options.panel && isPanelId(options.panel) ? options.panel : undefined;
  const instance = render(<App initialPanel={initialPanel} />);
  await instance.waitUntilExit();
}
