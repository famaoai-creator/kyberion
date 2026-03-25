import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core', () => {
  const safeExec = vi.fn(() => '');
  return {
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    safeReadFile: vi.fn(() => '{}'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn(() => false),
    derivePipelineStatus: vi.fn((results: Array<{ status: string }>) => results.every((r) => r.status === 'success') ? 'succeeded' : 'failed'),
    safeExec,
    createStandardYargs: vi.fn(),
    activateApplication: vi.fn((application: string) => safeExec('osascript', ['-e', `tell application "${application}" to activate`])),
    detectFocusedInput: vi.fn(() => {
      const output = String(safeExec('osascript', ['-e', '__detect_focused_input__'])).trimEnd();
      const [application = '', windowTitle = '', role = '', description = '', editableFlag = 'false'] = output.split('\n');
      return {
        application,
        windowTitle,
        role,
        description,
        editable: editableFlag.trim().toLowerCase() === 'true',
      };
    }),
    keystrokeText: vi.fn((text: string) => safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${text}"`])),
    pasteText: vi.fn((text: string) => safeExec('osascript', ['-e', `set the clipboard to "${text}"\ntell application "System Events" to keystroke "v" using command down`])),
    pressKey: vi.fn((key: string) => {
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedKey === 'enter' || normalizedKey === 'return') {
        return safeExec('osascript', ['-e', 'tell application "System Events" to key code 36']);
      }
      return safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${normalizedKey}"`]);
    }),
    clickAt: vi.fn((x: number, y: number, clickCount = 1) => {
      for (let index = 0; index < clickCount; index += 1) {
        safeExec('osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`]);
      }
    }),
    rightClickAt: vi.fn((x: number, y: number, clickCount = 1) => {
      for (let index = 0; index < clickCount; index += 1) {
        safeExec('osascript', ['-e', `tell application "System Events" to do shell script "/usr/bin/env cliclick rc:${x},${y}"`]);
      }
    }),
    moveMouse: vi.fn((x: number, y: number) => safeExec('osascript', ['-e', `tell application "System Events" to do shell script "/usr/bin/env cliclick m:${x},${y}"`])),
    listKnownAppCapabilities: vi.fn(() => [
      { application: 'Google Chrome', adapter: 'browser_tabs', capabilities: ['list_tabs', 'activate_tab_by_title'] },
      { application: 'Finder', adapter: 'file_manager', capabilities: ['empty_trash'] },
    ]),
    listTerminalTargets: vi.fn(() => [
      { application: 'Terminal', supported: true, preferred: false, adapter: 'terminal', canInject: true, sessionCount: 0, sessions: [], idleSession: null },
      { application: 'iTerm2', supported: true, preferred: true, adapter: 'iterm2', canInject: true, sessionCount: 1, sessions: [{ winId: '1', sessionId: 'abc', type: 'iTerm2' }], idleSession: { winId: '1', sessionId: 'abc', type: 'iTerm2' } },
    ]),
    listChromeTabs: vi.fn(() => [
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: 'https://docs.example' },
    ]),
    activateChromeTabByTitle: vi.fn((title: string) => ({ matched: title === 'Docs' })),
    activateChromeTabByUrl: vi.fn((url: string) => ({ matched: url === 'docs.example' })),
    closeChromeTabByTitle: vi.fn((title: string) => ({ matched: title === 'Docs' })),
    closeChromeTabByUrl: vi.fn((url: string) => ({ matched: url === 'docs.example' })),
    emptyFinderTrash: vi.fn(),
    revealFinderPath: vi.fn(),
    openFinderPath: vi.fn(),
    emitComputerSurfacePatch: vi.fn(),
    createApprovalRequest: vi.fn(() => ({ id: 'approval-123', status: 'pending' })),
    loadApprovalRequest: vi.fn(() => null),
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn(() => []),
}));

vi.mock('@agent/shared-vision', () => ({
  consultVision: vi.fn(async () => ({ decision: 'ok' })),
}));

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

