import { safeExecResult } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import { resolveFfmpegBin } from '../tool/tool-binary-resolvers.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export const VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID = 'virtual-device-inventory-bridge' as const;

export type VirtualDeviceKind =
  'audio-input' | 'audio-output' | 'camera' | 'virtual-audio' | 'virtual-camera';

export interface VirtualDeviceRecord {
  device_id?: string;
  provider_id?: string;
  kind: VirtualDeviceKind;
  name: string;
  platform: NodeJS.Platform;
  source: string;
  available: boolean;
  details?: Record<string, unknown>;
}

export interface VirtualDeviceInventory {
  audio_inputs: VirtualDeviceRecord[];
  audio_outputs: VirtualDeviceRecord[];
  cameras: VirtualDeviceRecord[];
  virtual_audio_devices: VirtualDeviceRecord[];
  virtual_cameras: VirtualDeviceRecord[];
  notes: string[];
}

export interface VirtualDeviceInventoryProbe {
  bridge_id: typeof VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  inventory: VirtualDeviceInventory;
}

export interface VirtualDeviceInventoryBridge {
  readonly bridge_id: typeof VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;
  probe(): Promise<VirtualDeviceInventoryProbe>;
  scan(): Promise<VirtualDeviceInventory>;
}

export interface VirtualDeviceInventoryOptions {
  system_profiler_bin?: string;
  ffmpeg_bin?: string;
  pactl_bin?: string;
  imagesnap_bin?: string;
  powershell_bin?: string;
  command_runner?: (
    command: string,
    args: string[]
  ) => {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
}

export interface VirtualDeviceInventoryProvider {
  readonly provider_id: string;
  readonly platforms: readonly NodeJS.Platform[];
  scan(
    options: VirtualDeviceInventoryOptions
  ): VirtualDeviceInventory | Promise<VirtualDeviceInventory>;
}

const inventoryProviderSeam = createSeam<VirtualDeviceInventoryProvider>({
  key: 'virtual-device-inventory',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/virtual/virtual-device-inventory-bridge.ts',
});

/** Supplemental device discovery; disposal removes only this registration. */
export function registerVirtualDeviceInventoryProvider(
  provider: VirtualDeviceInventoryProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'device-inventory-extension' }
): () => void {
  if (!provider.provider_id.trim()) throw new Error('Inventory provider_id is required');
  return inventoryProviderSeam.register(provider.provider_id, provider, metadata);
}

const DEFAULT_SYSTEM_PROFILER = 'system_profiler';
const DEFAULT_PACTL = 'pactl';
const DEFAULT_POWERSHELL = 'powershell.exe';

function emptyInventory(): VirtualDeviceInventory {
  return {
    audio_inputs: [],
    audio_outputs: [],
    cameras: [],
    virtual_audio_devices: [],
    virtual_cameras: [],
    notes: [],
  };
}

