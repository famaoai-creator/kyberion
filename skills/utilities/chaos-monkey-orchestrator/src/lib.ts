export interface ChaosConfig {
  active: boolean;
  target: string;
  mode: 'latency' | 'error' | 'memory-spike' | 'aws-fis';
  intensity: number;
  experimentId?: string; // For AWS FIS
  timestamp: string;
}

/**
 * Starts an AWS FIS Experiment to inject faults into the infrastructure.
 * This can be stopping EC2 instances, DB failover, or network latency.
 */
export async function startFisExperiment(templateId: string): Promise<string> {
  // In a real environment, we'd use @aws-sdk/client-fis here.
  // We'll simulate the successful trigger for the automation demo.
  const experimentId = `exp-${Math.random().toString(36).substring(2, 10)}`;
  console.error(`[AWS FIS] Starting experiment based on template: ${templateId}`);
  return experimentId;
}

export function createChaosConfig(
  target: string,
  mode: ChaosConfig['mode'],
  intensity: number,
  experimentId?: string
): ChaosConfig {
  return {
    active: true,
    target: target || '*',
    mode,
    intensity,
    experimentId,
    timestamp: new Date().toISOString(),
  };
}
