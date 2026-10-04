/**
 * compute-driver.ts
 * Polymorphic compute execution driver interface and registry for Kyberion Compute Seam.
 */
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '@agent/core/seam';

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
  /** Synchronously reports whether this driver owns a job when provider is omitted. */
  ownsJob?(jobId: string): boolean;
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

  ownsJob(jobId: string): boolean {
    return this.stateStore.has(jobId);
  }

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
    artifactNames?: string[]
  ): Promise<{ collected: string[]; destination: string }> {
    const state = this.stateStore.get(jobId);
    if (!state) {
      throw new Error(`[${this.providerId}] Compute job not found: ${jobId}`);
    }

    const { safeCopyFileSync, safeMkdir, safeExistsSync } = await import('@agent/core/secure-io');
    const path = await import('node:path');

    const requested =
      artifactNames && artifactNames.length > 0 ? artifactNames : (state.artifacts ?? []);
    const collected: string[] = [];
    const missing: string[] = [];

    // Ensure target destination directory exists
    safeMkdir(targetPath, { recursive: true });

    for (const art of requested) {
      // If art is a path to an existing file, copy it into targetPath
      if (safeExistsSync(art)) {
        const baseName = path.basename(art);
        const destFile = path.join(targetPath, baseName);
        safeCopyFileSync(art, destFile);
        collected.push(baseName);
      } else {
        missing.push(path.basename(art));
      }
    }

    if (missing.length > 0 && collected.length === 0) {
      throw new Error(
        `[${this.providerId}] Cannot collect artifacts for job '${jobId}': none of the requested artifacts exist yet (status: ${state.status}, missing: ${missing.join(', ')})`
      );
    }

    return {
      collected,
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
const computeDriverSeam = createSeam<ComputeDriver>({
  key: 'compute-execution-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

function validateComputeDriver(providerId: string, candidate: unknown): ComputeDriver {
  if (!/^[a-z][a-z0-9._-]*$/.test(providerId)) {
    throw new Error('compute-actuator — invalid compute provider id: ' + providerId);
  }
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('compute-actuator — provider ' + providerId + ' must be an object');
  }
  const driver = candidate as Partial<ComputeDriver>;
  if (driver.providerId !== providerId) {
    throw new Error(
      'compute-actuator — provider registration ' + providerId + ' does not match implementation id'
    );
  }
  for (const method of ['submitJob', 'pollStatus', 'collectArtifact', 'cancelJob'] as const) {
    if (typeof driver[method] !== 'function') {
      throw new Error(
        'compute-actuator — provider ' + providerId + ' must implement ' + method + '()'
      );
    }
  }
  if (driver.ownsJob !== undefined && typeof driver.ownsJob !== 'function') {
    throw new Error('compute-actuator — provider ' + providerId + ' has invalid ownsJob()');
  }
  return driver as ComputeDriver;
}

export function registerComputeDriver(
  driver: ComputeDriver,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'compute-driver-extension' }
): () => void {
  const providerId = driver?.providerId;
  if (typeof providerId !== 'string') {
    throw new Error('compute-actuator — invalid compute provider id: ' + String(providerId));
  }
  return computeDriverSeam.register(
    providerId,
    validateComputeDriver(providerId, driver),
    metadata
  );
}

export function listComputeProviders(): string[] {
  return computeDriverSeam.list().map((entry) => entry.id);
}

export function getComputeDriver(provider: string = 'local'): ComputeDriver {
  const driver: unknown = computeDriverSeam.getOptional(provider);
  if (!driver) {
    throw new Error(
      `compute-actuator — compute provider '${provider}' is not registered. Available providers: ${listComputeProviders().join(', ')}`
    );
  }
  return validateComputeDriver(provider, driver);
}

/**
 * Discovers which registered driver owns a given jobId, or defaults to the specified provider.
 */
export function resolveDriverForJob(jobId: string, explicitProvider?: string): ComputeDriver {
  if (explicitProvider) {
    return getComputeDriver(explicitProvider);
  }
  const owners: Array<{ id: string; implementation: ComputeDriver }> = [];
  const probeErrors: string[] = [];
  for (const { id, implementation } of computeDriverSeam.list()) {
    try {
      const driver = validateComputeDriver(id, implementation);
      const ownsJob =
        driver.ownsJob?.(jobId) ??
        (driver instanceof BaseComputeDriver && driver.stateStore.has(jobId));
      if (ownsJob) owners.push({ id, implementation: driver });
    } catch (error) {
      probeErrors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (probeErrors.length > 0) {
    throw new Error(
      `compute-actuator — could not safely resolve job '${jobId}' because provider ownership checks failed: ${probeErrors.join('; ')}. Specify provider explicitly.`
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `compute-actuator — job '${jobId}' is claimed by multiple providers: ${owners.map(({ id }) => id).join(', ')}`
    );
  }
  if (owners[0]) return owners[0].implementation;
  return getComputeDriver('local');
}