function uniqueByName(records: VirtualDeviceRecord[]): VirtualDeviceRecord[] {
  const seen = new Set<string>();
  return records
    .map((record) => ({
      ...record,
      provider_id: record.provider_id ?? record.source,
      device_id:
        record.device_id ??
        String(record.details?.uid ?? record.details?.instance_id ?? `name:${record.name}`),
    }))
    .filter((record) => {
      const key = `${record.kind}:${record.provider_id || record.source}:${record.device_id || record.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function tryParseJson(text: string): unknown | null {
  try {
    return parseSafeJsonInput(text, 'virtual device inventory response');
  } catch {
    return null;
  }
}

export function parseSystemProfilerItems(
  payload: unknown,
  sectionKey: string
): Array<Record<string, unknown>> {
  if (!isRecord(payload) || !Array.isArray(payload[sectionKey])) return [];
  return payload[sectionKey].filter(isRecord).flatMap((section) => {
    const items = section._items;
    return Array.isArray(items) ? items.filter(isRecord) : [];
  });
}

function runCommand(
  opts: VirtualDeviceInventoryOptions,
  command: string,
  args: string[]
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  if (opts.command_runner) return opts.command_runner(command, args);
  return safeExecResult(command, args, { maxOutputMB: 5 });
}

function collectMacAudioDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, ['SPAudioDataType', '-json']);
  const records: VirtualDeviceRecord[] = [];
  const payload = tryParseJson(result.stdout);
  for (const device of parseSystemProfilerItems(payload, 'SPAudioDataType')) {
    const name = String(device._name || device.coreaudio_device_name || '').trim();
    if (!name) continue;
    const hasInput = Boolean(
      device.coreaudio_default_audio_input_device || device.coreaudio_input_source
    );
    const hasOutput = Boolean(
      device.coreaudio_default_audio_output_device || device.coreaudio_output_source
    );
    const isVirtual = /blackhole|loopback|meeting_in|meeting_out|pulse/i.test(name);
    const base: VirtualDeviceRecord = {
      kind:
        hasInput && !hasOutput
          ? 'audio-input'
          : hasOutput && !hasInput
            ? 'audio-output'
            : 'audio-input',
      name,
      platform: process.platform,
      source: 'system_profiler',
      available: true,
      details: {
        model: device._model || device.coreaudio_device_transport || undefined,
      },
    };
    records.push(base);
    if (hasOutput) {
      records.push({ ...base, kind: 'audio-output' });
    }
    if (hasInput) {
      records.push({ ...base, kind: 'audio-input' });
    }
    if (isVirtual) {
      records.push({ ...base, kind: 'virtual-audio' });
    }
  }
  return uniqueByName(records);
}

function collectMacCameraDevices(
  opts: VirtualDeviceInventoryOptions,
  systemProfilerBin: string,
  ffmpegBin: string
): VirtualDeviceRecord[] {
  const records: VirtualDeviceRecord[] = [];
  const sp = runCommand(opts, systemProfilerBin, ['SPCameraDataType', '-json']);
  const payload = tryParseJson(sp.stdout);
  for (const device of parseSystemProfilerItems(payload, 'SPCameraDataType')) {
    const name = String(device._name || device.coremediaio_dal_device_name || '').trim();
    if (!name) continue;
    records.push({
      kind: 'camera',
      name,
      platform: process.platform,
      source: 'system_profiler',
      available: true,
      details: {
        model: device._model || undefined,
      },
    });
  }

  if (records.length === 0) {
    const result = runCommand(opts, ffmpegBin, [
      '-hide_banner',
      '-f',
      'avfoundation',
      '-list_devices',
      'true',
      '-i',
      '""',
    ]);
    const text = `${result.stdout}\n${result.stderr}`;
    const lines = text.split('\n');
    let section: 'audio' | 'video' | null = null;
    for (const line of lines) {
      if (/AVFoundation video devices/i.test(line)) {
        section = 'video';
        continue;
      }
      if (/AVFoundation audio devices/i.test(line)) {
        section = 'audio';
        continue;
      }
      const match = line.match(/\[\s*\d+\]\s*(.+?)\s*(?:\((video|audio)\))?\s*$/);
      if (!match) continue;
      const name = match[1].trim();
      if (!name) continue;
      if (section === 'video') {
        records.push({
          kind: 'camera',
          name,
          platform: process.platform,
          source: 'ffmpeg',
          available: true,
        });
      }
    }
  }

  const virtualSources = records.filter(
    (record) => record.kind === 'camera' && /loopback|virtual/i.test(record.name)
  );
  for (const virtualSource of virtualSources) {
    records.push({
      kind: 'virtual-camera',
      name: virtualSource.name,
      platform: process.platform,
      source: virtualSource.source,
      available: true,
      details: virtualSource.details,
    });
  }

  return uniqueByName(records);
}

function collectLinuxAudioDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, ['list', 'short', 'sources']);
  const sourcesText = result.stdout || result.stderr;
  const records: VirtualDeviceRecord[] = [];
  for (const line of sourcesText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[1];
    if (!name) continue;
    records.push({
      kind: /monitor|source/i.test(name) ? 'audio-input' : 'audio-input',
      name,
      platform: process.platform,
      source: 'pactl',
      available: true,
    });
    if (/monitor|null/i.test(name)) {
      records.push({
        kind: 'virtual-audio',
        name,
        platform: process.platform,
        source: 'pactl',
        available: true,
      });
    }
  }

  const sinks = runCommand(opts, bin, ['list', 'short', 'sinks']);
  const sinksText = sinks.stdout || sinks.stderr;
  for (const line of sinksText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[1];
    if (!name) continue;
    records.push({
      kind: 'audio-output',
      name,
      platform: process.platform,
      source: 'pactl',
      available: true,
    });
    if (/monitor|null/i.test(name)) {
      records.push({
        kind: 'virtual-audio',
        name,
        platform: process.platform,
        source: 'pactl',
        available: true,
      });
    }
  }
  return uniqueByName(records);
}

function collectLinuxCameraDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, [
    '-hide_banner',
    '-f',
    'v4l2',
    '-list_devices',
    'true',
    '-i',
    '""',
  ]);
  const text = `${result.stdout}\n${result.stderr}`;
  const records: VirtualDeviceRecord[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\[(?:video4linux2|v4l2|dshow|avfoundation).*?\]\s*(.+)$/i);
    const name = match?.[1]?.trim();
    if (!name) continue;
    records.push({
      kind: 'camera',
      name,
      platform: process.platform,
      source: 'ffmpeg',
      available: true,
    });
  }
  return uniqueByName(records);
}

function collectWindowsDevices(
  opts: VirtualDeviceInventoryOptions,
  powershellBin: string
): VirtualDeviceRecord[] {
  const script =
    "Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @('AudioEndpoint','Camera','Image') } | Select-Object Class,FriendlyName,Status,InstanceId | ConvertTo-Json -Compress";
  const result = runCommand(opts, powershellBin, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  let payload: unknown;
  try {
    payload = parseSafeJsonInput(result.stdout, 'virtual device inventory response');
  } catch {
    return [];
  }
  const rows = Array.isArray(payload)
    ? payload.filter(isRecord)
    : isRecord(payload)
      ? [payload]
      : [];
  const records: VirtualDeviceRecord[] = [];
  for (const row of rows) {
    const name = String(row.FriendlyName || '').trim();
    const deviceClass = String(row.Class || '').trim();
    if (!name) continue;
    const details = { status: row.Status, instance_id: row.InstanceId, class: deviceClass };
    const virtual = /virtual|loopback|cable|blackhole|vb-audio|voicemeeter/i.test(name);
    if (deviceClass === 'AudioEndpoint') {
      const capture = /capture|input|microphone|マイク/i.test(name);
      const kind: VirtualDeviceKind = capture ? 'audio-input' : 'audio-output';
      records.push({
        kind,
        name,
        platform: process.platform,
        source: 'powershell',
        available: row.Status === 'OK',
        details,
      });
      if (virtual)
        records.push({
          kind: 'virtual-audio',
          name,
          platform: process.platform,
          source: 'powershell',
          available: row.Status === 'OK',
          details,
        });
    } else if (/camera|image/i.test(deviceClass)) {
      records.push({
        kind: 'camera',
        name,
        platform: process.platform,
        source: 'powershell',
        available: row.Status === 'OK',
        details,
      });
      if (virtual)
        records.push({
          kind: 'virtual-camera',
          name,
          platform: process.platform,
          source: 'powershell',
          available: row.Status === 'OK',
          details,
        });
    }
  }
  return uniqueByName(records);
}

export class VirtualDeviceInventoryBridgeImpl implements VirtualDeviceInventoryBridge {
  readonly bridge_id = VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;

  constructor(private readonly opts: VirtualDeviceInventoryOptions = {}) {}

  async scan(): Promise<VirtualDeviceInventory> {
    const inventory = resolveVirtualDeviceAdapter(process.platform).scan(this.opts);
    for (const { implementation: provider } of inventoryProviderSeam.list()) {
      if (!provider.platforms.includes(process.platform)) continue;
      const scanned = await provider.scan(this.opts);
      const qualify = (records: VirtualDeviceRecord[]) =>
        records.map((record) => {
          if (!record.device_id)
            throw new Error(`Inventory provider '${provider.provider_id}' must supply device_id`);
          return { ...record, provider_id: provider.provider_id };
        });
      const additional = {
        ...scanned,
        audio_inputs: qualify(scanned.audio_inputs),
        audio_outputs: qualify(scanned.audio_outputs),
        cameras: qualify(scanned.cameras),
        virtual_audio_devices: qualify(scanned.virtual_audio_devices),
        virtual_cameras: qualify(scanned.virtual_cameras),
      };
      inventory.audio_inputs = uniqueByName([
        ...inventory.audio_inputs,
        ...additional.audio_inputs,
      ]);
      inventory.audio_outputs = uniqueByName([
        ...inventory.audio_outputs,
        ...additional.audio_outputs,
      ]);
      inventory.cameras = uniqueByName([...inventory.cameras, ...additional.cameras]);
      inventory.virtual_audio_devices = uniqueByName([
        ...inventory.virtual_audio_devices,
        ...additional.virtual_audio_devices,
      ]);
      inventory.virtual_cameras = uniqueByName([
        ...inventory.virtual_cameras,
        ...additional.virtual_cameras,
      ]);
      inventory.notes.push(...additional.notes);
    }

    if (
      inventory.audio_inputs.length === 0 &&
      inventory.audio_outputs.length === 0 &&
      inventory.cameras.length === 0
    ) {
      inventory.notes.push('no real devices discovered; bridge should fall back to stub');
    }

    return inventory;
  }

  async probe(): Promise<VirtualDeviceInventoryProbe> {
    const inventory = await this.scan();
    const available =
      inventory.audio_inputs.length > 0 ||
      inventory.audio_outputs.length > 0 ||
      inventory.cameras.length > 0 ||
      inventory.virtual_audio_devices.length > 0 ||
      inventory.virtual_cameras.length > 0;
    return {
      bridge_id: VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID,
      platform: process.platform,
      available,
      reason: available ? undefined : inventory.notes[0],
      inventory,
    };
  }
}

interface VirtualDevicePlatformAdapter {
  scan(options: VirtualDeviceInventoryOptions): VirtualDeviceInventory;
}

class DarwinVirtualDeviceAdapter implements VirtualDevicePlatformAdapter {
  scan(options: VirtualDeviceInventoryOptions): VirtualDeviceInventory {
    const inventory = emptyInventory();
    const audio = collectMacAudioDevices(
      options,
      options.system_profiler_bin ?? DEFAULT_SYSTEM_PROFILER
    );
    inventory.audio_inputs.push(...audio.filter((record) => record.kind === 'audio-input'));
    inventory.audio_outputs.push(...audio.filter((record) => record.kind === 'audio-output'));
    inventory.virtual_audio_devices.push(
      ...audio.filter((record) => record.kind === 'virtual-audio')
    );
    const cameras = collectMacCameraDevices(
      options,
      options.system_profiler_bin ?? DEFAULT_SYSTEM_PROFILER,
      options.ffmpeg_bin ?? resolveFfmpegBin()
    );
    inventory.cameras.push(...cameras.filter((record) => record.kind === 'camera'));
    inventory.virtual_cameras.push(...cameras.filter((record) => record.kind === 'virtual-camera'));
    return inventory;
  }
}

class LinuxVirtualDeviceAdapter implements VirtualDevicePlatformAdapter {
  scan(options: VirtualDeviceInventoryOptions): VirtualDeviceInventory {
    const inventory = emptyInventory();
    const audio = collectLinuxAudioDevices(options, options.pactl_bin ?? DEFAULT_PACTL);
    inventory.audio_inputs.push(...audio.filter((record) => record.kind === 'audio-input'));
    inventory.audio_outputs.push(...audio.filter((record) => record.kind === 'audio-output'));
    inventory.virtual_audio_devices.push(
      ...audio.filter((record) => record.kind === 'virtual-audio')
    );
    inventory.cameras.push(
      ...collectLinuxCameraDevices(options, options.ffmpeg_bin ?? resolveFfmpegBin())
    );
    return inventory;
  }
}

class WindowsVirtualDeviceAdapter implements VirtualDevicePlatformAdapter {
  scan(options: VirtualDeviceInventoryOptions): VirtualDeviceInventory {
    const inventory = emptyInventory();
    const devices = collectWindowsDevices(options, options.powershell_bin ?? DEFAULT_POWERSHELL);
    inventory.audio_inputs.push(...devices.filter((record) => record.kind === 'audio-input'));
    inventory.audio_outputs.push(...devices.filter((record) => record.kind === 'audio-output'));
    inventory.cameras.push(...devices.filter((record) => record.kind === 'camera'));
    inventory.virtual_audio_devices.push(
      ...devices.filter((record) => record.kind === 'virtual-audio')
    );
    inventory.virtual_cameras.push(...devices.filter((record) => record.kind === 'virtual-camera'));
    return inventory;
  }
}

class StubVirtualDeviceAdapter implements VirtualDevicePlatformAdapter {
  scan(): VirtualDeviceInventory {
    const inventory = emptyInventory();
    inventory.notes.push(`platform ${process.platform} has no built-in inventory probe; stub only`);
    return inventory;
  }
}

function resolveVirtualDeviceAdapter(platform: NodeJS.Platform): VirtualDevicePlatformAdapter {
  switch (platform) {
    case 'darwin':
      return new DarwinVirtualDeviceAdapter();
    case 'linux':
      return new LinuxVirtualDeviceAdapter();
    case 'win32':
      return new WindowsVirtualDeviceAdapter();
    default:
      return new StubVirtualDeviceAdapter();
  }
}

export function createVirtualDeviceInventoryBridge(
  opts: VirtualDeviceInventoryOptions = {}
): VirtualDeviceInventoryBridge {
  return new VirtualDeviceInventoryBridgeImpl(opts);
}
