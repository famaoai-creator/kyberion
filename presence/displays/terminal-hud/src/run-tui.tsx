import { render } from 'ink';
import { App } from './app.js';
import { renderSnapshotLines } from './snapshot.js';
import { isPanelId, type PanelId } from './keymap.js';

export interface RunTuiOptions {
  once?: boolean;
  panel?: string;
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  if (options.once) {
    const lines = await renderSnapshotLines({ panel: options.panel });
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  const initialPanel: PanelId | undefined =
    options.panel && isPanelId(options.panel) ? options.panel : undefined;
  const instance = render(<App initialPanel={initialPanel} />);
  await instance.waitUntilExit();
}