describe('system-actuator computer_interaction adapter', () => {
  it('detects the currently focused input element', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'detect_focused_input',
      },
    } as any);

    expect(result.context.focused_input).toEqual({
      application: 'Codex',
      windowTitle: 'Current Chat',
      role: 'AXTextArea',
      description: 'Chat Input',
      editable: true,
    });
  });

  it('remembers the currently focused target', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'remember_focused_target',
        focus_target_id: 'chat-main',
      },
    } as any);

    expect(result.context.focus_target_id).toBe('chat-main');
    expect(core.safeWriteFile).toHaveBeenCalled();
  });

  it('activates an application before keyboard input when target.application is present', async () => {
    mockDarwinPlatform();
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');

    await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Safari',
      },
      action: {
        type: 'type',
        text: 'hello',
      },
    } as any);

    expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "Safari" to activate']);

    restorePlatform();
  });

  it('supports explicit activate_application actions', async () => {
    mockDarwinPlatform();
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');

    await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'activate_application',
        application: 'Finder',
      },
    } as any);

    expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "Finder" to activate']);

    restorePlatform();
  });

  it('submits the focused input with enter', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'submit_focused_input',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "System Events" to key code 36']);
  });

  it('uses paste strategy for focused input typing by default', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'type_into_focused_input',
        text: 'こんにちは',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.safeExec).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('keystroke "v" using command down')]),
    );
  });

  it('guards against focus target drift before typing', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExistsSync).mockReturnValue(true);
    vi.mocked(core.safeReadFile).mockReturnValue(
      JSON.stringify({
        'chat-main': {
          id: 'chat-main',
          application: 'Codex',
          windowTitle: 'Original Chat',
          role: 'AXTextArea',
        },
      }),
    );
    vi.mocked(core.safeExec).mockReturnValueOnce('Codex\nDifferent Chat\nAXTextArea\nChat Input\ntrue');

    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        target: {
          executor: 'system',
          focus_target_id: 'chat-main',
        },
        action: {
          type: 'type_into_focused_input',
          text: 'hello',
        },
      } as any),
    ).rejects.toThrow('Focused target guard failed for chat-main');
  });

  it('allows window title prefix matching for remembered targets', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExistsSync).mockReturnValue(true);
    vi.mocked(core.safeReadFile).mockReturnValue(
      JSON.stringify({
        'chat-main': {
          id: 'chat-main',
          application: 'Codex',
          windowTitle: 'Original Chat',
          role: 'AXTextArea',
        },
      }),
    );
    vi.mocked(core.safeExec)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('Codex\nOriginal Chat — Updated\nAXTextArea\nChat Input\ntrue')
      .mockReturnValueOnce('');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        focus_target_id: 'chat-main',
        focus_target_match_policy: 'prefix',
      },
      action: {
        type: 'type_into_focused_input',
        text: 'hello',
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('retries after re-activating the remembered application before failing guard', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExistsSync).mockReturnValue(true);
    vi.mocked(core.safeReadFile).mockReturnValue(
      JSON.stringify({
        'chat-main': {
          id: 'chat-main',
          application: 'Codex',
          windowTitle: 'Original Chat',
          role: 'AXTextArea',
        },
      }),
    );
    vi.mocked(core.safeExec)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('OtherApp\nElsewhere\nAXTextArea\nChat Input\ntrue')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('Codex\nOriginal Chat\nAXTextArea\nChat Input\ntrue')
      .mockReturnValueOnce('');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        focus_target_id: 'chat-main',
      },
      action: {
        type: 'type_into_focused_input',
        text: 'hello',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "Codex" to activate']);
  });

  it('maps keyboard typing into the system pipeline', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'type',
        text: 'hello',
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('maps left_click into mouse_click execution', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'left_click',
        coordinate: { x: 120, y: 240 },
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('returns known app capabilities', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'list_known_app_capabilities',
      },
    } as any);

    expect(result.context.known_app_capabilities).toHaveLength(2);
  });

  it('returns Chrome tabs through the app adapter', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'list_tabs',
      },
    } as any);

    expect(result.context.browser_tabs[1].title).toBe('Docs');
  });

  it('returns terminal targets through the app adapter', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'list_terminal_targets',
      },
    } as any);

    expect(result.context.terminal_targets[1].application).toBe('iTerm2');
    expect(result.context.terminal_targets[1].preferred).toBe(true);
  });

  it('activates a Chrome tab by title', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'activate_tab_by_title',
        title: 'Docs',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.tab_activation.matched).toBe(true);
  });

  it('activates a Chrome tab by url fragment', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'activate_tab_by_url',
        url: 'docs.example',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.tab_activation.matched).toBe(true);
  });

  it('blocks close_tab_by_url and creates an approval request when none is supplied', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.closeChromeTabByUrl).mockClear();

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'computer-session-1',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'close_tab_by_url',
        url: 'docs.example',
      },
    } as any);

    expect(result.status).toBe('blocked');
    expect(result.context.approval_request_id).toBe('approval-123');
    expect(core.closeChromeTabByUrl).not.toHaveBeenCalled();
  });

  it('closes a Chrome tab by url when approval is present', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.loadApprovalRequest).mockReturnValue({ status: 'approved' } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'close_tab_by_url',
        url: 'docs.example',
        approval_request_id: 'approved-req',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.closeChromeTabByUrl).toHaveBeenCalledWith('docs.example', 'Google Chrome');
  });

  it('executes empty_trash through the Finder adapter', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.loadApprovalRequest).mockReturnValue({ status: 'approved' } as any);
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'empty_trash',
        approval_request_id: 'approved-req',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.emptyFinderTrash).toHaveBeenCalled();
  });

  it('blocks empty_trash and creates an approval request when none is supplied', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.emptyFinderTrash).mockClear();

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'computer-session-1',
      action: {
        type: 'empty_trash',
      },
    } as any);

    expect(result.status).toBe('blocked');
    expect(result.context.approval_request_id).toBe('approval-123');
    expect(core.createApprovalRequest).toHaveBeenCalled();
    expect(core.emptyFinderTrash).not.toHaveBeenCalled();
  });

  it('blocks close_tab_by_title and creates an approval request when none is supplied', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.closeChromeTabByTitle).mockClear();

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'computer-session-1',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'close_tab_by_title',
        title: 'Docs',
      },
    } as any);

    expect(result.status).toBe('blocked');
    expect(result.context.approval_request_id).toBe('approval-123');
    expect(core.createApprovalRequest).toHaveBeenCalled();
    expect(core.closeChromeTabByTitle).not.toHaveBeenCalled();
  });

  it('closes a Chrome tab by title when approval is present', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.loadApprovalRequest).mockReturnValue({ status: 'approved' } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      target: {
        executor: 'system',
        application: 'Google Chrome',
      },
      action: {
        type: 'close_tab_by_title',
        title: 'Docs',
        approval_request_id: 'approved-req',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.closeChromeTabByTitle).toHaveBeenCalledWith('Docs', 'Google Chrome');
  });

  it('reveals a path through Finder', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'reveal_path',
        path: '/tmp/demo.txt',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.revealFinderPath).toHaveBeenCalledWith('/tmp/demo.txt');
  });

  it('opens a path through Finder', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'open_path',
        path: '/tmp/demo-folder',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.openFinderPath).toHaveBeenCalledWith('/tmp/demo-folder');
  });
});
