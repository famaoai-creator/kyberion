import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeExec = vi.fn(() => '');
const safeReadFile = vi.fn(() => '{}');
const safeWriteFile = vi.fn();
const safeMkdir = vi.fn();
const safeExistsSync = vi.fn(() => false);
const derivePipelineStatus = vi.fn((results: Array<{ status: string }>) =>
  results.every((r) => r.status === 'success') ? 'succeeded' : 'failed'
);
const resolveVars = vi.fn((value: any, ctx: Record<string, any>) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return trimmed in ctx ? String(ctx[trimmed]) : '';
  });
});
const evaluateCondition = vi.fn(() => false);
const getPathValue = vi.fn((data: any, path: string) =>
  path.split('.').reduce((acc, key) => acc?.[key], data)
);
const resolveWriteArtifactSpec = vi.fn((params: any, ctx: any, resolve: (value: any) => any) => ({
  path: String(resolve(params.path || params.output_path || 'active/shared/tmp/output.txt')),
  content: params.content ?? params.data ?? resolve(params.from ? `{{${params.from}}}` : ''),
}));
const activateApplication = vi.fn((application: string) =>
  safeExec('osascript', ['-e', `tell application "${application}" to activate`])
);
const detectFocusedInput = vi.fn(() => {
  const output = String(safeExec('osascript', ['-e', '__detect_focused_input__'])).trimEnd();
  const [application = '', windowTitle = '', role = '', description = '', editableFlag = 'false'] =
    output.split('\n');
  return {
    application,
    windowTitle,
    role,
    description,
    editable: editableFlag.trim().toLowerCase() === 'true',
  };
});
const keystrokeText = vi.fn((text: string) =>
  safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${text}"`])
);
const pasteText = vi.fn((text: string) =>
  safeExec('osascript', [
    '-e',
    `set the clipboard to "${text}"\ntell application "System Events" to keystroke "v" using command down`,
  ])
);
const pressKey = vi.fn((key: string) => {
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey === 'enter' || normalizedKey === 'return') {
    return safeExec('osascript', ['-e', 'tell application "System Events" to key code 36']);
  }
  return safeExec('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${normalizedKey}"`,
  ]);
});
const clickAt = vi.fn((x: number, y: number, clickCount = 1) => {
  for (let index = 0; index < clickCount; index += 1) {
    safeExec('osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`]);
  }
});
const rightClickAt = vi.fn((x: number, y: number, clickCount = 1) => {
  for (let index = 0; index < clickCount; index += 1) {
    safeExec('osascript', [
      '-e',
      `tell application "System Events" to do shell script "/usr/bin/env cliclick rc:${x},${y}"`,
    ]);
  }
});
const moveMouse = vi.fn((x: number, y: number) =>
  safeExec('osascript', [
    '-e',
    `tell application "System Events" to do shell script "/usr/bin/env cliclick m:${x},${y}"`,
  ])
);
const scrollAt = vi.fn();
const dragFrom = vi.fn();
const runAppleScript = vi.fn((_script: string) => 'applescript-result');
const getScreenSize = vi.fn(() => ({ width: 1920, height: 1080 }));
const getWindowList = vi.fn((_app: string) => ['Window 1', 'Window 2']);
const quitApplication = vi.fn();
const systemNotify = vi.fn();
const clipboardRead = vi.fn(() => 'clipboard text');
const clipboardWrite = vi.fn();
const takeScreenshot = vi.fn((p: string) => p);
const listKnownAppCapabilities = vi.fn(() => [
  {
    application: 'Google Chrome',
    adapter: 'browser_tabs',
    capabilities: ['list_tabs', 'activate_tab_by_title'],
  },
  { application: 'Finder', adapter: 'file_manager', capabilities: ['empty_trash'] },
]);
const listTerminalTargets = vi.fn(() => [
  {
    application: 'Terminal',
    supported: true,
    preferred: false,
    adapter: 'terminal',
    canInject: true,
    sessionCount: 0,
    sessions: [],
    idleSession: null,
  },
  {
    application: 'iTerm2',
    supported: true,
    preferred: true,
    adapter: 'iterm2',
    canInject: true,
    sessionCount: 1,
    sessions: [{ winId: '1', sessionId: 'abc', type: 'iTerm2' }],
    idleSession: { winId: '1', sessionId: 'abc', type: 'iTerm2' },
  },
]);
const listChromeTabs = vi.fn(() => [
  { index: 1, title: 'Inbox', url: 'https://mail.example' },
  { index: 2, title: 'Docs', url: 'https://docs.example' },
]);
const activateChromeTabByTitle = vi.fn((title: string) => ({ matched: title === 'Docs' }));
const activateChromeTabByUrl = vi.fn((url: string) => ({ matched: url === 'docs.example' }));
const closeChromeTabByTitle = vi.fn((title: string) => ({ matched: title === 'Docs' }));
const closeChromeTabByUrl = vi.fn((url: string) => ({ matched: url === 'docs.example' }));
const emptyFinderTrash = vi.fn();
const revealFinderPath = vi.fn();
const openFinderPath = vi.fn();
const emitComputerSurfacePatch = vi.fn();
const createApprovalRequest = vi.fn(() => ({ id: 'approval-123', status: 'pending' }));
const loadApprovalRequest = vi.fn(() => null);
const classifyError = vi.fn(() => ({ category: 'timeout' }));
const withRetry = vi.fn(async (fn: any) => fn());
const pathResolver = {
  rootDir: vi.fn(() => '/tmp/kyberion'),
  rootResolve: vi.fn((p: string) => `/tmp/kyberion/${String(p).replace(/^\/+/, '')}`),
  shared: vi.fn((p = '') => `/tmp/kyberion/active/shared/${String(p).replace(/^\/+/, '')}`),
  knowledge: vi.fn((p = '') => `/tmp/kyberion/knowledge/${String(p).replace(/^\/+/, '')}`),
  active: vi.fn((p = '') => `/tmp/kyberion/active/${String(p).replace(/^\/+/, '')}`),
  resolve: vi.fn((p = '') => `/tmp/kyberion/${String(p).replace(/^\/+/, '')}`),
};

vi.mock('@agent/core', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  derivePipelineStatus,
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
  safeExec,
  classifyError,
  withRetry,
  emitComputerSurfacePatch,
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  clickAt,
  rightClickAt,
  moveMouse,
  listKnownAppCapabilities,
  listTerminalTargets,
  listChromeTabs,
  activateChromeTabByTitle,
  activateChromeTabByUrl,
  closeChromeTabByTitle,
  closeChromeTabByUrl,
  emptyFinderTrash,
  revealFinderPath,
  openFinderPath,
  createApprovalRequest,
  loadApprovalRequest,
  pathResolver,
}));

