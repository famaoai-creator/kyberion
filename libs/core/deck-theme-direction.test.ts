import { describe, expect, it } from 'vitest';
import { selectDeckTheme } from './deck-theme-direction.js';

const CATALOG = [
  { id: 'kyberion-standard', name: 'Kyberion Standard' },
  { id: 'warm-earth', name: 'Warm Earth' },
];

describe('deck theme selection (pptx design quality)', () => {
  it('adopts a valid catalog selection', async () => {
    const theme = await selectDeckTheme({
      title: 'T',
      summary: 'human interest story',
      catalog: CATALOG,
      defaultTheme: 'kyberion-standard',
      generate: async () => JSON.stringify({ theme_id: 'warm-earth', reason: 'warm story' }),
    });
    expect(theme).toBe('warm-earth');
  });

  it('rejects out-of-catalog ids and keeps the default', async () => {
    const theme = await selectDeckTheme({
      title: 'T',
      summary: 'S',
      catalog: CATALOG,
      defaultTheme: 'kyberion-standard',
      generate: async () => JSON.stringify({ theme_id: 'made-up-theme' }),
    });
    expect(theme).toBe('kyberion-standard');
  });

  it('degrades to the default on backend failure or empty catalog', async () => {
    const failed = await selectDeckTheme({
      title: 'T',
      summary: 'S',
      catalog: CATALOG,
      defaultTheme: 'kyberion-standard',
      generate: async () => {
        throw new Error('down');
      },
    });
    expect(failed).toBe('kyberion-standard');

    const empty = await selectDeckTheme({
      title: 'T',
      summary: 'S',
      catalog: [],
      defaultTheme: 'kyberion-standard',
      generate: async () => JSON.stringify({ theme_id: 'anything' }),
    });
    expect(empty).toBe('kyberion-standard');
  });
});
