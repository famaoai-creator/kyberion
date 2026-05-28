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
    ts: event.ts || new Date().toISOString(),
  });
}

export function isTelemetryEnabled(): boolean {
  return process.env.KYBERION_TELEMETRY === '1';
}

export function readTelemetryStats(): TelemetryStats {
  return {
    enabled: isTelemetryEnabled(),
    eventCount: telemetryEvents.length,
  };
}
