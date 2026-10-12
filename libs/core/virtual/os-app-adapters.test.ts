import { describe, expect, it, vi } from 'vitest';

vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeExec: vi.fn(() => ''),
    safeExecResult: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
  };
});

vi.mock('../apple-event-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../apple-event-bridge.js')>(
    '../apple-event-bridge.js'
  );
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
    mockDarwinPlatform();
    const adapters = await import('./os-app-adapters.js');
    try {
      expect(
        adapters.listKnownAppCapabilities().find((entry) => entry.application === 'Google Chrome')
          ?.capabilities
      ).toContain('list_tabs');
    } finally {
      restorePlatform();
    }
  });

  it('parses Chrome tab listings into structured rows', async () => {
    mockDarwinPlatform();
    const secureIo = await import('../secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce(
      '1\nInbox\nhttps://mail.example\n2\nDocs\nhttps://docs.example'
    );
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listChromeTabs()).toEqual([
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: 'https://docs.example' },
    ]);

    restorePlatform();
  });

  it('reads Chrome tab names through Windows UI Automation', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const secureIo = await import('../secure-io.js');
    vi.mocked(secureIo.safeExecResult).mockReturnValueOnce({
      stdout:
        '[{"index":1,"title":"Inbox","url":"https://mail.example"},{"index":2,"title":"Docs","url":""}]',
      stderr: '',
      status: 0,
    });
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.listChromeTabs()).toEqual([
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: '' },
    ]);
    const [command, args] = vi.mocked(secureIo.safeExecResult).mock.calls[0] ?? [];
    expect(command).toBe('powershell.exe');
    expect(args?.join(' ')).toContain('foreach ($p in (Get-Process chrome');
    expect(args?.join(' ')).toContain('$candidateTabs.Count -gt $tabs.Count');
    restorePlatform();
  });

  it('reports Windows Chrome and File Explorer capabilities', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listKnownAppCapabilities()).toEqual([
      {
        application: 'Google Chrome',
        adapter: 'browser_tabs',
        capabilities: ['list_tabs', 'activate_tab_by_title', 'close_tab_by_title'],
      },
      {
        application: 'File Explorer',
        adapter: 'file_manager',
        capabilities: ['empty_trash', 'reveal_path', 'open_path'],
      },
    ]);

    restorePlatform();
  });

  it('routes Windows Explorer actions through the fixed PowerShell script and env data', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const secureIo = await import('../secure-io.js');
    const adapters = await import('./os-app-adapters.js');

    adapters.revealFinderPath('C:\\Users\\me\\report.txt');
    const [command, args, options] = vi.mocked(secureIo.safeExecResult).mock.calls.at(-1) ?? [];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-EncodedCommand');
    expect(options?.input).toBe(adapters.WINDOWS_FILE_MANAGER_ACTION_SCRIPT);
    expect(options?.env?.[adapters.WINDOWS_FILE_MANAGER_ACTION_ENV]).toBe(
      JSON.stringify({ operation: 'reveal', path: 'C:\\Users\\me\\report.txt' })
    );
    expect(adapters.WINDOWS_FILE_MANAGER_ACTION_SCRIPT).not.toContain('report.txt');

    adapters.emptyFinderTrash();
    expect(
      vi.mocked(secureIo.safeExecResult).mock.calls.at(-1)?.[2]?.env?.[
        adapters.WINDOWS_FILE_MANAGER_ACTION_ENV
      ]
    ).toBe(JSON.stringify({ operation: 'empty_trash', path: undefined }));
    restorePlatform();
  });

  it('reports no native app capabilities on unsupported platforms', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listKnownAppCapabilities()).toEqual([]);

    restorePlatform();
  });

  it('resolves file manager implementations by platform without performing I/O', async () => {
    vi.resetModules();
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.resolveFileManagerPlatform('darwin')?.application).toBe('Finder');
    expect(adapters.resolveFileManagerPlatform('win32')?.application).toBe('File Explorer');
    expect(adapters.resolveFileManagerPlatform('linux')).toBeUndefined();
  });

  it('activates a uniquely matched Windows Chrome tab through the UIA bridge', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const secureIo = await import('../secure-io.js');
    vi.mocked(secureIo.safeExecResult).mockReturnValueOnce({
      stdout: '{"matched":true,"reason":"selected"}',
      stderr: '',
      status: 0,
    });
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.activateChromeTabByTitle('Docs')).toEqual({ matched: true });
    const [command, args, options] = vi.mocked(secureIo.safeExecResult).mock.calls.at(-1) ?? [];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-EncodedCommand');
    expect(options?.input).toBe(adapters.WINDOWS_CHROME_TAB_ACTION_SCRIPT);
    expect(options?.env?.[adapters.WINDOWS_CHROME_TAB_ACTION_ENV]).toBe(
      JSON.stringify({ operation: 'activate', title: 'Docs' })
    );
    expect(adapters.WINDOWS_CHROME_TAB_ACTION_SCRIPT).not.toContain('Docs');

    restorePlatform();
  });

  it('closes a Windows Chrome tab through the adapter while leaving approval to the actuator', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const secureIo = await import('../secure-io.js');
    vi.mocked(secureIo.safeExecResult).mockReturnValueOnce({
      stdout: '{"matched":true,"reason":"closed"}',
      stderr: '',
      status: 0,
    });
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.closeChromeTabByTitle('Docs')).toEqual({ matched: true });
    const [, , options] = vi.mocked(secureIo.safeExecResult).mock.calls.at(-1) ?? [];
    expect(options?.env?.[adapters.WINDOWS_CHROME_TAB_ACTION_ENV]).toBe(
      JSON.stringify({ operation: 'close', title: 'Docs' })
    );
    expect(adapters.WINDOWS_CHROME_TAB_ACTION_SCRIPT).toContain("'ambiguous'");
    expect(adapters.WINDOWS_CHROME_TAB_ACTION_SCRIPT.indexOf('if (-not $selected)')).toBeLessThan(
      adapters.WINDOWS_CHROME_TAB_ACTION_SCRIPT.indexOf("$shell.SendKeys('^w')")
    );

    restorePlatform();
  });

  it('does not target a different browser through the Windows Chrome adapter', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const secureIo = await import('../secure-io.js');
    const adapters = await import('./os-app-adapters.js');

    expect(adapters.listChromeTabs('Brave Browser')).toEqual([]);
    expect(adapters.activateChromeTabByTitle('Docs', 'Brave Browser')).toEqual({ matched: false });
    expect(vi.mocked(secureIo.safeExecResult)).not.toHaveBeenCalled();

    restorePlatform();
  });

  it('keeps the full native app capability set on macOS', async () => {
    vi.resetModules();
    mockDarwinPlatform();
    const adapters = await import('./os-app-adapters.js');
    const chrome = adapters
      .listKnownAppCapabilities()
      .find((entry) => entry.application === 'Google Chrome');

    expect(chrome?.capabilities).toEqual([
      'list_tabs',
      'activate_tab_by_title',
      'activate_tab_by_url',
      'close_tab_by_title',
      'close_tab_by_url',
    ]);
    expect(
      adapters.listKnownAppCapabilities().some((entry) => entry.application === 'Finder')
    ).toBe(true);

    restorePlatform();
  });

  it('activates a Chrome tab by URL fragment', async () => {
    mockDarwinPlatform();
    const secureIo = await import('../secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('matched');
    const adapters = await import('./os-app-adapters.js');
    expect(adapters.activateChromeTabByUrl('docs.example')).toEqual({ matched: true });

    restorePlatform();
  });

  it('marks iTerm2 as preferred when it owns the idle session', async () => {
    vi.resetModules();
    vi.doMock('../shell/terminal-bridge.js', () => ({
      terminalBridge: {
        listTargets: () => [
          { application: 'Terminal', adapter: 'terminal', sessions: [], idleSession: null },
          {
            application: 'iTerm2',
            adapter: 'iterm2',
            sessions: [{ winId: '1', sessionId: 'abc', type: 'iTerm2' }],
            idleSession: { winId: '1', sessionId: 'abc', type: 'iTerm2' },
          },
        ],
      },
    }));
    const adapters = await import('./os-app-adapters.js');
    const targets = adapters.listTerminalTargets();
    expect(targets.find((entry) => entry.application === 'iTerm2')?.preferred).toBe(true);
  });
});