vi.mock('@agent/core/os-automation', () => ({
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  runAppleScript,
  getScreenSize,
  getWindowList,
  quitApplication,
  systemNotify,
  clipboardRead,
  clipboardWrite,
  takeScreenshot,
  listKnownAppCapabilities,
  listTerminalTargets,
  listChromeTabs,
  activateChromeTabByTitle,
  activateChromeTabByUrl,
  closeChromeTabByTitle,
  closeChromeTabByUrl,
  emptyFinderTrash,
  revealFinderPath,
  openFinderPath,
}));

vi.mock('@agent/core/governance', () => ({
  createApprovalRequest,
  loadApprovalRequest,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  safeExec.mockImplementation(() => '');
  safeReadFile.mockImplementation(() => '{}');
  safeWriteFile.mockImplementation(() => {});
  safeMkdir.mockImplementation(() => {});
  safeExistsSync.mockImplementation(() => false);
  derivePipelineStatus.mockImplementation((results: Array<{ status: string }>) =>
    results.every((r) => r.status === 'success') ? 'succeeded' : 'failed'
  );
  resolveVars.mockImplementation((value: any, ctx: Record<string, any>) => {
    if (typeof value !== 'string') {
      return value;
    }
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key: string) => {
      const trimmed = key.trim();
      return trimmed in ctx ? String(ctx[trimmed]) : '';
    });
  });
  evaluateCondition.mockImplementation(() => false);
  getPathValue.mockImplementation((data: any, path: string) =>
    path.split('.').reduce((acc, key) => acc?.[key], data)
  );
  resolveWriteArtifactSpec.mockImplementation(
    (params: any, ctx: any, resolve: (value: any) => any) => ({
      path: String(resolve(params.path || params.output_path || 'active/shared/tmp/output.txt')),
      content: params.content ?? params.data ?? resolve(params.from ? `{{${params.from}}}` : ''),
    })
  );
  restorePlatform();
});

