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

const originalPlatform = process.platform;

function mockDarwinPlatform() {
  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
}

describe('os-app-adapters', () => {
  it('lists known app capabilities', async () => {
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.listKnownAppCapabilities().find((entry) => entry.application === 'Google Chrome')?.capabilities).toContain('list_tabs');
  });

  it('parses Chrome tab listings into structured rows', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('1\nInbox\nhttps://mail.example\n2\nDocs\nhttps://docs.example');
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listChromeTabs()).toEqual([
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: 'https://docs.example' },
    ]);

    restorePlatform();
  });

  it('activates a Chrome tab by URL fragment', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('matched');
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.activateChromeTabByUrl('docs.example')).toEqual({ matched: true });

    restorePlatform();
  });

  it('marks iTerm2 as preferred when it owns the idle session', async () => {
    vi.resetModules();
    vi.doMock('./terminal-bridge.js', () => ({
      terminalBridge: {
        listTargets: () => [
          { application: 'Terminal', adapter: 'terminal', sessions: [], idleSession: null },
          { application: 'iTerm2', adapter: 'iterm2', sessions: [{ winId: '1', sessionId: 'abc', type: 'iTerm2' }], idleSession: { winId: '1', sessionId: 'abc', type: 'iTerm2' } },
        ],
      },
    }));
    const adapters = await import('./os-app-adapters.js');
    const targets = adapters.listTerminalTargets();
    expect(targets.find((entry) => entry.application === 'iTerm2')?.preferred).toBe(true);
  });
});
