import { describe, it, expect } from 'vitest';
import { analyzeTelemetry } from './lib';

describe('telemetry-insight-engine lib', () => {
  it('should calculate stats correctly', () => {
    const events = [
      { feature: 'auth', status: 'success', duration: 100 },
      { feature: 'auth', status: 'error', duration: 200 },
    ];
    const stats = analyzeTelemetry(events);
    expect(stats.auth.count).toBe(2);
    expect(stats.auth.errors).toBe(1);
    expect(stats.auth.avgDuration).toBe(150);
  });
});
