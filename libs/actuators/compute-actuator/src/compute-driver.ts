/**
 * compute-driver.ts
 * Polymorphic compute execution driver interface and registry for Kyberion Compute Seam.
 */

export type ComputeProviderType = 'local' | 'colab' | (string & {});

export interface ComputeJobHardwareSpec {
  accelerator?: 'none' | 'gpu' | 'tpu';
  gpu_type?: string;
  high_ram?: boolean;
}

export interface ComputeJobSpec {
  job_id: string;
  provider?: ComputeProviderType;
  notebook_path?: string;
  entrypoint?: string;
  hardware?: ComputeJobHardwareSpec;
  params?: Record<string, unknown>;
}

export type ComputeJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ComputeJobState {
  job_id: string;
  provider: ComputeProviderType;
  status: ComputeJobStatus;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  message?: string;
  artifacts?: string[];
}

export interface ComputeDriver {
  readonly providerId: string;
  submitJob(spec: ComputeJobSpec): Promise<ComputeJobState>;
  pollStatus(jobId: string): Promise<ComputeJobState>;
  collectArtifact(
    jobId: string,
    targetPath: string,
    artifactNames?: string[]
  ): Promise<{ collected: string[]; destination: string }>;
  cancelJob(jobId: string): Promise<ComputeJobState>;
}

/**
 * BaseComputeDriver: Common state store & lifecycle management
 * Concrete drivers override execution semantics while sharing state handling.
 */
export abstract class BaseComputeDriver implements ComputeDriver {
  abstract readonly providerId: string;
  readonly stateStore = new Map<string, ComputeJobState>();

  abstract submitJob(spec: ComputeJobSpec): Promise<ComputeJobState>;

  async pollStatus(jobId: string): Promise<ComputeJobState> {
    const state = this.stateStore.get(jobId);
    if (!state) {
      throw new Error(`[${this.providerId}] Compute job not found: ${jobId}`);
    }
    return state;
  }

  async collectArtifact(
    jobId: string,
    targetPath: string,
    _artifactNames?: string[]
  ): Promise<{ collected: string[]; destination: string }> {
    const state = this.stateStore.get(jobId);
    if (!state) {
      throw new Error(`[${this.providerId}] Compute job not found: ${jobId}`);
    }
    return {
      collected: state.artifacts ?? ['output.json'],
      destination: targetPath,
    };
  }

  async cancelJob(jobId: string): Promise<ComputeJobState> {
    const state = this.stateStore.get(jobId);
    if (!state) {
      throw new Error(`[${this.providerId}] Compute job not found: ${jobId}`);
    }
    state.status = 'cancelled';
    return state;
  }
}

/** Polymorphic Registry of Compute Drivers */
const driverRegistry = new Map<string, ComputeDriver>();

export function registerComputeDriver(driver: ComputeDriver): void {
  driverRegistry.set(driver.providerId, driver);
}

export function listComputeProviders(): string[] {
  return Array.from(driverRegistry.keys());
}

export function getComputeDriver(provider: string = 'local'): ComputeDriver {
  const driver = driverRegistry.get(provider);
  if (!driver) {
    throw new Error(
      `compute-actuator — compute provider '${provider}' is not registered. Available providers: ${listComputeProviders().join(', ')}`
    );
  }
  return driver;
}

/**
 * Discovers which registered driver owns a given jobId, or defaults to the specified provider.
 */
export function resolveDriverForJob(jobId: string, explicitProvider?: string): ComputeDriver {
  if (explicitProvider) {
    return getComputeDriver(explicitProvider);
  }
  for (const driver of driverRegistry.values()) {
    if (driver instanceof BaseComputeDriver && driver.stateStore.has(jobId)) {
      return driver;
    }
  }
  return getComputeDriver('local');
}
