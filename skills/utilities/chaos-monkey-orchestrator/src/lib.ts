export interface ChaosConfig {
  active: boolean;
  target: string;
  mode: 'latency' | 'error' | 'memory-spike';
  intensity: number;
  timestamp: string;
}

export function createChaosConfig(
  target: string,
  mode: ChaosConfig['mode'],
  intensity: number
): ChaosConfig {
  return {
    active: true,
    target: target || '*',
    mode,
    intensity,
    timestamp: new Date().toISOString(),
  };
}
