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
const pressKeyCode = vi.fn((keyCode: number) =>
  safeExec('osascript', ['-e', `tell application "System Events" to key code ${keyCode}`])
);
const toggleDictation = vi.fn((keyCode = 176) => pressKeyCode(keyCode));
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
const activateWindowByTitle = vi.fn((_app: string, _windowTitle: string, _matchPolicy?: string) => true);
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
const createVirtualMediaDeviceControlBridge = vi.fn(() => ({
  bridge_id: 'virtual-media-device-control-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-media-device-control-bridge',
    platform: 'darwin',
    available: true,
    selection: {
      inventory: {
        audio_inputs: [
          { kind: 'audio-input', name: 'Built-in Microphone', platform: 'darwin', source: 'system_profiler', available: true },
        ],
        audio_outputs: [
          { kind: 'audio-output', name: 'Built-in Output', platform: 'darwin', source: 'system_profiler', available: true },
        ],
        cameras: [
          { kind: 'camera', name: 'FaceTime HD Camera', platform: 'darwin', source: 'system_profiler', available: true },
        ],
        virtual_audio_devices: [],
        virtual_cameras: [],
        notes: [],
      },
      audio: {
        bridge_id: 'virtual-audio-device-bridge',
        devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
        selected_devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
        available: true,
      },
      camera: {
        bridge_id: 'virtual-camera-bridge',
        backend: 'stub',
        available: true,
        selected_camera: 'FaceTime HD Camera',
      },
    },
    supported_actions: [
      { action: 'select', scope: 'audio', runtime_supported: true, host_setup_required: false },
      { action: 'select', scope: 'camera', runtime_supported: true, host_setup_required: false },
      { action: 'select', scope: 'all', runtime_supported: true, host_setup_required: false },
      { action: 'add', scope: 'audio', runtime_supported: false, host_setup_required: true },
      { action: 'add', scope: 'camera', runtime_supported: false, host_setup_required: true },
      { action: 'add', scope: 'all', runtime_supported: false, host_setup_required: true },
      { action: 'remove', scope: 'audio', runtime_supported: false, host_setup_required: true },
      { action: 'remove', scope: 'camera', runtime_supported: false, host_setup_required: true },
      { action: 'remove', scope: 'all', runtime_supported: false, host_setup_required: true },
    ],
  })),
  control: vi.fn(async (request: { action: string; scope?: string }) => ({
    bridge_id: 'virtual-media-device-control-bridge',
    platform: 'darwin',
    action: request.action,
    scope: request.scope || 'all',
    status: request.action === 'select' ? 'succeeded' : 'blocked',
    selection: {
      inventory: {
        audio_inputs: [],
        audio_outputs: [],
        cameras: [],
        virtual_audio_devices: [],
        virtual_cameras: [],
        notes: [],
      },
      audio: {
        bridge_id: 'virtual-audio-device-bridge',
        devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
        selected_devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
        available: true,
      },
      camera: {
        bridge_id: 'virtual-camera-bridge',
        backend: 'stub',
        available: true,
        selected_camera: 'FaceTime HD Camera',
      },
    },
    host_plan: request.action === 'select' ? undefined : { notes: ['host setup required'] },
  })),
}));
const createVirtualDeviceInventoryBridge = vi.fn(() => ({
  bridge_id: 'virtual-device-inventory-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-device-inventory-bridge',
    platform: 'darwin',
    available: true,
    inventory: {
      audio_inputs: [
        { kind: 'audio-input', name: 'Built-in Microphone', platform: 'darwin', source: 'system_profiler', available: true },
      ],
      audio_outputs: [
        { kind: 'audio-output', name: 'Built-in Output', platform: 'darwin', source: 'system_profiler', available: true },
      ],
      cameras: [
        { kind: 'camera', name: 'FaceTime HD Camera', platform: 'darwin', source: 'system_profiler', available: true },
      ],
      virtual_audio_devices: [],
      virtual_cameras: [],
      notes: [],
    },
  })),
}));
const createVirtualAudioDeviceBridge = vi.fn(() => ({
  bridge_id: 'virtual-audio-device-bridge',
  probe: vi.fn(async () => ({
    bus_id: 'stub',
    available: true,
    devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
    bridge_id: 'virtual-audio-device-bridge',
    platform: 'darwin',
    selected_devices: { input: 'Built-in Microphone', output: 'Built-in Output' },
  })),
}));
const createVirtualCameraBridge = vi.fn(() => ({
  bridge_id: 'virtual-camera-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-camera-bridge',
    platform: 'darwin',
    backend: 'stub',
    available: true,
    selected_camera: 'FaceTime HD Camera',
    inventory: {
      audio_inputs: [],
      audio_outputs: [],
      cameras: [
        { kind: 'camera', name: 'FaceTime HD Camera', platform: 'darwin', source: 'system_profiler', available: true },
      ],
      virtual_audio_devices: [],
      virtual_cameras: [],
      notes: [],
    },
  })),
  pipeTo: vi.fn(async (bus: any, input?: any) => {
    await bus.writeFrames((async function* () {
      const frameCount = Math.max(1, Number(input?.max_frames || 2));
      for (let index = 0; index < frameCount; index += 1) {
        yield {
          format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
          payload: new Uint8Array([index + 1, index + 2, index + 3]),
          ts_ms: index * 33,
        };
      }
    })());
  }),
}));
const createVirtualCameraInjectionBridge = vi.fn(() => ({
  bridge_id: 'virtual-camera-injection-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-camera-injection-bridge',
    platform: 'darwin',
    backend: 'stub',
    available: true,
    selected_camera: 'FaceTime HD Camera',
    host_plan: {
      notes: ['replay-only backend active'],
      camera: ['Install or enable a virtual camera sink'],
    },
  })),
  injectFromMp4: vi.fn(async (inputPath: string) => ({
    bridge_id: 'virtual-camera-injection-bridge',
    platform: 'darwin',
    backend: 'stub',
    mode: 'replay',
    status: 'succeeded',
    source_path: inputPath,
    output_path: inputPath,
    selected_camera: 'FaceTime HD Camera',
    injected_frame_count: 2,
  })),
  injectFrames: vi.fn(async () => ({
    bridge_id: 'virtual-camera-injection-bridge',
    platform: 'darwin',
    backend: 'stub',
    mode: 'replay',
    status: 'succeeded',
  })),
  injectBus: vi.fn(async () => ({
    bridge_id: 'virtual-camera-injection-bridge',
    platform: 'darwin',
    backend: 'stub',
    mode: 'replay',
    status: 'succeeded',
  })),
}));
const createScreenCaptureBridge = vi.fn(() => ({
  bridge_id: 'screen-capture-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'screen-capture-bridge',
    platform: 'darwin',
    backend: 'stub',
    available: true,
  })),
  captureScreenshot: vi.fn(async (input?: any) => ({
    bridge_id: 'screen-capture-bridge',
    platform: 'darwin',
    backend: 'stub',
    save_path: input?.save_path || '/tmp/screen.png',
    display_index: input?.display_index,
    capture_mode: input?.capture_mode || 'screen',
    subject_hint: input?.subject_hint,
  })),
  pipeTo: vi.fn(async (bus: any, input?: any) => {
    await bus.writeFrames((async function* () {
      const frameCount = Math.max(1, Number(input?.max_frames || 2));
      for (let index = 0; index < frameCount; index += 1) {
        yield {
          format: { mime_type: 'image/png' as const, width: 1920, height: 1080 },
          payload: new Uint8Array([index + 10, index + 11, index + 12]),
          ts_ms: index * 250,
        };
      }
    })());
  }),
}));
const createScreenRecordingBridge = vi.fn(() => ({
  bridge_id: 'screen-recording-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'screen-recording-bridge',
    available: true,
    platform: 'darwin',
    capture_bridge: {
      bridge_id: 'screen-capture-bridge',
      platform: 'darwin',
      backend: 'stub',
      available: true,
    },
  })),
  recordToMp4: vi.fn(async (outputPath: string, input?: any) => ({
    output_path: outputPath,
    frame_count: Math.max(1, Number(input?.max_frames || 2)),
    fps: input?.fps ?? 30,
    format: { mime_type: 'image/png' as const, width: 1920, height: 1080 },
  })),
}));
const createScreenDisplayInventoryBridge = vi.fn(() => ({
  bridge_id: 'screen-display-inventory-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'screen-display-inventory-bridge',
    platform: 'darwin',
    available: true,
    inventory: {
      displays: [
        {
          index: 0,
          name: 'Built-in Retina Display',
          platform: 'darwin',
          source: 'system_profiler',
          available: true,
          primary: true,
          width: 3456,
          height: 2234,
        },
        {
          index: 1,
          name: 'DELL U2720Q',
          platform: 'darwin',
          source: 'system_profiler',
          available: true,
          primary: false,
          width: 3840,
          height: 2160,
        },
      ],
      notes: [],
    },
  })),
}));
const listToolRuntimeInventory = vi.fn(() => ({
  version: '1.0.0',
  platform: 'darwin',
  requested_mode: 'trial',
  default_tool_id: 'mflux',
  items: [
    {
      tool: {
        tool_id: 'mflux',
        display_name: 'mflux Local FLUX Image Generator',
        ecosystem: 'python',
      },
      state: null,
      requested_mode: 'trial',
      lifecycle_stage: 'trial',
      selected_action: 'run_trial',
      selected_backend: { kind: 'uvx', command: 'uvx', args: ['--from', 'mflux', 'mflux-generate'] },
      trial_backend: { kind: 'uvx', command: 'uvx', args: ['--from', 'mflux', 'mflux-generate'] },
      install_backend: { kind: 'uv', command: 'uv', args: ['tool', 'install', 'mflux'] },
      installed_backend: { kind: 'uv', command: 'uv', args: ['tool', 'run', 'mflux-generate'] },
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/kyberion/active/shared/runtime/tool-runtimes/mflux',
      state_path: '/tmp/kyberion/active/shared/runtime/tool-runtimes/mflux/state.json',
      available_commands: ['uvx', 'uv'],
      reason: 'using trial backend for mflux',
    },
  ],
}));
const listServiceRuntimeInventory = vi.fn(() => ({
  version: '1.0.0',
  platform: 'darwin',
  requested_mode: 'trial',
  default_service_id: 'comfyui',
  items: [
    {
      service: {
        service_id: 'comfyui',
        display_name: 'ComfyUI Local Service Runtime',
        kind: 'local_service',
      },
      state: null,
      requested_mode: 'trial',
      lifecycle_stage: 'trial',
      selected_action: 'probe',
      selected_probe: { kind: 'http', method: 'GET', path: 'system_stats' },
      selected_plan: { kind: 'service_preset', preset_path: 'knowledge/product/orchestration/service-presets/comfyui.json' },
      available: true,
      installed: true,
      requires_install: false,
      managed_service_path: '/tmp/kyberion/active/shared/runtime/service-runtimes/comfyui',
      state_path: '/tmp/kyberion/active/shared/runtime/service-runtimes/comfyui/state.json',
      base_url: 'http://127.0.0.1:8188',
      probe_url: 'http://127.0.0.1:8188/system_stats',
      reason: 'probe_succeeded',
    },
  ],
}));
const writeVideoFrameBusToMp4 = vi.fn(async (bus: any, outputPath: string) => {
  const frames: any[] = [];
  for await (const frame of bus.frameStream()) {
    frames.push(frame);
  }
  return {
    output_path: outputPath,
    frame_count: frames.length,
    fps: 30,
    format: { mime_type: 'image/jpeg', width: 640, height: 480 },
  };
});
const pipeMp4ToVideoFrameBus = vi.fn(async (_inputPath: string, bus: any) => {
  await bus.writeFrames((async function* () {
    yield {
      format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
      payload: new Uint8Array([9, 8, 7]),
      ts_ms: 0,
    };
    yield {
      format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
      payload: new Uint8Array([6, 5, 4]),
      ts_ms: 33,
    };
  })());
});
const StubVideoFrameBus = vi.fn(function StubVideoFrameBus(this: any) {
  const queue: Array<any> = [];
  let closed = false;
  let resolver: ((frame: any | null) => void) | null = null;
  this.bus_id = 'stub';
  this.probe = vi.fn(async () => ({ bus_id: 'stub', available: true, buffered_frames: queue.length }));
  this.frameStream = vi.fn(async function* () {
    while (!closed || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (closed) return;
      const frame = await new Promise<any | null>((resolve) => {
        resolver = resolve;
      });
      if (frame === null) return;
      yield frame;
    }
  });
  this.writeFrames = vi.fn(async (stream: AsyncIterable<any>) => {
    for await (const frame of stream) {
      if (resolver) {
        const resolve = resolver;
        resolver = null;
        resolve(frame);
      } else {
        queue.push(frame);
      }
    }
  });
  this.close = vi.fn(async () => {
    closed = true;
    if (resolver) {
      const resolve = resolver;
      resolver = null;
      resolve(null);
    }
  });
});
const createVirtualAudioOutputPlaybackBridge = vi.fn(() => ({
  bridge_id: 'virtual-audio-output-playback-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-audio-output-playback-bridge',
    platform: 'darwin',
    available: true,
    outputs: ['Built-in Output', 'HDMI'],
  })),
  playOnOutputs: vi.fn(async (targets?: string[]) => ({
    bridge_id: 'virtual-audio-output-playback-bridge',
    platform: 'darwin',
    outputs: (targets && targets.length > 0 ? targets : ['Built-in Output', 'HDMI']).map((device_name) => ({
      device_name,
      status: 'played',
      tone_path: '/tmp/kyberion-tone.wav',
      selected_backend: 'swift-output-switch' as const,
    })),
  })),
}));
const createVirtualAudioInputRecordingBridge = vi.fn(() => ({
  bridge_id: 'virtual-audio-input-recording-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-audio-input-recording-bridge',
    platform: 'darwin',
    available: true,
    inputs: ['Built-in Microphone', 'External Mic'],
  })),
  recordOnInputs: vi.fn(async (targets?: string[]) => ({
    bridge_id: 'virtual-audio-input-recording-bridge',
    platform: 'darwin',
    recordings: (targets && targets.length > 0 ? targets : ['Built-in Microphone', 'External Mic']).map((device_name) => ({
      device_name,
      status: 'recorded',
      recorded_path: `/tmp/${device_name.replace(/\s+/g, '_').toLowerCase()}.wav`,
      selected_backend: 'ffmpeg-avfoundation' as const,
    })),
  })),
}));
const createVirtualInputDeviceInventoryBridge = vi.fn(() => ({
  bridge_id: 'virtual-input-device-inventory-bridge',
  probe: vi.fn(async () => ({
    bridge_id: 'virtual-input-device-inventory-bridge',
    platform: 'darwin',
    available: true,
    inventory: {
      keyboards: [
        {
          kind: 'keyboard',
          name: 'MINILA-R Convertible',
          platform: 'darwin',
          source: 'hidutil',
          available: true,
        },
      ],
      mice: [
        {
          kind: 'mouse',
          name: 'ERGO M575SP',
          platform: 'darwin',
          source: 'hidutil',
          available: true,
        },
      ],
      pointing_devices: [],
      virtual_input_devices: [],
      notes: [],
    },
  })),
}));
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
  pressKeyCode,
  toggleDictation,
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
  createVirtualMediaDeviceControlBridge,
  createVirtualAudioOutputPlaybackBridge,
  createVirtualAudioInputRecordingBridge,
  createVirtualDeviceInventoryBridge,
  createVirtualAudioDeviceBridge,
  createVirtualCameraBridge,
  createVirtualCameraInjectionBridge,
  createScreenCaptureBridge,
  createScreenRecordingBridge,
  createScreenDisplayInventoryBridge,
  listToolRuntimeInventory,
  listServiceRuntimeInventory,
  writeVideoFrameBusToMp4,
  pipeMp4ToVideoFrameBus,
  StubVideoFrameBus,
  createVirtualInputDeviceInventoryBridge,
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
  pressKeyCode,
  toggleDictation,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  runAppleScript,
  getScreenSize,
  getWindowList,
  activateWindowByTitle,
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

  it('maps voice input toggle into the system pipeline', async () => {
    mockDarwinPlatform();
    const { handleAction } = await import('./index');
    const core = await import('@agent/core');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'voice_input_toggle',
        dictation_keycode: 176,
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "System Events" to key code 176']);
    restorePlatform();
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
    expect(result.context.screenshot_display_index).toBe(0);
    expect(result.context.screenshot_display_name).toBe('Built-in Retina Display');
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

    it('screenshot: defaults to primary display when display_index is omitted', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'screenshot', params: { export_as: 'shot' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      const screenFactory = vi.mocked(createScreenCaptureBridge).mock.results.at(-1)?.value;
      expect(screenFactory?.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ display_index: 0 }));
      expect(createScreenDisplayInventoryBridge).toHaveBeenCalled();
    });

    it('screenshot: resolves display_name to a display index', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'screenshot', params: { export_as: 'shot', display_name: 'DELL U2720Q' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      const screenFactory = vi.mocked(createScreenCaptureBridge).mock.results.at(-1)?.value;
      expect(screenFactory?.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ display_index: 1 }));
      expect(createScreenDisplayInventoryBridge).toHaveBeenCalled();
    });

    it('screenshot: activates application and captures the focused window', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'screenshot', params: { export_as: 'shot', application: 'Finder' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(activateApplication).toHaveBeenCalledWith('Finder');
      const screenFactory = vi.mocked(createScreenCaptureBridge).mock.results.at(-1)?.value;
      expect(screenFactory?.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ capture_mode: 'focused_window' }));
      expect(result.context.screenshot_application).toBe('Finder');
    });

    it('screenshot: selects a named application window when window_title is provided', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{
          type: 'capture',
          op: 'screenshot',
          params: { export_as: 'shot', application: 'Finder', window_title: 'Downloads', window_match_policy: 'contains' },
        }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(activateApplication).toHaveBeenCalledWith('Finder');
      expect(activateWindowByTitle).toHaveBeenCalledWith('Finder', 'Downloads', 'contains');
      expect(result.context.screenshot_window_selection_source).toBe('window_title');
      expect(result.context.screenshot_window_title).toBe('Downloads');
      expect(result.context.screenshot_window_candidates).toContain('Window 1');
    });

    it('screen_stream: captures repeated screen frames via bridge', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'test_screen_stream', params: { export_as: 'screen_stream_test', max_frames: 2 } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.context.screen_stream_test.frame_count).toBe(2);
      expect(result.context.screen_stream_test.selected_display_index).toBe(0);
      expect(result.context.screen_stream_test.display_selection_source).toBe('primary');
    });

    it('screen_stream: resolves display_name to a display index', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'test_screen_stream', params: { export_as: 'screen_stream_test', max_frames: 2, display_name: 'DELL U2720Q' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.context.screen_stream_test.selected_display_index).toBe(1);
      expect(result.context.screen_stream_test.selected_display_name).toBe('DELL U2720Q');
      expect(result.context.screen_stream_test.display_selection_source).toBe('display_name');
    });

    it('screen_mp4_roundtrip: records and reimports screen frames', async () => {
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');
      vi.mocked(core.safeExistsSync).mockReturnValue(true);

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'test_screen_mp4_roundtrip', params: { export_as: 'screen_roundtrip', max_frames: 2 } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.context.screen_roundtrip.imported_frame_count).toBe(2);
      expect(result.context.screen_roundtrip.output_path).toContain('screen-roundtrip');
      expect(result.context.screen_roundtrip.selected_display_index).toBe(0);
      expect(result.context.screen_roundtrip.display_selection_source).toBe('primary');
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

    it('list_input_devices: returns input inventory', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'list_input_devices', params: { export_as: 'inputs' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.inputs as any).keyboards.map((d: any) => d.name)).toContain('MINILA-R Convertible');
      expect((result.context.inputs as any).mice.map((d: any) => d.name)).toContain('ERGO M575SP');
      expect(createVirtualInputDeviceInventoryBridge).toHaveBeenCalled();
    });

    it('list_displays: returns display inventory', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'list_displays', params: { export_as: 'displays' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.displays as any).inventory.displays.map((d: any) => d.name)).toContain('DELL U2720Q');
      expect((result.context.displays as any).primary_display.name).toBe('Built-in Retina Display');
      expect((result.context.displays as any).display_count).toBe(2);
      expect(createScreenDisplayInventoryBridge).toHaveBeenCalled();
    });

    it('list_media_devices: returns selected audio and camera bridges', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'list_media_devices', params: { export_as: 'media' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.media as any).audio.selected_devices.input).toBe('Built-in Microphone');
      expect((result.context.media as any).audio.selected_devices.output).toBe('Built-in Output');
      expect((result.context.media as any).camera.selected_camera).toBe('FaceTime HD Camera');
      expect((result.context.media as any).supported_actions).toBeTruthy();
      expect(createVirtualMediaDeviceControlBridge).toHaveBeenCalled();
    });

    it('list_tool_runtimes: returns governed runtime inventory', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'list_tool_runtimes', params: { export_as: 'tool_runtimes' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.tool_runtimes as any).default_tool_id).toBe('mflux');
      expect((result.context.tool_runtimes as any).tools.map((tool: any) => tool.tool_id)).toContain('mflux');
      expect((result.context.tool_runtimes as any).tools[0].lifecycle_stage).toBe('trial');
      expect(listToolRuntimeInventory).toHaveBeenCalledWith('trial');
    });

    it('list_service_runtimes: returns governed service runtime inventory', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'list_service_runtimes', params: { export_as: 'service_runtimes' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.service_runtimes as any).default_service_id).toBe('comfyui');
      expect((result.context.service_runtimes as any).services.map((service: any) => service.service_id)).toContain('comfyui');
      expect((result.context.service_runtimes as any).services[0].lifecycle_stage).toBe('trial');
      expect(listServiceRuntimeInventory).toHaveBeenCalledWith('trial');
    });

    it('control_media_devices: returns host provisioning plan for add/remove', async () => {
      const { handleAction } = await import('./index');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'control_media_devices', params: { action: 'add', scope: 'audio', export_as: 'control' } }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect((result.context.control as any).status).toBe('blocked');
      expect((result.context.control as any).host_plan.notes).toContain('host setup required');
    expect(createVirtualMediaDeviceControlBridge).toHaveBeenCalled();
  });

  it('test_audio_outputs: returns per-output playback results', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'test_audio_outputs', params: { export_as: 'audio_test' } }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.audio_test as any).outputs.map((entry: any) => entry.device_name)).toContain('Built-in Output');
    expect(createVirtualAudioOutputPlaybackBridge).toHaveBeenCalled();
  });

  it('test_audio_inputs: returns per-input recording results', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'test_audio_inputs', params: { export_as: 'audio_input_test' } }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.audio_input_test as any).recordings.map((entry: any) => entry.device_name)).toContain('Built-in Microphone');
    expect(createVirtualAudioInputRecordingBridge).toHaveBeenCalled();
  });

  it('test_camera_stream: returns camera frames through a video bus', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'test_camera_stream', params: { export_as: 'camera_stream_test', frame_count: 2, frame_interval_ms: 0 } }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.camera_stream_test as any).bridge_id).toBe('virtual-camera-bridge');
    expect((result.context.camera_stream_test as any).backend).toBe('stub');
    expect((result.context.camera_stream_test as any).selected_camera).toBe('FaceTime HD Camera');
    expect((result.context.camera_stream_test as any).frame_count).toBe(2);
    expect((result.context.camera_stream_test as any).frames).toHaveLength(2);
    expect(createVirtualCameraBridge).toHaveBeenCalled();
    expect(StubVideoFrameBus).toHaveBeenCalled();
  });

  it('test_camera_mp4_roundtrip: exports and re-imports camera frames through mp4', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'test_camera_mp4_roundtrip', params: { export_as: 'camera_mp4_roundtrip', frame_count: 2, frame_interval_ms: 0 } }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.camera_mp4_roundtrip as any).bridge_id).toBe('virtual-camera-bridge');
    expect((result.context.camera_mp4_roundtrip as any).exported_frame_count).toBe(2);
    expect((result.context.camera_mp4_roundtrip as any).imported_frame_count).toBe(2);
    expect((result.context.camera_mp4_roundtrip as any).exported_mp4_path).toContain('.mp4');
    expect(writeVideoFrameBusToMp4).toHaveBeenCalled();
    expect(pipeMp4ToVideoFrameBus).toHaveBeenCalled();
  });

  it('test_camera_injection: injects an mp4 through the camera injection bridge', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'test_camera_injection', params: { export_as: 'camera_injection_test', input_mp4_path: 'active/shared/tmp/in.mp4' } }],
    } as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.camera_injection_test as any).bridge_id).toBe('virtual-camera-injection-bridge');
    expect((result.context.camera_injection_test as any).status).toBe('succeeded');
    expect((result.context.camera_injection_test as any).mode).toBe('replay');
    expect((result.context.camera_injection_test as any).source_path).toContain('active/shared/tmp/in.mp4');
    expect(createVirtualCameraInjectionBridge).toHaveBeenCalled();
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

    it('voice_input_toggle: sends the macOS dictation key code', async () => {
      mockDarwinPlatform();
      const { handleAction } = await import('./index');
      const core = await import('@agent/core');

      const result = await handleAction({
        action: 'pipeline',
        steps: [{
          type: 'apply',
          op: 'voice_input_toggle',
          params: { dictation_keycode: 176 },
        }],
      } as any);

      expect(result.status).toBe('succeeded');
      expect(core.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "System Events" to key code 176']);
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
