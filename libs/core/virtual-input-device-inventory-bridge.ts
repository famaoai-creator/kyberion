import { safeExecResult } from './secure-io.js';

export const VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID = 'virtual-input-device-inventory-bridge' as const;

export type VirtualInputDeviceKind = 'keyboard' | 'mouse' | 'pointing-device' | 'other-input' | 'virtual-input';

export interface VirtualInputDeviceRecord {
  kind: VirtualInputDeviceKind;
  name: string;
  platform: NodeJS.Platform;
  source: 'hidutil' | 'libinput' | 'xinput' | 'heuristic';
  available: boolean;
  details?: Record<string, unknown>;
}

export interface VirtualInputDeviceInventory {
  keyboards: VirtualInputDeviceRecord[];
  mice: VirtualInputDeviceRecord[];
  pointing_devices: VirtualInputDeviceRecord[];
  virtual_input_devices: VirtualInputDeviceRecord[];
  notes: string[];
}

export interface VirtualInputDeviceInventoryProbe {
  bridge_id: typeof VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  inventory: VirtualInputDeviceInventory;
}

export interface VirtualInputDeviceInventoryBridge {
  readonly bridge_id: typeof VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID;
  probe(): Promise<VirtualInputDeviceInventoryProbe>;
  scan(): Promise<VirtualInputDeviceInventory>;
}

export interface VirtualInputDeviceInventoryOptions {
  hidutil_bin?: string;
  libinput_bin?: string;
  xinput_bin?: string;
  command_runner?: (command: string, args: string[]) => {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
}

const DEFAULT_HIDUTIL = 'hidutil';
const DEFAULT_LIBINPUT = 'libinput';
const DEFAULT_XINPUT = 'xinput';

function emptyInventory(): VirtualInputDeviceInventory {
  return {
    keyboards: [],
    mice: [],
    pointing_devices: [],
    virtual_input_devices: [],
    notes: [],
  };
}

function uniqueByName(records: VirtualInputDeviceRecord[]): VirtualInputDeviceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.kind}:${record.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runCommand(
  opts: VirtualInputDeviceInventoryOptions,
  command: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  if (opts.command_runner) return opts.command_runner(command, args);
  return safeExecResult(command, args, { maxOutputMB: 4 });
}

function isVirtualName(name: string): boolean {
  return /virtual|loopback|blackhole|meeting_in|meeting_out|dummy|stub/i.test(name);
}

function classifyUsage(usagePage: number, usage: number, name: string): VirtualInputDeviceKind {
  const lowerName = name.toLowerCase();
  if (usagePage === 1 && usage === 6) return 'keyboard';
  if (usagePage === 1 && usage === 2) return 'mouse';
  if (/keyboard/.test(lowerName)) return 'keyboard';
  if (/mouse|trackball/.test(lowerName)) return 'mouse';
  if (/trackpad|touchpad|pointer|touch/.test(lowerName)) return 'pointing-device';
  return 'other-input';
}

function parseHidutilLines(stdout: string): VirtualInputDeviceRecord[] {
  const records: VirtualInputDeviceRecord[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^devices?:$/i.test(line)) continue;
    if (!/^0x/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 10) continue;

    const vendorId = tokens[0];
    const productId = tokens[1];
    const locationId = tokens[2];
    const usagePageRaw = tokens[3];
    const usageRaw = tokens[4];
    const registryId = tokens[5];
    const userClass = tokens[tokens.length - 2];
    const builtIn = tokens[tokens.length - 1];
    const classIndex = tokens.findIndex((token, index) => index >= 6 && /HIDDevice$|^IOHIDUserDevice$|^AppleBTM$|^AppleSPUHIDDevice$/.test(token));
    if (classIndex < 0 || classIndex >= tokens.length - 2) continue;
    const transport = tokens.slice(6, classIndex).join(' ').trim();
    const className = tokens[classIndex];
    const product = tokens.slice(classIndex + 1, -2).join(' ').trim();

    if (!product) continue;

    const usagePage = Number(usagePageRaw);
    const usage = Number(usageRaw);
    const kind = classifyUsage(usagePage, usage, product);
    records.push({
      kind,
      name: product,
      platform: process.platform,
      source: 'hidutil',
      available: true,
      details: {
        vendor_id: vendorId,
        product_id: productId,
        location_id: locationId,
        usage_page: usagePageRaw,
        usage: usageRaw,
        registry_id: registryId,
        transport,
        class_name: className,
        user_class: userClass,
        built_in: builtIn === '1',
      },
    });
    if (isVirtualName(product)) {
      records.push({
        kind: 'virtual-input',
        name: product,
        platform: process.platform,
        source: 'hidutil',
        available: true,
        details: {
          vendor_id: vendorId,
          product_id: productId,
          location_id: locationId,
          usage_page: usagePageRaw,
          usage: usageRaw,
          registry_id: registryId,
          transport,
          class_name: className,
          user_class: userClass,
          built_in: builtIn === '1',
        },
      });
    }
  }
  return uniqueByName(records);
}

