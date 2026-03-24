import { describe, expect, it, vi } from 'vitest';

vi.mock('./secure-io.js', () => ({
  safeExec: vi.fn(() => ''),
}));

vi.mock('./apple-event-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./apple-event-bridge.js')>('./apple-event-bridge.js');
  return {
    ...actual,
    activateApplication: vi.fn(),
  };
});

describe('os-app-adapters', () => {
  it('lists known app capabilities', async () => {
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.listKnownAppCapabilities().find((entry) => entry.application === 'Google Chrome')?.capabilities).toContain('list_tabs');
  });

  it('parses Chrome tab listings into structured rows', async () => {
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('1\nInbox\nhttps://mail.example\n2\nDocs\nhttps://docs.example');
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listChromeTabs()).toEqual([
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: 'https://docs.example' },
    ]);
  });
});
