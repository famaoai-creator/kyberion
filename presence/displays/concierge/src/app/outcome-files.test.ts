import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/use-concierge-i18n', async () => {
  const { conciergeText } = await import('../lib/i18n');
  return {
    useConciergeI18n: () => ({
      t: (key: Parameters<typeof conciergeText>[0], params?: Record<string, string | number>) =>
        conciergeText(key, 'en', params),
    }),
  };
});
import { OutcomeFiles } from './outcome-files';
describe('outcome download component initial state', () => {
  it('offers a distinct download action without exposing paths or triggering requests', () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const markup = renderToStaticMarkup(
      React.createElement(OutcomeFiles, { entryId: 'INBOX-TEST', revision: '1' })
    );
    expect(markup).toContain('Download files');
    expect(markup).toContain('aria-expanded="false"');
    const panelId = /aria-controls="([^"]+)"/.exec(markup)?.[1];
    expect(panelId).toBeTruthy();
    expect(markup).toContain('id="' + panelId + '" hidden=""');

    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('artifacts/');
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });
});