function collectMacInputDevices(
  opts: VirtualInputDeviceInventoryOptions,
  hidutilBin: string,
): VirtualInputDeviceRecord[] {
  const result = runCommand(opts, hidutilBin, ['list']);
  const text = `${result.stdout}\n${result.stderr}`;
  const records = parseHidutilLines(text);
  if (records.length === 0 && (result.status !== 0 || result.error)) {
    return [
      {
        kind: 'other-input',
        name: 'hidutil list unavailable',
        platform: process.platform,
        source: 'heuristic',
        available: false,
        details: {
          stderr: result.stderr || '',
          status: result.status,
        },
      },
    ];
  }
  return records;
}

function collectLibinputDevices(
  opts: VirtualInputDeviceInventoryOptions,
  libinputBin: string,
): VirtualInputDeviceRecord[] {
  const result = runCommand(opts, libinputBin, ['list-devices']);
  const text = `${result.stdout}\n${result.stderr}`;
  const records: VirtualInputDeviceRecord[] = [];
  let currentName = '';
  let currentKinds = new Set<VirtualInputDeviceKind>();
  let currentDetails: Record<string, unknown> = {};

  const flush = () => {
    if (!currentName) return;
    const kind = currentKinds.has('keyboard')
      ? 'keyboard'
      : currentKinds.has('mouse')
        ? 'mouse'
        : currentKinds.has('pointing-device')
          ? 'pointing-device'
          : 'other-input';
    records.push({
      kind,
      name: currentName,
      platform: process.platform,
      source: 'libinput',
      available: true,
      details: { ...currentDetails },
    });
    if (isVirtualName(currentName)) {
      records.push({
        kind: 'virtual-input',
        name: currentName,
        platform: process.platform,
        source: 'libinput',
        available: true,
        details: { ...currentDetails },
      });
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      currentName = '';
      currentKinds = new Set<VirtualInputDeviceKind>();
      currentDetails = {};
      continue;
    }
    if (line.startsWith('Device:')) {
      flush();
      currentName = line.slice('Device:'.length).trim();
      currentKinds = new Set<VirtualInputDeviceKind>();
      currentDetails = {};
      continue;
    }
    if (line.startsWith('Kernel:')) {
      currentDetails.kernel = line.slice('Kernel:'.length).trim();
      continue;
    }
    if (line.startsWith('Capabilities:')) {
      const caps = line.slice('Capabilities:'.length).trim().toLowerCase();
      if (caps.includes('keyboard')) currentKinds.add('keyboard');
      if (caps.includes('pointer')) currentKinds.add('mouse');
      if (caps.includes('touchpad')) currentKinds.add('pointing-device');
      currentDetails.capabilities = caps;
      continue;
    }
  }
  flush();
  return uniqueByName(records);
}

