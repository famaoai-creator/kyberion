import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  safeReadFile: vi.fn(() => '{}'),
  safeWriteFile: vi.fn(),
  safeMkdir: vi.fn(),
  safeExistsSync: vi.fn(() => false),
  derivePipelineStatus: vi.fn((results: Array<{ status: string }>) => results.every((r) => r.status === 'success') ? 'succeeded' : 'failed'),
  safeExec: vi.fn(() => ''),
  createStandardYargs: vi.fn(),
}));

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
    vi.mocked(core.safeExec)
      .mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue')
      .mockReturnValueOnce('');

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
    vi.mocked(core.safeExec)
      .mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue')
      .mockReturnValueOnce('');

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
});
