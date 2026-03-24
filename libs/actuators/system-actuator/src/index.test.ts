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
    listChromeTabs: vi.fn(() => [
      { index: 1, title: 'Inbox', url: 'https://mail.example' },
      { index: 2, title: 'Docs', url: 'https://docs.example' },
    ]),
    activateChromeTabByTitle: vi.fn((title: string) => ({ matched: title === 'Docs' })),
    emptyFinderTrash: vi.fn(),
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn(() => []),
}));

vi.mock('@agent/shared-vision', () => ({
  consultVision: vi.fn(async () => ({ decision: 'ok' })),
}));

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
  });

  it('supports explicit activate_application actions', async () => {
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

  it('executes empty_trash through the Finder adapter', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'empty_trash',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.emptyFinderTrash).toHaveBeenCalled();
  });
});
