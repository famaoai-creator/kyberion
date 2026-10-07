/**
 * Calendar backend registry — adapter registration / resolution only.
 * No JXA / GWS implementation details here so third-party backends
 * (e.g. Outlook) can register without touching dispatch code.
 */

import type {
  CalendarBackendAdapter,
  CalendarBackendAvailabilityOverrides,
  CalendarBackendPreference,
} from './calendar-types.js';

export type {
  CalendarBackend,
  CalendarBackendAdapter,
  CalendarBackendAvailabilityOverrides,
  CalendarBackendKind,
  CalendarBackendPreference,
} from './calendar-types.js';

const CALENDAR_BACKEND_REQUIRED_METHODS = [
  'isAvailable',
  'unavailableMessage',
  'listCalendars',
  'listEvents',
  'queryFreeBusy',
  'createEvent',
] as const;
const CALENDAR_BACKEND_OPTIONAL_METHODS = ['updateEvent', 'deleteEvent', 'findSlots'] as const;

function assertCalendarBackendAdapter(adapter: CalendarBackendAdapter): string {
  const id = adapter?.id;
  if (typeof id !== 'string' || id !== id.trim() || !/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new Error(`calendar-actuator: invalid backend adapter id: ${String(id)}`);
  }
  for (const method of CALENDAR_BACKEND_REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`calendar-actuator: backend adapter '${id}' must implement ${method}()`);
    }
  }
  for (const method of CALENDAR_BACKEND_OPTIONAL_METHODS) {
    if (adapter[method] !== undefined && typeof adapter[method] !== 'function') {
      throw new Error(`calendar-actuator: backend adapter '${id}' has invalid ${method}()`);
    }
  }
  return id;
}

export class CalendarBackendRegistry {
  private readonly adapters = new Map<string, CalendarBackendAdapter>();

  constructor(adapters: readonly CalendarBackendAdapter[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: CalendarBackendAdapter): this {
    const id = assertCalendarBackendAdapter(adapter);
    if (this.adapters.has(id)) {
      throw new Error(`calendar-actuator: backend adapter "${id}" is already registered`);
    }
    this.adapters.set(id, adapter);
    return this;
  }

  get(id: string): CalendarBackendAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(
        `calendar-actuator: unsupported backend "${id}". Available backends: ${this.ids().join(', ') || '(none)'}`
      );
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /** Capability summary for help / discovery output. */
  describeCapabilities(): Array<{ backend: string; capabilities: string[]; priority?: number }> {
    return [...this.adapters.values()].map((adapter) => ({
      backend: adapter.id,
      capabilities: [
        'listCalendars',
        'listEvents',
        'queryFreeBusy',
        'createEvent',
        ...(adapter.updateEvent ? ['updateEvent'] : []),
        ...(adapter.deleteEvent ? ['deleteEvent'] : []),
        ...(adapter.findSlots ? ['findSlots'] : []),
        ...(adapter.capabilities ?? []),
      ].filter((entry, index, all) => all.indexOf(entry) === index),
      ...(adapter.priority !== undefined ? { priority: adapter.priority } : {}),
    }));
  }

  resolve(
    requested: CalendarBackendPreference = 'auto',
    platform: string = process.platform,
    availabilityOverrides: CalendarBackendAvailabilityOverrides = {}
  ): CalendarBackendAdapter {
    if (requested !== 'auto') {
      const adapter = this.get(requested);
      let available: boolean;
      try {
        available = this.isAvailable(adapter, platform, availabilityOverrides);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${adapter.unavailableMessage()} Availability probe failed: ${reason}`);
      }
      if (!available) throw new Error(adapter.unavailableMessage());
      return adapter;
    }

    const probeErrors: string[] = [];
    const available = [...this.adapters.values()]
      .filter((adapter) => {
        try {
          return this.isAvailable(adapter, platform, availabilityOverrides);
        } catch (error) {
          probeErrors.push(
            `${adapter.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          return false;
        }
      })
      .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
    if (available[0]) return available[0];
    const diagnostics = [
      ...[...this.adapters.values()].map((adapter) => adapter.unavailableMessage()),
      ...probeErrors.map((error) => `availability probe failed for ${error}`),
    ];
    throw new Error(
      `calendar-actuator: no calendar backend is ready. ${diagnostics.join(' ')} Available backends: ${this.ids().join(', ') || '(none)'}`
    );
  }

  private isAvailable(
    adapter: CalendarBackendAdapter,
    platform: string,
    availabilityOverrides: CalendarBackendAvailabilityOverrides
  ): boolean {
    const override = availabilityOverrides[adapter.id];
    return override === undefined ? adapter.isAvailable(platform) : override;
  }
}
