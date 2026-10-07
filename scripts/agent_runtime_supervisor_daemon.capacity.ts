import { logger } from '@agent/core/core';
import { parseInflightLimit } from '@agent/core/foundation/inflight-limit';
import { sendOpsAlert } from '@agent/core/ops-alert';
import { recordRuntimeHealthSample } from '@agent/core/tool/runtime-health-history';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';

const MAX_INFLIGHT_LIMIT = 256;

export function readDaemonLockTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function resolveInflightLimit(
  name: string,
  raw: string | undefined,
  fallback: number
): number {
  const result = parseInflightLimit(raw, fallback, MAX_INFLIGHT_LIMIT);
  if (result.invalid) {
    logger.warn(
      `[RUNTIME_CAPACITY_CONFIG_INVALID] ${name}=${JSON.stringify(raw)} is outside 1..${MAX_INFLIGHT_LIMIT} — using safe default ${fallback} | next: set a positive integer within the supported range | evidence: ${name}`
    );
  }
  return result.value;
}

export function alertVetoWindowFailure(now: Date, error: unknown): void {
  try {
    sendOpsAlert({
      severity: 'warning',
      category: 'approval',
      title: 'Autonomy veto-window processing failed',
      context: {
        operation: 'veto_window_tick',
        observed_at: now.toISOString(),
        error_type: error instanceof Error ? error.name : typeof error,
      },
      recommendation:
        'Inspect the agent-runtime-supervisor log and run the governed approval inbox tick after resolving the cause.',
      dedupe_key: 'dot-supervisor:veto-window-tick-failed',
    });
  } catch (alertError) {
    logger.warn(
      `[dot-sweep] veto-window alert failed: ${alertError instanceof Error ? alertError.message : alertError}`
    );
  }
}

export function startRuntimeHealthSampler(processName: string): void {
  recordRuntimeHealthSample({ processName });
  const sampler = setInterval(() => recordRuntimeHealthSample({ processName }), 60 * 60 * 1000);
  sampler.unref?.();
}
