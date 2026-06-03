import { safeExecResult } from './secure-io.js';

export const SCREEN_DISPLAY_INVENTORY_BRIDGE_ID = 'screen-display-inventory-bridge' as const;

export interface ScreenDisplayRecord {
  index: number;
  name: string;
  platform: NodeJS.Platform;
  source: 'system_profiler' | 'xrandr' | 'heuristic';
  available: boolean;
  primary?: boolean;
  width?: number;
  height?: number;
  details?: Record<string, unknown>;
}

export interface ScreenDisplayInventory {
  displays: ScreenDisplayRecord[];
  notes: string[];
}

export interface ScreenDisplayInventoryProbe {
  bridge_id: typeof SCREEN_DISPLAY_INVENTORY_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  inventory: ScreenDisplayInventory;
}

export interface ScreenDisplayInventoryBridge {
  readonly bridge_id: typeof SCREEN_DISPLAY_INVENTORY_BRIDGE_ID;
  probe(): Promise<ScreenDisplayInventoryProbe>;
  scan(): Promise<ScreenDisplayInventory>;
}

export interface ScreenDisplayInventoryOptions {
  platform?: NodeJS.Platform;
  system_profiler_bin?: string;
  xrandr_bin?: string;
  command_runner?: (command: string, args: string[]) => {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
}

const DEFAULT_SYSTEM_PROFILER = 'system_profiler';
const DEFAULT_XRANDR = 'xrandr';

function emptyInventory(): ScreenDisplayInventory {
  return {
    displays: [],
    notes: [],
  };
}

function runCommand(
  opts: ScreenDisplayInventoryOptions,
  command: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  if (opts.command_runner) return opts.command_runner(command, args);
  return safeExecResult(command, args, { maxOutputMB: 4 });
}

function parseResolution(text: string): { width?: number; height?: number } {
  const match = text.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
}

function collectMacDisplays(
  opts: ScreenDisplayInventoryOptions,
  runtimePlatform: NodeJS.Platform,
  bin: string,
): ScreenDisplayRecord[] {
  const result = runCommand(opts, bin, ['SPDisplaysDataType', '-json']);
  const records: ScreenDisplayRecord[] = [];
  try {
    const payload = JSON.parse(result.stdout || '{}');
    const sections = Array.isArray((payload as any)?.SPDisplaysDataType) ? (payload as any).SPDisplaysDataType : [];
    let index = 0;
    for (const section of sections) {
      const items = Array.isArray(section?._items)
        ? section._items
        : Array.isArray(section?.spdisplays_ndrvs)
          ? section.spdisplays_ndrvs
          : [];
      for (const device of items) {
        const name = String(
          device?._name
          || device?.spdisplays_display_name
          || device?.spdisplays_display_product_name
          || device?.spdisplays_vendor
          || section?._name
          || ''
        ).trim();
        const displayName = name || `Display ${index + 1}`;
        const resolution = `${device?.spdisplays_resolution || device?.spdisplays_pixels || device?.spdisplays_display_resolution || ''}`;
        const parsed = parseResolution(resolution);
        records.push({
          index,
          name: displayName,
          platform: runtimePlatform,
          source: 'system_profiler',
          available: true,
          primary: Boolean(device?.spdisplays_main),
          width: parsed.width,
          height: parsed.height,
          details: {
            vendor: device?.spdisplays_vendor || undefined,
            model: device?.spdisplays_model || undefined,
            mirror: device?.spdisplays_mirror || undefined,
            resolution: resolution || undefined,
          },
        });
        index += 1;
      }
    }
    if (records.length === 0) {
      records.push({
        index: 0,
        name: 'Display 1',
        platform: runtimePlatform,
        source: 'heuristic',
        available: true,
        primary: true,
      });
    }
  } catch {
    records.push({
      index: 0,
      name: 'Display 1',
      platform: runtimePlatform,
      source: 'heuristic',
      available: true,
      primary: true,
    });
  }
  return records;
}

function collectLinuxDisplays(
  opts: ScreenDisplayInventoryOptions,
  runtimePlatform: NodeJS.Platform,
  bin: string,
): ScreenDisplayRecord[] {
  const result = runCommand(opts, bin, ['--query']);
  const text = `${result.stdout}\n${result.stderr}`;
  const records: ScreenDisplayRecord[] = [];
  let index = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('connected') === false) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    const primary = parts.includes('primary');
    const resPart = parts.find((part) => /\d+x\d+\+/.test(part)) || '';
    const resMatch = resPart.match(/(\d+)x(\d+)\+/);
    records.push({
      index,
      name,
      platform: runtimePlatform,
      source: 'xrandr',
      available: true,
      primary,
      width: resMatch ? Number(resMatch[1]) : undefined,
      height: resMatch ? Number(resMatch[2]) : undefined,
      details: { raw: trimmed },
    });
    index += 1;
  }
  if (records.length === 0) {
    records.push({
      index: 0,
      name: 'Display 1',
      platform: runtimePlatform,
      source: 'heuristic',
      available: true,
      primary: true,
    });
  }
  return records;
}

export class ScreenDisplayInventoryBridgeImpl implements ScreenDisplayInventoryBridge {
  readonly bridge_id = SCREEN_DISPLAY_INVENTORY_BRIDGE_ID;

  constructor(private readonly opts: ScreenDisplayInventoryOptions = {}) {}

  async scan(): Promise<ScreenDisplayInventory> {
    const inventory = emptyInventory();
    const runtimePlatform = this.opts.platform ?? process.platform;
    if (runtimePlatform === 'darwin') {
      inventory.displays = collectMacDisplays(this.opts, runtimePlatform, this.opts.system_profiler_bin ?? DEFAULT_SYSTEM_PROFILER);
    } else if (runtimePlatform === 'linux') {
      inventory.displays = collectLinuxDisplays(this.opts, runtimePlatform, this.opts.xrandr_bin ?? DEFAULT_XRANDR);
    } else {
      inventory.notes.push(`unsupported platform: ${runtimePlatform}`);
      inventory.displays.push({
        index: 0,
        name: 'Display 1',
        platform: runtimePlatform,
        source: 'heuristic',
        available: true,
        primary: true,
      });
    }
    return inventory;
  }

  async probe(): Promise<ScreenDisplayInventoryProbe> {
    const inventory = await this.scan();
    const available = inventory.displays.length > 0;
      return {
      bridge_id: SCREEN_DISPLAY_INVENTORY_BRIDGE_ID,
      platform: this.opts.platform ?? process.platform,
      available,
      reason: available ? undefined : 'no display candidates detected',
      inventory,
    };
  }
}

export function createScreenDisplayInventoryBridge(
  opts: ScreenDisplayInventoryOptions = {},
): ScreenDisplayInventoryBridge {
  return new ScreenDisplayInventoryBridgeImpl(opts);
}
