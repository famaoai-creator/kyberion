/**
 * Dynamic Actuator Capability Contracts
 *
 * Transforms static manifest.json declarations into runtime capability detection,
 * so the orchestrator can determine which actuators are actually usable in the
 * current environment.
 */

import { logger } from '../core.js';
import * as path from 'path';
import { safeExistsSync, safeReadFile, safeReaddir } from '../secure-io.js';

export interface ActuatorCapability {
  op: string;
  available: boolean;
  reason?: string;              // why unavailable
  prerequisites?: string[];     // what's needed to make it available
  cost?: 'free' | 'api_call' | 'compute_intensive';
}

export interface ActuatorStatus {
  actuatorId: string;
  version: string;
  capabilities: ActuatorCapability[];
  checkedAt: string;
}

// Registry of capability probe functions
const capabilityProbes = new Map<string, () => Promise<ActuatorCapability[]>>();

export function registerCapabilityProbe(
  actuatorId: string,
  probe: () => Promise<ActuatorCapability[]>
) {
  capabilityProbes.set(actuatorId, probe);
}

/**
 * Check capabilities for a specific actuator by running environment probes.
 * Each actuator can register a checkFn, or fall back to manifest-based static check.
 */
export async function checkActuatorCapabilities(
  actuatorId: string,
  manifestPath: string
): Promise<ActuatorStatus> {
  // Read manifest
  const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
  const capabilities: ActuatorCapability[] = [];

  // Run registered probe if exists
  const probe = capabilityProbes.get(actuatorId);
  if (probe) {
    const probed = await probe();
    capabilities.push(...probed);
  } else {
    // Fallback: mark all manifest capabilities as available (static)
    for (const cap of manifest.capabilities || []) {
      capabilities.push({ op: cap.op, available: true, cost: 'free' });
    }
  }

  return {
    actuatorId: manifest.actuator_id || actuatorId,
    version: manifest.version || '0.0.0',
    capabilities,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Scan all actuators in libs/actuators/ and check their capabilities
 */
export async function checkAllActuatorCapabilities(
  actuatorsDir?: string
): Promise<ActuatorStatus[]> {
  const dir = actuatorsDir || path.join(process.cwd(), 'libs/actuators');
  const results: ActuatorStatus[] = [];

  if (!safeExistsSync(dir)) return results;

  const entries = safeReaddir(dir);
  for (const entry of entries) {
    const manifestPath = path.join(dir, entry, 'manifest.json');
    if (safeExistsSync(manifestPath)) {
      try {
        const status = await checkActuatorCapabilities(entry, manifestPath);
        results.push(status);
      } catch (e: any) {
        logger.error(`Failed to check ${entry}: ${e.message}`);
      }
    }
  }

  return results;
}

// ─── Built-in Probes ───────────────────────────────────────────────────────────

// Browser actuator: check if Playwright is installed
registerCapabilityProbe('browser-actuator', async () => {
  try {
    const pwPath = path.join(process.cwd(), 'node_modules/playwright-core');
    const pwTestPath = path.join(process.cwd(), 'node_modules/@playwright/test');
    const available = safeExistsSync(pwPath) || safeExistsSync(pwTestPath);
    return [{
      op: 'pipeline',
      available,
      reason: available ? undefined : '@playwright/test or playwright-core not installed',
      prerequisites: available ? undefined : ['pnpm add -D @playwright/test', 'npx playwright install chromium'],
    }];
  } catch { return [{ op: 'pipeline', available: false, reason: 'check failed' }]; }
});

// Voice actuator: check if TTS server is reachable
registerCapabilityProbe('voice-actuator', async () => {
  try {
    const { platform } = await import('../platform.js');
    const capabilities = await platform.getCapabilities();
    const available = capabilities.hasSpeech;
    const reason = available ? undefined : 'No native speech binary is available on this host';
    return [
      { op: 'speak_local', available, reason, cost: 'free' },
      { op: 'list_voices', available, reason },
      { op: 'generate_voice', available, reason, cost: 'compute_light' },
    ];
  } catch {
    return [
      { op: 'speak_local', available: false, reason: 'probe failed' },
      { op: 'list_voices', available: false, reason: 'probe failed' },
      { op: 'generate_voice', available: false, reason: 'probe failed' },
    ];
  }
});

// Vision actuator: check platform
registerCapabilityProbe('vision-actuator', async () => {
  const isDarwin = process.platform === 'darwin';
  return [
    { op: 'capture', available: isDarwin, reason: isDarwin ? undefined : 'screencapture requires macOS', prerequisites: isDarwin ? undefined : ['Run on macOS'] },
    { op: 'pipeline', available: isDarwin, reason: isDarwin ? undefined : 'vision pipeline requires macOS screen capture' },
  ];
});

// Media actuator: always available (pure Node.js)
registerCapabilityProbe('media-actuator', async () => [
  { op: 'pipeline', available: true, cost: 'free' },
]);

// System actuator: check shell availability
registerCapabilityProbe('system-actuator', async () => [
  { op: 'exec', available: true, cost: 'free' },
  { op: 'pipeline', available: true, cost: 'free' },
]);