describe('system-actuator computer_interaction adapter', () => {
  it('detects the currently focused input element', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue'
    );

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
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue'
    );

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'remember_focused_target',
        focus_target_id: 'chat-main',
      },
    } as any);

    expect(result.context.focus_target_id).toBe('chat-main');
    expect(core.safeWriteFile).toHaveBeenCalledWith(
      '/tmp/kyberion/active/shared/runtime/computer/focused-targets.json',
      expect.stringContaining('"chat-main"')
    );
  });

  it('fails typing when focused element is not editable', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\nfalse'
    );

    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: {
          type: 'type_into_focused_input',
          text: 'hello',
        },
      } as any)
    ).rejects.toThrow('Focused element is not editable');
  });

  it('persists pipeline context to rootDir-based context_path', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeReadFile).mockReturnValueOnce('{"a":1}');

    const result = await handleAction({
      action: 'pipeline',
      context: {
        context_path: 'active/shared/tmp/system-context.json',
      },
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: 'active/shared/tmp/input.json',
            export_as: 'parsed',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.parsed.a).toBe(1);
    expect(core.safeWriteFile).toHaveBeenCalledWith(
      '/tmp/kyberion/active/shared/tmp/system-context.json',
      expect.stringContaining('"parsed"')
    );
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

    expect(core.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Safari" to activate',
    ]);

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

    expect(core.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Finder" to activate',
    ]);

    restorePlatform();
  });

  it('submits the focused input with enter', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue'
    );

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'submit_focused_input',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to key code 36',
    ]);
  });

  it('uses paste strategy for focused input typing by default', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue'
    );

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
      expect.arrayContaining(['-e', expect.stringContaining('keystroke "v" using command down')])
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
      })
    );
    vi.mocked(core.safeExec).mockReturnValueOnce(
      'Codex\nDifferent Chat\nAXTextArea\nChat Input\ntrue'
    );

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
      } as any)
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
      })
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
      })
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
    expect(core.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Codex" to activate',
    ]);
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

  it('handles pipeline action with empty steps', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      steps: [],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(0);
  });

  it('handles max_steps limit in pipeline', async () => {
    const { handleAction } = await import('./index');
    const steps = Array.from({ length: 3 }, (_, i) => ({
      type: 'apply' as const,
      op: 'log',
      params: { message: `step ${i}` },
    }));

    await expect(
      handleAction({ action: 'pipeline', steps, options: { max_steps: 2 } } as any)
    ).rejects.toThrow('[SAFETY_LIMIT]');
  });

  it('handles right_click action', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'right_click',
        coordinate: { x: 100, y: 200 },
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('handles mouse_move action', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'mouse_move',
        coordinate: { x: 300, y: 400 },
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('handles key action', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'key',
        key: 'Enter',
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('handles double_click action', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'double_click',
        coordinate: { x: 100, y: 200 },
      },
    } as any);

    expect(result.status).toBe('succeeded');
  });

  it('handles screenshot via pipeline API', async () => {
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');
    vi.mocked(core.safeExistsSync).mockReturnValue(true);

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'screenshot', params: {} }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.screenshot_path).toBeDefined();
  });
});

