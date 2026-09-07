import { describe, expect, it } from 'vitest';
import { renderSnapshotLines } from './snapshot.js';

describe('renderSnapshotLines', () => {
  it('renders a section for all 9 panels', async () => {
    const lines = await renderSnapshotLines();
    expect(lines[0]).toBe('Kyberion Terminal HUD');
    expect(lines.filter((line) => line.startsWith('## ')).length).toBe(9);
  }, 60000);

  it('focuses a single panel via --panel', async () => {
    const lines = await renderSnapshotLines({ panel: 'settings' });
    expect(lines.filter((line) => line.startsWith('## ')).length).toBe(1);
  }, 30000);

  it('ignores unknown panel ids and renders everything', async () => {
    const lines = await renderSnapshotLines({ panel: 'nope' });
    expect(lines.filter((line) => line.startsWith('## ')).length).toBe(9);
  }, 60000);
});
