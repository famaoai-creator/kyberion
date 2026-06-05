import { createScreenDisplayInventoryBridge, type ScreenDisplayInventory, type ScreenDisplayRecord } from '@agent/core';

export interface ResolvedScreenDisplaySelection {
  inventory: ScreenDisplayInventory;
  selected_display: ScreenDisplayRecord;
  display_index: number;
  display_name: string;
  selection_source: 'explicit_index' | 'display_name' | 'primary' | 'fallback';
}

export function normalizeDisplayName(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : undefined;
}

export function normalizeApplicationName(value: unknown): string | undefined {
  return normalizeDisplayName(value);
}

export function normalizeDisplayIndex(value: unknown): number | undefined {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

export function selectDisplayFromInventory(
  inventory: ScreenDisplayInventory,
  requestedIndex?: number,
  requestedName?: string,
): { display: ScreenDisplayRecord; selection_source: ResolvedScreenDisplaySelection['selection_source'] } {
  const displays = Array.isArray(inventory.displays) ? inventory.displays.filter((display) => display.available !== false) : [];
  const normalizedRequestedName = requestedName ? requestedName.toLowerCase() : undefined;

  if (typeof requestedIndex === 'number') {
    const exact = displays.find((display) => display.index === requestedIndex);
    if (exact) {
      return { display: exact, selection_source: 'explicit_index' };
    }
  }

  if (normalizedRequestedName) {
    const exact = displays.find((display) => display.name.toLowerCase() === normalizedRequestedName);
    if (exact) {
      return { display: exact, selection_source: 'display_name' };
    }
    const partial = displays.find((display) => display.name.toLowerCase().includes(normalizedRequestedName));
    if (partial) {
      return { display: partial, selection_source: 'display_name' };
    }
  }

  const primary = displays.find((display) => display.primary);
  if (primary) {
    return { display: primary, selection_source: 'primary' };
  }

  if (displays.length > 0) {
    return { display: displays[0], selection_source: 'fallback' };
  }

  return {
    display: {
      index: 0,
      name: 'Display 1',
      platform: process.platform,
      source: 'heuristic',
      available: true,
      primary: true,
    },
    selection_source: 'fallback',
  };
}

export async function resolveScreenDisplaySelection(params: Record<string, any>, resolve: (value: any) => any): Promise<ResolvedScreenDisplaySelection> {
  const inventoryBridge = createScreenDisplayInventoryBridge();
  const probe = await inventoryBridge.probe();
  const requestedIndex = normalizeDisplayIndex(resolve(params.display_index));
  const requestedName = normalizeDisplayName(resolve(params.display_name));
  const { display, selection_source } = selectDisplayFromInventory(probe.inventory, requestedIndex, requestedName);
  return {
    inventory: probe.inventory,
    selected_display: display,
    display_index: display.index,
    display_name: display.name,
    selection_source,
  };
}

export const systemDisplayHelpers = {
  normalizeDisplayName,
  normalizeApplicationName,
  normalizeDisplayIndex,
  selectDisplayFromInventory,
  resolveScreenDisplaySelection,
};