describe('system-actuator new OS automation ops (pipeline mode)', () => {
  describe('capture ops', () => {
    it('screenshot: creates dir when missing and returns path', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValueOnce(false);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'screenshot', params: { export_as: 'shot' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(core.safeMkdir).toHaveBeenCalledWith(
        expect.stringContaining('screenshots'),
        { recursive: true },
      );
      expect(typeof result.context.shot).toBe('string');
    });

    it('screenshot: uses custom path param', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'screenshot', params: { path: 'active/shared/tmp/snap.png', export_as: 'snap' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(String(result.context.snap)).toContain('snap.png');
    });

    it('clipboard_read: returns clipboard content', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'clipboard_read', params: { export_as: 'clip' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.context.clip).toBe('clipboard text');
    });

    it('get_focused_input: returns focused UI element state', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'get_focused_input', params: { export_as: 'focus' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.focus as any).width).toBeUndefined();
      expect(result.context.focus).toBeDefined();
    });

    it('get_screen_size: returns width and height', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'get_screen_size', params: { export_as: 'sz' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.sz as any).width).toBe(1920);
      expect((result.context.sz as any).height).toBe(1080);
    });

    it('window_list: returns windows for the given application', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'window_list', params: { application: 'Finder', export_as: 'wins' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.wins as string[]).length).toBe(2);
      expect(getWindowList).toHaveBeenCalledWith('Finder');
    });

    it('window_list: throws when application param is missing', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'window_list', params: { export_as: 'wins' } }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/application/);
    });

    it('chrome_tab_list: returns tabs using default browser', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'chrome_tab_list', params: { export_as: 'tabs' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.tabs as any[]).length).toBe(2);
      expect(listChromeTabs).toHaveBeenCalledWith('Google Chrome');
    });

    it('chrome_tab_list: uses custom application param', async () => {
      const { handleAction } = await import('./index');

      await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'chrome_tab_list', params: { application: 'Brave Browser', export_as: 'tabs' } }],
      } as any);

      expect(listChromeTabs).toHaveBeenCalledWith('Brave Browser');
    });
  });

  describe('apply ops', () => {
    it('scroll: calls scrollAt with correct coordinates and direction', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'scroll', params: { x: 100, y: 200, direction: 'down', amount: 5 } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(scrollAt).toHaveBeenCalledWith(100, 200, 'down', 5);
    });

    it('drag: calls dragFrom with from and to coordinates', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'drag', params: { from_x: 10, from_y: 20, to_x: 300, to_y: 400 } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(dragFrom).toHaveBeenCalledWith(10, 20, 300, 400);
    });

    it('system_notify: calls systemNotify with title, message and subtitle', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'system_notify', params: { title: 'Hi', message: 'Done', subtitle: 'detail' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(systemNotify).toHaveBeenCalledWith('Hi', 'Done', 'detail');
    });

    it('system_notify: works without subtitle', async () => {
      const { handleAction } = await import('./index');

      await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'system_notify', params: { title: 'Hi', message: 'Done' } }],
      } as any);

      expect(systemNotify).toHaveBeenCalledWith('Hi', 'Done', undefined);
    });

    it('clipboard_write: calls clipboardWrite with text', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'clipboard_write', params: { text: 'hello world' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(clipboardWrite).toHaveBeenCalledWith('hello world');
    });

    it('app_quit: calls quitApplication with app name', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'app_quit', params: { application: 'Finder' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(quitApplication).toHaveBeenCalledWith('Finder');
    });

    it('app_quit: throws when application param is missing', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'app_quit', params: {} }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/application/);
    });

    it('open_file: opens file within repo root on darwin', async () => {
      mockDarwinPlatform();
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'open_file', params: { path: 'active/shared/tmp/report.html' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(core.safeExec).toHaveBeenCalledWith('open', [expect.stringContaining('report.html')], expect.any(Object));
      restorePlatform();
    });
  });

  describe('security guards', () => {
    it('run_applescript: throws when KYBERION_ALLOW_UNSAFE_SHELL is not set', async () => {
      const savedEnv = process.env.KYBERION_ALLOW_UNSAFE_SHELL;
      delete process.env.KYBERION_ALLOW_UNSAFE_SHELL;

      const { handleAction } = await import('./index');
      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'run_applescript', params: { script: 'return "hi"' } }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/SECURITY|disabled/i);

      process.env.KYBERION_ALLOW_UNSAFE_SHELL = savedEnv;
    });

    it('process_kill: throws when KYBERION_ALLOW_UNSAFE_SHELL is not set', async () => {
      const savedEnv = process.env.KYBERION_ALLOW_UNSAFE_SHELL;
      delete process.env.KYBERION_ALLOW_UNSAFE_SHELL;

      const { handleAction } = await import('./index');
      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'process_kill', params: { pid: 12345 } }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/SECURITY|disabled/i);

      process.env.KYBERION_ALLOW_UNSAFE_SHELL = savedEnv;
    });

    it('open_file: rejects path traversal outside repo root', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'open_file', params: { path: '../../etc/passwd' } }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/repo root/);
    });

    it('open_file: throws when path param is missing', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'open_file', params: {} }],
      } as any);

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toMatch(/path/);
    });
  });
});
