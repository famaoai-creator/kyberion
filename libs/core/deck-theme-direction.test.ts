import { describe, expect, it } from 'vitest';
import { draftDeckSectionBodies, selectDeckTheme } from './deck-theme-direction.js';

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

describe('deck section body drafting (llm_zone draft_body_content)', () => {
  const SECTIONS = [
    { id: 'intro', title: 'はじめに' },
    { id: 'plan', title: '計画', body: '既に書かれた本文。' },
    { id: 'next', title: '次のステップ' },
  ];

  it('drafts only the empty sections and never touches written ones', async () => {
    const drafts = await draftDeckSectionBodies({
      title: 'T',
      sections: SECTIONS,
      generate: async () =>
        JSON.stringify({ intro: '導入本文。', plan: '上書きを試みる。', next: '締めの本文。' }),
    });
    expect(drafts).toEqual({ intro: '導入本文。', next: '締めの本文。' });
  });

  it('returns nothing when every section already has a body', async () => {
    const drafts = await draftDeckSectionBodies({
      title: 'T',
      sections: [{ id: 'a', title: 'A', body: 'done' }],
      generate: async () => {
        throw new Error('should not be called');
      },
    });
    expect(drafts).toEqual({});
  });

  it('keeps the outline unchanged on backend failure or garbage', async () => {
    const failed = await draftDeckSectionBodies({
      title: 'T',
      sections: SECTIONS,
      generate: async () => {
        throw new Error('down');
      },
    });
    expect(failed).toEqual({});

    const garbage = await draftDeckSectionBodies({
      title: 'T',
      sections: SECTIONS,
      generate: async () => 'not json',
    });
    expect(garbage).toEqual({});
  });
});
