import { nowIso } from './foundation/time.js';

export interface TelemetryEvent {
  name: string;
  ts?: string;
  attrs?: Record<string, unknown>;
}

export type TelemetryEventType = string;

export interface TelemetryStats {
  enabled: boolean;
  eventCount: number;
}

const telemetryEvents: TelemetryEvent[] = [];

export function recordTelemetryEvent(event: TelemetryEvent): void {
  telemetryEvents.push({
    ...event,
    ts: event.ts || nowIso(),
  });
}

export function isTelemetryEnabled(): boolean {
  return getRegisteredEnvText('KYBERION_TELEMETRY') === '1';
}

export function readTelemetryStats(): TelemetryStats {
  return {
    enabled: isTelemetryEnabled(),
    eventCount: telemetryEvents.length,
  };
}
import { getRegisteredEnvText } from './foundation/env.js';