function collectXinputDevices(
  opts: VirtualInputDeviceInventoryOptions,
  xinputBin: string,
): VirtualInputDeviceRecord[] {
  const result = runCommand(opts, xinputBin, ['list', '--name-only']);
  const text = `${result.stdout}\n${result.stderr}`;
  const records: VirtualInputDeviceRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const name = rawLine.trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    const kind = lowerName.includes('keyboard')
      ? 'keyboard'
      : lowerName.includes('mouse') || lowerName.includes('pointer')
        ? 'mouse'
        : lowerName.includes('touchpad') || lowerName.includes('trackpad')
          ? 'pointing-device'
          : 'other-input';
    records.push({
      kind,
      name,
      platform: process.platform,
      source: 'xinput',
      available: true,
    });
    if (isVirtualName(name)) {
      records.push({
        kind: 'virtual-input',
        name,
        platform: process.platform,
        source: 'xinput',
        available: true,
      });
    }
  }
  return uniqueByName(records);
}

export class VirtualInputDeviceInventoryBridgeImpl implements VirtualInputDeviceInventoryBridge {
  readonly bridge_id = VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID;

  constructor(private readonly opts: VirtualInputDeviceInventoryOptions = {}) {}

  async scan(): Promise<VirtualInputDeviceInventory> {
    const inventory = emptyInventory();

    if (process.platform === 'darwin') {
      const hidutilBin = this.opts.hidutil_bin ?? DEFAULT_HIDUTIL;
      const inputDevices = collectMacInputDevices(this.opts, hidutilBin);
      inventory.keyboards.push(...inputDevices.filter((record) => record.kind === 'keyboard'));
      inventory.mice.push(...inputDevices.filter((record) => record.kind === 'mouse'));
      inventory.pointing_devices.push(...inputDevices.filter((record) => record.kind === 'pointing-device'));
      inventory.virtual_input_devices.push(...inputDevices.filter((record) => record.kind === 'virtual-input'));
      if (inputDevices.length === 0) {
        inventory.notes.push('hidutil list returned no input devices');
      }
    } else if (process.platform === 'linux') {
      const libinputBin = this.opts.libinput_bin ?? DEFAULT_LIBINPUT;
      const xinputBin = this.opts.xinput_bin ?? DEFAULT_XINPUT;
      const libinputDevices = collectLibinputDevices(this.opts, libinputBin);
      if (libinputDevices.length > 0) {
        inventory.keyboards.push(...libinputDevices.filter((record) => record.kind === 'keyboard'));
        inventory.mice.push(...libinputDevices.filter((record) => record.kind === 'mouse'));
        inventory.pointing_devices.push(...libinputDevices.filter((record) => record.kind === 'pointing-device'));
        inventory.virtual_input_devices.push(...libinputDevices.filter((record) => record.kind === 'virtual-input'));
      } else {
        const xinputDevices = collectXinputDevices(this.opts, xinputBin);
        inventory.keyboards.push(...xinputDevices.filter((record) => record.kind === 'keyboard'));
        inventory.mice.push(...xinputDevices.filter((record) => record.kind === 'mouse'));
        inventory.pointing_devices.push(...xinputDevices.filter((record) => record.kind === 'pointing-device'));
        inventory.virtual_input_devices.push(...xinputDevices.filter((record) => record.kind === 'virtual-input'));
      }
    } else {
      inventory.notes.push(`platform ${process.platform} has no built-in input inventory probe; stub only`);
    }

    if (
      inventory.keyboards.length === 0 &&
      inventory.mice.length === 0 &&
      inventory.pointing_devices.length === 0 &&
      inventory.virtual_input_devices.length === 0
    ) {
      inventory.notes.push('no real input devices discovered; bridge should fall back to stub');
    }

    return inventory;
  }

  async probe(): Promise<VirtualInputDeviceInventoryProbe> {
    const inventory = await this.scan();
    const available =
      inventory.keyboards.length > 0 ||
      inventory.mice.length > 0 ||
      inventory.pointing_devices.length > 0 ||
      inventory.virtual_input_devices.length > 0;
    return {
      bridge_id: VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID,
      platform: process.platform,
      available,
      reason: available ? undefined : inventory.notes[0],
      inventory,
    };
  }
}

export function createVirtualInputDeviceInventoryBridge(
  opts: VirtualInputDeviceInventoryOptions = {},
): VirtualInputDeviceInventoryBridge {
  return new VirtualInputDeviceInventoryBridgeImpl(opts);
}
