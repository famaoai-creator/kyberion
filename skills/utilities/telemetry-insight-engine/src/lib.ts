export interface TelemetryEvent {
  feature?: string;
  action?: string;
  name?: string;
  status?: string;
  error?: string;
  duration?: number;
  timestamp?: string;
}

export interface FeatureStats {
  count: number;
  errors: number;
  avgDuration: number;
}

export function analyzeTelemetry(events: TelemetryEvent[]): Record<string, FeatureStats> {
  const features: Record<
    string,
    { count: number; errors: number; totalDuration: number; durationCount: number }
  > = {};

  for (const event of events) {
    const name = event.feature || event.action || event.name || 'unknown';
    if (!features[name]) {
      features[name] = { count: 0, errors: 0, totalDuration: 0, durationCount: 0 };
    }
    const f = features[name];
    f.count++;
    if (event.error || event.status === 'error') f.errors++;
    if (event.duration) {
      f.totalDuration += event.duration;
      f.durationCount++;
    }
  }

  const result: Record<string, FeatureStats> = {};
  for (const [name, data] of Object.entries(features)) {
    result[name] = {
      count: data.count,
      errors: data.errors,
      avgDuration: data.durationCount > 0 ? Math.round(data.totalDuration / data.durationCount) : 0,
    };
  }
  return result;
}
